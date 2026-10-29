import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useLocation } from "react-router-dom";
import { Download, Printer } from "lucide-react";
import { DEFAULT_PAYSLIP_DESIGN, type PayslipDetailView, type PayslipPrintDesign, type PayslipView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { PayslipSheet, payslipPrintCss } from "./payslipSheet";
import { toPayslipSheetData } from "./payslipSheetData";
import { toPaystubRow } from "./paystubs";

/**
 * The paystub itself (what the SAP "My Paystubs" app opens as a PDF): who, which period and pay date, earnings,
 * deductions and take-home pay, drawn from the company's payslip print design (Configuration Center > Payslip print
 * design). "Download PDF" and "Print" both open the browser's print dialog on this sheet only (choose "Save as PDF"
 * there to keep a file). If the design cannot be loaded the built-in design is used, so a paystub always prints.
 */
export function PaystubViewPage() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  // Opened from My Paystubs (own pay) or from the Payroll page (someone else's payslip): "back" goes to where the person came from.
  const fromMine = (location.state as { from?: string } | null)?.from === "mine";
  const { identity } = useAuth();
  const [payslip, setPayslip] = useState<PayslipView | null>(null);
  const [detail, setDetail] = useState<PayslipDetailView | null>(null);
  const [design, setDesign] = useState<PayslipPrintDesign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printed = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.getPayslip(id), api.getPayslipDetail(id).catch(() => null), api.getPayslipDesign().then((v) => v.design).catch(() => DEFAULT_PAYSLIP_DESIGN)])
      .then(([p, d, dz]) => {
        if (!live) return;
        setPayslip(p);
        setDetail(d);
        setDesign(dz);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load this paystub."));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (payslip && design && search.get("print") === "1" && !printed.current) {
      printed.current = true;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [payslip, design, search]);

  const row = useMemo(() => (payslip ? toPaystubRow(payslip) : null), [payslip]);
  const data = useMemo(() => (payslip ? toPayslipSheetData(payslip, detail, identity) : null), [payslip, detail, identity]);

  return (
    <div>
      <style>{payslipPrintCss(design ?? DEFAULT_PAYSLIP_DESIGN)}</style>
      <div className="no-print">
        <BackLink to={fromMine ? "/app/ess/paystubs" : "/app/payroll"}>{fromMine ? "My Paystubs" : "Payroll"}</BackLink>
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

      {error ? <p className="text-sm text-danger">{error}</p> : !data || !design ? <LoadingNote /> : <PayslipSheet design={design} data={data} />}
    </div>
  );
}
