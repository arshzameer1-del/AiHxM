import type { PayrollRunStatus } from "@boostfactor/shared-types";

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
  finalized: "Finalized",
};

/** Mirrors LeavePage's STATUS_STYLES pattern — a run's lifecycle is
 * strictly one-directional (draft → calculated → finalized, per
 * PayrollService.finalizeRun's own guard), so these read left-to-right
 * as "not started yet" → "in review" → "locked". */
export const RUN_STATUS_STYLES: Record<PayrollRunStatus, string> = {
  draft: "bg-black/5 text-label-tertiary",
  calculated: "bg-amber-100 text-amber-800",
  finalized: "bg-success/15 text-green-700",
};
