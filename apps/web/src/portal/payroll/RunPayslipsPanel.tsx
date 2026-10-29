import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Printer, Search } from "lucide-react";
import type { PayrollRunView, PayslipView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatPeriod } from "../shared/dates";
import { RUN_STATUS_LABELS } from "./payrollLabels";
import { inputClass } from "./PayrollPanelKit";
import { money2 } from "./paystubs";

/**
 * Payroll staff: the payslips of every employee in one payroll run, with employee number and name, searchable.
 * (Own pay is in Employee Self Service > My Paystubs; this list is for looking after everybody else's.)
 */
export function RunPayslipsPanel({ refreshKey }: { refreshKey: number }) {
  const [runs, setRuns] = useState<PayrollRunView[] | null>(null);
  const [runId, setRunId] = useState("");
  const [slips, setSlips] = useState<PayslipView[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPayrollRuns()
      .then((all) => {
        const withSlips = all.filter((r) => r.status !== "draft" && r.status !== "cancelled");
        setRuns(withSlips);
        setRunId((cur) => (cur && withSlips.some((r) => r.id === cur) ? cur : (withSlips[0]?.id ?? "")));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the payroll runs."));
  }, [refreshKey]);

  useEffect(() => {
    if (!runId) {
      setSlips([]);
      return;
    }
    setSlips(null);
    setError(null);
    api
      .listPayslips({ payrollRunId: runId })
      .then(setSlips)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the payslips."));
  }, [runId, refreshKey]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (slips ?? []).slice().sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, undefined, { numeric: true }));
    return q ? rows.filter((p) => `${p.employeeNumber} ${p.employeeName}`.toLowerCase().includes(q)) : rows;
  }, [slips, query]);

  return (
    <div className="space-y-4" data-testid="run-payslips-panel">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-label-tertiary mb-1">Payroll run</span>
          <select id="run-payslips-run" className={`${inputClass} min-w-[16rem]`} value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Payroll run for payslips">
            {!runs ? <option value="">Loading…</option> : runs.length === 0 ? <option value="">No calculated run yet</option> : null}
            {(runs ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {formatPeriod(r.periodStart, r.periodEnd)} · {RUN_STATUS_LABELS[r.status] ?? r.status}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[12rem]">
          <span className="block text-label-tertiary mb-1">Search by employee number or name</span>
          <span className="relative block">
            <Search size={14} className="absolute start-2 top-1/2 -translate-y-1/2 text-label-tertiary" aria-hidden="true" />
            <input id="run-payslips-search" className={`${inputClass} ps-7`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="EMP-0001 or Ayesha" />
          </span>
        </label>
        <span className="text-xs text-label-tertiary pb-2" data-testid="run-payslips-count">
          {slips ? `${shown.length} of ${slips.length} payslips` : ""}
        </span>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}
      {!error && slips === null ? (
        <LoadingNote />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-black/5">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-label-tertiary">
              <tr>
                <th className="px-3 py-2 font-medium">Employee no.</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Period</th>
                <th className="px-3 py-2 font-medium text-right">Gross pay</th>
                <th className="px-3 py-2 font-medium text-right">Take-home pay</th>
                <th className="px-3 py-2 font-medium text-right">Paystub</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-label-tertiary">
                    {slips && slips.length > 0 ? "No employee matches that search." : "No payslips in this run yet. Calculate the run first."}
                  </td>
                </tr>
              )}
              {shown.map((p) => (
                <tr key={p.id} data-testid="run-payslip-row" className="border-t border-black/5">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{p.employeeNumber}</td>
                  <td className="px-3 py-2">{p.employeeName || "—"}</td>
                  <td className="px-3 py-2 text-label-secondary whitespace-nowrap">{formatPeriod(p.payrollRunPeriodStart, p.payrollRunPeriodEnd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money2.format(p.grossPay)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{money2.format(p.netPay)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Link to={`/app/payroll/paystub/${p.id}`} className="text-accent font-medium hover:underline" aria-label={`Open paystub of ${p.employeeNumber} ${p.employeeName}`}>
                      Open
                    </Link>
                    <Link to={`/app/payroll/paystub/${p.id}?print=1`} className="ms-3 inline-flex align-middle text-accent" aria-label={`Print paystub of ${p.employeeNumber}`} title="Print / save as PDF">
                      <Printer size={15} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
