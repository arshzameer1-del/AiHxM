import { useEffect, useState } from "react";
import type { PayrollDashboardView } from "@aihxm/shared-types";
import { api, withoutCache } from "../../api/client";
import { formatPeriod } from "../shared/dates";
import { Pill } from "./PayrollPanelKit";
import { RUN_STATUS_LABELS, pkr } from "./payrollLabels";
import { pickMonthFocus, type StepState } from "./payrollMonth";

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const STEP_STYLE: Record<StepState, string> = {
  done: "bg-success text-white",
  current: "bg-accent text-white ring-4 ring-accent/20",
  todo: "bg-black/10 text-label-tertiary",
};

/**
 * "This month" at the top of the Run payroll tab: which step of the month's payroll the newest run is on, what to do next, and anything that
 * needs a look. It only reads the payroll dashboard; the work itself is done in the runs list below.
 */
export function PayrollMonthCard({ refreshKey }: { refreshKey: number }) {
  const [d, setD] = useState<PayrollDashboardView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    withoutCache(() => api.getPayrollDashboard())
      .then((v) => live && setD(v))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (failed || !d) return null; // the dashboard below already says so; this card is only a summary
  const today = localToday();
  const { focus, coversThisMonth } = pickMonthFocus(d, today);
  const goToRuns = () => document.getElementById("payroll-runs")?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (!focus) {
    return (
      <div className="bg-card rounded-card shadow-sm p-5" data-testid="month-card">
        <h2 className="font-semibold">No payroll has been run yet</h2>
        <p className="text-sm text-label-tertiary mt-1">Start the first run for a pay period; the steps will show here as it moves along.</p>
        <button onClick={goToRuns} className="mt-3 text-sm font-semibold text-accent hover:underline">Go to payroll runs</button>
      </div>
    );
  }

  const r = focus.run;
  const alerts = d.attention.filter((a) => a.runId === r.runId);
  return (
    <div className="bg-card rounded-card shadow-sm p-5 space-y-4" data-testid="month-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{coversThisMonth ? "This month's payroll" : "Latest payroll"}</h2>
          <p className="text-sm text-label-tertiary">{formatPeriod(r.periodStart, r.periodEnd)} · {r.populationCount} {r.populationCount === 1 ? "person" : "people"}</p>
        </div>
        <Pill tone={focus.needsAction ? "accent" : "good"}>{RUN_STATUS_LABELS[r.status] ?? r.status}</Pill>
      </div>

      <ol className="flex items-center gap-1 overflow-x-auto" aria-label="Steps of this month's payroll">
        {focus.steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-1 shrink-0" aria-current={s.state === "current" ? "step" : undefined}>
            <span className={`w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center ${STEP_STYLE[s.state]}`} aria-hidden="true">
              {s.state === "done" ? "✓" : i + 1}
            </span>
            <span className={`text-xs ${s.state === "current" ? "font-semibold text-label-primary" : "text-label-tertiary"}`}>
              {s.label}
              <span className="sr-only"> ({s.state === "done" ? "done" : s.state === "current" ? "now" : "to do"})</span>
            </span>
            {i < focus.steps.length - 1 && <span className="w-4 h-px bg-black/15 mx-1" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      <p className="text-sm" data-testid="month-next">
        <span className="font-semibold">Next: </span>
        {focus.next}
      </p>

      {(alerts.length > 0 || r.failedCount > 0 || r.openExceptions > 0) && (
        <ul className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1 text-xs text-amber-900" role="status">
          {r.failedCount > 0 && <li>{r.failedCount} person(s) could not be calculated.</li>}
          {r.openExceptions > 0 && <li>{r.openExceptions} open exception(s) on this run.</li>}
          {alerts.map((a, i) => <li key={i}>{a.message}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-label-tertiary">
          {r.totalNet !== null ? `Net pay ${pkr.format(r.totalNet)}` : ""}
          {r.totalNet !== null && r.totalEmployerCost !== null ? " · " : ""}
          {r.totalEmployerCost !== null ? `Employer cost ${pkr.format(r.totalEmployerCost)}` : ""}
        </div>
        <button onClick={goToRuns} className="text-sm font-semibold text-accent hover:underline">Go to runs</button>
      </div>

      {!coversThisMonth && <p className="text-xs text-label-tertiary">No run covers the current month yet. Use "New run" below when it is time.</p>}
    </div>
  );
}
