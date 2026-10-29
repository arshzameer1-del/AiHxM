import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EmployeeConsistencyCheckResult, EmployeeConsistencyReport } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { PageHeader, LoadingNote } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";
import { NO_ACCESS, PageLoadError } from "../../components/NoAccessPanel";

/**
 * BACKLOG46 — where the employee record disagrees with the place that owns the value (organization unit, position,
 * location, contact records, reporting line, payment accounts, salary). "Fix automatically" repairs the ones with one
 * obviously right answer; the rest list the people HR has to look at.
 */
const SEVERITY: Record<EmployeeConsistencyCheckResult["severity"], string> = {
  high: "bg-danger/10 text-danger",
  medium: "bg-warning/15 text-warning",
  low: "bg-black/5 text-label-secondary",
};

export function EmployeeDataConsistencyPage() {
  const [report, setReport] = useState<EmployeeConsistencyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getEmployeeDataConsistency()
      .then(setReport)
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? NO_ACCESS : "Could not load the data check."));
  }, []);
  useEffect(load, [load]);

  async function repair() {
    setBusy(true);
    setNote(null);
    try {
      const res = await api.repairEmployeeDataConsistency();
      const changed = Object.values(res.repaired).reduce((t, n) => t + Number(n), 0);
      setReport(res.report);
      setNote(changed === 0 ? "Nothing needed fixing." : `Fixed ${changed} value${changed === 1 ? "" : "s"}.`);
    } catch {
      setNote("The fix did not run. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <PageLoadError message={error} what="The data check" />;
  if (!report) return <LoadingNote />;

  const withIssues = report.checks.filter((c) => c.count > 0);
  const clean = report.checks.filter((c) => c.count === 0);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Data Consistency"
        subtitle={`Checked ${report.employeesChecked} employee${report.employeesChecked === 1 ? "" : "s"} on ${formatDateTime(report.generatedAt)}`}
        actions={
          <button
            onClick={repair}
            disabled={busy || report.fixableIssues === 0}
            className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold disabled:opacity-40"
          >
            {busy ? "Fixing…" : `Fix automatically (${report.fixableIssues})`}
          </button>
        }
      />
      {note && <p className="text-sm mb-3" role="status">{note}</p>}

      <section className="bg-card rounded-card p-5 shadow-sm mb-6 flex flex-wrap gap-8">
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary">Mismatches found</div>
          <div className={`text-xl font-bold ${report.totalIssues > 0 ? "text-warning" : ""}`}>{report.totalIssues}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary">Fixed automatically</div>
          <div className="text-xl font-bold">{report.fixableIssues}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary">Need a person</div>
          <div className="text-xl font-bold">{report.totalIssues - report.fixableIssues}</div>
        </div>
      </section>

      {withIssues.length === 0 && <p className="text-sm text-label-secondary mb-6">Every check passed. The employee records agree with the data that owns each value.</p>}

      <div className="space-y-3 mb-8">
        {withIssues.map((c) => (
          <section key={c.id} className="bg-card rounded-card shadow-sm">
            <button
              className="w-full text-left p-4 flex items-start gap-3"
              onClick={() => setOpen(open === c.id ? null : c.id)}
              aria-expanded={open === c.id}
            >
              <span className={`text-xs font-semibold uppercase rounded px-2 py-0.5 mt-0.5 ${SEVERITY[c.severity]}`}>{c.severity}</span>
              <span className="flex-1">
                <span className="block font-semibold">{c.label}</span>
                <span className="block text-sm text-label-secondary">{c.explanation}</span>
                {c.fixable && <span className="block text-xs text-accent mt-1">Fixed by “Fix automatically”</span>}
              </span>
              <span className="font-mono tabular-nums text-lg">{c.count}</span>
            </button>
            {open === c.id && (
              <ul className="border-t border-black/5 px-4 py-3 space-y-1 text-sm">
                {c.samples.map((s) => (
                  <li key={s.employeeId} className="flex flex-wrap gap-x-3">
                    <Link className="text-accent hover:underline" to={`/app/employees/${s.employeeId}`}>
                      {s.employeeNumber} · {s.name}
                    </Link>
                    <span className="text-label-secondary">{s.detail}</span>
                  </li>
                ))}
                {c.count > c.samples.length && <li className="text-label-tertiary">and {c.count - c.samples.length} more</li>}
              </ul>
            )}
          </section>
        ))}
      </div>

      {clean.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">Passed</h2>
          <ul className="text-sm text-label-secondary space-y-1">
            {clean.map((c) => (
              <li key={c.id}>✓ {c.label}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
