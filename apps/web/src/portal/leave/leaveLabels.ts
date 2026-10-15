import type { LeaveRequestStatus, LeaveType } from "@aihxm/shared-types";

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
