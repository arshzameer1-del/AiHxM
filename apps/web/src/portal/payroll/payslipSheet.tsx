import type { CSSProperties, ReactNode } from "react";
import {
  amountInWordsPKR,
  PAYSLIP_DETAIL_FIELD_LABELS,
  PAYSLIP_FONT_STACKS,
  PAYSLIP_PAPER_MM,
  type PayslipDesignSection,
  type PayslipDetailField,
  type PayslipPrintDesign,
} from "@aihxm/shared-types";
import { publicTenantBrandingAssetUrl } from "../../api/client";
import { formatDay, todayIso } from "../shared/dates";

/** One printed line of a payslip. */
export type SheetLine = { key: string; label: string; amount: number; quantity?: number | null; unit?: string | null; rate?: number | null; taxable?: boolean };

/** Everything the sheet needs, already reduced to plain values so the real paystub and the editor's sample use the same drawing code. */
export type PayslipSheetData = {
  companyName: string;
  /** Used for the logo address. Empty draws no logo. */
  companySlug: string;
  employeeNumber: string;
  bankAccountNumber: string | null;
  payrollPeriod: string;
  payDate: string;
  payrollType: string;
  paidDays: number;
  daysInPeriod: number;
  grossPay: number;
  /** Negative: what was taken off gross. */
  deductions: number;
  takeHomePay: number;
  earnings: SheetLine[];
  deductionLines: SheetLine[];
  employerLines: SheetLine[];
  /** Used when the payslip has no itemised lines (older payslips). */
  calculation: Array<{ label: string; value: string }>;
};

/** Plain numbers for the editor's preview: a believable monthly payslip, clearly not a real employee. */
export const SAMPLE_PAYSLIP: PayslipSheetData = {
  companyName: "Your company name",
  companySlug: "",
  employeeNumber: "EMP-0042",
  bankAccountNumber: "PK36SCBL0000001123456702",
  payrollPeriod: "Sep 2026",
  payDate: "2026-09-30",
  payrollType: "Regular payroll run",
  paidDays: 30,
  daysInPeriod: 30,
  grossPay: 185000,
  deductions: -21650,
  takeHomePay: 163350,
  earnings: [
    { key: "basic", label: "Basic salary", amount: 111000, taxable: true },
    { key: "hra", label: "House rent allowance", amount: 55500, taxable: true },
    { key: "transport", label: "Transport allowance", amount: 15000, quantity: 30, unit: "days", rate: 500, taxable: true },
    { key: "bonus", label: "Performance bonus", amount: 3500, taxable: true },
    { key: "zero", label: "Overtime", amount: 0, taxable: true },
  ],
  deductionLines: [
    { key: "tax", label: "Income tax", amount: -16200 },
    { key: "eobi", label: "EOBI (employee)", amount: -370 },
    { key: "loan", label: "Loan instalment", amount: -5000 },
    { key: "zero", label: "Advance recovery", amount: 0 },
  ],
  employerLines: [
    { key: "eobi", label: "EOBI (employer)", amount: 1480 },
    { key: "ss", label: "Social security (employer)", amount: 2200 },
  ],
  calculation: [
    { label: "Gross salary", value: "185,000.00" },
    { label: "Less income tax", value: "16,200.00" },
  ],
};

/** `@page` and print rules for a design. The sheet is the only thing printed; the browser's margins are the design's margins. */
export function payslipPrintCss(design: PayslipPrintDesign): string {
  return `
@page { size: ${design.page.size} ${design.page.orientation}; margin: ${design.page.marginMm}mm; }
@media print {
  html, body { background: #fff !important; }
  body * { visibility: hidden !important; }
  .paystub-sheet, .paystub-sheet * { visibility: visible !important; }
  .paystub-sheet { position: absolute !important; left: 0; top: 0; width: 100% !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; border: none !important; }
  .no-print { display: none !important; }
}`;
}

function formatAmount(value: number, design: PayslipPrintDesign): string {
  const digits = design.lines.decimals;
  const number = new Intl.NumberFormat("en-PK", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(value));
  if (design.lines.currency === "none") return number;
  if (design.lines.currency === "code") return `PKR ${number}`;
  return `Rs ${number}`;
}

function maskAccount(value: string | null): string {
  if (!value) return "—";
  const tail = value.replace(/\s/g, "").slice(-4);
  return `•••• ${tail}`;
}

function detailValue(field: PayslipDetailField, d: PayslipSheetData): string {
  switch (field) {
    case "employeeNumber":
      return d.employeeNumber;
    case "payrollPeriod":
      return d.payrollPeriod;
    case "payDate":
      return formatDay(d.payDate);
    case "paidDays":
      return `${d.paidDays} of ${d.daysInPeriod}`;
    case "payrollType":
      return d.payrollType;
    case "bankAccount":
      return maskAccount(d.bankAccountNumber);
  }
}

const hexToRgba = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

/**
 * The payslip drawn from a design. Used by the real paystub (printed / saved as PDF) and by the editor's live preview,
 * so what you see while designing is what gets printed. All sizes are relative (em) to the design's base size.
 */
export function PayslipSheet({ design, data, preview = false }: { design: PayslipPrintDesign; data: PayslipSheetData; preview?: boolean }) {
  const accent = design.colors.accent;
  const paper = PAYSLIP_PAPER_MM[design.page.size];
  const widthMm = design.page.orientation === "landscape" ? paper.height : paper.width;
  const headingStyle: CSSProperties = {
    fontSize: "0.8em",
    fontWeight: 700,
    letterSpacing: design.typography.headingCase === "upper" ? "0.06em" : undefined,
    textTransform: design.typography.headingCase === "upper" ? "uppercase" : "none",
    color: accent,
    margin: "0 0 0.5em",
  };

  const keep = (lines: SheetLine[]) => (design.lines.showZeroLines ? lines : lines.filter((l) => Math.abs(l.amount) > 0.004));
  const hasItems = data.earnings.length + data.deductionLines.length > 0;

  function Lines({ title, lines, empty }: { title: string; lines: SheetLine[]; empty: string }): ReactNode {
    const shown = keep(lines);
    return (
      <div style={{ breakInside: "avoid" }}>
        <h3 style={headingStyle}>{title}</h3>
        {shown.length === 0 ? (
          <p style={{ opacity: 0.6, margin: 0 }}>{empty}</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {shown.map((l, i) => (
                <tr key={l.key + i} style={{ background: design.colors.zebraRows && i % 2 === 1 ? hexToRgba(accent, 0.07) : undefined, borderTop: i === 0 || design.colors.zebraRows ? undefined : "1px solid rgba(0,0,0,0.08)" }}>
                  <td style={{ padding: "0.3em 0.4em 0.3em 0" }}>
                    {l.label}
                    {design.lines.showTaxableMarker && l.taxable ? <sup style={{ marginLeft: "0.25em", opacity: 0.7 }}>T</sup> : null}
                    {design.lines.showQuantityAndRate && l.quantity != null ? (
                      <span style={{ display: "block", fontSize: "0.85em", opacity: 0.65 }}>
                        {l.quantity}
                        {l.unit ? ` ${l.unit}` : ""}
                        {l.rate != null ? ` × ${formatAmount(l.rate, design)}` : ""}
                      </span>
                    ) : null}
                  </td>
                  <td style={{ padding: "0.3em 0", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{formatAmount(l.amount, design)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  function Header(): ReactNode {
    const band = design.header.style === "band";
    const logoOn = design.header.logo !== "none" && data.companySlug !== "";
    const logo = logoOn ? (
      <img
        src={publicTenantBrandingAssetUrl(data.companySlug, "logo")}
        alt=""
        style={{ height: `${design.header.logoHeightMm}mm`, width: "auto", maxWidth: "45%", objectFit: "contain" }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    ) : null;
    const text = (
      <div style={{ textAlign: design.header.logo === "center" ? "center" : design.header.logo === "right" ? "right" : "left", flex: 1 }}>
        {design.header.showCompanyName ? <div style={{ fontSize: "1.45em", fontWeight: 700, lineHeight: 1.2 }}>{data.companyName}</div> : null}
        {design.header.title ? <div style={{ fontSize: "1.1em", fontWeight: 600, opacity: band ? 0.95 : 1, color: band ? undefined : accent }}>{design.header.title}</div> : null}
        {design.header.subtitle ? <div style={{ opacity: 0.8 }}>{design.header.subtitle}</div> : null}
        {design.header.addressLines.map((l, i) => (
          <div key={i} style={{ fontSize: "0.9em", opacity: 0.8 }}>
            {l}
          </div>
        ))}
        {design.header.taxIds ? <div style={{ fontSize: "0.9em", opacity: 0.8 }}>{design.header.taxIds}</div> : null}
      </div>
    );
    const center = design.header.logo === "center";
    return (
      <header
        style={{
          display: "flex",
          flexDirection: center ? "column" : design.header.logo === "right" ? "row-reverse" : "row",
          alignItems: center ? "center" : "flex-start",
          gap: "0.9em",
          padding: band ? "0.9em 1em" : "0 0 0.8em",
          marginBottom: "1em",
          background: band ? accent : undefined,
          color: band ? "#fff" : undefined,
          borderBottom: design.header.style === "underline" ? `2px solid ${accent}` : undefined,
          borderRadius: band ? "0.3em" : undefined,
        }}
      >
        {logo}
        {text}
      </header>
    );
  }

  function Details(): ReactNode {
    if (design.detailFields.length === 0) return null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${design.detailColumns}, minmax(0, 1fr))`, gap: "0.5em 1.4em" }}>
        {design.detailFields.map((f) => (
          <div key={f}>
            <div style={{ fontSize: "0.8em", opacity: 0.65 }}>{PAYSLIP_DETAIL_FIELD_LABELS[f]}</div>
            <div style={{ fontWeight: 600 }}>{detailValue(f, data)}</div>
          </div>
        ))}
      </div>
    );
  }

  function Calculation(): ReactNode {
    if (data.calculation.length === 0) return null;
    return (
      <div>
        <h3 style={headingStyle}>Calculation</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {data.calculation.map((s, i) => (
              <tr key={i} style={{ borderTop: i === 0 ? undefined : "1px solid rgba(0,0,0,0.08)" }}>
                <td style={{ padding: "0.3em 0.4em 0.3em 0" }}>{s.label}</td>
                <td style={{ padding: "0.3em 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function Summary(): ReactNode {
    const cells: Array<{ label: string; value: string; strong?: boolean }> = [];
    if (design.summary.showGross) cells.push({ label: "Gross pay", value: formatAmount(data.grossPay, design) });
    if (design.summary.showDeductions) cells.push({ label: "Deductions", value: formatAmount(data.deductions, design) });
    cells.push({ label: "Take home pay", value: formatAmount(data.takeHomePay, design), strong: true });
    const box = design.summary.emphasis === "box";
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`,
          gap: "0.8em",
          padding: box ? "0.8em 1em" : "0.7em 0 0",
          border: box ? `1.5px solid ${accent}` : undefined,
          borderTop: box ? undefined : `1px solid rgba(0,0,0,0.15)`,
          background: box ? hexToRgba(accent, 0.07) : undefined,
          borderRadius: box ? "0.3em" : undefined,
          breakInside: "avoid",
        }}
      >
        {cells.map((c) => (
          <div key={c.label}>
            <div style={{ fontSize: "0.8em", opacity: 0.65 }}>{c.label}</div>
            <div style={{ fontWeight: c.strong ? 800 : 600, fontSize: c.strong ? "1.3em" : "1em", color: c.strong ? accent : undefined, fontVariantNumeric: "tabular-nums" }}>{c.value}</div>
          </div>
        ))}
      </div>
    );
  }

  function Notes(): ReactNode {
    const signatures = design.footer.employerSignature || design.footer.employeeSignature;
    const nothing = !design.footer.note && !design.footer.confidentialLabel && !design.footer.showGeneratedDate && !signatures;
    if (nothing) return null;
    return (
      <div style={{ breakInside: "avoid" }}>
        {signatures ? (
          <div style={{ display: "flex", justifyContent: "space-between", gap: "2em", margin: "2.2em 0 1em" }}>
            {design.footer.employeeSignature ? (
              <div style={{ flex: 1, borderTop: "1px solid currentColor", paddingTop: "0.3em", fontSize: "0.85em" }}>{design.footer.employeeSignatureLabel}</div>
            ) : (
              <div style={{ flex: 1 }} />
            )}
            {design.footer.employerSignature ? (
              <div style={{ flex: 1, borderTop: "1px solid currentColor", paddingTop: "0.3em", fontSize: "0.85em", textAlign: "right" }}>{design.footer.employerSignatureLabel}</div>
            ) : (
              <div style={{ flex: 1 }} />
            )}
          </div>
        ) : null}
        {design.footer.note ? <p style={{ margin: "0 0 0.4em", fontSize: "0.85em", opacity: 0.8 }}>{design.footer.note}</p> : null}
        {design.footer.confidentialLabel || design.footer.showGeneratedDate ? (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8em", opacity: 0.6 }}>
            <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>{design.footer.confidentialLabel}</span>
            <span>{design.footer.showGeneratedDate ? `Generated ${formatDay(todayIso())}` : ""}</span>
          </div>
        ) : null}
      </div>
    );
  }

  function block(section: PayslipDesignSection): ReactNode {
    switch (section.key) {
      case "details":
        return Details();
      case "earnings":
        return hasItems ? Lines({ title: "Earnings", lines: data.earnings, empty: "No earnings recorded." }) : Calculation();
      case "deductions":
        return hasItems ? Lines({ title: "Deductions", lines: data.deductionLines, empty: "No deductions." }) : null;
      case "employerContributions":
        return data.employerLines.length > 0 ? Lines({ title: "Employer contributions", lines: data.employerLines, empty: "None." }) : null;
      case "summary":
        return Summary();
      case "amountInWords":
        return (
          <p style={{ margin: 0 }}>
            <span style={{ opacity: 0.65, fontSize: "0.85em" }}>Take-home pay in words: </span>
            <span style={{ fontWeight: 600 }}>{amountInWordsPKR(data.takeHomePay)}</span>
          </p>
        );
      case "calculation":
        return hasItems ? Calculation() : null;
      case "notes":
        return Notes();
    }
  }

  // Earnings and deductions share a row when the design asks for it and both are switched on next to each other.
  const enabled = design.sections.filter((s) => s.enabled);
  const rows: ReactNode[] = [];
  for (let i = 0; i < enabled.length; i += 1) {
    const s = enabled[i];
    const next = enabled[i + 1];
    const pair = design.earningsDeductions === "sideBySide" && hasItems && next && ((s.key === "earnings" && next.key === "deductions") || (s.key === "deductions" && next.key === "earnings"));
    if (pair) {
      rows.push(
        <div key={`${s.key}+${next.key}`} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1.4em" }}>
          {block(s)}
          {block(next)}
        </div>
      );
      i += 1;
      continue;
    }
    const content = block(s);
    if (content) rows.push(<div key={s.key}>{content}</div>);
  }

  const wm = design.watermark.text;
  return (
    <article
      className="paystub-sheet"
      data-testid="paystub-sheet"
      style={{
        position: "relative",
        boxSizing: "border-box",
        background: "#fff",
        color: design.colors.text,
        fontFamily: PAYSLIP_FONT_STACKS[design.typography.fontFamily],
        fontSize: `${design.typography.baseSizePt}pt`,
        lineHeight: 1.4,
        width: preview ? `${widthMm}mm` : `min(100%, ${widthMm}mm)`,
        padding: `${design.page.marginMm}mm`,
        boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
        overflow: "hidden",
      }}
    >
      {wm ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: "7em",
            fontWeight: 800,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            transform: "rotate(-30deg)",
            color: design.colors.text,
            opacity: design.watermark.opacityPct / 100,
            whiteSpace: "nowrap",
          }}
        >
          {wm}
        </div>
      ) : null}
      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "1.1em" }}>
        {Header()}
        {rows}
      </div>
    </article>
  );
}
