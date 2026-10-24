import type {
  LeaveConditionField,
  LeaveConditionOperator,
  LeaveRuleCondition,
  LeaveRuleConditionGroup,
  LeaveValidationRuleParams,
  LeaveValidationRuleView,
  LeaveValidationSeverity,
  SaveLeaveValidationRuleRequest,
} from "@aihxm/shared-types";

/**
 * BACKLOG58 - pure helpers behind the leave rule builder. The builder never produces code, SQL or an expression: a rule
 * condition is always "<field> <operator> <value>" from the fixed lists below, grouped with AND / OR.
 */

export type FieldKind = "number" | "time" | "text" | "bool" | "weekday";

export const CONDITION_FIELDS: { field: LeaveConditionField; label: string; kind: FieldKind; hint?: string }[] = [
  { field: "durationMinutes", label: "Duration (minutes)", kind: "number", hint: "Minutes of leave requested, breaks not counted." },
  { field: "requestedUnits", label: "Amount charged to the balance", kind: "number", hint: "In the leave type's balance unit (days, hours or minutes)." },
  { field: "daysRequested", label: "Working days requested", kind: "number" },
  { field: "balanceAvailable", label: "Balance available", kind: "number", hint: "In the leave type's balance unit, less requests still waiting." },
  { field: "noticeMinutes", label: "Notice given (minutes)", kind: "number", hint: "How long before the start the request is made." },
  { field: "startMinute", label: "Start time", kind: "time", hint: "Timed requests only." },
  { field: "endMinute", label: "End time", kind: "time", hint: "Timed requests only." },
  { field: "dayOfWeek", label: "Day of the week", kind: "weekday" },
  { field: "leaveType", label: "Leave type code", kind: "text" },
  { field: "employmentType", label: "Employment type", kind: "text" },
  { field: "isTimed", label: "Is a short-hours request", kind: "bool" },
  { field: "reasonLength", label: "Reason length (characters)", kind: "number" },
  { field: "hasAttachment", label: "Has a supporting document", kind: "bool" },
];

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const OPERATOR_LABELS: Record<LeaveConditionOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  not_in: "is none of",
  between: "is between",
};

export function fieldInfo(field: LeaveConditionField) {
  return CONDITION_FIELDS.find((f) => f.field === field) ?? CONDITION_FIELDS[0];
}

export function operatorsFor(kind: FieldKind): LeaveConditionOperator[] {
  switch (kind) {
    case "number":
    case "time":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "between"];
    case "bool":
      return ["eq"];
    case "weekday":
      return ["eq", "neq", "in", "not_in"];
    default:
      return ["eq", "neq", "in", "not_in"];
  }
}

export function isCondition(node: LeaveRuleCondition | LeaveRuleConditionGroup): node is LeaveRuleCondition {
  return !("children" in node);
}

export function emptyGroup(): LeaveRuleConditionGroup {
  return { op: "and", children: [] };
}

export function newCondition(field: LeaveConditionField = "durationMinutes"): LeaveRuleCondition {
  const kind = fieldInfo(field).kind;
  return { field, operator: operatorsFor(kind)[0], value: kind === "bool" ? true : kind === "text" ? "" : 0 };
}

/** "09:30" -> 570; null when it is not a time of day. */
export function clockToMinutes(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function minutesToClock(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Changing the field resets the operator and value to ones that make sense for it. */
export function changeField(c: LeaveRuleCondition, field: LeaveConditionField): LeaveRuleCondition {
  return fieldInfo(field).kind === fieldInfo(c.field).kind && operatorsFor(fieldInfo(field).kind).includes(c.operator) ? { ...c, field } : newCondition(field);
}

/** Changing the operator keeps the value when its shape still fits (a list for in/not_in, a pair for between, a single value otherwise). */
export function changeOperator(c: LeaveRuleCondition, operator: LeaveConditionOperator): LeaveRuleCondition {
  const kind = fieldInfo(c.field).kind;
  const scalarDefault = kind === "bool" ? true : kind === "text" ? "" : 0;
  const first = Array.isArray(c.value) ? (c.value[0] ?? scalarDefault) : c.value;
  if (operator === "in" || operator === "not_in") return { ...c, operator, value: Array.isArray(c.value) ? c.value : first === "" ? [] : [first as string | number] };
  if (operator === "between") return { ...c, operator, value: Array.isArray(c.value) && c.value.length === 2 ? c.value : [first as number, first as number] };
  return { ...c, operator, value: first };
}

function valueText(c: LeaveRuleCondition): string {
  const kind = fieldInfo(c.field).kind;
  const one = (v: string | number | boolean) => {
    if (kind === "time") return minutesToClock(Number(v));
    if (kind === "weekday") return WEEKDAYS[Number(v)] ?? String(v);
    if (kind === "bool") return v ? "yes" : "no";
    return String(v);
  };
  if (Array.isArray(c.value)) return c.operator === "between" ? `${one(c.value[0])} and ${one(c.value[1])}` : c.value.map(one).join(", ") || "(nothing chosen)";
  return one(c.value);
}

/** "Duration (minutes) is more than 120" - the sentence shown for a condition. */
export function describeCondition(c: LeaveRuleCondition): string {
  return `${fieldInfo(c.field).label} ${OPERATOR_LABELS[c.operator]} ${valueText(c)}`;
}

export function describeGroup(g: LeaveRuleConditionGroup | null | undefined): string {
  if (!g || g.children.length === 0) return "Always applies";
  const parts = g.children.map((ch) => (isCondition(ch) ? describeCondition(ch) : `(${describeGroup(ch)})`));
  return parts.join(g.op === "and" ? " AND " : " OR ");
}

export function countConditions(g: LeaveRuleConditionGroup | null | undefined): number {
  if (!g) return 0;
  return g.children.reduce((n, ch) => n + (isCondition(ch) ? 1 : countConditions(ch)), 0);
}

export function groupDepth(g: LeaveRuleConditionGroup): number {
  return 1 + Math.max(0, ...g.children.map((ch) => (isCondition(ch) ? 0 : groupDepth(ch))));
}

/** The same limits the server enforces (at most 20 conditions, three groups deep), plus values that are missing. */
export function conditionProblem(g: LeaveRuleConditionGroup | null | undefined): string | null {
  if (!g) return null;
  if (countConditions(g) > 20) return "A rule can have at most 20 conditions.";
  if (groupDepth(g) > 4) return "Conditions can be nested at most three groups deep.";
  const walk = (grp: LeaveRuleConditionGroup): string | null => {
    for (const ch of grp.children) {
      if (!isCondition(ch)) {
        const inner = walk(ch);
        if (inner) return inner;
        continue;
      }
      const label = fieldInfo(ch.field).label;
      if ((ch.operator === "in" || ch.operator === "not_in") && (!Array.isArray(ch.value) || ch.value.length === 0)) return `Choose at least one value for "${label}".`;
      if (ch.operator === "between" && (!Array.isArray(ch.value) || ch.value.length !== 2)) return `"${label}" needs two values.`;
      if (fieldInfo(ch.field).kind === "text" && !Array.isArray(ch.value) && String(ch.value).trim() === "") return `Enter a value for "${label}".`;
      if (ch.operator === "between" && Array.isArray(ch.value) && Number(ch.value[0]) > Number(ch.value[1])) return `"${label}": the first value must not be larger than the second.`;
    }
    return null;
  };
  return walk(g);
}

/** Immutable update of the node at `path` (indexes into children, from the root). */
export function updateAt(root: LeaveRuleConditionGroup, path: number[], fn: (node: LeaveRuleCondition | LeaveRuleConditionGroup) => LeaveRuleCondition | LeaveRuleConditionGroup | null): LeaveRuleConditionGroup {
  if (path.length === 0) return (fn(root) as LeaveRuleConditionGroup | null) ?? emptyGroup();
  const [head, ...rest] = path;
  const children = root.children.flatMap((ch, i) => {
    if (i !== head) return [ch];
    if (rest.length === 0) {
      const out = fn(ch);
      return out ? [out] : [];
    }
    return [isCondition(ch) ? ch : updateAt(ch, rest, fn)];
  });
  return { ...root, children };
}

export const SEVERITY_LABELS: Record<LeaveValidationSeverity, string> = { block: "Block", warning: "Warning", info: "Info" };

// --- rule parameters and the editable draft -----------------------------------------------------------------------


export type ParamMeta = { key: keyof LeaveValidationRuleParams; label: string; kind: "number" | "period" | "list" | "holiday"; hint?: string };

export const PARAM_META: ParamMeta[] = [
  { key: "minNoticeMinutes", label: "Minimum notice (minutes)", kind: "number", hint: "Empty = use the leave type's timing rules." },
  { key: "maxMinutes", label: "Longest request (minutes)", kind: "number" },
  { key: "minMinutes", label: "Shortest request (minutes)", kind: "number" },
  { key: "dailyLimitMinutes", label: "Daily limit (minutes)", kind: "number" },
  { key: "monthlyLimitMinutes", label: "Monthly limit (minutes)", kind: "number" },
  { key: "maxRequests", label: "Most requests", kind: "number" },
  { key: "period", label: "Per", kind: "period" },
  { key: "minReasonLength", label: "Reason at least (characters)", kind: "number" },
  { key: "allowedEmploymentTypes", label: "Allowed employment types", kind: "list", hint: "Separate with commas, e.g. permanent, contract." },
  { key: "holidayMode", label: "A public holiday counts as a conflict", kind: "holiday" },
  { key: "backdateDaysAllowed", label: "Days in the past allowed", kind: "number" },
  { key: "requiredAfterMinutes", label: "Document needed above (minutes)", kind: "number", hint: "0 = always needed." },
];

export type RuleDraft = {
  id: string | null;
  code: string;
  name: string;
  description: string;
  validationType: string;
  leaveTypes: string[];
  policyIds: string[];
  employeeGroupIds: string[];
  severity: LeaveValidationSeverity;
  message: string;
  messages: Array<{ locale: string; text: string }>;
  adminExplanation: string;
  priority: string;
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
  allowProceed: boolean;
  conditions: LeaveRuleConditionGroup;
  params: Record<string, string>;
  isSystem: boolean;
  isLocked: boolean;
};

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(s) ? s.slice(0, 59) : s ? `rule_${s}`.slice(0, 59) : "";
}

export function draftFromRule(r: LeaveValidationRuleView | null, defaults: { validationType: string; message: string; severity: LeaveValidationSeverity }): RuleDraft {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(r?.params ?? {})) params[k] = Array.isArray(v) ? v.join(", ") : String(v);
  return {
    id: r?.id ?? null,
    code: r?.code ?? "",
    name: r?.name ?? "",
    description: r?.description ?? "",
    validationType: r?.validationType ?? defaults.validationType,
    leaveTypes: r?.leaveTypes ?? [],
    policyIds: r?.policyIds ?? [],
    employeeGroupIds: r?.employeeGroupIds ?? [],
    severity: r?.severity ?? defaults.severity,
    message: r?.message ?? defaults.message,
    messages: Object.entries(r?.messages ?? {}).map(([locale, text]) => ({ locale, text })),
    adminExplanation: r?.adminExplanation ?? "",
    priority: String(r?.priority ?? 100),
    effectiveFrom: r?.effectiveFrom ?? "",
    effectiveTo: r?.effectiveTo ?? "",
    isActive: r?.isActive ?? true,
    allowProceed: r?.allowProceed ?? true,
    conditions: r?.conditions ?? emptyGroup(),
    params,
    isSystem: r?.isSystem ?? false,
    isLocked: r?.isLocked ?? false,
  };
}

/** Only the parameters the chosen validation understands, as numbers / lists; blank ones are left out. */
export function paramsToRequest(values: Record<string, string>, allowed: string[]): LeaveValidationRuleParams {
  const out: Record<string, unknown> = {};
  for (const meta of PARAM_META) {
    if (!allowed.includes(meta.key)) continue;
    const raw = (values[meta.key] ?? "").trim();
    if (raw === "") continue;
    if (meta.kind === "number") out[meta.key] = Number(raw);
    else if (meta.kind === "list") out[meta.key] = raw.split(",").map((x) => x.trim()).filter(Boolean);
    else out[meta.key] = raw;
  }
  return out as LeaveValidationRuleParams;
}

export function ruleProblem(d: RuleDraft, allowedParams: string[]): string | null {
  if (!d.name.trim()) return "Give the rule a name.";
  if (!d.id && !slugify(d.code || d.name)) return "The rule needs a code made of letters and numbers.";
  if (!d.message.trim()) return "Write the message the employee will see.";
  const prio = Number(d.priority);
  if (!Number.isInteger(prio) || prio < 1) return "Priority must be a whole number, 1 or more.";
  if (d.effectiveFrom && d.effectiveTo && d.effectiveFrom > d.effectiveTo) return "The rule cannot end before it starts.";
  for (const m of d.messages) {
    if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(m.locale.trim())) return `"${m.locale}" is not a language code (use e.g. ur or en).`;
    if (!m.text.trim()) return `Write the ${m.locale} translation or remove it.`;
  }
  for (const meta of PARAM_META) {
    if (!allowedParams.includes(meta.key) || meta.kind !== "number") continue;
    const raw = (d.params[meta.key] ?? "").trim();
    if (raw !== "" && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) return `${meta.label} must be a number, zero or more.`;
  }
  return conditionProblem(d.conditions);
}

export function draftToRequest(d: RuleDraft, allowedParams: string[]): SaveLeaveValidationRuleRequest {
  const messages: Record<string, string> = {};
  for (const m of d.messages) messages[m.locale.trim().toLowerCase()] = m.text.trim();
  return {
    ...(d.id ? {} : { code: slugify(d.code || d.name), validationType: d.validationType as SaveLeaveValidationRuleRequest["validationType"] }),
    name: d.name.trim(),
    description: d.description.trim() || null,
    leaveTypes: d.leaveTypes,
    policyIds: d.policyIds,
    employeeGroupIds: d.employeeGroupIds,
    severity: d.isLocked ? "block" : d.severity,
    message: d.message.trim(),
    messages,
    adminExplanation: d.adminExplanation.trim() || null,
    priority: Number(d.priority),
    effectiveFrom: d.effectiveFrom || null,
    effectiveTo: d.effectiveTo || null,
    isActive: d.isLocked ? true : d.isActive,
    allowProceed: d.allowProceed,
    conditions: countConditions(d.conditions) > 0 ? d.conditions : null,
    params: paramsToRequest(d.params, allowedParams),
  };
}

/** "Applies to: Short leave · 2 policies" - a one-line summary of a rule's scope. */
export function scopeSummary(r: { leaveTypes: string[]; policyIds: string[]; employeeGroupIds: string[] }, typeName: (code: string) => string): string {
  const parts: string[] = [];
  if (r.leaveTypes.length) parts.push(r.leaveTypes.length <= 2 ? r.leaveTypes.map(typeName).join(", ") : `${r.leaveTypes.length} leave types`);
  if (r.policyIds.length) parts.push(`${r.policyIds.length} polic${r.policyIds.length === 1 ? "y" : "ies"}`);
  if (r.employeeGroupIds.length) parts.push(`${r.employeeGroupIds.length} group${r.employeeGroupIds.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Everyone";
}
