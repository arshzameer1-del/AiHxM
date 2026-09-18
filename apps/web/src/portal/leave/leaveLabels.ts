import type { AttendanceCorrectionStatus, AttendanceStatus, LeaveRequestStatus, LeaveType } from "@boostfactor/shared-types";

/**
 * Matches SubmitLeaveRequestDto's own
 * `@IsIn(["annual", "casual", "sick", "unpaid"])` — kept as an explicit
 * literal list rather than deriving from `LeaveType` so this file still
 * fails to compile (via `LEAVE_TYPE_LABELS`'s `Record<LeaveType, ...>`
 * below) the day the backend's allowed set changes again, the same
 * "don't let the UI silently drift from the DTO" discipline
 * EMPLOYMENT_TYPES/CONDITION_FIELDS already follow in this portal.
 */
export const LEAVE_TYPES: LeaveType[] = ["annual", "casual", "sick", "unpaid"];

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: "Annual",
  casual: "Casual",
  sick: "Sick",
  unpaid: "Unpaid",
};

export const STATUS_STYLES: Record<LeaveRequestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-success/15 text-green-700",
  rejected: "bg-danger/15 text-red-700",
  cancelled: "bg-black/5 text-label-tertiary",
};

export const STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

// Shift Management increment — computed at read time by
// WorkScheduleResolutionService.resolveAttendanceStatus (Work Schedule &
// Employee Schedule Assignment Architecture, 2026-09-18) against the
// employee's resolved weekly pattern + holiday calendar for the punch
// date, never stored on attendance_records itself. rest_day/holiday were
// added alongside the weekly-pattern-aware resolution — previously a
// day off or a company holiday was silently compared against the shift's
// flat hours like any other day.
export const ATTENDANCE_STATUS_STYLES: Record<AttendanceStatus, string> = {
  on_time: "bg-success/15 text-green-700",
  late: "bg-amber-100 text-amber-800",
  early_departure: "bg-amber-100 text-amber-800",
  no_shift_assigned: "bg-black/5 text-label-tertiary",
  rest_day: "bg-black/5 text-label-tertiary",
  holiday: "bg-black/5 text-label-tertiary",
};

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  on_time: "On time",
  late: "Late",
  early_departure: "Left early",
  no_shift_assigned: "No shift assigned",
  rest_day: "Rest day",
  holiday: "Holiday",
};

// Attendance Policies increment 1 — correction requests
// (0028_attendance_corrections.sql). Reuses the exact same pending/
// approved/rejected shape as leave requests (minus "cancelled", which
// this increment doesn't support — see the migration's own scope note).
export const CORRECTION_STATUS_STYLES: Record<AttendanceCorrectionStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-success/15 text-green-700",
  rejected: "bg-danger/15 text-red-700",
};

export const CORRECTION_STATUS_LABELS: Record<AttendanceCorrectionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};
