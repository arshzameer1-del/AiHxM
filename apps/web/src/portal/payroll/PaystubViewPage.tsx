import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Download, Printer } from "lucide-react";
import type { PayslipComponentView, PayslipDetailView, PayslipView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { describePayrollPeriod, money2, toPaystubRow } from "./paystubs";

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .paystub-sheet, .paystub-sheet * { visibility: visible !important; }
  .paystub-sheet { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: none !important; }
  .no-print { display: none !important; }
}`;

function Lines({ title, lines, empty }: { title: string; lines: PayslipComponentView[]; empty: string }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-sm text-label-tertiary">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {lines.map((c) => (
              <tr key={c.lineNo} className="border-t border-black/5 first:border-t-0">
                <td className="py-1.5 pr-3">{c.label}</td>
                <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money2.format(Math.abs(c.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * The paystub itself (what the SAP "My Paystubs" app opens as a PDF): who, which period and pay date, earnings,
 * deductions and take-home pay. "Download PDF" and "Print" both open the browser's print dialog on this sheet only
 * (choose "Save as PDF" there to keep a file).
 */
export function PaystubViewPage() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const { identity } = useAuth();
  const [payslip, setPayslip] = useState<PayslipView | null>(null);
  const [detail, setDetail] = useState<PayslipDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printed = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.getPayslip(id), api.getPayslipDetail(id).catch(() => null)])
      .then(([p, d]) => {
        if (!live) return;
        setPayslip(p);
        setDetail(d);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load this paystub."));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (payslip && search.get("print") === "1" && !printed.current) {
      printed.current = true;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [payslip, search]);

  const row = useMemo(() => (payslip ? toPaystubRow(payslip) : null), [payslip]);
  const earnings = (detail?.components ?? []).filter((c) => c.affects === "gross");
  const deductions = (detail?.components ?? []).filter((c) => c.affects === "net");

  return (
    <div>
      <style>{PRINT_CSS}</style>
      <div className="no-print">
        <BackLink to="/app/payroll">My Paystubs</BackLink>
        <PageHeader
          title="Paystub"
          subtitle={row ? `${row.payrollPeriod} · paid ${formatDay(row.payDate)}` : undefined}
          actions={
            payslip && (
              <>
                <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-black/10 text-sm font-semibold text-accent hover:bg-black/5">
                  <Printer size={15} /> Print
                </button>
                <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-accent text-white text-sm font-semibold hover:opacity-90">
                  <Download size={15} /> Download PDF
                </button>
              </>
            )
          }
        />
      </div>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !payslip || !row ? (
        <LoadingNote />
      ) : (
        <article className="paystub-sheet bg-card rounded-card shadow-sm border border-black/5 p-6 max-w-3xl space-y-6" data-testid="paystub-sheet">
          <header className="flex flex-wrap justify-between gap-4 border-b border-black/10 pb-4">
            <div>
              <div className="text-lg font-bold">{identity?.companyName ?? "Paystub"}</div>
              <div className="text-sm text-label-secondary">{row.payrollType}</div>
            </div>
            <dl className="text-sm grid grid-cols-[auto_auto] gap-x-4 gap-y-1">
              <dt className="text-label-tertiary">Employee no.</dt>
              <dd className="font-medium">{payslip.employeeNumber}</dd>
              <dt className="text-label-tertiary">Payroll period</dt>
              <dd className="font-medium">{describePayrollPeriod(payslip.payrollRunPeriodStart, payslip.payrollRunPeriodEnd)}</dd>
              <dt className="text-label-tertiary">Pay date</dt>
              <dd className="font-medium">{formatDay(row.payDate)}</dd>
              <dt className="text-label-tertiary">Paid days</dt>
              <dd className="font-medium tabular-nums">
                {payslip.paidDays} of {payslip.daysInPeriod}
              </dd>
            </dl>
          </header>

          {detail && detail.components.length > 0 ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <Lines title="Earnings" lines={earnings} empty="No earnings recorded." />
              <Lines title="Deductions" lines={deductions} empty="No deductions." />
            </div>
          ) : (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">Calculation</h3>
              <table className="w-full text-sm">
                <tbody>
                  {payslip.calculationBreakdown.map((step, i) => (
                    <tr key={i} className="border-t border-black/5 first:border-t-0">
                      <td className="py-1.5 pr-3">{step.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{typeof step.value === "number" ? money2.format(step.value) : step.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <footer className="grid grid-cols-3 gap-4 border-t border-black/10 pt-4 text-sm">
            <div>
              <div className="text-label-tertiary">Gross pay</div>
              <div className="text-success font-semibold tabular-nums">{money2.format(row.grossPay)}</div>
            </div>
            <div>
              <div className="text-label-tertiary">Deductions</div>
              <div className="text-danger font-semibold tabular-nums">{money2.format(row.deductions)}</div>
            </div>
            <div>
              <div className="text-label-tertiary">Take home pay</div>
              <div className="text-lg font-bold tabular-nums">{money2.format(row.takeHomePay)}</div>
            </div>
          </footer>
        </article>
      )}
    </div>
  );
}
