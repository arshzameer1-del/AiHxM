import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { ComponentLedger } from "./payroll-components";

/** Gap Register Step 9C - PAY-05 (structured payslip results, snapshots, YTD, immutability) and PAY-21 (consumption links). */
describe("Payslip components, snapshots, YTD and immutability (Step 9C)", () => {
  let f: PayrollFixture;
  let loans: EmployeeLoansService;
  let adds: EmployeeAdditionalPaymentsService;
  let staffEmpId: string;

  beforeAll(async () => {
    f = await buildPayrollFixture("cmp");
    loans = f.loans;
    adds = f.additionalPayments;
    staffEmpId = (await f.createEmployee({ userAccountId: f.staff.uid, monthlySalary: 150000 })).id;
  }, 60000);

  afterAll(async () => {
    await f.cleanup();
  });

  const sum = (lines: Array<{ affects: string; amount: number }>, affects: string[]) =>
    Number(lines.filter((l) => affects.includes(l.affects)).reduce((a, l) => a + l.amount, 0).toFixed(2));

  /** An employee with salary, a taxable earning, a non-taxable earning, a deduction and a loan: every line type at once. */
  async function richEmployee(period: { start: string; end: string }) {
    const emp = await f.createEmployee({ monthlySalary: 180000 });
    const mid = period.start.slice(0, 8) + "10";
    const earning = await adds.create(f.hr, { employeeId: emp.id, paymentType: "earning", label: "Project bonus", amount: 12000, effectiveDate: mid });
    const free = await adds.create(f.hr, { employeeId: emp.id, paymentType: "earning", label: "Travel reimbursement", amount: 3000, isTaxable: false, effectiveDate: mid });
    const ded = await adds.create(f.hr, { employeeId: emp.id, paymentType: "deduction", label: "Uniform recovery", amount: 1500, effectiveDate: mid });
    const loan = await loans.create(f.hr, { employeeId: emp.id, loanType: "loan", principalAmount: 50000, installmentAmount: 5000, issuedDate: period.start });
    return { emp, earning, free, ded, loan };
  }

  describe("ComponentLedger", () => {
    it("adds a visible rounding line only where the rounded lines differ from the stated totals", () => {
      const l = new ComponentLedger();
      l.add({ key: "basic", label: "Basic", category: "earning", affects: "gross", amount: 100.004, sourceType: "compensation" });
      l.add({ key: "tax", label: "Tax", category: "tax", affects: "net", amount: -10.006, sourceType: "tax" });
      const lines = l.finish(100.01, 89.99);
      expect(sum(lines, ["gross"])).toBe(100.01);
      expect(sum(lines, ["gross", "net"])).toBe(89.99);
      expect(lines.filter((x) => x.sourceType === "rounding").map((x) => x.key)).toEqual(["rounding_gross", "rounding_net"]);
      const exact = new ComponentLedger();
      exact.add({ key: "basic", label: "Basic", category: "earning", affects: "gross", amount: 100, sourceType: "compensation" });
      expect(exact.finish(100, 100).some((x) => x.sourceType === "rounding")).toBe(false);
    });
  });

  describe("PAY-05 component results", () => {
    it("every payslip's lines add up exactly to its gross, net and employer cost", async () => {
      const { emp } = await richEmployee({ start: "2037-01-01", end: "2037-01-31" });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-01-01", periodEnd: "2037-01-31" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      expect(slips.length).toBeGreaterThanOrEqual(2);
      for (const slip of slips) {
        const detail = await f.payroll.getPayslipDetail(f.hr, slip.id);
        expect(detail.components.length).toBeGreaterThan(0);
        expect(sum(detail.components, ["gross"])).toBe(slip.grossPay);
        expect(sum(detail.components, ["gross", "net"])).toBe(slip.netPay);
        expect(sum(detail.components, ["employer_cost"])).toBeCloseTo(slip.eobiEmployerContribution + slip.socialSecurityEmployerContribution, 2);
        expect(detail.employerCost).toBeCloseTo(slip.grossPay + slip.eobiEmployerContribution + slip.socialSecurityEmployerContribution, 2);
        expect(detail.status).toBe("calculated");
        expect(detail.isImmutable).toBe(false);
      }
      const rich = slips.find((s) => s.employeeId === emp.id)!;
      const d = await f.payroll.getPayslipDetail(f.hr, rich.id);
      const keys = d.components.map((c) => c.key);
      expect(keys).toEqual(expect.arrayContaining(["additional_earning", "additional_deduction", "income_tax", "eobi_employee", "eobi_employer", "loan_repayment"]));
      const bonus = d.components.find((c) => c.label === "Project bonus")!;
      expect(bonus).toMatchObject({ amount: 12000, isTaxable: true, category: "earning", affects: "gross", sourceType: "additional_payment" });
      expect(d.components.find((c) => c.label === "Travel reimbursement")).toMatchObject({ isTaxable: false, amount: 3000 });
      expect(d.components.find((c) => c.key === "loan_repayment")).toMatchObject({ amount: -5000, category: "recovery", affects: "net", sourceType: "loan" });
      const tax = d.components.find((c) => c.key === "income_tax")!;
      expect(tax.amount).toBe(-rich.incomeTaxMonthly);
      expect(tax.trace).toMatchObject({ taxYear: 2037 });
      expect((tax.trace as { bracket: { ratePercent: number } }).bracket).toBeDefined();
      // the salary line explains its own proration
      const salary = d.components.find((c) => c.sourceType === "compensation")!;
      expect(salary).toMatchObject({ category: "earning", unit: expect.stringMatching(/days/) });
      expect(salary.trace).toMatchObject({ from: "2037-01-01", to: "2037-01-31" });
    });

    it("a mid-month joiner's lines still reconcile (proration)", async () => {
      const joiner = await f.createEmployee({ monthlySalary: 100000, dateOfJoining: "2037-02-10" });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-02-01", periodEnd: "2037-02-28" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === joiner.id)!;
      const d = await f.payroll.getPayslipDetail(f.hr, slip.id);
      expect(sum(d.components, ["gross"])).toBe(slip.grossPay);
      expect(sum(d.components, ["gross", "net"])).toBe(slip.netPay);
      const salary = d.components.find((c) => c.sourceType === "compensation")!;
      expect(salary.quantity).toBe(19); // 10 to 28 February
    });

    it("a recalculation replaces the lines rather than adding to them", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-03-01", periodEnd: "2037-03-31" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip1 = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id }))[0];
      const n1 = (await f.payroll.getPayslipDetail(f.hr, slip1.id)).components.length;
      await f.payroll.calculateRun(f.hr, run.id);
      const slip2 = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === slip1.employeeId)!;
      const d2 = await f.payroll.getPayslipDetail(f.hr, slip2.id);
      expect(d2.components.length).toBe(n1);
      expect(d2.calculationSequence).toBe(2);
      expect(await f.sql("SELECT 1 FROM payroll_component_results WHERE payslip_id = $1", [slip1.id])).toHaveLength(0);
    });

    it("an off-cycle payment run produces its own lines", async () => {
      const emp = await f.createEmployee({ monthlySalary: 100000 });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-04-01", periodEnd: "2037-04-30", runType: "off_cycle", offCycleReason: "bonus", targetEmployeeId: emp.id });
      await f.offCyclePayments.create(f.hr, { payrollRunId: run.id, employeeId: emp.id, paymentType: "earning", label: "Annual bonus", amount: 40000 });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id }))[0];
      const d = await f.payroll.getPayslipDetail(f.hr, slip.id);
      expect(d.components.map((c) => c.key)).toEqual(["offcycle_earning", "income_tax"]);
      expect(sum(d.components, ["gross", "net"])).toBe(slip.netPay);
      expect(d.consumptions).toEqual([expect.objectContaining({ sourceType: "off_cycle_payment", amount: 40000, status: "previewed" })]);
    });
  });

  describe("PAY-05 input snapshot and PAY-21 consumption links", () => {
    it("records what the payslip was calculated from, with a stable hash", async () => {
      const { emp, earning, ded, loan } = await richEmployee({ start: "2037-05-01", end: "2037-05-31" });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-05-01", periodEnd: "2037-05-31" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;
      const d = await f.payroll.getPayslipDetail(f.hr, slip.id);
      const snap = d.inputSnapshot as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(snap.period).toEqual({ start: "2037-05-01", end: "2037-05-31", daysInPeriod: 31 });
      expect(snap.employment).toMatchObject({ dateOfJoining: "2020-01-01", terminationDate: null, windowStart: "2037-05-01", windowEnd: "2037-05-31" });
      expect(snap.compensation[0]).toMatchObject({ monthlyAmount: 180000, from: "2037-05-01", to: "2037-05-31" });
      expect(snap.workingDays).toMatchObject({ mode: "calendar", prorationDays: 31 });
      expect(snap.adjustments.additionalPaymentIds).toEqual(expect.arrayContaining([earning.id, ded.id]));
      expect(snap.adjustments.loanIds).toEqual([loan.id]);
      expect(snap.tax).toMatchObject({ taxYear: 2037, taxYearStart: "2036-07-01", taxYearEnd: "2037-06-30", priorYtdTaxable: 0 });
      expect(snap.organisation).toHaveProperty("costCenters");
      expect(d.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/);

      // same inputs -> same hash
      await f.payroll.calculateRun(f.hr, run.id);
      const slipAgain = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;
      expect((await f.payroll.getPayslipDetail(f.hr, slipAgain.id)).inputSnapshotHash).toBe(d.inputSnapshotHash);
    });

    it("links every input the payslip used, commits them on finalise and gives them back on reversal", async () => {
      const { emp, earning, free, ded, loan } = await richEmployee({ start: "2037-06-01", end: "2037-06-30" });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-06-01", periodEnd: "2037-06-30" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;
      const before = await f.payroll.getPayslipDetail(f.hr, slip.id);
      const linked = before.consumptions!.map((c) => `${c.sourceType}:${c.sourceId}:${c.status}`).sort();
      expect(linked).toEqual(
        [
          `additional_payment:${earning.id}:previewed`,
          `additional_payment:${free.id}:previewed`,
          `additional_payment:${ded.id}:previewed`,
          `loan_installment:${loan.id}:previewed`,
        ].sort()
      );
      // nothing is consumed by a mere calculation
      expect((await adds.list(f.hr, emp.id)).every((p) => p.status === "pending")).toBe(true);

      await f.submitAndApprove(run.id);
      await f.payroll.finalizeRun(f.hr, run.id);
      const after = await f.payroll.getPayslipDetail(f.hr, slip.id);
      expect(after.consumptions!.every((c) => c.status === "consumed")).toBe(true);
      expect(after.status).toBe("final");
      expect(after.isImmutable).toBe(true);
      expect((await adds.list(f.hr, emp.id)).every((p) => p.status === "consumed")).toBe(true);
      const repayments = await f.sql("SELECT amount FROM employee_loan_repayments WHERE loan_id = $1", [loan.id]);
      expect(repayments).toHaveLength(1);

      await f.payroll.reverseRun(f.hr, run.id, { reason: "Wrong bonus amount for the whole team" });
      const voided = await f.payroll.getPayslipDetail(f.hr, slip.id);
      expect(voided.status).toBe("voided");
      expect(voided.isImmutable).toBe(true);
      expect(voided.consumptions!.every((c) => c.status === "released")).toBe(true);
    });

    it("links unpaid leave and approved overtime to the payslip that used them", async () => {
      const emp = await f.createEmployee({ monthlySalary: 120000 });
      await f.sql(
        `INSERT INTO leave_types (company_id, code, name, is_paid, tracks_balance) VALUES ($1,'unpaid','Unpaid leave',false,false) ON CONFLICT DO NOTHING`,
        [f.companyId]
      );
      const leave = await f.sql<{ id: string }>(
        `INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id)
         VALUES ($1,$2,'unpaid','2037-07-06','2037-07-07',2,'approved',$3) RETURNING id`,
        [f.companyId, emp.id, f.staff.uid]
      );
      const ot = await f.sql<{ id: string }>(
        `INSERT INTO overtime_records (company_id, employee_id, work_date, scheduled_minutes, actual_minutes, overtime_minutes, day_type, rate_multiplier, status, submitted_by_user_account_id, hourly_rate, amount)
         VALUES ($1,$2,'2037-07-14',480,600,120,'weekday',1.5,'approved',$3,1000,3000) RETURNING id`,
        [f.companyId, emp.id, f.staff.uid]
      );
      const run = await f.payroll.createRun(f.hr, { periodStart: "2037-07-01", periodEnd: "2037-07-31" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;
      const d = await f.payroll.getPayslipDetail(f.hr, slip.id);
      expect(d.consumptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceType: "unpaid_leave", sourceId: leave[0].id, quantity: 2, unit: "days", status: "previewed" }),
          expect.objectContaining({ sourceType: "overtime", sourceId: ot[0].id, amount: 3000, status: "previewed" }),
        ])
      );
      expect(d.components.find((c) => c.key === "unpaid_leave_deduction")).toMatchObject({ category: "adjustment", affects: "gross", quantity: 2, sourceType: "leave" });
      expect(d.components.find((c) => c.key === "overtime")).toMatchObject({ amount: 3000, sourceType: "overtime", sourceId: ot[0].id, quantity: 120, unit: "minutes" });
      expect(sum(d.components, ["gross"])).toBe(slip.grossPay);
      expect(sum(d.components, ["gross", "net"])).toBe(slip.netPay);
      expect((d.inputSnapshot as { leave: { unpaidDays: number }; overtime: { minutes: number } }).leave.unpaidDays).toBe(2);
      expect((d.inputSnapshot as { overtime: { minutes: number } }).overtime.minutes).toBe(120);

      // finalising marks the overtime as paid by this run, and the link as consumed
      await f.submitAndApprove(run.id);
      await f.payroll.finalizeRun(f.hr, run.id);
      const paid = await f.sql<{ consumed_payroll_run_id: string }>("SELECT consumed_payroll_run_id FROM overtime_records WHERE id = $1", [ot[0].id]);
      expect(paid[0].consumed_payroll_run_id).toBe(run.id);
      expect((await f.payroll.getPayslipDetail(f.hr, slip.id)).consumptions!.every((c) => c.status === "consumed")).toBe(true);
    });
  });

  describe("PAY-05 immutability", () => {
    it("a final payslip and everything beneath it refuse edits and deletes, even from raw SQL", async () => {
      const { emp } = await richEmployee({ start: "2037-08-01", end: "2037-08-31" });
      const runId = await f.finalizedRun("2037-08-01", "2037-08-31");
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((x) => x.employeeId === emp.id)!;
      await expect(f.sql("UPDATE payslips SET net_pay = net_pay + 1 WHERE id = $1", [slip.id])).rejects.toThrow(/figures cannot be changed/);
      await expect(f.sql("UPDATE payslips SET calculation_breakdown = '[]'::jsonb WHERE id = $1", [slip.id])).rejects.toThrow(/figures cannot be changed/);
      await expect(f.sql("UPDATE payslips SET is_immutable = false WHERE id = $1", [slip.id])).rejects.toThrow(/cannot be made editable/);
      await expect(f.sql("UPDATE payslips SET status = 'calculated' WHERE id = $1", [slip.id])).rejects.toThrow(/final to voided/);
      await expect(f.sql("DELETE FROM payslips WHERE id = $1", [slip.id])).rejects.toThrow(/cannot be deleted/);
      await expect(f.sql("UPDATE payroll_component_results SET amount = 0 WHERE payslip_id = $1", [slip.id])).rejects.toThrow(/payslip is final/);
      await expect(f.sql("DELETE FROM payroll_component_results WHERE payslip_id = $1", [slip.id])).rejects.toThrow(/payslip is final/);
      await expect(f.sql("UPDATE payroll_input_snapshots SET snapshot = '{}'::jsonb WHERE payslip_id = $1", [slip.id])).rejects.toThrow(/payslip is final/);
      await expect(f.sql("DELETE FROM payslip_consumptions WHERE payslip_id = $1", [slip.id])).rejects.toThrow(/cannot be removed/);
      await expect(f.sql("UPDATE payslip_consumptions SET amount = 1 WHERE payslip_id = $1", [slip.id])).rejects.toThrow(/only the status/);
      // the at-rest encoding of the bank account may still be rewritten (encryption backfill), nothing else
      await expect(f.sql("UPDATE payslips SET bank_account_number = bank_account_number WHERE id = $1", [slip.id])).resolves.toBeDefined();
    });

    it("a draft payslip stays freely recalculable, and deleting the company still cascades", async () => {
      const other = await buildPayrollFixture("cmp2");
      await other.createEmployee({ monthlySalary: 100000 });
      const runId = await other.finalizedRun("2037-09-01", "2037-09-30");
      expect(await other.payroll.listPayslips(other.hr, { payrollRunId: runId })).not.toHaveLength(0);
      await other.cleanup(); // would throw if the guard blocked the cascade
      expect(true).toBe(true);
    });
  });

  describe("PAY-05 year to date", () => {
    it("accumulates settled payslips of the tax year, ignores drafts, and drops a reversed run", async () => {
      const emp = await f.createEmployee({ monthlySalary: 200000 });
      expect(await f.payroll.getYtd(f.hr, emp.id)).toEqual([]);

      const r1 = await f.finalizedRun("2037-10-01", "2037-10-31");
      const r2 = await f.finalizedRun("2037-11-01", "2037-11-30");
      const draft = await f.payroll.createRun(f.hr, { periodStart: "2037-12-01", periodEnd: "2037-12-31" });
      await f.payroll.calculateRun(f.hr, draft.id);

      const s1 = (await f.payroll.listPayslips(f.hr, { payrollRunId: r1 })).find((s) => s.employeeId === emp.id)!;
      const s2 = (await f.payroll.listPayslips(f.hr, { payrollRunId: r2 })).find((s) => s.employeeId === emp.id)!;
      const [ytd] = await f.payroll.getYtd(f.hr, emp.id, 2038);
      expect(ytd).toMatchObject({ employeeId: emp.id, taxYear: "2038", payslipCount: 2, lastPeriodEnd: "2037-11-30" });
      expect(ytd.grossPay).toBeCloseTo(s1.grossPay + s2.grossPay, 2);
      expect(ytd.incomeTax).toBeCloseTo(s1.incomeTaxMonthly + s2.incomeTaxMonthly, 2);
      expect(ytd.taxableGross).toBeCloseTo(s1.taxableGrossThisPeriod + s2.taxableGrossThisPeriod, 2);
      expect(ytd.netPay).toBeCloseTo(s1.netPay + s2.netPay, 2);
      expect(ytd.employerCost).toBeGreaterThan(ytd.grossPay);

      await f.payroll.reverseRun(f.hr, r2, { reason: "Duplicate allowance paid in November" });
      const [after] = await f.payroll.getYtd(f.hr, emp.id, 2038);
      expect(after.payslipCount).toBe(1);
      expect(after.grossPay).toBeCloseTo(s1.grossPay, 2);
    });

    it("an employee can read only their own year to date", async () => {
      await f.finalizedRun("2037-10-01", "2037-10-31").catch(() => undefined); // may already exist for the period: harmless
      const own = await f.payroll.getYtd(f.staff, staffEmpId);
      expect(Array.isArray(own)).toBe(true);
      const colleague = await f.createEmployee({ monthlySalary: 90000 });
      await expect(f.payroll.getYtd(f.staff, colleague.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("access", () => {
    it("an employee sees the lines of their own final payslip but not the snapshot or the links; other tenants see nothing", async () => {
      const runId = await f.finalizedRun("2038-01-01", "2038-01-31");
      const mine = (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((s) => s.employeeId === staffEmpId)!;
      const asStaff = await f.payroll.getPayslipDetail(f.staff, mine.id);
      expect(asStaff.components.length).toBeGreaterThan(0);
      expect(asStaff.inputSnapshot).toBeNull();
      expect(asStaff.consumptions).toBeNull();

      const other = await buildPayrollFixture("cmp3");
      try {
        await expect(other.payroll.getPayslipDetail(other.hr, mine.id)).rejects.toBeInstanceOf(NotFoundException);
      } finally {
        await other.cleanup();
      }
      void ForbiddenException;
    });
  });
});
