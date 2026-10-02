import type { PayrollRunStatus } from "@aihxm/shared-types";

/** Same "en-PK / PKR" formatting DashboardPage already established for
 * platform-level revenue figures — reused here so a payslip's rupee
 * amounts read the same way everywhere in the app. */
export const pkr = new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
});

export const RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  draft: "Draft",
  calculated: "Calculated",
  pending_approval: "Pending approval",
  approved: "Approved",
  finalized: "Finalized",
  // Phase P2 (Correction/Reversal) — the one genuinely terminal state, set
  // by PayrollService.reverseRun(). Unlike a rejection at pending_approval
  // (which reverts in place to `calculated`), a reversed run stays
  // reversed forever; a fresh `draft` run opens for the same period.
  reversed: "Reversed",
};

/** Mirrors LeavePage's STATUS_STYLES pattern. Phase P2 widened the
 * lifecycle to draft → calculated → pending_approval → approved →
 * finalized (PayrollService.finalizeRun's own guard) — a rejection at
 * pending_approval reverts to `calculated` rather than a terminal state
 * (see 0093_payroll_approval_workflow.sql), so there's no "rejected" style
 * here the way RequisitionStatus/leave request status need one.
 * `reversed` reuses the same red style every other module's terminal
 * "didn't go through" status already uses (leaveLabels/requisitionLabels). */
export const RUN_STATUS_STYLES: Record<PayrollRunStatus, string> = {
  draft: "bg-black/5 text-label-tertiary",
  calculated: "bg-amber-100 text-amber-800",
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-blue-100 text-blue-800",
  finalized: "bg-success/15 text-green-700",
  reversed: "bg-danger/15 text-red-700",
};
