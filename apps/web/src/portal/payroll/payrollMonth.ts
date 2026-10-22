import type { PayrollDashboardRunView, PayrollDashboardView, PayrollRunStatus } from "@aihxm/shared-types";

/** The steps of one month's payroll, in the order the work is done. */
export const MONTH_STEPS = ["Prepare", "Calculate", "Review", "Approve", "Finalize", "Pay & post"] as const;

export type StepState = "done" | "current" | "todo";

export type MonthFocus = {
  run: PayrollDashboardRunView;
  /** index into MONTH_STEPS that the run is working on now; MONTH_STEPS.length when everything is done */
  stepIndex: number;
  steps: Array<{ label: string; state: StepState }>;
  /** one sentence saying what to do next */
  next: string;
  /** false once the month is closed or reconciled */
  needsAction: boolean;
};

const STATUS_STEP: Partial<Record<PayrollRunStatus, number>> = {
  draft: 0,
  pre_validated: 1,
  calculating: 1,
  calculated: 2,
  validated: 3,
  pending_approval: 3,
  approved: 4,
  finalized: 5,
  accounting: 5,
  payment_released: 5,
  reopened: 5,
  reconciled: 6,
  closed: 6,
};

/** Where a run stands and what comes next. */
export function describeRun(run: PayrollDashboardRunView): MonthFocus {
  const stepIndex = STATUS_STEP[run.status] ?? 0;
  const steps = MONTH_STEPS.map((label, i) => ({ label, state: (i < stepIndex ? "done" : i === stepIndex ? "current" : "todo") as StepState }));
  let next: string;
  switch (run.status) {
    case "draft":
      next = "Pre-validate the run to check that everyone can be paid, then calculate it.";
      break;
    case "pre_validated":
      next = "Calculate the run.";
      break;
    case "calculating":
      next = `Calculating: ${run.progressPercent}% done${run.estimatedSecondsRemaining !== null ? `, about ${Math.max(1, Math.round(run.estimatedSecondsRemaining / 60))} min left` : ""}.`;
      break;
    case "calculated":
      next = run.failedCount > 0 || run.openExceptions > 0
        ? "Fix the people who could not be calculated, then review who moved since last month."
        : "Review who moved since last month, then validate and submit the run for approval.";
      break;
    case "validated":
      next = "Submit the run for approval.";
      break;
    case "pending_approval":
      next = "Waiting for the payroll approver to decide.";
      break;
    case "approved":
      next = "Finalize the run to lock the payslips.";
      break;
    case "finalized":
    case "accounting":
    case "payment_released":
    case "reopened":
      next = run.paymentStatus === null
        ? "Generate the bank file and release the payments, then post the journal."
        : run.postingStatus !== "posted"
          ? "Post the journal to the books, then reconcile."
          : "Reconcile the payments and close the run.";
      break;
    case "reconciled":
      next = "Close the run.";
      break;
    default:
      next = "This month's payroll is done.";
  }
  return { run, stepIndex, steps, next, needsAction: run.status !== "closed" };
}


/**
 * The run this month's work is about: the newest regular run still being worked on, otherwise the newest finished one.
 * `today` is a local date (yyyy-mm-dd). `coversThisMonth` says whether that run's period reaches the current month.
 */
export function pickMonthFocus(d: PayrollDashboardView, today: string): { focus: MonthFocus | null; coversThisMonth: boolean } {
  const regular = (r: PayrollDashboardRunView) => r.runType === "regular";
  const byPeriod = (a: PayrollDashboardRunView, b: PayrollDashboardRunView) => b.periodEnd.localeCompare(a.periodEnd);
  const active = d.active.filter(regular).sort(byPeriod)[0];
  const run = active ?? d.recent.filter(regular).sort(byPeriod)[0];
  if (!run) return { focus: null, coversThisMonth: false };
  const thisMonth = today.slice(0, 7);
  return { focus: describeRun(run), coversThisMonth: run.periodEnd.slice(0, 7) >= thisMonth };
}

