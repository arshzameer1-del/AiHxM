import type { LeaveDurationSettingsView, LeaveValidationRuleView, LeaveValidationType } from "@aihxm/shared-types";
import { VALIDATION_CATALOG } from "./leave-validation.catalog";
import { conditionsMatch, evaluateValidation, renderMessage, validateConditionTree, type ValidationFacts } from "./leave-validation.engine";
import { emptySettings } from "./leave-duration-settings.service";

/** The tenant's built-in rules, as the service creates them. */
function systemRules(): LeaveValidationRuleView[] {
  return VALIDATION_CATALOG.map((c) => ({
    id: `sys-${c.type}`, code: c.type, name: c.label, description: c.description, validationType: c.type, leaveTypes: [], policyIds: [], employeeGroupIds: [],
    severity: "block", message: c.defaultMessage, messages: {}, adminExplanation: null, priority: 1000, effectiveFrom: null, effectiveTo: null,
    isActive: c.type !== "reason_required" && c.type !== "ineligible_employment_category", allowProceed: false, conditions: null, params: {}, isSystem: true,
    isLocked: c.locked, version: 1, updatedAt: "",
  }));
}

function rule(type: LeaveValidationType, over: Partial<LeaveValidationRuleView> = {}): LeaveValidationRuleView {
  const base = systemRules().find((r) => r.validationType === type)!;
  return { ...base, id: `r-${over.code ?? type}`, code: over.code ?? `custom_${type}`, isSystem: false, priority: 100, isActive: true, ...over };
}

const settings = (over: Partial<LeaveDurationSettingsView> = {}): LeaveDurationSettingsView => ({
  ...emptySettings("short_leave"), earliestStartTime: "09:00", latestEndTime: "17:00", minDurationMinutes: 30, maxDurationMinutes: 120, incrementMinutes: 30,
  dailyLimitMinutes: 120, ...over,
});

/** A valid one-hour short leave, 10:30-11:30, on an ordinary working day. */
function facts(over: Partial<ValidationFacts> = {}): ValidationFacts {
  return {
    requestStartDate: "2026-10-14",
    leaveType: { code: "short_leave", name: "Short leave", maxConsecutiveDays: null, documentRequired: false, documentRequiredAfterDays: 0, tracksBalance: true },
    isTimed: true,
    balanceUnit: "hours",
    settings: settings(),
    structuralErrors: [],
    calc: { errors: [], startOffset: 630, endOffset: 690, grossMinutes: 60 },
    request: { startDate: "2026-10-14", endDate: "2026-10-14", startTime: "10:30", endTime: "11:30", durationMinutes: 60, requestedUnits: 1, daysRequested: 0.13, daysEquivalent: 0.13, reasonLength: 10, hasAttachment: false, dayOfWeek: 3 },
    balance: { unit: "hours", entitled: 16, used: 2, reserved: 1, available: 13, year: 2026 },
    policy: { required: true, assigned: true, entitlementMissing: false, policyId: "p1" },
    eligibility: [],
    overlapCount: 0,
    schedule: { hasSchedule: true, chargeableDays: 1, restDates: [], holidays: [], shiftWindow: "09:00-17:00", withinShift: true },
    notice: { minutesUntilStart: 1440, startInPast: false, daysBack: -3 },
    limits: { dayUsedMinutes: 0, monthUsedMinutes: 0, periodCounts: { day: 0, week: 0, month: 0, year: 0 } },
    employee: { employmentType: "permanent", groupIds: [], policyId: "p1" },
    attendanceConflict: false,
    workflow: { resolvable: true, detail: null },
    ...over,
  };
}

const run = (f: ValidationFacts, rules = systemRules(), opts = {}) => evaluateValidation(f, rules, opts);
const codes = (r: ReturnType<typeof run>) => [...r.blocking, ...r.warnings, ...r.info].map((x) => x.code);

describe("evaluateValidation - the twenty predefined validations", () => {
  it("accepts a valid one-hour request", () => {
    const r = run(facts());
    expect(r.canSubmit).toBe(true);
    expect(codes(r)).toEqual([]);
  });

  it("1 balance_insufficient", () => {
    const r = run(facts({ request: { ...facts().request, requestedUnits: 14 } }));
    expect(codes(r)).toEqual(["balance_insufficient"]);
    expect(r.blocking[0].message).toBe("Insufficient Short leave balance: requested 14 h, 13 h available for 2026.");
  });

  it("2 max_duration_exceeded and 3 min_duration_not_met, with the boundaries accepted", () => {
    const longer = run(facts({ request: { ...facts().request, durationMinutes: 150 }, calc: { errors: [], startOffset: 600, endOffset: 750, grossMinutes: 150 } }));
    expect(codes(longer)).toContain("max_duration_exceeded");
    expect(longer.blocking.find((b) => b.code === "max_duration_exceeded")!.message).toBe("Short leave cannot exceed 2 h per request.");
    expect(codes(run(facts({ request: { ...facts().request, durationMinutes: 120 } })))).toEqual([]);
    expect(codes(run(facts({ request: { ...facts().request, durationMinutes: 15 } })))).toEqual(["min_duration_not_met"]);
    expect(codes(run(facts({ request: { ...facts().request, durationMinutes: 30 } })))).toEqual([]);
  });

  it("2 max_duration_exceeded for day-based leave uses the consecutive-days limit", () => {
    const f = facts({ isTimed: false, calc: null, leaveType: { ...facts().leaveType, maxConsecutiveDays: 3 }, request: { ...facts().request, daysRequested: 4, durationMinutes: null } });
    expect(codes(run(f))).toEqual(["max_duration_exceeded"]);
  });

  it("4 invalid_time_range: reversed, malformed, non-existent and off-increment times", () => {
    expect(codes(run(facts({ calc: { errors: ["end_not_after_start"], startOffset: 690, endOffset: 630, grossMinutes: 0 } })))).toContain("invalid_time_range");
    expect(codes(run(facts({ calc: { errors: ["invalid_time_format"], startOffset: null, endOffset: null, grossMinutes: 0 } })))).toContain("invalid_time_range");
    expect(codes(run(facts({ calc: { errors: ["time_does_not_exist"], startOffset: 150, endOffset: 210, grossMinutes: 0 } })))).toContain("invalid_time_range");
    const offGrid = run(facts({ calc: { errors: [], startOffset: 635, endOffset: 695, grossMinutes: 60 } }));
    expect(offGrid.blocking[0].code).toBe("invalid_time_range");
    expect(offGrid.blocking[0].message).toContain("30 min steps");
    expect(codes(run(facts({ structuralErrors: ["Short leave cannot be requested by the hour."] })))).toContain("invalid_time_range");
  });

  it("5 outside_permitted_hours: window, fixed window and same-day-only", () => {
    expect(codes(run(facts({ calc: { errors: [], startOffset: 480, endOffset: 540, grossMinutes: 60 } })))).toEqual(["outside_permitted_hours"]);
    expect(codes(run(facts({ calc: { errors: [], startOffset: 1020, endOffset: 1080, grossMinutes: 60 } })))).toEqual(["outside_permitted_hours"]);
    const windowMsg = run(facts({ calc: { errors: [], startOffset: 480, endOffset: 540, grossMinutes: 60 } })).blocking[0].message;
    expect(windowMsg).toBe("Select a time within your permitted Short leave window (09:00-17:00).");
    const fixed = settings({ selectionMethod: "fixed_window", fixedStartTime: "10:00", fixedEndTime: "11:00" });
    expect(codes(run(facts({ settings: fixed })))).toEqual(["outside_permitted_hours"]);
    expect(codes(run(facts({ settings: fixed, calc: { errors: [], startOffset: 600, endOffset: 660, grossMinutes: 60 } })))).toEqual([]);
    expect(codes(run(facts({ settings: settings({ sameDayPolicy: "same_day_only" }) })))).toEqual(["outside_permitted_hours"]);
  });

  it("6 overlaps_existing_request", () => {
    expect(codes(run(facts({ overlapCount: 1 })))).toEqual(["overlaps_existing_request"]);
  });

  it("7 non_working_day and 8 public_holiday_conflict", () => {
    const rest = run(facts({ schedule: { ...facts().schedule, chargeableDays: 0, restDates: ["2026-10-14"], withinShift: null } }));
    expect(codes(rest)).toEqual(["non_working_day"]);
    const holiday = run(facts({ schedule: { ...facts().schedule, chargeableDays: 0, holidays: [{ date: "2026-10-14", name: "Iqbal Day" }], withinShift: null } }));
    expect(codes(holiday)).toEqual(["public_holiday_conflict"]);
    expect(holiday.blocking[0].message).toContain("Iqbal Day");
    // a holiday inside a longer range only matters when a rule asks for it
    const inRange = facts({ isTimed: false, calc: null, schedule: { ...facts().schedule, chargeableDays: 2, holidays: [{ date: "2026-10-15", name: "Iqbal Day" }] } });
    expect(codes(run(inRange))).toEqual([]);
    const strict = run(inRange, [...systemRules(), rule("public_holiday_conflict", { params: { holidayMode: "any_in_range" }, severity: "warning", allowProceed: true, priority: 10 })]);
    expect(strict.warnings.map((w) => w.code)).toEqual(["public_holiday_conflict"]);
  });

  it("9 insufficient_notice: warning or block per rule, tiers by priority", () => {
    const f = facts({ notice: { minutesUntilStart: 30, startInPast: false, daysBack: 0 } });
    expect(codes(run(f))).toEqual([]); // nothing configured, nothing enforced
    const tiers = [
      rule("insufficient_notice", { code: "notice_block", params: { minNoticeMinutes: 60 }, priority: 10 }),
      rule("insufficient_notice", { code: "notice_warn", params: { minNoticeMinutes: 1440 }, severity: "warning", allowProceed: true, priority: 20 }),
    ];
    const strict = run(f, [...systemRules(), ...tiers]);
    expect(strict.blocking.map((b) => b.ruleCode)).toEqual(["notice_block"]);
    const mid = run(facts({ notice: { minutesUntilStart: 600, startInPast: false, daysBack: 0 } }), [...systemRules(), ...tiers]);
    expect(mid.warnings.map((w) => w.ruleCode)).toEqual(["notice_warn"]);
    expect(mid.canSubmit).toBe(false);
    expect(run(facts({ notice: { minutesUntilStart: 600, startInPast: false, daysBack: 0 } }), [...systemRules(), ...tiers], { acknowledgedWarnings: ["notice_warn"] }).canSubmit).toBe(true);
  });

  it("10 backdated_not_allowed", () => {
    const past = facts({ notice: { minutesUntilStart: -3000, startInPast: true, daysBack: 2 }, settings: settings({ backdateDaysAllowed: 0 }) });
    expect(codes(run(past))).toEqual(["backdated_not_allowed"]);
    expect(codes(run(facts({ notice: { minutesUntilStart: -3000, startInPast: true, daysBack: 2 }, settings: settings({ backdateDaysAllowed: 3 }) })))).toEqual([]);
    expect(codes(run(facts({ notice: { minutesUntilStart: -30, startInPast: true, daysBack: 0 }, settings: settings({ backdateDaysAllowed: 0 }) })))).toEqual(["backdated_not_allowed"]);
  });

  it("11 attachment_required", () => {
    const needs = facts({ leaveType: { ...facts().leaveType, documentRequired: true } });
    expect(codes(run(needs))).toEqual(["attachment_required"]);
    expect(run(needs).blocking[0].message).toBe("Please attach the required supporting document before submitting.");
    expect(codes(run(facts({ leaveType: { ...facts().leaveType, documentRequired: true }, request: { ...facts().request, hasAttachment: true } })))).toEqual([]);
  });

  it("12 reason_required is off until a rule is switched on", () => {
    const noReason = facts({ request: { ...facts().request, reasonLength: 0 } });
    expect(codes(run(noReason))).toEqual([]);
    const on = systemRules().map((r) => (r.validationType === "reason_required" ? { ...r, isActive: true, params: { minReasonLength: 1 } } : r));
    expect(codes(run(noReason, on))).toEqual(["reason_required"]);
  });

  it("13 leave_type_unavailable and 14 policy_not_assigned come first", () => {
    const r = run(facts({ eligibility: ["Hajj leave is only available to female employees"], request: { ...facts().request, requestedUnits: 99 } }));
    expect(r.blocking[0].code).toBe("leave_type_unavailable");
    expect(codes(run(facts({ policy: { required: true, assigned: false, entitlementMissing: false, policyId: null } })))).toEqual(["policy_not_assigned"]);
  });

  it("15 limit_exceeded (daily and monthly)", () => {
    const daily = run(facts({ limits: { dayUsedMinutes: 90, monthUsedMinutes: 90, periodCounts: { day: 1, week: 1, month: 1, year: 1 } } }));
    expect(codes(daily)).toEqual(["limit_exceeded"]);
    expect(daily.blocking[0].message).toBe("Short leave is limited to 2 h per day; 1 h 30 min is already booked.");
    const monthly = run(facts({ settings: settings({ dailyLimitMinutes: null, monthlyLimitMinutes: 240 }), limits: { dayUsedMinutes: 0, monthUsedMinutes: 200, periodCounts: { day: 0, week: 0, month: 2, year: 2 } } }));
    expect(codes(monthly)).toEqual(["limit_exceeded"]);
  });

  it("16 frequency_reached", () => {
    const s = settings({ frequencyMaxRequests: 2, frequencyPeriod: "week" });
    expect(codes(run(facts({ settings: s, limits: { dayUsedMinutes: 0, monthUsedMinutes: 0, periodCounts: { day: 0, week: 2, month: 2, year: 2 } } })))).toEqual(["frequency_reached"]);
    expect(codes(run(facts({ settings: s, limits: { dayUsedMinutes: 0, monthUsedMinutes: 0, periodCounts: { day: 0, week: 1, month: 5, year: 9 } } })))).toEqual([]);
  });

  it("17 ineligible_employment_category", () => {
    const rules = [...systemRules(), rule("ineligible_employment_category", { params: { allowedEmploymentTypes: ["permanent"] } })];
    expect(codes(run(facts({ employee: { ...facts().employee, employmentType: "contract" } }), rules))).toEqual(["ineligible_employment_category"]);
    expect(codes(run(facts(), rules))).toEqual([]);
  });

  it("18 workflow_unresolved, 19 balance_unavailable and 20 attendance_or_shift_conflict", () => {
    expect(codes(run(facts({ workflow: { resolvable: false, detail: "Nobody could be found" } })))).toEqual(["workflow_unresolved"]);
    expect(codes(run(facts({ balance: "unavailable" })))).toEqual(["balance_unavailable"]);
    const off = run(facts({ schedule: { ...facts().schedule, withinShift: false } }));
    expect(codes(off)).toEqual(["attendance_or_shift_conflict"]);
    expect(off.blocking[0].message).toBe("The selected time is outside your assigned shift (09:00-17:00).");
    expect(codes(run(facts({ settings: settings({ validateAgainstSchedule: false }), schedule: { ...facts().schedule, withinShift: false } })))).toEqual([]);
    expect(codes(run(facts({ attendanceConflict: true })))).toEqual(["attendance_or_shift_conflict"]);
  });
});

describe("evaluateValidation - configuration", () => {
  it("a locked validation always blocks, whatever a rule says, and cannot be switched off", () => {
    const f = facts({ overlapCount: 1 });
    const rules = [...systemRules().filter((r) => r.validationType !== "overlaps_existing_request"), rule("overlaps_existing_request", { severity: "info", isActive: false })];
    const r = run(f, rules);
    expect(r.blocking.map((b) => b.code)).toEqual(["overlaps_existing_request"]);
  });

  it("an unlocked validation can be lowered to a warning, an info, or switched off", () => {
    const f = facts({ settings: settings({ dailyLimitMinutes: null }), request: { ...facts().request, durationMinutes: 150 } });
    const warn = run(f, [...systemRules(), rule("max_duration_exceeded", { severity: "warning", allowProceed: true, priority: 1 })]);
    expect(warn.blocking).toEqual([]);
    expect(warn.warnings.map((w) => w.code)).toEqual(["max_duration_exceeded"]);
    const info = run(f, [...systemRules(), rule("max_duration_exceeded", { severity: "info", priority: 1 })]);
    expect(info.canSubmit).toBe(true);
    expect(info.info).toHaveLength(1);
    const off = run(f, systemRules().map((r) => (r.validationType === "max_duration_exceeded" ? { ...r, isActive: false } : r)));
    expect(codes(off)).toEqual([]);
  });

  it("a warning that does not allow proceeding blocks even when confirmed", () => {
    const f = facts({ settings: settings({ dailyLimitMinutes: null }), request: { ...facts().request, durationMinutes: 150 } });
    const r = run(f, [...systemRules(), rule("max_duration_exceeded", { code: "strict_warn", severity: "warning", allowProceed: false, priority: 1 })], { acknowledgedWarnings: ["strict_warn"] });
    expect(r.canSubmit).toBe(false);
    expect(r.blocking.map((b) => b.ruleCode)).toEqual(["strict_warn"]);
  });

  it("rules respect scope: leave type, policy, employee group and effective dates", () => {
    const f = facts({ request: { ...facts().request, durationMinutes: 150 } });
    const scoped = (over: Partial<LeaveValidationRuleView>) => run(f, [...systemRules(), rule("max_duration_exceeded", { code: "scoped", severity: "warning", allowProceed: true, priority: 1, ...over })]);
    expect(scoped({ leaveTypes: ["annual"] }).warnings).toHaveLength(0);
    expect(scoped({ leaveTypes: ["short_leave"] }).warnings).toHaveLength(1);
    expect(scoped({ policyIds: ["other"] }).warnings).toHaveLength(0);
    expect(scoped({ policyIds: ["p1"] }).warnings).toHaveLength(1);
    expect(scoped({ employeeGroupIds: ["g1"] }).warnings).toHaveLength(0);
    expect(run({ ...f, employee: { ...f.employee, groupIds: ["g1"] } }, [...systemRules(), rule("max_duration_exceeded", { code: "scoped", severity: "warning", allowProceed: true, priority: 1, employeeGroupIds: ["g1"] })]).warnings).toHaveLength(1);
    expect(scoped({ effectiveFrom: "2026-11-01" }).warnings).toHaveLength(0);
    expect(scoped({ effectiveTo: "2026-10-01" }).warnings).toHaveLength(0);
    expect(scoped({ effectiveFrom: "2026-10-01", effectiveTo: "2026-10-31" }).warnings).toHaveLength(1);
  });

  it("rule parameters override the leave type's settings", () => {
    const f = facts({ request: { ...facts().request, durationMinutes: 100 } });
    const r = run(f, [...systemRules(), rule("max_duration_exceeded", { params: { maxMinutes: 90 }, priority: 1 })]);
    expect(codes(r)).toEqual(["max_duration_exceeded"]);
    expect(r.blocking[0].message).toContain("1 h 30 min");
  });

  it("conditions gate a rule with AND / OR groups", () => {
    const f = facts({ request: { ...facts().request, durationMinutes: 150 } });
    const gated = (conditions: Parameters<typeof conditionsMatch>[0]) =>
      run(f, [...systemRules(), rule("max_duration_exceeded", { code: "gated", severity: "warning", allowProceed: true, priority: 1, conditions })]).warnings.length;
    expect(gated({ op: "and", children: [{ field: "durationMinutes", operator: "gt", value: 120 }, { field: "dayOfWeek", operator: "eq", value: 3 }] })).toBe(1);
    expect(gated({ op: "and", children: [{ field: "durationMinutes", operator: "gt", value: 120 }, { field: "dayOfWeek", operator: "eq", value: 1 }] })).toBe(0);
    expect(gated({ op: "or", children: [{ field: "dayOfWeek", operator: "eq", value: 1 }, { field: "leaveType", operator: "in", value: ["short_leave", "casual"] }] })).toBe(1);
    expect(gated({ op: "and", children: [{ field: "durationMinutes", operator: "between", value: [100, 200] }, { op: "or", children: [{ field: "isTimed", operator: "eq", value: true }] }] })).toBe(1);
  });

  it("messages are localised and fall back to the default; placeholders are filled", () => {
    const f = facts({ request: { ...facts().request, durationMinutes: 150 } });
    const rules = [...systemRules(), rule("max_duration_exceeded", { message: "Max is {{max}}", messages: { ur: "زیادہ سے زیادہ {{max}}" }, priority: 1 })];
    expect(run(f, rules, { locale: "ur" }).blocking[0].message).toBe("زیادہ سے زیادہ 2 h");
    expect(run(f, rules, { locale: "ur-PK" }).blocking[0].message).toBe("زیادہ سے زیادہ 2 h");
    expect(run(f, rules, { locale: "fr" }).blocking[0].message).toBe("Max is 2 h");
    expect(renderMessage("a {{x}} b {{ y }} c {{z}}", { x: 1, y: "two" })).toBe("a 1 b two c ");
  });

  it("is deterministic: the same facts and rules always give the same answer", () => {
    const f = facts({ overlapCount: 1, request: { ...facts().request, durationMinutes: 150 } });
    const rules = [...systemRules(), rule("max_duration_exceeded", { code: "b", priority: 5 }), rule("max_duration_exceeded", { code: "a", priority: 5 })];
    const first = JSON.stringify(run(f, rules));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(run(f, [...rules].reverse()))).toBe(first);
  });

  it("validates condition trees: known fields and operators only, bounded size", () => {
    expect(validateConditionTree({ op: "and", children: [{ field: "durationMinutes", operator: "gt", value: 60 }] })).toBeNull();
    expect(validateConditionTree({ op: "and", children: [{ field: "salary" as never, operator: "gt", value: 1 }] })).toContain("Unknown condition field");
    expect(validateConditionTree({ op: "and", children: [{ field: "durationMinutes", operator: "matches" as never, value: 1 }] })).toContain("Unknown condition operator");
    expect(validateConditionTree({ op: "and", children: [{ field: "leaveType", operator: "in", value: "x" }] })).toContain("list of values");
    expect(validateConditionTree({ op: "and", children: Array.from({ length: 21 }, () => ({ field: "durationMinutes" as const, operator: "gt" as const, value: 1 })) })).toContain("at most 20");
  });
});
