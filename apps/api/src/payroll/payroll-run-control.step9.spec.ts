import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { canTransitionPayrollRun, PAYROLL_RUN_TRANSITIONS } from "./payroll-run-control.service";
import type { PayrollRunStatus } from "@aihxm/shared-types";

/**
 * Gap Register Step 9A - PAY-01 (state machine), PAY-02 (pinned inputs, totals, idempotency, simulation),
 * PAY-19 (reversal / reopen / cancel) and PAY-23 (manual overrides).
 */
describe("Payroll run control (Step 9A)", () => {
  let f: PayrollFixture;
  let staffEmpId: string;

  beforeAll(async () => {
    f = await buildPayrollFixture("ctl");
    staffEmpId = (await f.createEmployee({ userAccountId: f.staff.uid, monthlySalary: 150000 })).id;
  }, 60000);

  afterAll(async () => {
    await f.cleanup();
  });

  const statuses = Object.keys(PAYROLL_RUN_TRANSITIONS) as PayrollRunStatus[];

  // ======================================================================= PAY-01
  describe("PAY-01 state machine", () => {
    it("the application matrix and the database trigger function agree on every pair", async () => {
      for (const from of statuses) {
        for (const to of statuses) {
          const row = (await f.sql<{ ok: boolean }>("SELECT app.payroll_run_transition_allowed($1, $2) AS ok", [from, to]))[0];
          expect({ from, to, ok: row.ok }).toEqual({ from, to, ok: canTransitionPayrollRun(from, to) });
        }
      }
    });

    it("the database refuses an illegal move even from raw SQL, and the event log is append-only", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2036-01-01", periodEnd: "2036-01-31" });
      await expect(f.sql("UPDATE payroll_runs SET status = 'finalized' WHERE id = $1", [run.id])).rejects.toThrow(/cannot move from draft to finalized/);
      await expect(f.sql("UPDATE payroll_run_events SET action = 'x' WHERE payroll_run_id = $1", [run.id])).rejects.toThrow(/append-only/);
      await expect(f.sql("DELETE FROM payroll_run_events WHERE payroll_run_id = $1", [run.id])).rejects.toThrow(/append-only/);
    });

    it("records every step of a run's life with its actor, in order", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2036-02-01", periodEnd: "2036-02-29" });
      await f.payroll.calculateRun(f.hr, run.id);
      await f.payroll.submitForApproval(f.hr, run.id);
      await f.payroll.decideApproval(f.approver, run.id, { decision: "approved" });
      await f.payroll.finalizeRun(f.hr, run.id);
      const events = await f.control.listEvents(f.hr, run.id);
      expect(events.map((e) => `${e.fromStatus ?? "-"}>${e.toStatus}:${e.action}`)).toEqual([
        "->draft:create",
        "draft>calculated:calculate",
        "calculated>pending_approval:submit",
        "pending_approval>approved:approve",
        "approved>finalized:finalize",
      ]);
      expect(events[3].actorUserAccountId).toBe(f.approver.uid);
      expect(events.every((e) => e.correlationId === null || /^[0-9a-f-]{36}$/.test(e.correlationId))).toBe(true);
    });

    it("a finalised run cannot be recalculated, approved again or cancelled; a closed run cannot be disbursed or reversed until reopened", async () => {
      const runId = await f.finalizedRun("2036-03-01", "2036-03-31");
      await expect(f.payroll.calculateRun(f.hr, runId)).rejects.toThrow(/finalized/);
      await expect(f.control.cancel(f.hr, runId, "no longer needed")).rejects.toThrow(/not been finalised/);

      const closed = await f.control.close(f.hr, runId, "March done");
      expect(closed.status).toBe("closed");
      expect(closed.closedAt).not.toBeNull();
      await expect(f.payroll.generateDisbursementFile(f.hr, runId)).rejects.toThrow(/closed/);
      await expect(f.payroll.reverseRun(f.hr, runId, { reason: "mistake" })).rejects.toThrow(/reopen/);
      await expect(f.control.close(f.hr, runId)).rejects.toBeInstanceOf(BadRequestException);

      // reopening is its own restricted action with a reason and a record
      await expect(f.control.reopen(f.approver, runId, "need a fix here")).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.control.reopen(f.hr, runId, "no")).rejects.toThrow(/reason/);
      const reopened = await f.control.reopen(f.hr, runId, "Wrong bank file was sent");
      expect(reopened.status).toBe("reopened");
      const reopens = await f.control.listReopens(f.hr, runId);
      expect(reopens).toHaveLength(1);
      expect(reopens[0]).toMatchObject({ reason: "Wrong bank file was sent", authorizedBy: f.hr.uid, fromStatus: "closed" });
      await expect(f.control.reopen(f.hr, runId, "again please")).rejects.toThrow(/only a closed run/);
      const batch = await f.payroll.generateDisbursementFile(f.hr, runId);
      expect(batch.csv.length).toBeGreaterThan(0);
    });

    it("only holders of the matching permission can close or cancel", async () => {
      const runId = await f.finalizedRun("2036-04-01", "2036-04-30");
      await expect(f.control.close(f.approver, runId)).rejects.toBeInstanceOf(ForbiddenException);
      const draft = await f.payroll.createRun(f.hr, { periodStart: "2036-05-01", periodEnd: "2036-05-31" });
      await expect(f.control.cancel(f.approver, draft.id, "wrong period selected")).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.control.cancel(f.hr, draft.id, "x")).rejects.toThrow(/reason/);
    });
  });

  // ======================================================================= PAY-02
  describe("PAY-02 pinned inputs, totals, idempotency, simulation", () => {
    it("freezes the rules a calculation read, one snapshot per calculation, unaffected by later changes", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2036-06-01", periodEnd: "2036-06-30" });
      const first = await f.payroll.calculateRun(f.hr, run.id);
      expect(first.run.calculationSequence).toBe(1);
      expect(first.run.ruleSnapshotId).not.toBeNull();
      const snap1 = await f.control.getRuleSnapshot(f.hr, run.id);
      expect(snap1).toMatchObject({ calculationSequence: 1, engineVersion: "payroll-engine/9", asOfDate: "2036-06-30" });
      expect(snap1!.taxSlabs.length).toBeGreaterThan(0);
      expect(snap1!.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // a rate change effective for the same period is a different input: the second snapshot differs, the first stays as it was
      await f.payroll.updateSettings(f.hr, { eobiEmployeeRatePercent: 2 });
      const second = await f.payroll.calculateRun(f.hr, run.id);
      expect(second.run.calculationSequence).toBe(2);
      const snap2 = await f.control.getRuleSnapshot(f.hr, run.id);
      expect(snap2!.contentHash).not.toBe(snap1!.contentHash);
      const stored = await f.sql<{ settings: { eobiEmployeeRatePercent: number } }>(
        "SELECT settings FROM payroll_rule_snapshots WHERE payroll_run_id = $1 ORDER BY calculation_sequence",
        [run.id]
      );
      expect(stored.map((r) => r.settings.eobiEmployeeRatePercent)).toEqual([1, 2]);
      await f.payroll.updateSettings(f.hr, { eobiEmployeeRatePercent: 1 });
    });

    it("stores totals and counters from the payslips and keeps them in step with every change", async () => {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2036-08-01", periodEnd: "2036-08-31" });
      const calc = await f.payroll.calculateRun(f.hr, run.id);
      const slips = await f.payroll.listPayslips(f.hr, { payrollRunId: run.id });
      const sum = (k: "grossPay" | "netPay" | "incomeTaxMonthly") => slips.reduce((a, s) => a + s[k], 0);
      expect(calc.run.totals!.gross).toBeCloseTo(sum("grossPay"), 2);
      expect(calc.run.totals!.net).toBeCloseTo(sum("netPay"), 2);
      expect(calc.run.totals!.incomeTax).toBeCloseTo(sum("incomeTaxMonthly"), 2);
      expect(calc.run.totals!.employerCost).toBeCloseTo(calc.run.totals!.gross + calc.run.totals!.employerContributions, 2);
      expect(calc.run.populationCount).toBeGreaterThanOrEqual(1);
      expect(calc.run.calculatedCount).toBe(slips.length);
      expect(calc.run.calculatedAt).not.toBeNull();
      expect(calc.run.currencyCode).toBe("PKR");
    });

    it("the same idempotency key returns the run already created; a different request with that key conflicts", async () => {
      const a = await f.payroll.createRun(f.hr, { periodStart: "2036-09-01", periodEnd: "2036-09-30", idempotencyKey: "sep-2036" });
      const b = await f.payroll.createRun(f.hr, { periodStart: "2036-09-01", periodEnd: "2036-09-30", idempotencyKey: "sep-2036" });
      expect(b.id).toBe(a.id);
      await expect(f.payroll.createRun(f.hr, { periodStart: "2036-10-01", periodEnd: "2036-10-31", idempotencyKey: "sep-2036" })).rejects.toBeInstanceOf(ConflictException);
      const count = await f.sql<{ n: number }>("SELECT count(*)::int AS n FROM payroll_runs WHERE company_id = $1 AND idempotency_key = 'sep-2036'", [f.companyId]);
      expect(count[0].n).toBe(1);
    });

    it("duplicate regular runs for a period are refused; a cancelled run frees the period", async () => {
      const a = await f.payroll.createRun(f.hr, { periodStart: "2036-11-01", periodEnd: "2036-11-30" });
      await expect(f.payroll.createRun(f.hr, { periodStart: "2036-11-01", periodEnd: "2036-11-30" })).rejects.toThrow(/already exists/);
      await expect(f.sql(`INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id) VALUES ($1,'2036-11-01','2036-11-30',$2)`, [f.companyId, f.hr.uid])).rejects.toThrow(/duplicate key/);
      const cancelled = await f.control.cancel(f.hr, a.id, "Created for the wrong area");
      expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Created for the wrong area" });
      const again = await f.payroll.createRun(f.hr, { periodStart: "2036-11-01", periodEnd: "2036-11-30" });
      expect(again.id).not.toBe(a.id);
      await expect(f.payroll.calculateRun(f.hr, a.id)).rejects.toThrow(/cancelled/);
    });

    it("a simulation never blocks the period, never double-counts people and cannot be approved or finalised", async () => {
      const real = await f.payroll.createRun(f.hr, { periodStart: "2036-12-01", periodEnd: "2036-12-31" });
      const sim = await f.payroll.createRun(f.hr, { periodStart: "2036-12-01", periodEnd: "2036-12-31", isSimulation: true });
      expect(sim.isSimulation).toBe(true);
      const simCalc = await f.payroll.calculateRun(f.hr, sim.id);
      expect(simCalc.errors).toEqual([]);
      // the simulation's payslips do not make the real run think the staff were already paid
      const realCalc = await f.payroll.calculateRun(f.hr, real.id);
      expect(realCalc.errors).toEqual([]);
      expect(realCalc.payslipCount).toBe(simCalc.payslipCount);
      await expect(f.payroll.submitForApproval(f.hr, sim.id)).rejects.toThrow(/simulation/);
      await expect(f.sql("UPDATE payroll_runs SET status = 'pending_approval' WHERE id = $1", [sim.id])).rejects.toThrow(/simulation_status|check constraint/);
    });
  });

  // ======================================================================= validation steps
  describe("pre-validation and validation", () => {
    it("pre-validation fails when nobody is in scope, and warns about people who cannot be paid", async () => {
      const empty = await f.payroll.createRun(f.hr, { periodStart: "1999-01-01", periodEnd: "1999-01-31" });
      const bad = await f.control.preValidate(f.hr, empty.id);
      expect(bad.passed).toBe(false);
      expect(bad.findings.map((x) => x.code)).toContain("EMPTY_POPULATION");
      expect(bad.run.status).toBe("draft");

      const noBank = await f.createEmployee({ bank: null, monthlySalary: 90000 });
      const noPay = await f.createEmployee({ monthlySalary: null });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2035-01-01", periodEnd: "2035-01-31" });
      const res = await f.control.preValidate(f.hr, run.id);
      const codes = res.findings.map((x) => `${x.code}:${x.employeeId ?? ""}`);
      expect(codes).toContain(`NO_PAYMENT_ACCOUNT:${noBank.id}`);
      expect(codes).toContain(`NO_COMPENSATION:${noPay.id}`);
      expect(res.passed).toBe(false); // missing compensation is blocking
      await f.sql("UPDATE employees SET termination_date = '2034-12-31' WHERE id = $1", [noPay.id]);
      const ok = await f.control.preValidate(f.hr, run.id);
      expect(ok.passed).toBe(true);
      expect(ok.run.status).toBe("pre_validated");
      // and it still calculates from pre_validated
      const calc = await f.payroll.calculateRun(f.hr, run.id);
      expect(calc.run.status).toBe("calculated");
    });

    it("validation flags negative net pay and holds the run back; the tenant policy can make validation mandatory", async () => {
      const emp = await f.createEmployee({ monthlySalary: 50000 });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2035-03-01", periodEnd: "2035-03-31" });
      await f.sql(
        `INSERT INTO employee_additional_payments (company_id, employee_id, payment_type, label, amount, is_taxable, effective_date, created_by_user_account_id)
         VALUES ($1,$2,'deduction','Recovery of overpayment',80000,false,'2035-03-15',$3)`,
        [f.companyId, emp.id, f.hr.uid]
      );
      await f.payroll.calculateRun(f.hr, run.id);
      const res = await f.control.validate(f.hr, run.id);
      expect(res.passed).toBe(false);
      expect(res.findings.find((x) => x.code === "NEGATIVE_NET_PAY")?.employeeId).toBe(emp.id);
      expect(res.run.status).toBe("calculated");

      // fix the data, recalculate, validate, then the policy
      await f.sql("UPDATE employee_additional_payments SET status = 'cancelled' WHERE employee_id = $1", [emp.id]);
      await f.payroll.calculateRun(f.hr, run.id);
      await f.sql(
        `INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default) VALUES ($1,'payroll','default','Payroll','{"requireValidationBeforeApproval": true}'::jsonb, true)`,
        [f.companyId]
      );
      const policyAware = new (await import("./payroll-run-control.service")).PayrollRunControlService(f.db, f.rbac, f.entitlements, f.audit, new (await import("../hr-administration/hr-business-policy.service")).HrBusinessPolicyService(f.db, f.rbac, f.entitlements, f.audit, new (await import("../hr-administration/configuration-rule-mapping.service")).ConfigurationRuleMappingService(f.db, f.rbac, f.entitlements, f.audit)));
      expect((await f.db.withClaims(f.hr, (c) => policyAware.policy(c, f.companyId))).requireValidationBeforeApproval).toBe(true);
      const strict = await buildStrictPayroll(f, policyAware);
      await expect(strict.submitForApproval(f.hr, run.id)).rejects.toThrow(/pass validation/);
      const passed = await f.control.validate(f.hr, run.id);
      expect(passed.passed).toBe(true);
      expect(passed.run.status).toBe("validated");
      const submitted = await strict.submitForApproval(f.hr, run.id);
      expect(submitted.status).toBe("pending_approval");
      await f.sql("UPDATE hr_business_policies SET is_active = false, is_default = false WHERE company_id = $1 AND policy_type = 'payroll'", [f.companyId]);
    });
  });

  // ======================================================================= PAY-19
  describe("PAY-19 reversal", () => {
    it("records the reversal with its impact, voids the bank file and opens a corrective run", async () => {
      const runId = await f.finalizedRun("2035-04-01", "2035-04-30");
      await f.payroll.generateDisbursementFile(f.hr, runId);
      const reversed = await f.payroll.reverseRun(f.hr, runId, { reason: "Wrong allowance applied to everyone" });
      expect(reversed.status).toBe("reversed");
      const rev = await f.control.getReversal(f.hr, runId);
      expect(rev).toMatchObject({ reason: "Wrong allowance applied to everyone", correctiveRunId: reversed.correctiveRunId, requestedBy: f.hr.uid });
      expect((rev!.impact as { voidedPaymentBatches: string[] }).voidedPaymentBatches).toHaveLength(1);
      const batches = await f.payroll.listPaymentBatches(f.hr, runId);
      expect(batches.every((b) => b.status === "voided")).toBe(true);
      const events = await f.control.listEvents(f.hr, runId);
      expect(events[events.length - 1]).toMatchObject({ toStatus: "reversed", action: "reverse", reason: "Wrong allowance applied to everyone" });
      const corrective = await f.control.listEvents(f.hr, reversed.correctiveRunId!);
      expect(corrective[0]).toMatchObject({ action: "create" });
      await expect(f.payroll.reverseRun(f.hr, runId, { reason: "again" })).rejects.toThrow(/only a finalized run/);
    });
  });

  // ======================================================================= PAY-23
  describe("PAY-23 manual overrides", () => {
    it("overrides one value with a reason, recomputes net pay, survives a rerun and is approved with the run", async () => {
      const emp = await f.createEmployee({ monthlySalary: 200000 });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2035-05-01", periodEnd: "2035-05-31" });
      await f.payroll.calculateRun(f.hr, run.id);
      const before = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;

      await expect(f.control.applyOverride(f.approver, run.id, { employeeId: emp.id, field: "incomeTaxMonthly", value: 1000, reason: "Court order" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "incomeTaxMonthly", value: 1000, reason: "x" })).rejects.toThrow(/reason/);
      await expect(f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "incomeTaxMonthly", value: -5, reason: "Court order" })).rejects.toThrow(/zero or more/);

      const ov = await f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "incomeTaxMonthly", value: 1234.5, reason: "Exemption certificate on file" });
      expect(ov).toMatchObject({ field: "incomeTaxMonthly", newValue: 1234.5, status: "applied", overriddenBy: f.hr.uid, approvedBy: null });
      expect(ov.oldValue).toBeCloseTo(before.incomeTaxMonthly, 2);
      const after = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;
      expect(after.incomeTaxMonthly).toBe(1234.5);
      expect(after.netPay).toBeCloseTo(before.netPay + before.incomeTaxMonthly - 1234.5, 2);
      expect(after.calculationBreakdown.some((l) => l.label.startsWith("Manual override of incomeTaxMonthly"))).toBe(true);
      const run1 = await f.payroll.getRun(f.hr, run.id);
      expect(run1.totals!.incomeTax).toBeGreaterThanOrEqual(1234.5);

      // a second override of the same field replaces the first and keeps the calculated value as "old"
      const ov2 = await f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "incomeTaxMonthly", value: 2000, reason: "Corrected exemption amount" });
      expect(ov2.oldValue).toBeCloseTo(before.incomeTaxMonthly, 2);
      const all = await f.control.listOverrides(f.hr, run.id);
      expect(all.map((o) => o.status)).toEqual(["withdrawn", "applied"]);

      // recalculating keeps the manual decision on the new payslip
      await f.payroll.calculateRun(f.hr, run.id);
      const rerun = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((s) => s.employeeId === emp.id)!;
      expect(rerun.incomeTaxMonthly).toBe(2000);
      const listed = (await f.control.listOverrides(f.hr, run.id)).find((o) => o.status === "applied")!;
      expect(listed.reappliedCount).toBe(1);
      expect(listed.payslipId).toBe(rerun.id);

      // the workflow approval approves the overrides too
      await f.payroll.submitForApproval(f.hr, run.id);
      await expect(f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "incomeTaxMonthly", value: 1, reason: "Too late now" })).rejects.toThrow(/not yet submitted/);
      await f.payroll.decideApproval(f.approver, run.id, { decision: "approved" });
      const approved = (await f.control.listOverrides(f.hr, run.id)).find((o) => o.status === "applied")!;
      expect(approved.approvedBy).toBe(f.approver.uid);
      expect(approved.approvedAt).not.toBeNull();
    });

    it("can be withdrawn, restoring the calculated value; employer-side overrides leave net pay alone", async () => {
      const emp = await f.createEmployee({ monthlySalary: 120000 });
      const run = await f.payroll.createRun(f.hr, { periodStart: "2035-06-01", periodEnd: "2035-06-30" });
      await f.payroll.calculateRun(f.hr, run.id);
      const slip = () => f.payroll.listPayslips(f.hr, { payrollRunId: run.id }).then((l) => l.find((s) => s.employeeId === emp.id)!);
      const original = await slip();
      const employer = await f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "eobiEmployerContribution", value: 0, reason: "Establishment exempt" });
      const afterEmployer = await slip();
      expect(afterEmployer.eobiEmployerContribution).toBe(0);
      expect(afterEmployer.netPay).toBe(original.netPay);
      const employee = await f.control.applyOverride(f.hr, run.id, { employeeId: emp.id, field: "eobiEmployeeContribution", value: 0, reason: "Under age limit" });
      expect((await slip()).netPay).toBeCloseTo(original.netPay + original.eobiEmployeeContribution, 2);
      await f.control.withdrawOverride(f.hr, run.id, employee.id);
      expect((await slip()).eobiEmployeeContribution).toBeCloseTo(original.eobiEmployeeContribution, 2);
      expect((await slip()).netPay).toBeCloseTo(original.netPay, 2);
      await f.control.withdrawOverride(f.hr, run.id, employer.id);
      await expect(f.control.withdrawOverride(f.hr, run.id, employer.id)).rejects.toThrow(/already withdrawn/);
      const events = await f.control.listEvents(f.hr, run.id);
      expect(events.filter((e) => e.action.startsWith("override")).length).toBe(4);
    });
  });

  // ======================================================================= tenant isolation
  it("run history and overrides are invisible to another tenant", async () => {
    const other = await buildPayrollFixture("oth");
    try {
      const run = await f.payroll.createRun(f.hr, { periodStart: "2034-01-01", periodEnd: "2034-01-31" });
      await expect(other.control.listEvents(other.hr, run.id)).resolves.toEqual([]);
      const rows = await other.db.withClaims(other.hr, async (c) => (await c.query("SELECT count(*)::int AS n FROM payroll_run_events WHERE payroll_run_id = $1", [run.id])).rows[0].n);
      expect(rows).toBe(0);
    } finally {
      await other.cleanup();
    }
  });
});

/** A PayrollService wired with a policy-aware control service (the fixture's default has no policy resolver). */
async function buildStrictPayroll(f: PayrollFixture, control: import("./payroll-run-control.service").PayrollRunControlService) {
  const { PayrollService } = await import("./payroll.service");
  const { ImportExportService } = await import("../import-export/import-export.service");
  const { EffectiveDatingEngine } = await import("../effective-dating/effective-dating.engine");
  return new PayrollService(
    f.db, f.rbac, f.entitlements, f.audit, new ImportExportService(), new EffectiveDatingEngine(), f.workflow,
    f.leaveRequests, f.overtime, f.workSchedule, undefined, undefined, f.loans, f.additionalPayments, f.offCyclePayments, control
  );
}
