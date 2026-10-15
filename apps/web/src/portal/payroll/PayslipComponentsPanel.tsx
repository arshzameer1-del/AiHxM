import { useState } from "react";
import type { PayslipComponentView, PayslipDetailView, PayslipView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";

const AFFECTS_LABELS: Record<PayslipComponentView["affects"], string> = {
  gross: "Gross pay",
  net: "Taken from net pay",
  employer_cost: "Employer cost",
};

const SOURCE_LABELS: Record<string, string> = {
  additional_payment: "one-time payment",
  off_cycle_payment: "off-cycle payment",
  overtime: "overtime claim",
  loan_installment: "loan installment",
  unpaid_leave: "unpaid leave",
  attendance_deduction: "attendance deduction",
};

/**
 * PAY-05. The structured twin of the calculation breakdown: one line per pay component with its sign, what it
 * affects and how it was reached, plus (payroll staff only) the inputs the payslip consumed and a fingerprint
 * of everything it was calculated from.
 */
export function PayslipComponentsPanel({ payslip }: { payslip: PayslipView }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<PayslipDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<number | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      try {
        setDetail(await api.getPayslipDetail(payslip.id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the pay components.");
      }
    }
  }

  const groups: Array<PayslipComponentView["affects"]> = ["gross", "net", "employer_cost"];

  return (
    <div className="border-t border-black/10 pt-3">
      <button onClick={toggle} className="text-xs font-semibold text-accent hover:underline">
        {open ? "Hide pay components" : "Show pay components"}
      </button>
      {open && error && <p className="text-xs text-danger mt-2">{error}</p>}
      {open && !detail && !error && <p className="text-xs text-label-tertiary mt-2">Loading…</p>}
      {open && detail && (
        <div className="mt-2 space-y-3">
          {detail.components.length === 0 && (
            <p className="text-xs text-label-tertiary">This payslip was calculated before structured components were recorded; the breakdown above is its record.</p>
          )}
          {groups.map((g) => {
            const lines = detail.components.filter((c) => c.affects === g);
            if (lines.length === 0) return null;
            return (
              <div key={g}>
                <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">{AFFECTS_LABELS[g]}</div>
                <ul className="space-y-1">
                  {lines.map((c) => (
                    <li key={c.lineNo} className="text-xs">
                      <div className="flex justify-between gap-3">
                        <button className="text-left text-label-secondary hover:underline" onClick={() => setOpenTrace(openTrace === c.lineNo ? null : c.lineNo)}>
                          {c.label}
                          {c.quantity !== null && c.unit ? (
                            <span className="text-label-tertiary">
                              {" "}
                              · {c.quantity} {c.unit}
                            </span>
                          ) : null}
                          {!c.isTaxable && c.category === "earning" ? <span className="text-label-tertiary"> · non-taxable</span> : null}
                          {c.isOverridden ? <span className="text-amber-800"> · overridden</span> : null}
                        </button>
                        <span className="font-mono tabular-nums">{pkr.format(c.amount)}</span>
                      </div>
                      {openTrace === c.lineNo && (
                        <pre className="mt-1 p-2 rounded bg-black/5 text-[11px] overflow-x-auto whitespace-pre-wrap">{JSON.stringify(c.trace, null, 2)}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="flex justify-between text-xs font-semibold border-t border-black/10 pt-2">
            <span>Employer cost (gross + employer contributions)</span>
            <span className="font-mono">{pkr.format(detail.employerCost)}</span>
          </div>
          {detail.consumptions && detail.consumptions.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">Inputs used</div>
              <ul className="space-y-0.5">
                {detail.consumptions.map((c, i) => (
                  <li key={i} className="text-xs text-label-secondary">
                    {SOURCE_LABELS[c.sourceType] ?? c.sourceType} · {c.quantity !== null && c.unit ? `${c.quantity} ${c.unit}` : pkr.format(c.amount)} · {c.status}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.inputSnapshotHash && (
            <p className="text-[11px] text-label-tertiary font-mono break-all">
              Input fingerprint {detail.inputSnapshotHash.slice(0, 16)}… · calculation #{detail.calculationSequence} · {detail.status}
              {detail.isImmutable ? " · locked" : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
