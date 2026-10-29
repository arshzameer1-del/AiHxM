import { useEffect, useState } from "react";
import type { PayrollRunView, PayrollStatutoryReportKind, PayrollStatutoryReportView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatPeriod } from "../shared/dates";
import { Field, Notice, buttonClass, errorMessage, inputClass } from "./PayrollPanelKit";
import { isPostFinalRunStatus, pkr } from "./payrollLabels";

const KINDS: PayrollStatutoryReportKind[] = ["income_tax", "eobi", "social_security"];

/**
 * Statements for the tax authority and the contribution bodies, for a finalised run. The figures are the ones on the payslips as finalised;
 * nothing is recalculated. Each can be previewed here and downloaded as a CSV.
 */
export function PayrollStatutoryReportsPanel() {
  const [runs, setRuns] = useState<PayrollRunView[] | null>(null);
  const [runId, setRunId] = useState("");
  const [reports, setReports] = useState<PayrollStatutoryReportView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPayrollRuns()
      .then((all) => {
        const done = all.filter((r) => isPostFinalRunStatus(r.status) && !r.isSimulation).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
        setRuns(done);
        if (done[0]) setRunId(done[0].id);
      })
      .catch((e) => setError(errorMessage(e, "Could not load the payroll runs.")));
  }, []);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    setReports(null);
    setError(null);
    Promise.all(KINDS.map((k) => api.getPayrollStatutoryReport(runId, k)))
      .then((r) => live && setReports(r))
      .catch((e) => live && setError(errorMessage(e, "Could not build the reports for this run.")));
    return () => {
      live = false;
    };
  }, [runId]);

  if (!runs && !error) return <LoadingNote />;
  if (runs && runs.length === 0) return <p className="text-sm text-label-tertiary">Statutory reports appear here once a payroll run has been finalised.</p>;

  return (
    <div className="space-y-4">
      <Field label="Payroll run" hint="Only finalised runs can be reported, because the reports show what was actually withheld.">
        <select id="statutory-run" value={runId} onChange={(e) => setRunId(e.target.value)} className={inputClass}>
          {(runs ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {formatPeriod(r.periodStart, r.periodEnd)}
              {r.runType !== "regular" ? ` · ${r.runType.replace("_", " ")}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Notice error={error} />
      {runId && !reports && !error && <LoadingNote />}
      <div className="grid gap-3 md:grid-cols-3">
        {(reports ?? []).map((r) => (
          <div key={r.kind} className="bg-black/5 rounded-lg p-4 space-y-2 text-sm" data-testid={`statutory-${r.kind}`}>
            <h3 className="font-semibold">{r.title}</h3>
            <p className="text-xs text-label-tertiary">
              {r.rows.length} {r.rows.length === 1 ? "person" : "people"}
              {r.omittedCount > 0 ? ` · ${r.omittedCount} with nothing to report left out` : ""}
            </p>
            <dl className="text-xs space-y-0.5">
              {r.columns.map((c, i) => (
                <div key={c.key} className="flex justify-between gap-3">
                  <dt className="text-label-tertiary">{c.label}</dt>
                  <dd className="font-mono">{pkr.format(r.totals[i])}</dd>
                </div>
              ))}
            </dl>
            {r.missingCnicCount > 0 && r.rows.length > 0 && (
              <p className="text-xs text-amber-800">{r.missingCnicCount} of {r.rows.length} have no CNIC on file; the authority's statements need it.</p>
            )}
            {r.registrationLabel && r.missingRegistrationCount > 0 && r.rows.length > 0 && (
              <p className="text-xs text-amber-800">{r.missingRegistrationCount} of {r.rows.length} have no {r.registrationLabel.toLowerCase()} on file (add it on the employee's statutory IDs).</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={r.rows.length === 0}
                onClick={() => api.downloadPayrollText(`/payroll/runs/${r.payrollRunId}/statutory/${r.kind}/csv`, `${r.kind}-${r.periodStart}-to-${r.periodEnd}.csv`).catch((e) => setError(errorMessage(e, "Could not download the report.")))}
              >
                Download CSV
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={r.rows.length === 0}
                title="A shorter working file to prepare the payment slip from. Check it against the format your bank or the authority asks for."
                onClick={() => api.downloadPayrollText(`/payroll/runs/${r.payrollRunId}/statutory/${r.kind}/csv?layout=challan`, `${r.kind}-challan-${r.periodStart.slice(0, 7)}.csv`).catch((e) => setError(errorMessage(e, "Could not download the challan file.")))}
              >
                Challan working file
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
