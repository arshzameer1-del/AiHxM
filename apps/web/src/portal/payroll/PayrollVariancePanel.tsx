import { useEffect, useState } from "react";
import type { PayrollRunVarianceView, PayrollVarianceFlag } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";

const FLAG_LABELS: Record<PayrollVarianceFlag, string> = {
  new_in_run: "New in this run",
  missing_from_run: "Paid last time, not now",
  net_change: "Net pay moved a lot",
  tax_change: "Tax moved a lot",
};

const FLAG_STYLES: Record<PayrollVarianceFlag, string> = {
  new_in_run: "bg-black/5 text-label-secondary",
  missing_from_run: "bg-danger/15 text-red-700",
  net_change: "bg-amber-100 text-amber-800",
  tax_change: "bg-amber-100 text-amber-800",
};

const FIRST_ROWS = 10;

function percent(v: number | null) {
  return v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * Review help for a calculated run: every person compared with the previous finalised run, the biggest movers first.
 * Only the people who need a look are listed unless "Show everyone" is chosen.
 */
export function PayrollVariancePanel({ runId, calculationSequence }: { runId: string; calculationSequence: number }) {
  const [data, setData] = useState<PayrollRunVarianceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .getPayrollRunVariance(runId)
      .then((v) => live && setData(v))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not compare this run with the previous one."));
    return () => {
      live = false;
    };
  }, [runId, calculationSequence]);

  if (error) return <p className="text-xs text-danger mt-3">{error}</p>;
  if (!data) return <p className="text-xs text-label-tertiary mt-3">Comparing with the previous run…</p>;
  if (!data.previousRun) {
    return <p className="text-xs text-label-tertiary mt-3">No earlier finalised run to compare with, so there is nothing to review against yet.</p>;
  }

  const t = data.totals;
  const listed = everyone ? data.rows : data.rows.filter((r) => r.flags.length > 0);
  const visible = showAll ? listed : listed.slice(0, FIRST_ROWS);

  return (
    <div className="mt-3 rounded-lg border border-black/5 p-3" aria-label="Comparison with the previous run">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-xs font-semibold">
          Compared with {data.previousRun.periodStart} to {data.previousRun.periodEnd}
        </div>
        <div className="text-xs text-label-secondary">
          Net pay {pkr.format(t.netPay)}
          {t.previousNetPay !== null ? ` (was ${pkr.format(t.previousNetPay)}${t.netChangePercent !== null ? `, ${percent(t.netChangePercent)}` : ""})` : ""} · {t.headcount} paid
          {t.previousHeadcount !== null ? ` (was ${t.previousHeadcount})` : ""}
        </div>
      </div>
      <p className="text-[11px] text-label-tertiary mt-0.5">
        Listed when net pay moves by more than {data.netPayThresholdPercent}% or tax by more than {data.taxThresholdPercent}% (and at least Rs 1,000), or when someone is new or missing.
      </p>

      {listed.length === 0 ? (
        <p className="text-xs text-success mt-2">Nobody moved enough to need a look.</p>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-label-tertiary">
                <th className="font-medium py-1 pr-3">Employee</th>
                <th className="font-medium py-1 pr-3 text-right">Previous net</th>
                <th className="font-medium py-1 pr-3 text-right">Net now</th>
                <th className="font-medium py-1 pr-3 text-right">Change</th>
                <th className="font-medium py-1">Why it is listed</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.employeeId} className="border-t border-black/5 align-top">
                  <td className="py-1 pr-3">
                    <span className="font-mono">{r.employeeNumber}</span> {r.employeeName}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono">{r.previousNetPay === null ? "—" : pkr.format(r.previousNetPay)}</td>
                  <td className="py-1 pr-3 text-right font-mono">{r.netPay === null ? "—" : pkr.format(r.netPay)}</td>
                  <td className="py-1 pr-3 text-right font-mono">
                    {r.netChange >= 0 ? "+" : "−"}
                    {pkr.format(Math.abs(r.netChange))}
                    {r.netChangePercent !== null && <span className="text-label-tertiary"> {percent(r.netChangePercent)}</span>}
                  </td>
                  <td className="py-1">
                    <span className="flex flex-wrap gap-1">
                      {r.flags.map((f) => (
                        <span key={f} className={`px-1.5 py-0.5 rounded-full font-semibold text-[10px] ${FLAG_STYLES[f]}`}>
                          {FLAG_LABELS[f]}
                        </span>
                      ))}
                    </span>
                    {r.grossPay !== null && r.previousGrossPay !== null && r.flags.includes("net_change") && (
                      <span className="block text-label-tertiary mt-0.5">
                        Gross {pkr.format(r.previousGrossPay)} → {pkr.format(r.grossPay)} · tax {pkr.format(r.previousIncomeTax ?? 0)} → {pkr.format(r.incomeTax ?? 0)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-3 mt-2 text-xs">
        {listed.length > FIRST_ROWS && (
          <button onClick={() => setShowAll((x) => !x)} className="font-semibold text-accent hover:underline">
            {showAll ? "Show fewer" : `Show all ${listed.length}`}
          </button>
        )}
        <button onClick={() => setEveryone((x) => !x)} className="font-semibold text-accent hover:underline">
          {everyone ? "Only people who need a look" : `Show everyone (${data.rows.length})`}
        </button>
      </div>
    </div>
  );
}
