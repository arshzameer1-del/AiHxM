import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollRetroService } from "./payroll-retro.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../employees/employee-offcycle-payments.service";
import { InboxService } from "../workflow/inbox.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import type { CompensationComponentView } from "@aihxm/shared-types";

/** Gap Register Step 9E - PAY-07, PAY-11, PAY-12: component rules, compensation records, adjustments and retro/arrears. */
describe("Payroll components, compensation records, adjustments and retro (Step 9E)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let retro: PayrollRetroService;
  let basicId: string;
  let year = 2040; // every test uses its own year so the runs of one never touch another's periods

  beforeAll(async () => {
    f = await buildPayrollFixture("cmp");
    other = await buildPayrollFixture("cmp2");
    retro = new PayrollRetroService(f.db, f.audit, f.payroll);
    const components = await f.compensation.listCompensationComponents(f.hr);
    basicId = components.find((c) => c.key === "basic_salary")!.id;
  }, 90000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  });

  const nextYear = () => ++year;
  const history = async (employeeId: string, key: string) => (await f.compensation.getCompensationHistory(f.hr, employeeId)).filter((h) => h.componentKey === key);
  const component = (input: Record<string, unknown>) => f.compensation.createCompensationComponent(f.hr, input as never) as Promise<CompensationComponentView>;
  const assign = (employeeId: string, effectiveFrom: string, components: Array<{ componentId: string; amount?: number; percentage?: number; units?: number }>, extra: Record<string, unknown> = {}) =>
    f.compensation.setCompensationComponents(f.hr, { employeeId, effectiveFrom, components, ...extra } as never);
  async function payslipOf(runId: string, employeeId: string) {
    const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: runId });
    const slip = slips.find((s) => s.employeeId === employeeId)!;
    return { slip, detail: await f.payroll.getPayslipDetail(f.hr, slip.id) };
  }
  const line = (detail: { components: Array<{ key: string; amount: number }> }, key: string) => detail.components.find((c) => c.key === key);

  describe("component rules (PAY-07)", () => {
    it("derives a percentage component from its basis and re-resolves it when the basis changes", async () => {
      const hra = await component({ name: `House Rent ${Date.now()}`, calculationType: "percentage", basisType: "basic_salary", defaultPercentage: 40 });
      expect(hra).toMatchObject({ calculationType: "percentage", basisType: "basic_salary", defaultPercentage: 40 });
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await assign(e.id, "2020-01-01", [{ componentId: hra.id }]);
      expect((await history(e.id, hra.key)).at(-1)).toMatchObject({ amount: 40000, percentage: 40, effectiveTo: null });

      await f.compensation.setCompensation(f.hr, { employeeId: e.id, monthlySalary: 120000, effectiveFrom: "2030-03-01" });
      const rows = await history(e.id, hra.key);
      expect(rows.find((r) => r.effectiveTo === null)).toMatchObject({ amount: 48000, effectiveFrom: "2030-03-01" });
      expect(rows.some((r) => r.amount === 40000 && r.effectiveTo === "2030-02-28")).toBe(true);
    });

    it("prices a per-unit component from its rate and units", async () => {
      const shift = await component({ name: `Night shift ${Date.now()}`, calculationType: "per_unit", unitRate: 500, unitLabel: "shift" });
      const e = await f.createEmployee({ monthlySalary: 90000 });
      await assign(e.id, "2020-01-01", [{ componentId: shift.id, units: 10 }]);
      expect((await history(e.id, shift.key)).at(-1)).toMatchObject({ amount: 5000, units: 10 });
      await expect(assign(e.id, "2031-01-01", [{ componentId: shift.id }])).rejects.toBeInstanceOf(BadRequestException);
    });

    it("applies cap, floor and rounding, and rejects an inconsistent rule", async () => {
      const capped = await component({ name: `Capped ${Date.now()}`, calculationType: "percentage", basisType: "basic_salary", defaultPercentage: 10, capAmount: 5000 });
      const rounded = await component({ name: `Rounded ${Date.now()}`, calculationType: "percentage", basisType: "basic_salary", defaultPercentage: 3.33, roundingMode: "nearest", roundingIncrement: 100 });
      const floored = await component({ name: `Floored ${Date.now()}`, calculationType: "percentage", basisType: "basic_salary", defaultPercentage: 1, floorAmount: 2500 });
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await assign(e.id, "2020-01-01", [{ componentId: capped.id }, { componentId: rounded.id }, { componentId: floored.id }]);
      expect((await history(e.id, capped.key)).at(-1)!.amount).toBe(5000);
      expect((await history(e.id, rounded.key)).at(-1)!.amount).toBe(3300);
      expect((await history(e.id, floored.key)).at(-1)!.amount).toBe(2500);
      await expect(component({ name: `Bad ${Date.now()}`, calculationType: "percentage", basisType: "none" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(component({ name: `Bad2 ${Date.now()}`, calculationType: "fixed", capAmount: 10, floorAmount: 20 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("evaluates a formula component and rejects an unknown variable", async () => {
      const formula = await component({
        name: `Formula ${Date.now()}`,
        calculationType: "formula",
        formulaExpression: { multiply: [{ var: "basic_salary" }, { const: 0.05 }] },
      });
      const e = await f.createEmployee({ monthlySalary: 80000 });
      await assign(e.id, "2020-01-01", [{ componentId: formula.id }]);
      expect((await history(e.id, formula.key)).at(-1)!.amount).toBe(4000);
      await expect(component({ name: `Formula bad ${Date.now()}`, calculationType: "formula", formulaExpression: { var: "nonsense" } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("keeps a component out of a payslip when the employee is not yet eligible, and pays a non-prorated one in full", async () => {
      const y = nextYear();
      const gated = await component({ name: `Loyalty ${Date.now()}`, calculationType: "fixed", eligibility: { minServiceMonths: 12 } });
      const flat = await component({ name: `Flat ${Date.now()}`, calculationType: "fixed", prorationMode: "none" });
      const newcomer = await f.createEmployee({ monthlySalary: 60000, dateOfJoining: `${y}-01-16` });
      await assign(newcomer.id, `${y}-01-16`, [{ componentId: gated.id, amount: 3000 }, { componentId: flat.id, amount: 1500 }]);
      const run = await f.payroll.createRun(f.hr, { periodStart: `${y}-01-01`, periodEnd: `${y}-01-31` });
      await f.payroll.calculateRun(f.hr, run.id);
      const { detail } = await payslipOf(run.id, newcomer.id);
      expect(line(detail, gated.key)).toBeUndefined();
      expect(line(detail, flat.key)!.amount).toBe(1500); // joined mid-month, not prorated
      expect(line(detail, "basic_salary")!.amount).toBeLessThan(60000); // basic is prorated as always
    });

    it("books an employer contribution as employer cost only and refuses to assign a non-cash benefit", async () => {
      const y = nextYear();
      const employer = await component({ name: `Employer cover ${Date.now()}`, componentType: "employer_contribution", calculationType: "fixed" });
      const benefit = await component({ name: `Company car ${Date.now()}`, componentType: "non_cash_benefit", calculationType: "fixed" });
      expect(employer.isTaxable).toBe(false);
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await assign(e.id, "2020-01-01", [{ componentId: employer.id, amount: 2000 }]);
      await expect(assign(e.id, "2020-01-01", [{ componentId: benefit.id, amount: 1000 }])).rejects.toBeInstanceOf(BadRequestException);
      const run = await f.payroll.createRun(f.hr, { periodStart: `${y}-01-01`, periodEnd: `${y}-01-31` });
      await f.payroll.calculateRun(f.hr, run.id);
      const { slip, detail } = await payslipOf(run.id, e.id);
      expect(line(detail, employer.key)).toMatchObject({ amount: 2000 });
      const base = (await f.sql<{ gross_pay: string; employer_cost: string }>("SELECT gross_pay, employer_cost FROM payslips WHERE id = $1", [slip.id]))[0];
      expect(Number(base.gross_pay)).toBe(100000); // not part of gross
      expect(Number(base.employer_cost)).toBeGreaterThanOrEqual(102000);
    });
  });

  describe("compensation records (PAY-11)", () => {
    it("stores an annual figure as its monthly share and keeps the reason, currency and frequency", async () => {
      const bonus = await component({ name: `Annual allowance ${Date.now()}`, calculationType: "fixed" });
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const reasons = await f.sql<{ id: string }>("SELECT id FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = 'lifecycle_reason' LIMIT 1", [f.companyId]);
      await assign(e.id, "2032-01-01", [{ componentId: bonus.id, amount: 120000 }], {
        payFrequency: "annual",
        changeReasonNote: "Annual package revision",
        ...(reasons[0] ? { changeReasonCatalogItemId: reasons[0].id } : {}),
      });
      expect((await history(e.id, bonus.key)).at(-1)).toMatchObject({
        amount: 10000, enteredAmount: 120000, payFrequency: "annual", currencyCode: "PKR", changeReasonNote: "Annual package revision",
      });
      await expect(assign(e.id, "2033-01-01", [{ componentId: bonus.id, amount: 1000 }], { currencyCode: "ZZ" })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("one-time and off-cycle adjustments (PAY-12)", () => {
    it("pays under a pay component with a reason, and only once the approval workflow has approved it", async () => {
      const y = nextYear();
      const additional = new EmployeeAdditionalPaymentsService(f.db, f.rbac, f.entitlements, f.audit, f.workflow);
      const inbox = new InboxService(f.db, f.rbac, f.audit, f.workflow, f.workflow.adapters, new LocalFileStorageService());
      await f.workflow.createTemplate(f.hr, {
        key: "additional_payment", name: "One-time payment approval", objectKey: "additional_payment",
        steps: [{ stepOrder: 1, name: "Review", approvers: [{ approverType: "specific_user", userAccountId: f.approver.uid }] }],
      } as never);
      const bonus = await component({ name: `Spot bonus ${Date.now()}`, calculationType: "fixed", componentType: "earning" });
      const reason = (await f.sql<{ id: string }>("SELECT id FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = 'payroll_adjustment_reason' LIMIT 1", [f.companyId]))[0];
      const e = await f.createEmployee({ monthlySalary: 100000 });

      const payment = await additional.create(f.hr, {
        employeeId: e.id, paymentType: "earning", amount: 7000, effectiveDate: `${y}-01-10`, componentId: bonus.id,
        ...(reason ? { reasonCatalogItemId: reason.id } : {}), reasonNote: "Q4 delivery",
      });
      expect(payment).toMatchObject({ label: bonus.name, approvalStatus: "pending", componentId: bonus.id });
      await expect(additional.create(f.hr, { employeeId: e.id, paymentType: "deduction", amount: 1, effectiveDate: `${y}-01-10`, componentId: bonus.id })).rejects.toBeInstanceOf(BadRequestException);

      const run = await f.payroll.createRun(f.hr, { periodStart: `${y}-01-01`, periodEnd: `${y}-01-31` });
      await f.payroll.calculateRun(f.hr, run.id);
      expect(line((await payslipOf(run.id, e.id)).detail, "additional_earning")).toBeUndefined(); // not approved yet

      const instance = (await f.workflow.listInstancesForRecord(f.hr, "additional_payment", payment.id))[0];
      await inbox.decide(f.approver, instance.id, { decision: "approved" } as never);
      expect((await additional.list(f.hr, e.id)).find((p) => p.id === payment.id)!.approvalStatus).toBe("approved");
      await f.payroll.calculateRun(f.hr, run.id);
      expect(line((await payslipOf(run.id, e.id)).detail, "additional_earning")!.amount).toBe(7000);
    });

    it("withdraws a rejected off-cycle payment", async () => {
      const y = nextYear();
      const offcycle = new EmployeeOffCyclePaymentsService(f.db, f.rbac, f.entitlements, f.audit, f.workflow);
      const inbox = new InboxService(f.db, f.rbac, f.audit, f.workflow, f.workflow.adapters, new LocalFileStorageService());
      await f.workflow.createTemplate(f.hr, {
        key: "off_cycle_payment", name: "Off-cycle payment approval", objectKey: "off_cycle_payment",
        steps: [{ stepOrder: 1, name: "Review", approvers: [{ approverType: "specific_user", userAccountId: f.approver.uid }] }],
      } as never);
      const e = await f.createEmployee({ monthlySalary: 50000 });
      const run = await f.payroll.createRun(f.hr, { periodStart: `${y}-02-01`, periodEnd: `${y}-02-28`, runType: "off_cycle", offCycleReason: "bonus", targetEmployeeId: e.id } as never);
      const payment = await offcycle.create(f.hr, { employeeId: e.id, payrollRunId: run.id, paymentType: "earning", label: "Festival bonus", amount: 20000 });
      expect(payment.approvalStatus).toBe("pending");
      const instance = (await f.workflow.listInstancesForRecord(f.hr, "off_cycle_payment", payment.id))[0];
      await inbox.decide(f.approver, instance.id, { decision: "rejected", comment: "Not budgeted" } as never);
      const row = (await f.sql<{ approval_status: string; status: string }>("SELECT approval_status, status FROM employee_offcycle_payments WHERE id = $1", [payment.id]))[0];
      expect(row.approval_status).toBe("rejected");
      expect(row.status).not.toBe("pending");
    });
  });

  describe("arrears / retro (PAY-12)", () => {
    /** A finalised period, then a salary change back-dated into it, then the next period's run. */
    async function backdatedRaise(y: number, salary = 100000, raisedTo = 110000) {
      const e = await f.createEmployee({ monthlySalary: salary });
      const sourceId = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      await f.compensation.setCompensation(f.hr, { employeeId: e.id, monthlySalary: raisedTo, effectiveFrom: `${y}-01-01` });
      const target = await f.payroll.createRun(f.hr, { periodStart: `${y}-02-01`, periodEnd: `${y}-02-28` });
      return { e, sourceId, target };
    }

    it("detects a back-dated change, includes it in the next run, pays it exactly once and gives it back on reversal", async () => {
      const y = nextYear();
      const { e, target } = await backdatedRaise(y);

      const detected = await retro.detect(f.hr, target.id, { employeeIds: [e.id] });
      expect(detected.detected).toBe(1);
      const item = detected.results[0];
      expect(item).toMatchObject({ employeeId: e.id, componentKey: "basic_salary", originalAmount: 100000, recalculatedAmount: 110000, delta: 10000, status: "detected", sourceEventType: "compensation_change" });
      // repeating the detection changes nothing
      expect(await retro.detect(f.hr, target.id, { employeeIds: [e.id] })).toMatchObject({ detected: 0, unchanged: 1 });

      const included = await retro.include(f.hr, target.id, { retroResultIds: [item.id] });
      expect(included[0]).toMatchObject({ status: "included", targetRunId: target.id });
      await f.payroll.calculateRun(f.hr, target.id);
      const { slip, detail } = await payslipOf(target.id, e.id);
      expect(line(detail, "arrears_basic_salary")!.amount).toBe(10000);
      expect(line(detail, "basic_salary")!.amount).toBe(110000);
      const row = (await f.sql<{ arrears_amount: string; gross_pay: string }>("SELECT arrears_amount, gross_pay FROM payslips WHERE id = $1", [slip.id]))[0];
      expect(Number(row.arrears_amount)).toBe(10000);
      expect(Number(row.gross_pay)).toBe(120000);
      const links = await f.sql("SELECT 1 FROM payslip_consumptions WHERE payslip_id = $1 AND source_type = 'retro_result' AND source_id = $2", [slip.id, item.id]);
      expect(links.length).toBe(1);

      await f.submitAndApprove(target.id);
      await f.payroll.finalizeRun(f.hr, target.id);
      const paid = (await retro.list(f.hr, target.id, "paid")).find((r) => r.id === item.id)!;
      expect(paid).toMatchObject({ status: "paid", includedPayslipId: slip.id });
      expect(paid.paidAt).toBeTruthy();

      // a later detection sees the difference as settled
      const march = await f.payroll.createRun(f.hr, { periodStart: `${y}-03-01`, periodEnd: `${y}-03-31` });
      expect(await retro.detect(f.hr, march.id, { employeeIds: [e.id] })).toMatchObject({ detected: 0 });

      // a reversal makes the arrears payable again
      await f.payroll.reverseRun(f.hr, target.id, { reason: "Wrong period selected for test" } as never);
      const back = (await f.sql<{ status: string; target_run_id: string | null; paid_at: string | null }>("SELECT status, target_run_id, paid_at FROM payroll_retro_results WHERE id = $1", [item.id]))[0];
      expect(back).toMatchObject({ status: "detected", target_run_id: null, paid_at: null });
    });

    it("lets HR dismiss a difference with a reason and keeps it dismissed", async () => {
      const y = nextYear();
      const { e, target } = await backdatedRaise(y, 80000, 85000);
      const item = (await retro.detect(f.hr, target.id, { employeeIds: [e.id] })).results[0];
      await expect(retro.dismiss(f.hr, item.id, "no")).rejects.toBeInstanceOf(BadRequestException);
      const dismissed = await retro.dismiss(f.hr, item.id, "Agreed to apply from next month only");
      expect(dismissed).toMatchObject({ status: "dismissed", dismissedReason: "Agreed to apply from next month only" });
      expect(await retro.detect(f.hr, target.id, { employeeIds: [e.id] })).toMatchObject({ detected: 0, unchanged: 1 });
      await expect(retro.include(f.hr, target.id, { retroResultIds: [item.id] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("returns included lines to the queue when the run is cancelled and when they are taken out", async () => {
      const y = nextYear();
      const { e, target } = await backdatedRaise(y, 70000, 72000);
      const item = (await retro.detect(f.hr, target.id, { employeeIds: [e.id] })).results[0];
      await retro.include(f.hr, target.id, { retroResultIds: [item.id] });
      expect((await retro.exclude(f.hr, target.id, { retroResultIds: [item.id] }))[0].status).toBe("detected");
      await retro.include(f.hr, target.id, { retroResultIds: [item.id] });
      await f.control.cancel(f.hr, target.id, "Cancelled for the retro test");
      const row = (await f.sql<{ status: string; target_run_id: string | null }>("SELECT status, target_run_id FROM payroll_retro_results WHERE id = $1", [item.id]))[0];
      expect(row).toMatchObject({ status: "detected", target_run_id: null });
    });

    it("detects an overpayment as a negative difference (recovery)", async () => {
      const y = nextYear();
      const { e, target } = await backdatedRaise(y, 100000, 90000);
      const item = (await retro.detect(f.hr, target.id, { employeeIds: [e.id] })).results[0];
      expect(item.delta).toBe(-10000);
      await retro.include(f.hr, target.id, { retroResultIds: [item.id] });
      await f.payroll.calculateRun(f.hr, target.id);
      const { detail } = await payslipOf(target.id, e.id);
      expect(line(detail, "arrears_basic_salary")!.amount).toBe(-10000);
    });

    it("is limited by permission, run state and tenant", async () => {
      const y = nextYear();
      const { e, target } = await backdatedRaise(y, 60000, 61000);
      await expect(retro.detect(f.staff, target.id, { employeeIds: [e.id] })).rejects.toBeInstanceOf(ForbiddenException);
      const item = (await retro.detect(f.hr, target.id, { employeeIds: [e.id] })).results[0];

      // another tenant can neither see nor use it
      await expect(retro.list(other.hr, target.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(retro.include(other.hr, target.id, {})).rejects.toBeInstanceOf(NotFoundException);
      const seen = await other.db.withClaims(other.hr, async (c) => (await c.query("SELECT 1 FROM payroll_retro_results WHERE id = $1", [item.id])).rowCount);
      expect(seen).toBe(0);

      // a finalised run no longer takes arrears
      await f.payroll.calculateRun(f.hr, target.id);
      await f.submitAndApprove(target.id);
      await f.payroll.finalizeRun(f.hr, target.id);
      await expect(retro.include(f.hr, target.id, { retroResultIds: [item.id] })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("migration 0146", () => {
    it("has row level security forced on the retro ledger and the catalog columns in place", async () => {
      const rls = await f.sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'payroll_retro_results'");
      expect(rls[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const cols = await f.sql<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'compensation_components' AND column_name IN ('calculation_type','formula_expression','proration_mode','counts_toward_eobi_base')");
      expect(cols.length).toBe(4);
      expect(basicId).toBeTruthy();
    });
  });
});
