import type { PayslipComponentView, PayslipDetailView, PayslipView } from "@aihxm/shared-types";
import { describePayrollPeriod, money2, toPaystubRow } from "./paystubs";
import type { PayslipSheetData, SheetLine } from "./payslipSheet";

const line = (c: PayslipComponentView): SheetLine => ({
  key: `${c.key}-${c.lineNo}`,
  label: c.label,
  amount: c.amount,
  quantity: c.quantity,
  unit: c.unit,
  rate: c.rate,
  taxable: c.isTaxable,
});

/** Reduces a real payslip (and its itemised lines, when it has them) to what the sheet draws. */
export function toPayslipSheetData(payslip: PayslipView, detail: PayslipDetailView | null, identity: { companyName?: string | null; companySlug?: string | null } | null): PayslipSheetData {
  const row = toPaystubRow(payslip);
  const components = detail?.components ?? [];
  return {
    companyName: identity?.companyName ?? "Payslip",
    companySlug: identity?.companySlug ?? "",
    employeeName: payslip.employeeName,
    employeeNumber: payslip.employeeNumber,
    bankAccountNumber: payslip.bankAccountNumber,
    payrollPeriod: describePayrollPeriod(payslip.payrollRunPeriodStart, payslip.payrollRunPeriodEnd),
    payDate: row.payDate,
    payrollType: row.payrollType,
    paidDays: payslip.paidDays,
    daysInPeriod: payslip.daysInPeriod,
    grossPay: row.grossPay,
    deductions: row.deductions,
    takeHomePay: row.takeHomePay,
    earnings: components.filter((c) => c.affects === "gross").map(line),
    deductionLines: components.filter((c) => c.affects === "net").map(line),
    employerLines: components.filter((c) => c.affects === "employer_cost").map(line),
    calculation: payslip.calculationBreakdown.map((step) => ({ label: step.label, value: typeof step.value === "number" ? money2.format(step.value) : String(step.value) })),
  };
}
