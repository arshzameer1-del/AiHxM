import type { LeaveRequestStatus, LeaveType } from "@boostfactor/shared-types";

/**
 * Hardcoded to the three real, committed leave types — matches
 * SubmitLeaveRequestDto's own `@IsIn(["annual", "casual", "sick"])`
 * rather than importing every value `LeaveType` allows, the same
 * "don't couple the UI to a type still being extended elsewhere"
 * discipline EMPLOYMENT_TYPES/CONDITION_FIELDS already follow in this
 * portal.
 */
export const LEAVE_TYPES: LeaveType[] = ["annual", "casual", "sick"];

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: "Annual",
  casual: "Casual",
  sick: "Sick",
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
