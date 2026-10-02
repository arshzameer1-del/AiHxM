import type { ExpenseCategory, ExpenseClaimStatus } from "@aihxm/shared-types";

/**
 * Matches SubmitExpenseClaimDto's own `@IsIn(EXPENSE_CATEGORIES)` list —
 * kept explicit rather than derived so this file fails to compile the day
 * the backend's allowed set changes, same discipline leaveLabels.ts's
 * LEAVE_TYPES/LEAVE_TYPE_LABELS pair already follows.
 */
export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "travel",
  "meals",
  "accommodation",
  "office_supplies",
  "communication",
  "training",
  "other",
];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  travel: "Travel",
  meals: "Meals",
  accommodation: "Accommodation",
  office_supplies: "Office Supplies",
  communication: "Communication",
  training: "Training",
  other: "Other",
};

// Same success/warning/danger semantic-color mapping leaveLabels.ts's own
// STATUS_STYLES uses for Approved/Pending/Rejected — 'draft'/'cancelled'
// get the same neutral treatment as Leave's 'cancelled'; 'paid' gets its
// own distinct accent-tinted style so a fully-closed claim reads
// differently from a merely-approved one still awaiting payment.
export const EXPENSE_STATUS_STYLES: Record<ExpenseClaimStatus, string> = {
  draft: "bg-black/5 text-label-tertiary",
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-success/15 text-green-700",
  rejected: "bg-danger/15 text-red-700",
  paid: "bg-accent/15 text-accent",
  cancelled: "bg-black/5 text-label-tertiary",
};

export const EXPENSE_STATUS_LABELS: Record<ExpenseClaimStatus, string> = {
  draft: "Draft",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid",
  cancelled: "Cancelled",
};
