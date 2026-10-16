import type { PayslipView } from "@aihxm/shared-types";
import { formatDay } from "../shared/dates";

/** One row of the My Paystubs list (modelled on the SAP Fiori "My Paystubs" app). */
export type PaystubRow = {
  id: string;
  /** YYYY-MM-DD: the day the run was finalized, else the end of the period. */
  payDate: string;
  payrollYear: string;
  payrollType: string;
  payrollPeriod: string;
  grossPay: number;
  /** Negative (what was taken off gross), shown in red. */
  deductions: number;
  takeHomePay: number;
};

export type PaystubSortKey = "payDate" | "grossPay" | "deductions" | "takeHomePay";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayPart(value: string | null | undefined): string {
  const m = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return m ? m[1] : "";
}

/** "Jun 2026" for a calendar month, "1 Jun 2026 – 15 Jun 2026" for anything shorter or longer. */
export function describePayrollPeriod(start: string, end: string): string {
  const s = /^(\d{4})-(\d{2})-(\d{2})/.exec(start);
  const e = /^(\d{4})-(\d{2})-(\d{2})/.exec(end);
  if (!s || !e) return `${formatDay(start)} – ${formatDay(end)}`;
  const lastDay = new Date(Date.UTC(Number(e[1]), Number(e[2]), 0)).getUTCDate();
  const wholeMonth = s[1] === e[1] && s[2] === e[2] && s[3] === "01" && Number(e[3]) === lastDay;
  if (wholeMonth) return `${MONTHS[Number(s[2]) - 1]} ${s[1]}`;
  return `${formatDay(start)} – ${formatDay(end)}`;
}

export function toPaystubRow(p: PayslipView): PaystubRow {
  const payDate = dayPart(p.payrollRunFinalizedAt) || dayPart(p.payrollRunPeriodEnd);
  return {
    id: p.id,
    payDate,
    payrollYear: payDate.slice(0, 4),
    payrollType: p.payrollRunType === "off_cycle" ? "Off-cycle payroll run" : "Regular payroll run",
    payrollPeriod: describePayrollPeriod(p.payrollRunPeriodStart, p.payrollRunPeriodEnd),
    grossPay: p.grossPay,
    deductions: Math.round((p.netPay - p.grossPay) * 100) / 100,
    takeHomePay: p.netPay,
  };
}

export function searchPaystubs(rows: PaystubRow[], query: string): PaystubRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [formatDay(r.payDate), r.payDate, r.payrollYear, r.payrollType, r.payrollPeriod, String(r.grossPay), String(r.takeHomePay)]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

export function sortPaystubs(rows: PaystubRow[], key: PaystubSortKey, direction: "asc" | "desc"): PaystubRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return cmp * sign || a.id.localeCompare(b.id);
  });
}

/** Rows grouped by payroll year, groups in the order the rows already have. */
export function groupPaystubsByYear(rows: PaystubRow[]): Array<{ year: string; rows: PaystubRow[] }> {
  const groups: Array<{ year: string; rows: PaystubRow[] }> = [];
  for (const r of rows) {
    const g = groups.find((x) => x.year === r.payrollYear);
    if (g) g.rows.push(r);
    else groups.push({ year: r.payrollYear, rows: [r] });
  }
  return groups;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The "Export to Spreadsheet" file: what the list shows, one line per paystub. */
export function paystubsToCsv(rows: PaystubRow[]): string {
  const header = ["Pay Date", "Payroll Type", "Payroll Period", "Gross Pay", "Deductions", "Take Home Pay"];
  const lines = rows.map((r) => [r.payDate, r.payrollType, r.payrollPeriod, r.grossPay.toFixed(2), r.deductions.toFixed(2), r.takeHomePay.toFixed(2)].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\r\n");
}

/** Paystub amounts keep their paisa, unlike the run screens' whole-rupee figures. */
export const money2 = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
