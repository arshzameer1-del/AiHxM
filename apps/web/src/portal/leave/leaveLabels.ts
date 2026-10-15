import type { AttendanceCorrectionStatus, AttendanceStatus, LeaveRequestStatus, LeaveType } from "@aihxm/shared-types";

/**
 * TLM-01: leave types are tenant-configured (`GET /leave-types`), so this is only the
 * FALLBACK vocabulary for the four built-ins; `leaveTypeLabel()` humanises any other code.
 */
export const LEAVE_TYPES: LeaveType[] = ["annual", "casual", "sick", "unpaid"];

export const LEAVE_TYPE_LABELS: Record<string, string> = {
  annual: "Annual",
  casual: "Casual",
  sick: "Sick",
  unpaid: "Unpaid",
};

export function leaveTypeLabel(code: string): string {
  if (LEAVE_TYPE_LABELS[code]) return LEAVE_TYPE_LABELS[code];
  const words = code.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
  returned: "bg-amber-100 text-amber-800",
  cancelled: "bg-slate-100 text-slate-600",
};

export const CORRECTION_STATUS_LABELS: Record<AttendanceCorrectionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Sent back",
  cancelled: "Cancelled",
};
