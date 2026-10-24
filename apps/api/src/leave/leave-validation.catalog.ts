import type { LeaveValidationSeverity, LeaveValidationType, LeaveValidationTypeInfo } from "@aihxm/shared-types";

/**
 * BACKLOG58 - the twenty predefined validations a leave rule can be built from. There is deliberately no way to
 * enter code, SQL or an expression: an administrator picks one of these, a severity, a message and a scope.
 *
 * The seven `locked` ones protect the request itself (a double booking, a start time that does not exist, a missing
 * policy, a balance that cannot be read or would be overspent, an approval route nobody can serve). Their message
 * can be reworded but they always block.
 */
export const VALIDATION_CATALOG: LeaveValidationTypeInfo[] = [
  {
    type: "balance_insufficient", number: 1, label: "Insufficient balance", locked: true, defaultSeverity: "block",
    description: "The request charges more than the employee's available balance (remaining, less what pending requests already hold).",
    defaultMessage: "Insufficient {{leaveType}} balance: requested {{requested}}, {{available}} available for {{year}}.",
    paramKeys: [], placeholders: ["leaveType", "requested", "available", "year"],
  },
  {
    type: "max_duration_exceeded", number: 2, label: "Exceeds maximum duration", locked: false, defaultSeverity: "block",
    description: "A single request is longer than the maximum (minutes for short-hours types, consecutive days otherwise).",
    defaultMessage: "{{leaveType}} cannot exceed {{max}} per request.",
    paramKeys: ["maxMinutes"], placeholders: ["leaveType", "max", "requested"],
  },
  {
    type: "min_duration_not_met", number: 3, label: "Below minimum duration", locked: false, defaultSeverity: "block",
    description: "A single request is shorter than the minimum duration.",
    defaultMessage: "{{leaveType}} must be at least {{min}} per request.",
    paramKeys: ["minMinutes"], placeholders: ["leaveType", "min", "requested"],
  },
  {
    type: "invalid_time_range", number: 4, label: "Invalid start or end time", locked: true, defaultSeverity: "block",
    description: "Missing or reversed times, a time that does not exist (daylight-saving jump), times off the request increment, or a request form this leave type does not support.",
    defaultMessage: "{{detail}}",
    paramKeys: [], placeholders: ["detail", "leaveType", "increment"],
  },
  {
    type: "outside_permitted_hours", number: 5, label: "Outside permitted hours", locked: false, defaultSeverity: "block",
    description: "The times fall outside the leave type's permitted window (earliest start / latest end, or the fixed window), or the day is not the permitted one (same-day-only types).",
    defaultMessage: "Select a time within your permitted {{leaveType}} window ({{window}}).",
    paramKeys: [], placeholders: ["leaveType", "window", "startTime", "endTime", "detail"],
  },
  {
    type: "overlaps_existing_request", number: 6, label: "Overlaps an existing request", locked: true, defaultSeverity: "block",
    description: "The employee already has pending or approved leave covering any part of this request.",
    defaultMessage: "This employee already has pending or approved leave overlapping these dates or times.",
    paramKeys: [], placeholders: ["leaveType"],
  },
  {
    type: "non_working_day", number: 7, label: "Non-working day", locked: false, defaultSeverity: "block",
    description: "The request falls only on days the employee's work schedule marks as rest days.",
    defaultMessage: "{{date}} is not a working day on this employee's work schedule.",
    paramKeys: [], placeholders: ["date", "leaveType"],
  },
  {
    type: "public_holiday_conflict", number: 8, label: "Public holiday conflict", locked: false, defaultSeverity: "block",
    description: "The request lands on a company holiday. By default only when nothing chargeable is left; a rule can also flag any holiday inside the range.",
    defaultMessage: "A leave request must span at least one day that isn't a company holiday ({{holiday}}).",
    paramKeys: ["holidayMode"], placeholders: ["holiday", "date", "leaveType"],
  },
  {
    type: "insufficient_notice", number: 9, label: "Insufficient advance notice", locked: false, defaultSeverity: "block",
    description: "The request starts sooner than the minimum notice allows (also used by future-only types that refuse a same-day request).",
    defaultMessage: "This request does not meet the standard advance-notice requirement of {{notice}}.",
    paramKeys: ["minNoticeMinutes"], placeholders: ["notice", "leaveType", "leadTime"],
  },
  {
    type: "backdated_not_allowed", number: 10, label: "Backdating not permitted", locked: false, defaultSeverity: "block",
    description: "The request starts in the past by more than the permitted number of days.",
    defaultMessage: "{{leaveType}} cannot be requested for a time that has already passed ({{backdateDays}} day(s) allowed).",
    paramKeys: ["backdateDaysAllowed"], placeholders: ["leaveType", "backdateDays", "daysBack"],
  },
  {
    type: "attachment_required", number: 11, label: "Required attachment missing", locked: false, defaultSeverity: "block",
    description: "The leave type requires a supporting document for a request of this size and none was attached.",
    defaultMessage: "Please attach the required supporting document before submitting.",
    paramKeys: ["requiredAfterMinutes"], placeholders: ["leaveType"],
  },
  {
    type: "reason_required", number: 12, label: "Required reason missing", locked: false, defaultSeverity: "block",
    description: "The request has no reason (or a shorter one than the rule asks for). Off until a rule is switched on.",
    defaultMessage: "Please enter a reason for this request.",
    paramKeys: ["minReasonLength"], placeholders: ["leaveType", "minLength"],
  },
  {
    type: "leave_type_unavailable", number: 13, label: "Leave type unavailable to employee", locked: true, defaultSeverity: "block",
    description: "The leave type is switched off, restricted to another gender, or needs more service than the employee has.",
    defaultMessage: "{{detail}}",
    paramKeys: [], placeholders: ["detail", "leaveType"],
  },
  {
    type: "policy_not_assigned", number: 14, label: "Policy not assigned or effective", locked: true, defaultSeverity: "block",
    description: "No leave policy applies to the employee, or the policy gives this leave type no entitlement.",
    defaultMessage: "No leave policy is configured for this employee — assign a tenant-wide default leave policy or an employee group policy first.",
    paramKeys: [], placeholders: ["leaveType"],
  },
  {
    type: "limit_exceeded", number: 15, label: "Daily or monthly limit exceeded", locked: false, defaultSeverity: "block",
    description: "The total of pending and approved timed requests of this type for the day or the month would pass the limit.",
    defaultMessage: "{{leaveType}} is limited to {{limit}} per {{period}}; {{used}} is already booked.",
    paramKeys: ["dailyLimitMinutes", "monthlyLimitMinutes"], placeholders: ["leaveType", "limit", "period", "used", "requested"],
  },
  {
    type: "frequency_reached", number: 16, label: "Maximum frequency reached", locked: false, defaultSeverity: "block",
    description: "The employee has already made the maximum number of requests of this type in the period.",
    defaultMessage: "You can make at most {{maxRequests}} {{leaveType}} request(s) per {{period}}.",
    paramKeys: ["maxRequests", "period"], placeholders: ["leaveType", "maxRequests", "period", "count"],
  },
  {
    type: "ineligible_employment_category", number: 17, label: "Ineligible employment category", locked: false, defaultSeverity: "block",
    description: "The employee's employment type is not one the rule allows. Off until a rule lists the allowed types.",
    defaultMessage: "{{leaveType}} is not available for your employment category.",
    paramKeys: ["allowedEmploymentTypes"], placeholders: ["leaveType", "employmentType"],
  },
  {
    type: "workflow_unresolved", number: 18, label: "Approval workflow cannot be resolved", locked: true, defaultSeverity: "block",
    description: "The approval route for this request is missing or has a step nobody can serve, so it could not be sent for approval.",
    defaultMessage: "No approver could be found for this request, so it cannot be submitted yet. Ask HR to check the approval route.",
    paramKeys: [], placeholders: ["leaveType", "detail"],
  },
  {
    type: "balance_unavailable", number: 19, label: "Leave balance temporarily unavailable", locked: true, defaultSeverity: "block",
    description: "The balance could not be read (or is being updated by another request at this moment).",
    defaultMessage: "Your leave balance is temporarily unavailable. Please try again in a moment.",
    paramKeys: [], placeholders: ["leaveType"],
  },
  {
    type: "attendance_or_shift_conflict", number: 20, label: "Conflicts with attendance or shift", locked: false, defaultSeverity: "block",
    description: "The times fall outside the employee's assigned shift (when the leave type validates against the schedule) or over time already recorded as worked.",
    defaultMessage: "{{detail}}",
    paramKeys: [], placeholders: ["detail", "shiftWindow", "leaveType"],
  },
];

export const VALIDATION_TYPES: LeaveValidationType[] = VALIDATION_CATALOG.map((c) => c.type);
export const LOCKED_VALIDATION_TYPES = new Set<LeaveValidationType>(VALIDATION_CATALOG.filter((c) => c.locked).map((c) => c.type));
export const SEVERITY_ORDER: Record<LeaveValidationSeverity, number> = { block: 0, warning: 1, info: 2 };

/**
 * The order findings are listed in (and so which message an employee reads first): the problems that make the rest
 * meaningless come first - the leave type is not available, no policy, an unusable time - then the rest in catalogue order.
 */
const GATE_ORDER: LeaveValidationType[] = ["leave_type_unavailable", "policy_not_assigned", "invalid_time_range"];
export function displayRank(type: LeaveValidationType): number {
  const gate = GATE_ORDER.indexOf(type);
  if (gate >= 0) return gate - 100;
  return VALIDATION_CATALOG.find((c) => c.type === type)?.number ?? 99;
}

export function catalogInfo(type: LeaveValidationType): LeaveValidationTypeInfo {
  const info = VALIDATION_CATALOG.find((c) => c.type === type);
  if (!info) throw new Error(`Unknown validation type ${type}`);
  return info;
}

/** Types whose default rule is created switched off: they need a rule's parameters before they check anything. */
export const DEFAULT_OFF_TYPES = new Set<LeaveValidationType>(["reason_required", "ineligible_employment_category"]);
