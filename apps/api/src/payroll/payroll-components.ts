/**
 * PAY-05 - the structured result of one payslip calculation.
 *
 * Every line is signed from the employee's point of view and says what it affects:
 *   gross          earnings, and reductions of gross (unpaid leave)       SUM = gross pay
 *   net            deductions taken from net pay only (tax, EOBI, loans)  SUM(gross + net) = net pay
 *   employer_cost  employer contributions (positive)                      not part of the employee's pay
 * Each line is rounded to two decimals; `finish()` adds a visible rounding / clamp line wherever the rounded lines
 * differ from the payslip totals, so the identities above always hold exactly.
 */
export type ComponentCategory = "earning" | "employee_deduction" | "employer_contribution" | "tax" | "statutory_deduction" | "recovery" | "adjustment";
export type ComponentAffects = "gross" | "net" | "employer_cost";
export type ComponentSource = "compensation" | "overtime" | "additional_payment" | "off_cycle_payment" | "loan" | "leave" | "statutory" | "tax" | "override" | "rounding" | "retro" | "attendance";

export type ComponentLine = {
  key: string;
  label: string;
  category: ComponentCategory;
  affects: ComponentAffects;
  amount: number;
  isTaxable?: boolean;
  quantity?: number;
  unit?: string;
  rate?: number;
  basisAmount?: number;
  sourceType: ComponentSource;
  sourceId?: string | null;
  componentId?: string | null;
  trace?: Record<string, unknown>;
};

const r2 = (n: number) => Number(n.toFixed(2));

export class ComponentLedger {
  private readonly lines: ComponentLine[] = [];

  add(line: ComponentLine): void {
    this.lines.push({ ...line, amount: r2(line.amount), quantity: line.quantity === undefined ? undefined : Number(line.quantity.toFixed(4)) });
  }

  /** Adds the rounding / clamp lines so the lines add up to the stated totals, and returns every line in order. */
  finish(grossPay: number, netPay: number): ComponentLine[] {
    const sum = (affects: ComponentAffects[]) => this.lines.filter((l) => affects.includes(l.affects)).reduce((a, l) => a + l.amount, 0);
    const grossGap = r2(r2(grossPay) - sum(["gross"]));
    if (Math.abs(grossGap) >= 0.005) {
      this.lines.push({
        key: "rounding_gross",
        label: "Rounding and floor adjustment (gross pay cannot fall below zero)",
        category: "adjustment",
        affects: "gross",
        amount: grossGap,
        sourceType: "rounding",
      });
    }
    const netGap = r2(r2(netPay) - sum(["gross", "net"]));
    if (Math.abs(netGap) >= 0.005) {
      this.lines.push({
        key: "rounding_net",
        label: "Rounding adjustment",
        category: "adjustment",
        affects: "net",
        amount: netGap,
        sourceType: "rounding",
      });
    }
    return this.lines;
  }
}

/** What a payslip was calculated from, apart from the rules (those are in the run's rule snapshot). */
export type PayslipInputSnapshot = {
  period: { start: string; end: string; daysInPeriod: number };
  employment: { dateOfJoining: string; terminationDate: string | null; windowStart: string; windowEnd: string; windowDays: number };
  organisation: Record<string, unknown>;
  workingDays: { mode: "calendar" | "working_days"; prorationDays: number; unit: string; scheduleNames?: string[]; note?: string | null };
  compensation: Array<{ segmentId: string; componentKey: string; componentType: string; monthlyAmount: number; from: string; to: string; days: number; taxable: boolean }>;
  /** R3 - loss of pay from attendance (empty / mode 'off' unless the tenant opted in). */
  attendance?: { mode: string; absentDays: number; absent: number; halfDays: number; lateMarks: number };
  leave: { unpaidDays: number; segments: Array<{ startDate: string; endDate: string; days: number; leaveRequestId?: string }> };
  overtime: { claimCount: number; minutes: number; total: number; claimIds: string[] };
  adjustments: { additionalPaymentIds: string[]; offCyclePaymentIds: string[]; loanIds: string[]; retroResultIds?: string[] };
  /** PAY-07 - what the component flags say counts toward each statutory / benefit base. */
  bases?: { eobiEligibleEarnings: number; gratuityBase: number; providentFundBase: number };
  /** PAY-28 - the statutory jurisdiction (province) the employee fell under when this payslip was produced. */
  jurisdiction?: { code: string | null; source: "location" | "payroll_area" | "none"; locationId: string | null };
  tax: { taxYear: number; taxYearStart: string; taxYearEnd: string; priorYtdTaxable: number; priorYtdTaxWithheld: number; isFinalSettlement: boolean; /** PAY-10 - the employee tax profile the tax was worked out under, if any. */ profile?: Record<string, unknown> | null };
};
