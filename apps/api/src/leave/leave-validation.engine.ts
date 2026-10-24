import type {
  LeaveBalanceUnit,
  LeaveConditionField,
  LeaveDurationSettingsView,
  LeaveRuleCondition,
  LeaveRuleConditionGroup,
  LeaveValidationFinding,
  LeaveValidationResult,
  LeaveValidationRuleParams,
  LeaveValidationRuleView,
  LeaveValidationSeverity,
  LeaveValidationType,
} from "@aihxm/shared-types";
import { LOCKED_VALIDATION_TYPES, SEVERITY_ORDER, VALIDATION_CATALOG, catalogInfo, displayRank } from "./leave-validation.catalog";
import { formatClock, formatMinutes, formatUnits, parseClock } from "./leave-time";

/**
 * BACKLOG58 - the validation engine. A pure function from a snapshot of facts about the request and the rules in
 * force to a list of findings: no database, no clock, no randomness, so the same inputs always give the same answer
 * and every rule type is unit-testable.
 *
 * How a request is judged:
 *  1. For each of the twenty predefined validations (in catalogue order) the engine takes the rules of that type
 *     that are active, effective on the request's date, in scope (leave type, policy, employee group) and whose
 *     optional condition tree matches the request.
 *  2. Those rules are tried in priority order (lowest number first). A rule's own parameters override the leave
 *     type's settings for its check. The first rule whose check fails produces the finding, with that rule's
 *     severity and message - so put a stricter rule ahead of a looser one.
 *  3. A locked validation with no applicable rule still runs with its built-in block, so a request can never skip
 *     the checks that protect its integrity.
 */

export type BalanceFacts = { unit: LeaveBalanceUnit; entitled: number; used: number; reserved: number; available: number; year: number };

export type ValidationFacts = {
  /** The request's start date; rules are in force on this date. */
  requestStartDate: string;
  leaveType: { code: string; name: string; maxConsecutiveDays: number | null; documentRequired: boolean; documentRequiredAfterDays: number; tracksBalance: boolean };
  isTimed: boolean;
  balanceUnit: LeaveBalanceUnit;
  settings: LeaveDurationSettingsView | null;
  /** Human-readable reasons the request form itself is not acceptable for this leave type (reversed dates, half day over several days, ...). */
  structuralErrors: string[];
  calc: { errors: string[]; startOffset: number | null; endOffset: number | null; grossMinutes: number } | null;
  request: {
    startDate: string;
    endDate: string;
    startTime: string | null;
    endTime: string | null;
    durationMinutes: number | null;
    requestedUnits: number;
    daysRequested: number;
    daysEquivalent: number;
    reasonLength: number;
    hasAttachment: boolean;
    dayOfWeek: number;
  };
  balance: BalanceFacts | "unavailable" | null;
  policy: { required: boolean; assigned: boolean; entitlementMissing: boolean; policyId: string | null };
  /** Reasons the leave type is not available to this employee (empty = available). */
  eligibility: string[];
  overlapCount: number;
  schedule: {
    hasSchedule: boolean;
    chargeableDays: number;
    restDates: string[];
    holidays: Array<{ date: string; name: string }>;
    shiftWindow: string | null;
    /** null = not applicable (no schedule / not a timed request). */
    withinShift: boolean | null;
  };
  notice: { minutesUntilStart: number | null; startInPast: boolean; daysBack: number };
  limits: { dayUsedMinutes: number; monthUsedMinutes: number; periodCounts: Record<"day" | "week" | "month" | "year", number> };
  employee: { employmentType: string | null; groupIds: string[]; policyId: string | null };
  attendanceConflict: boolean;
  workflow: { resolvable: boolean; detail: string | null };
};

type Hit = { field: string | null; vars: Record<string, string | number>; };

/** The values a rule's condition tree can look at. */
export function conditionValues(f: ValidationFacts): Record<LeaveConditionField, string | number | boolean | null> {
  const balance = f.balance && f.balance !== "unavailable" ? f.balance.available : null;
  return {
    durationMinutes: f.request.durationMinutes,
    requestedUnits: f.request.requestedUnits,
    daysRequested: f.request.daysRequested,
    balanceAvailable: balance,
    noticeMinutes: f.notice.minutesUntilStart,
    startMinute: f.calc?.startOffset ?? (f.request.startTime ? parseClock(f.request.startTime) : null),
    endMinute: f.calc?.endOffset ?? (f.request.endTime ? parseClock(f.request.endTime) : null),
    dayOfWeek: f.request.dayOfWeek,
    leaveType: f.leaveType.code,
    employmentType: f.employee.employmentType,
    isTimed: f.isTimed,
    reasonLength: f.request.reasonLength,
    hasAttachment: f.request.hasAttachment,
  };
}

function leafMatches(leaf: LeaveRuleCondition, values: Record<string, string | number | boolean | null>): boolean {
  const actual = values[leaf.field];
  if (actual === null || actual === undefined) return false;
  const v = leaf.value;
  switch (leaf.operator) {
    case "eq": return actual === v || (typeof actual === "number" && Number(v) === actual) || String(actual) === String(v);
    case "neq": return !(actual === v || String(actual) === String(v));
    case "gt": return Number(actual) > Number(v);
    case "gte": return Number(actual) >= Number(v);
    case "lt": return Number(actual) < Number(v);
    case "lte": return Number(actual) <= Number(v);
    case "in": return Array.isArray(v) && v.map(String).includes(String(actual));
    case "not_in": return Array.isArray(v) && !v.map(String).includes(String(actual));
    case "between": return Array.isArray(v) && v.length === 2 && Number(actual) >= Number(v[0]) && Number(actual) <= Number(v[1]);
    default: return false;
  }
}

export function conditionsMatch(group: LeaveRuleConditionGroup | null | undefined, values: Record<string, string | number | boolean | null>): boolean {
  if (!group || group.children.length === 0) return true;
  const results = group.children.map((child) => ("children" in child ? conditionsMatch(child, values) : leafMatches(child, values)));
  return group.op === "and" ? results.every(Boolean) : results.some(Boolean);
}

type Thresholds = {
  minNoticeMinutes: number | null;
  maxMinutes: number | null;
  minMinutes: number | null;
  dailyLimitMinutes: number | null;
  monthlyLimitMinutes: number | null;
  maxRequests: number | null;
  period: "day" | "week" | "month" | "year" | null;
  backdateDaysAllowed: number | null;
  minReasonLength: number | null;
  allowedEmploymentTypes: string[] | null;
  holidayMode: "no_chargeable_days" | "any_in_range";
  requiredAfterMinutes: number | null;
};

function thresholdsFor(f: ValidationFacts, params: LeaveValidationRuleParams): Thresholds {
  const s = f.settings;
  return {
    minNoticeMinutes: params.minNoticeMinutes ?? s?.minNoticeMinutes ?? null,
    maxMinutes: params.maxMinutes ?? s?.maxDurationMinutes ?? null,
    minMinutes: params.minMinutes ?? s?.minDurationMinutes ?? null,
    dailyLimitMinutes: params.dailyLimitMinutes ?? s?.dailyLimitMinutes ?? null,
    monthlyLimitMinutes: params.monthlyLimitMinutes ?? s?.monthlyLimitMinutes ?? null,
    maxRequests: params.maxRequests ?? s?.frequencyMaxRequests ?? null,
    period: params.period ?? s?.frequencyPeriod ?? null,
    backdateDaysAllowed: params.backdateDaysAllowed ?? s?.backdateDaysAllowed ?? null,
    minReasonLength: params.minReasonLength ?? null,
    allowedEmploymentTypes: params.allowedEmploymentTypes && params.allowedEmploymentTypes.length > 0 ? params.allowedEmploymentTypes : null,
    holidayMode: params.holidayMode ?? "no_chargeable_days",
    requiredAfterMinutes: params.requiredAfterMinutes ?? null,
  };
}

const PERIOD_LABEL = { day: "day", week: "week", month: "month", year: "year" } as const;

function windowLabel(s: LeaveDurationSettingsView | null): string {
  if (!s) return "";
  if (s.selectionMethod === "fixed_window" && s.fixedStartTime && s.fixedEndTime) return `${s.fixedStartTime.slice(0, 5)}-${s.fixedEndTime.slice(0, 5)}`;
  if (s.earliestStartTime && s.latestEndTime) return `${s.earliestStartTime.slice(0, 5)}-${s.latestEndTime.slice(0, 5)}`;
  if (s.earliestStartTime) return `from ${s.earliestStartTime.slice(0, 5)}`;
  if (s.latestEndTime) return `until ${s.latestEndTime.slice(0, 5)}`;
  return "";
}

/** Each check returns a Hit when the request FAILS it, null when it passes. */
const CHECKS: Record<LeaveValidationType, (f: ValidationFacts, t: Thresholds) => Hit | null> = {
  balance_insufficient(f) {
    if (!f.leaveType.tracksBalance || !f.balance || f.balance === "unavailable") return null;
    if (f.request.requestedUnits <= f.balance.available + 1e-9) return null;
    return {
      field: "balance",
      vars: {
        requested: formatUnits(f.request.requestedUnits, f.balance.unit),
        available: formatUnits(Math.max(0, f.balance.available), f.balance.unit),
        year: f.balance.year,
      },
    };
  },

  max_duration_exceeded(f, t) {
    if (f.isTimed) {
      const d = f.request.durationMinutes;
      if (t.maxMinutes === null || d === null || d <= t.maxMinutes) return null;
      return { field: "endTime", vars: { max: formatMinutes(t.maxMinutes), requested: formatMinutes(d) } };
    }
    const max = f.leaveType.maxConsecutiveDays;
    if (max === null || f.request.daysRequested <= max) return null;
    return { field: "endDate", vars: { max: formatUnits(max, "days"), requested: formatUnits(f.request.daysRequested, "days") } };
  },

  min_duration_not_met(f, t) {
    if (!f.isTimed) return null;
    const d = f.request.durationMinutes;
    if (t.minMinutes === null || d === null || d >= t.minMinutes) return null;
    return { field: "endTime", vars: { min: formatMinutes(t.minMinutes), requested: formatMinutes(d) } };
  },

  invalid_time_range(f) {
    if (f.structuralErrors.length > 0) return { field: f.isTimed ? "startTime" : "endDate", vars: { detail: f.structuralErrors[0] } };
    if (!f.isTimed) return null;
    const inc = f.settings?.incrementMinutes ?? null;
    const calc = f.calc;
    if (!calc) return { field: "startTime", vars: { detail: "Enter a start time and an end time." } };
    const incrementVars: Record<string, string | number> = inc === null ? {} : { increment: formatMinutes(inc) };
    if (calc.errors.includes("invalid_time_format")) return { field: "startTime", vars: { detail: "Enter the start and end time as HH:MM." } };
    if (calc.errors.includes("end_not_after_start")) return { field: "endTime", vars: { detail: "The end time must be after the start time." } };
    if (calc.errors.includes("time_does_not_exist")) return { field: "startTime", vars: { detail: "That clock time does not exist on this date (the clocks change). Pick another time." } };
    if (calc.errors.includes("no_minutes_left")) return { field: "endTime", vars: { detail: "The selected time is entirely within a break, so no leave time is left to charge." } };
    if (inc !== null && calc.startOffset !== null && calc.endOffset !== null && (calc.startOffset % inc !== 0 || calc.endOffset % inc !== 0)) {
      return { field: "startTime", vars: { detail: `Start and end times must be on ${formatMinutes(inc)} steps.`, ...incrementVars } };
    }
    return null;
  },

  outside_permitted_hours(f) {
    const s = f.settings;
    if (!s || !f.isTimed) return null;
    const start = f.calc?.startOffset ?? null;
    const end = f.calc?.endOffset ?? null;
    const window = windowLabel(s);
    const vars = { window, startTime: f.request.startTime ?? "", endTime: f.request.endTime ?? "", detail: "" };
    if (s.sameDayPolicy === "same_day_only" && f.notice.daysBack !== 0) {
      return { field: "startDate", vars: { ...vars, detail: "This leave can only be requested for today." } };
    }
    if (start === null || end === null) return null;
    if (s.selectionMethod === "fixed_window") {
      const fs = parseClock(s.fixedStartTime);
      const fe = parseClock(s.fixedEndTime);
      if (fs === null || fe === null) return null;
      return start === fs && end === fe ? null : { field: "startTime", vars };
    }
    const earliest = parseClock(s.earliestStartTime);
    let latest = parseClock(s.latestEndTime);
    if (earliest !== null && latest !== null && latest <= earliest && s.allowOvernight) latest += 1440;
    if (earliest !== null && start < earliest) return { field: "startTime", vars };
    if (latest !== null && end > latest) return { field: "endTime", vars };
    return null;
  },

  overlaps_existing_request(f) {
    return f.overlapCount > 0 ? { field: "startDate", vars: {} } : null;
  },

  non_working_day(f) {
    if (f.schedule.chargeableDays > 0 || f.schedule.restDates.length === 0) return null;
    return { field: "startDate", vars: { date: f.schedule.restDates[0] } };
  },

  public_holiday_conflict(f, t) {
    if (f.schedule.holidays.length === 0) return null;
    if (t.holidayMode === "no_chargeable_days" && f.schedule.chargeableDays > 0) return null;
    const first = f.schedule.holidays[0];
    return { field: "startDate", vars: { holiday: first.name, date: first.date } };
  },

  insufficient_notice(f, t) {
    const s = f.settings;
    const lead = f.notice.minutesUntilStart;
    if (s?.sameDayPolicy === "future_only" && f.notice.daysBack === 0 && f.isTimed) {
      return { field: "startDate", vars: { notice: "a day", leadTime: lead === null ? "" : formatMinutes(Math.max(0, lead)) } };
    }
    if (t.minNoticeMinutes === null || lead === null || lead >= t.minNoticeMinutes) return null;
    return { field: f.isTimed ? "startTime" : "startDate", vars: { notice: formatMinutes(t.minNoticeMinutes), leadTime: formatMinutes(Math.max(0, lead)) } };
  },

  backdated_not_allowed(f, t) {
    if (t.backdateDaysAllowed === null) return null;
    const past = f.notice.daysBack > t.backdateDaysAllowed || (t.backdateDaysAllowed === 0 && f.isTimed && f.notice.startInPast);
    return past ? { field: "startDate", vars: { backdateDays: t.backdateDaysAllowed, daysBack: Math.max(0, f.notice.daysBack) } } : null;
  },

  attachment_required(f, t) {
    if (!f.leaveType.documentRequired || f.request.hasAttachment) return null;
    const needed = f.isTimed && t.requiredAfterMinutes !== null
      ? (f.request.durationMinutes ?? 0) > t.requiredAfterMinutes
      : f.request.daysEquivalent > f.leaveType.documentRequiredAfterDays;
    return needed ? { field: "attachment", vars: {} } : null;
  },

  reason_required(f, t) {
    if (t.minReasonLength === null) return null;
    return f.request.reasonLength < Math.max(1, t.minReasonLength) ? { field: "reason", vars: { minLength: Math.max(1, t.minReasonLength) } } : null;
  },

  leave_type_unavailable(f) {
    return f.eligibility.length > 0 ? { field: "leaveType", vars: { detail: f.eligibility[0] } } : null;
  },

  policy_not_assigned(f) {
    if (!f.policy.required) return null;
    return !f.policy.assigned || f.policy.entitlementMissing ? { field: "leaveType", vars: {} } : null;
  },

  limit_exceeded(f, t) {
    if (!f.isTimed || f.request.durationMinutes === null) return null;
    const d = f.request.durationMinutes;
    if (t.dailyLimitMinutes !== null && f.limits.dayUsedMinutes + d > t.dailyLimitMinutes) {
      return { field: "endTime", vars: { limit: formatMinutes(t.dailyLimitMinutes), period: "day", used: formatMinutes(f.limits.dayUsedMinutes), requested: formatMinutes(d) } };
    }
    if (t.monthlyLimitMinutes !== null && f.limits.monthUsedMinutes + d > t.monthlyLimitMinutes) {
      return { field: "endTime", vars: { limit: formatMinutes(t.monthlyLimitMinutes), period: "month", used: formatMinutes(f.limits.monthUsedMinutes), requested: formatMinutes(d) } };
    }
    return null;
  },

  frequency_reached(f, t) {
    if (t.maxRequests === null || t.period === null) return null;
    const count = f.limits.periodCounts[t.period];
    return count >= t.maxRequests ? { field: "startDate", vars: { maxRequests: t.maxRequests, period: PERIOD_LABEL[t.period], count } } : null;
  },

  ineligible_employment_category(f, t) {
    if (!t.allowedEmploymentTypes) return null;
    const type = f.employee.employmentType ?? "";
    return t.allowedEmploymentTypes.includes(type) ? null : { field: "leaveType", vars: { employmentType: type } };
  },

  workflow_unresolved(f) {
    return f.workflow.resolvable ? null : { field: null, vars: { detail: f.workflow.detail ?? "" } };
  },

  balance_unavailable(f) {
    return f.balance === "unavailable" ? { field: "balance", vars: {} } : null;
  },

  attendance_or_shift_conflict(f) {
    if (!f.isTimed) return null;
    if (f.settings?.validateAgainstSchedule !== false && f.schedule.withinShift === false) {
      const w = f.schedule.shiftWindow ?? "";
      return { field: "startTime", vars: { detail: `The selected time is outside your assigned shift${w ? ` (${w})` : ""}.`, shiftWindow: w } };
    }
    if (f.attendanceConflict) {
      return { field: "startTime", vars: { detail: "Attendance is already recorded during the selected time.", shiftWindow: f.schedule.shiftWindow ?? "" } };
    }
    return null;
  },
};

export function ruleInScope(rule: LeaveValidationRuleView, f: ValidationFacts, values: Record<string, string | number | boolean | null>): boolean {
  if (!rule.isActive) return false;
  if (rule.effectiveFrom && f.requestStartDate < rule.effectiveFrom) return false;
  if (rule.effectiveTo && f.requestStartDate > rule.effectiveTo) return false;
  if (rule.leaveTypes.length > 0 && !rule.leaveTypes.includes(f.leaveType.code)) return false;
  if (rule.policyIds.length > 0 && (!f.employee.policyId || !rule.policyIds.includes(f.employee.policyId))) return false;
  if (rule.employeeGroupIds.length > 0 && !rule.employeeGroupIds.some((g) => f.employee.groupIds.includes(g))) return false;
  return conditionsMatch(rule.conditions, values);
}

/** `{{name}}` placeholders, filled from the check's variables plus the common ones. */
export function renderMessage(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => (vars[name] !== undefined ? String(vars[name]) : ""));
}

function pickMessage(rule: Pick<LeaveValidationRuleView, "message" | "messages">, locale: string | undefined): string {
  if (locale) {
    const exact = rule.messages[locale];
    if (exact) return exact;
    const base = rule.messages[locale.split("-")[0]];
    if (base) return base;
  }
  return rule.message;
}

function syntheticRule(type: LeaveValidationType): LeaveValidationRuleView {
  const info = catalogInfo(type);
  return {
    id: "", code: type, name: info.label, description: info.description, validationType: type, leaveTypes: [], policyIds: [], employeeGroupIds: [],
    severity: "block", message: info.defaultMessage, messages: {}, adminExplanation: null, priority: 1000, effectiveFrom: null, effectiveTo: null,
    isActive: true, allowProceed: false, conditions: null, params: {}, isSystem: true, isLocked: true, version: 0, updatedAt: "",
  };
}

export function evaluateValidation(
  facts: ValidationFacts,
  rules: LeaveValidationRuleView[],
  options: { locale?: string; acknowledgedWarnings?: string[] } = {}
): Pick<LeaveValidationResult, "canSubmit" | "blocking" | "warnings" | "info" | "acknowledged"> {
  const values = conditionValues(facts);
  const findings: Array<{ finding: LeaveValidationFinding; number: number }> = [];
  const common: Record<string, string | number> = {
    leaveType: facts.leaveType.name,
    window: windowLabel(facts.settings),
  };

  for (const info of VALIDATION_CATALOG) {
    let candidates = rules
      .filter((r) => r.validationType === info.type && ruleInScope(r, facts, values))
      .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
    if (candidates.length === 0 && LOCKED_VALIDATION_TYPES.has(info.type)) candidates = [syntheticRule(info.type)];
    for (const rule of candidates) {
      // A locked validation always blocks, whatever a stored rule says.
      const severity: LeaveValidationSeverity = LOCKED_VALIDATION_TYPES.has(info.type) ? "block" : rule.severity;
      const hit = CHECKS[info.type](facts, thresholdsFor(facts, rule.params));
      if (!hit) continue;
      findings.push({
        number: info.number,
        finding: {
          code: info.type,
          ruleCode: rule.code,
          ruleName: rule.name,
          severity,
          message: renderMessage(pickMessage(rule, options.locale), { ...common, ...hit.vars }),
          adminExplanation: rule.adminExplanation,
          field: hit.field,
          allowProceed: severity === "warning" ? rule.allowProceed : severity === "info",
        },
      });
      break; // first firing rule by priority decides this validation
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || displayRank(a.finding.code) - displayRank(b.finding.code));
  const all = findings.map((x) => x.finding);
  const acknowledgedInput = new Set(options.acknowledgedWarnings ?? []);
  const blocking = all.filter((x) => x.severity === "block" || (x.severity === "warning" && !x.allowProceed));
  const warnings = all.filter((x) => x.severity === "warning" && x.allowProceed);
  const info = all.filter((x) => x.severity === "info");
  const acknowledged = warnings.filter((w) => acknowledgedInput.has(w.ruleCode)).map((w) => w.ruleCode);
  const canSubmit = blocking.length === 0 && warnings.every((w) => acknowledged.includes(w.ruleCode));
  return { canSubmit, blocking, warnings, info, acknowledged };
}

/** Checks a condition tree is made only of known fields / operators and stays small. Returns the error or null. */
export function validateConditionTree(tree: LeaveRuleConditionGroup | null | undefined): string | null {
  if (!tree) return null;
  const FIELDS = new Set<string>([
    "durationMinutes", "requestedUnits", "daysRequested", "balanceAvailable", "noticeMinutes", "startMinute", "endMinute",
    "dayOfWeek", "leaveType", "employmentType", "isTimed", "reasonLength", "hasAttachment",
  ]);
  const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "between"]);
  let leaves = 0;
  const walk = (node: LeaveRuleCondition | LeaveRuleConditionGroup, depth: number): string | null => {
    if (depth > 3) return "Conditions can be nested at most three groups deep";
    if ("children" in node) {
      if (node.op !== "and" && node.op !== "or") return "A condition group must be AND or OR";
      if (!Array.isArray(node.children)) return "A condition group needs a list of conditions";
      for (const child of node.children) {
        const err = walk(child, depth + 1);
        if (err) return err;
      }
      return null;
    }
    leaves += 1;
    if (leaves > 20) return "A rule can have at most 20 conditions";
    if (!FIELDS.has(node.field)) return `Unknown condition field "${String(node.field)}"`;
    if (!OPS.has(node.operator)) return `Unknown condition operator "${String(node.operator)}"`;
    if ((node.operator === "in" || node.operator === "not_in") && !Array.isArray(node.value)) return `"${node.field}" needs a list of values`;
    if (node.operator === "between" && !(Array.isArray(node.value) && node.value.length === 2)) return `"${node.field}" needs exactly two values for between`;
    return null;
  };
  return walk(tree, 0);
}

export { formatClock };
