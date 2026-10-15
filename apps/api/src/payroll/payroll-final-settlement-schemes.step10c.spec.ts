import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollSchemesService } from "./payroll-schemes.service";
import { PayrollFinalSettlementService, completedMonths } from "./payroll-final-settlement.service";
import { LeaveLedgerService } from "../leave/leave-ledger.service";
import type { CompensationComponentView, FinalSettlementView } from "@aihxm/shared-types";

/** Gap Register Step 10C - PAY-14 (final settlement) and PAY-15 (scheme definitions and ledgers). */
describe("Final settlement and scheme ledgers (Step 10C)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let schemes: PayrollSchemesService;
  let settlements: PayrollFinalSettlementService;
  let otherSettlements: PayrollFinalSettlementService;
  let year = 2080;

  beforeAll(async () => {
    f = await buildPayrollFixture("s10c");
    other = await buildPayrollFixture("s10x");
    schemes = new PayrollSchemesService(f.db, f.rbac, f.entitlements, f.audit);
    settlements = new PayrollFinalSettlementService(f.db, f.rbac, f.entitlements, f.audit, schemes, new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit));
    // registering the other tenant's services last would replace the hooks of the first: register this tenant's again after
    const otherSchemes = new PayrollSchemesService(other.db, other.rbac, other.entitlements, other.audit);
    otherSettlements = new PayrollFinalSettlementService(other.db, other.rbac, other.entitlements, other.audit, otherSchemes);
    schemes = new PayrollSchemesService(f.db, f.rbac, f.entitlements, f.audit);
    settlements = new PayrollFinalSettlementService(f.db, f.rbac, f.entitlements, f.audit, schemes, new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit));
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  });

  const nextYear = () => ++year;
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  /** A terminated employee with an applied termination event (which opens the settlement). */
  async function leaver(opts: { joined?: string; lastDay: string; salary?: number; fx?: PayrollFixture }) {
    const fx = opts.fx ?? f;
    const emp = await fx.createEmployee({ dateOfJoining: opts.joined ?? "2020-01-01", terminationDate: opts.lastDay, monthlySalary: opts.salary ?? 100000 });
    const ev = await fx.sql<{ id: string }>(
      `INSERT INTO employee_lifecycle_events (company_id, employee_id, action_type, effective_date, status, source_channel)
       VALUES ($1, $2, 'termination', $3, 'applied', 'system') RETURNING id`,
      [fx.companyId, emp.id, opts.lastDay]
    );
    const s = (await fx.sql<{ id: string }>("SELECT id FROM payroll_final_settlements WHERE termination_event_id = $1", [ev[0].id]))[0];
    return { emp, eventId: ev[0].id, settlementId: s?.id };
  }

  const setSettings = (patch: Record<string, unknown>) => schemes.updateSettlementSettings(f.hr, { dailyRateBase: "basic_salary", ...patch } as never);
  const resetSchemes = () => f.sql("UPDATE payroll_scheme_definitions SET is_active = false WHERE company_id = $1", [f.companyId]);
  const line = (v: FinalSettlementView, kind: string) => v.lines.find((l) => l.kind === kind);

  async function finalRun(empId: string, lastDay: string) {
    const [y, m] = lastDay.split("-");
    const end = new Date(Date.UTC(Number(y), Number(m), 0)).toISOString().slice(0, 10);
    const run = await f.payroll.createRun(f.hr, { periodStart: `${y}-${m}-01`, periodEnd: end, runType: "off_cycle", offCycleReason: "final_settlement", targetEmployeeId: empId } as never);
    await f.payroll.calculateRun(f.hr, run.id);
    await f.submitAndApprove(run.id);
    return run.id;
  }

  describe("opening the settlement (LIF-05 -> PAY-14)", () => {
    it("opens one settlement when a termination takes effect, once, and when a scheduled one is applied", async () => {
      const y = nextYear();
      const a = await leaver({ lastDay: `${y}-03-15` });
      expect(a.settlementId).toBeDefined();
      const s = await settlements.get(f.hr, a.settlementId);
      expect(s).toMatchObject({ status: "open", employeeId: a.emp.id, lastWorkingDay: `${y}-03-15`, isImmutable: false, lines: [] });
      expect(await f.sql("SELECT 1 FROM payroll_final_settlements WHERE employee_id = $1", [a.emp.id])).toHaveLength(1);

      const emp = await f.createEmployee({ terminationDate: `${y}-04-10` });
      const ev = await f.sql<{ id: string }>(
        "INSERT INTO employee_lifecycle_events (company_id, employee_id, action_type, effective_date, status, source_channel) VALUES ($1, $2, 'termination', $3, 'scheduled', 'system') RETURNING id",
        [f.companyId, emp.id, `${y}-04-10`]
      );
      expect(await f.sql("SELECT 1 FROM payroll_final_settlements WHERE termination_event_id = $1", [ev[0].id])).toHaveLength(0);
      await f.sql("UPDATE employee_lifecycle_events SET status = 'applied' WHERE id = $1", [ev[0].id]);
      expect(await f.sql("SELECT 1 FROM payroll_final_settlements WHERE termination_event_id = $1", [ev[0].id])).toHaveLength(1);
    });

    it("keeps settlements to their tenant and to people with payroll permissions", async () => {
      const y = nextYear();
      const a = await leaver({ lastDay: `${y}-03-15` });
      await expect(settlements.get(f.staff, a.settlementId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(settlements.calculate(f.staff, a.settlementId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(settlements.get(other.hr, a.settlementId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(otherSettlements.calculate(other.hr, a.settlementId)).rejects.toBeInstanceOf(NotFoundException);
      expect((await otherSettlements.list(other.hr)).map((s) => s.id)).not.toContain(a.settlementId);
    });
  });

  describe("calculation (PAY-14)", () => {
    it("computes service in completed months, counting the last working day", () => {
      expect(completedMonths("2070-01-01", "2072-06-30")).toBe(30);
      expect(completedMonths("2070-01-15", "2072-06-30")).toBe(29);
      expect(completedMonths("2070-01-31", "2070-01-30")).toBe(0);
    });

    it("explains what it cannot compute until the tenant has configured it, and never invents a figure", async () => {
      const y = nextYear();
      await setSettings({ leaveEncashmentEnabled: false, noticeRecoveryEnabled: false, dailyRateDivisor: null });
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y - 2}-01-01` });
      await f.sql("INSERT INTO leave_types (company_id, code, name, encashable) VALUES ($1, 'enc_a', 'Encashable A', true) ON CONFLICT DO NOTHING", [f.companyId]);
      const ledger = new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit);
      await f.db.withClaims(f.hr, (c) => ledger.post(c, { companyId: f.companyId, employeeId: l.emp.id, leaveType: "enc_a", year: y, entryType: "opening", days: 10, sourceType: "test" }));
      await f.sql(
        "INSERT INTO employee_offboarding (company_id, employee_id, reason, last_working_day, notice_period_days, notice_start_date, termination_event_id) VALUES ($1,$2,'resignation',$3,30,$4,$5)",
        [f.companyId, l.emp.id, `${y}-06-30`, `${y}-06-21`, l.eventId]
      );
      await schemes.upsertScheme(f.hr, { code: "gratuity_a", schemeType: "gratuity", name: "Gratuity A", effectiveFrom: "2020-01-01", parameters: { daysPerYearOfService: 15 } });
      const v = await settlements.calculate(f.hr, l.settlementId);
      expect(v.status).toBe("calculated");
      expect(line(v, "leave_encashment")).toMatchObject({ amount: 0, settleVia: "info" });
      expect(line(v, "leave_encashment")!.warning).toMatch(/not enabled/);
      expect(line(v, "gratuity")).toMatchObject({ amount: 0, settleVia: "info" });
      expect(line(v, "gratuity")!.warning).toMatch(/dailyRateDivisor/);
      expect(line(v, "notice_recovery")!.warning).toMatch(/not enabled/);
      expect(v.lines.every((x) => x.amount === 0)).toBe(true);
    });

    it("computes leave encashment, gratuity, notice recovery, provident fund and loans from the tenant's own figures", async () => {
      const y = nextYear();
      await setSettings({ leaveEncashmentEnabled: true, leaveEncashmentTaxable: true, noticeRecoveryEnabled: true, dailyRateDivisor: 25 });
      await resetSchemes();
      await schemes.upsertScheme(f.hr, { code: "gratuity_b", schemeType: "gratuity", name: "Gratuity B", effectiveFrom: "2020-01-01", parameters: { daysPerYearOfService: 15, minimumServiceMonths: 12, dailyRateDivisor: 26, serviceRounding: "pro_rata", isTaxable: true } });
      await schemes.upsertScheme(f.hr, { code: "pf_b", schemeType: "provident_fund", name: "Provident fund B", effectiveFrom: "2020-01-01", parameters: { employerVestingMonths: 60 } });
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y - 2}-01-01`, salary: 100000 }); // 30 months of service
      await f.sql("INSERT INTO leave_types (company_id, code, name, encashable) VALUES ($1, 'enc_b', 'Encashable B', true) ON CONFLICT DO NOTHING", [f.companyId]);
      const ledger = new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit);
      await f.db.withClaims(f.hr, (c) => ledger.post(c, { companyId: f.companyId, employeeId: l.emp.id, leaveType: "enc_b", year: y, entryType: "opening", days: 10, sourceType: "test" }));
      await f.sql(
        "INSERT INTO employee_offboarding (company_id, employee_id, reason, last_working_day, notice_period_days, notice_start_date, termination_event_id) VALUES ($1,$2,'resignation',$3,30,$4,$5)",
        [f.companyId, l.emp.id, `${y}-06-30`, `${y}-06-21`, l.eventId]
      );
      const acc = await schemes.openAccount(f.hr, l.emp.id, "pf_b");
      await schemes.postEntry(f.hr, acc.id, { entryType: "opening_balance", amount: 30000 });
      await f.sql("INSERT INTO employee_scheme_ledger (company_id, account_id, entry_type, amount) VALUES ($1, $2, 'employer_contribution', 12000)", [f.companyId, acc.id]);
      await f.loans.create(f.hr, { employeeId: l.emp.id, loanType: "loan", principalAmount: 9000, installmentAmount: 3000, issuedDate: `${y}-01-10` } as never);

      const v = await settlements.calculate(f.hr, l.settlementId);
      expect(line(v, "leave_encashment")).toMatchObject({ amount: 40000, settleVia: "payslip", isTaxable: true }); // 10 days x 100000 / 25
      expect(line(v, "gratuity")).toMatchObject({ settleVia: "payslip", schemeCode: "gratuity_b" });
      expect(line(v, "gratuity")!.amount).toBe(r2(15 * 2.5 * (100000 / 26)));
      expect(line(v, "notice_recovery")).toMatchObject({ amount: -80000, settleVia: "payslip" }); // 30 - 10 served = 20 days x 4000
      // 42000 balance, of which 12000 is the employer's share, forfeited below the 60-month vesting period
      expect(line(v, "provident_fund")).toMatchObject({ amount: 30000, settleVia: "scheme_ledger", schemeCode: "pf_b" });
      expect(line(v, "provident_fund")!.basis).toMatchObject({ balance: 42000, employerShare: 12000, forfeitedEmployerShare: 12000 });
      expect(line(v, "loan_outstanding")).toMatchObject({ amount: -9000, settleVia: "run_result" });
      expect(v.calculationSequence).toBe(1);
      const again = await settlements.calculate(f.hr, l.settlementId);
      expect(again.calculationSequence).toBe(2);
      expect(again.lines.filter((x) => x.kind === "gratuity")).toHaveLength(1);
    });

    it("pays no gratuity below the scheme's minimum service", async () => {
      const y = nextYear();
      await setSettings({ dailyRateDivisor: 25 });
      await resetSchemes();
      await schemes.upsertScheme(f.hr, { code: "gratuity_min", schemeType: "gratuity", name: "Gratuity min", effectiveFrom: "2020-01-01", parameters: { daysPerYearOfService: 15, minimumServiceMonths: 12, dailyRateDivisor: 26, serviceRounding: "pro_rata" } });
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y}-03-01` });
      const v = await settlements.calculate(f.hr, l.settlementId);
      expect(line(v, "gratuity")).toMatchObject({ amount: 0, settleVia: "info" });
      expect(line(v, "gratuity")!.warning).toMatch(/below the scheme's minimum/);
    });
  });

  describe("approval, finalisation and reversal (PAY-14)", () => {
    it("needs a second person, creates the payments, and can be withdrawn before they are paid", async () => {
      const y = nextYear();
      await setSettings({ leaveEncashmentEnabled: true, noticeRecoveryEnabled: true, dailyRateDivisor: 25 });
      await resetSchemes();
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y - 3}-01-01` });
      await f.sql(
        "INSERT INTO employee_offboarding (company_id, employee_id, reason, last_working_day, notice_period_days, notice_start_date, termination_event_id) VALUES ($1,$2,'resignation',$3,30,$4,$5)",
        [f.companyId, l.emp.id, `${y}-06-30`, `${y}-06-21`, l.eventId]
      );
      await expect(settlements.approve(f.approver, l.settlementId)).rejects.toThrow(/Only a calculated settlement/);
      await settlements.calculate(f.hr, l.settlementId);
      await expect(settlements.approve(f.hr, l.settlementId)).rejects.toBeInstanceOf(ForbiddenException); // hr holds no approve permission
      await f.sql("UPDATE payroll_final_settlements SET calculated_by = $2 WHERE id = $1", [l.settlementId, f.approver.sub]);
      await expect(settlements.approve(f.approver, l.settlementId)).rejects.toThrow(/cannot approve/);
      await settlements.calculate(f.hr, l.settlementId);
      const approved = await settlements.approve(f.approver, l.settlementId);
      expect(approved).toMatchObject({ status: "approved", approvedBy: f.approver.sub });
      const pays = await f.sql<{ payment_type: string; amount: string; effective_date: Date; status: string; is_taxable: boolean }>(
        "SELECT * FROM employee_additional_payments WHERE employee_id = $1 ORDER BY payment_type", [l.emp.id]);
      expect(pays.map((p) => [p.payment_type, Number(p.amount), p.status])).toEqual([["deduction", 80000, "pending"]]); // no leave on record; notice recovery only
      await expect(settlements.calculate(f.hr, l.settlementId)).rejects.toThrow(/withdraw its approval/);
      await expect(settlements.cancel(f.hr, l.settlementId, "no")).rejects.toThrow(/withdraw its approval/);
      const back = await settlements.withdrawApproval(f.approver, l.settlementId, "Notice waived");
      expect(back.status).toBe("calculated");
      expect((await f.sql<{ status: string }>("SELECT status FROM employee_additional_payments WHERE employee_id = $1", [l.emp.id]))[0].status).toBe("cancelled");
      const cancelled = await settlements.cancel(f.hr, l.settlementId, "Employee withdrew resignation");
      expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Employee withdrew resignation" });
    });

    it("pays through the final run, closes with an immutable result, posts the ledgers, and reverses with the run", async () => {
      const y = nextYear();
      await setSettings({ leaveEncashmentEnabled: true, leaveEncashmentTaxable: true, noticeRecoveryEnabled: true, dailyRateDivisor: 25 });
      await resetSchemes();
      await schemes.upsertScheme(f.hr, { code: "pf_c", schemeType: "provident_fund", name: "Provident fund C", effectiveFrom: "2020-01-01", parameters: {} });
      await schemes.upsertScheme(f.hr, { code: "gratuity_c", schemeType: "gratuity", name: "Gratuity C", effectiveFrom: "2020-01-01", parameters: { daysPerYearOfService: 10, minimumServiceMonths: 0, dailyRateDivisor: 30, serviceRounding: "complete_years", isTaxable: true } });
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y - 4}-01-01`, salary: 100000 }); // 54 months -> 4 complete years
      await f.sql("INSERT INTO leave_types (company_id, code, name, encashable) VALUES ($1, 'enc_c', 'Encashable C', true) ON CONFLICT DO NOTHING", [f.companyId]);
      const ledger = new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit);
      await f.db.withClaims(f.hr, (c) => ledger.post(c, { companyId: f.companyId, employeeId: l.emp.id, leaveType: "enc_c", year: y, entryType: "opening", days: 5, sourceType: "test" }));
      const acc = await schemes.openAccount(f.hr, l.emp.id, "pf_c");
      await schemes.postEntry(f.hr, acc.id, { entryType: "opening_balance", amount: 25000 });
      await f.loans.create(f.hr, { employeeId: l.emp.id, loanType: "loan", principalAmount: 6000, installmentAmount: 3000, issuedDate: `${y}-01-10` } as never);

      const calculated = await settlements.calculate(f.hr, l.settlementId);
      const encash = line(calculated, "leave_encashment")!.amount;
      const gratuity = line(calculated, "gratuity")!.amount;
      expect(encash).toBe(20000); // 5 days x 100000 / 25
      expect(gratuity).toBe(r2(10 * 4 * (100000 / 30)));

      await settlements.approve(f.approver, l.settlementId);
      const runId = await finalRun(l.emp.id, `${y}-06-30`);
      await f.payroll.finalizeRun(f.hr, runId);

      const done = await settlements.get(f.hr, l.settlementId);
      expect(done).toMatchObject({ status: "finalized", isImmutable: true, payrollRunId: runId });
      const slip = (await f.sql<{ gross_pay: string; net_pay: string; income_tax_monthly: string }>("SELECT * FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2", [runId, l.emp.id]))[0];
      expect(done.result).toMatchObject({ netPay: Number(slip.net_pay), grossPay: Number(slip.gross_pay), incomeTax: Number(slip.income_tax_monthly) });
      // the payslip-side lines add up to the net pay exactly
      const payslipSide = r2(done.lines.filter((x) => ["payslip", "run_result"].includes(x.settleVia)).reduce((a, x) => a + x.amount, 0));
      expect(payslipSide).toBe(Number(slip.net_pay));
      expect(line(done, "salary_due")).toBeDefined();
      expect(line(done, "tax_finalization")!.amount).toBeCloseTo(-Number(slip.income_tax_monthly), 2);
      expect(line(done, "loan_outstanding")!.basis).not.toHaveProperty("estimate");
      expect(await f.sql("SELECT 1 FROM employee_additional_payments WHERE employee_id = $1 AND status = 'consumed'", [l.emp.id])).toHaveLength(2);

      // ledgers: the provident fund paid out and closed, the leave encashed
      const entries = await schemes.listLedger(f.hr, acc.id);
      expect(entries.map((e) => [e.entryType, e.amount])).toEqual([["opening_balance", 25000], ["payout", -25000]]);
      expect((await schemes.listAccounts(f.hr, l.emp.id))[0]).toMatchObject({ status: "closed", balance: 0 });
      const bal = await f.sql<{ entitled_days: string }>("SELECT entitled_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'enc_c' AND year = $2", [l.emp.id, y]);
      expect(Number(bal[0].entitled_days)).toBe(0);

      // immutable
      await expect(f.sql("UPDATE payroll_final_settlements SET result_snapshot = '{}'::jsonb WHERE id = $1", [l.settlementId])).rejects.toThrow(/immutable/);
      await expect(f.sql("UPDATE payroll_final_settlement_lines SET amount = 1 WHERE settlement_id = $1", [l.settlementId])).rejects.toThrow(/immutable/);
      await expect(f.sql("DELETE FROM payroll_final_settlement_lines WHERE settlement_id = $1", [l.settlementId])).rejects.toThrow(/immutable/);
      await expect(f.sql("DELETE FROM payroll_final_settlements WHERE id = $1", [l.settlementId])).rejects.toThrow(/cannot be deleted/);
      await expect(f.sql("UPDATE employee_scheme_ledger SET amount = 1 WHERE account_id = $1", [acc.id])).rejects.toThrow(/append-only|permission denied/);

      // reversal of the run reverses the settlement, gives the provident fund and leave back
      await f.payroll.reverseRun(f.hr, runId, { reason: "Wrong gratuity" });
      expect((await settlements.get(f.hr, l.settlementId)).status).toBe("reversed");
      const after = await schemes.listLedger(f.hr, acc.id);
      expect(after.map((e) => e.entryType)).toEqual(["opening_balance", "payout", "reversal"]);
      expect((await schemes.listAccounts(f.hr, l.emp.id))[0]).toMatchObject({ status: "active", balance: 25000 });
      const bal2 = await f.sql<{ entitled_days: string }>("SELECT entitled_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'enc_c' AND year = $2", [l.emp.id, y]);
      expect(Number(bal2[0].entitled_days)).toBe(5);
    }, 60000);

    it("stops the final run from being finalised while a calculated settlement waits for approval", async () => {
      const y = nextYear();
      await resetSchemes();
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y - 1}-01-01` });
      await settlements.calculate(f.hr, l.settlementId);
      const runId = await finalRun(l.emp.id, `${y}-06-30`);
      await expect(f.payroll.finalizeRun(f.hr, runId)).rejects.toThrow(/approve \(or cancel\) it/);
      expect((await f.sql<{ status: string }>("SELECT status FROM payroll_runs WHERE id = $1", [runId]))[0].status).toBe("approved");
      await settlements.cancel(f.hr, l.settlementId, "Not needed");
      await f.payroll.finalizeRun(f.hr, runId);
    });

    it("finalises a final run for an employee whose settlement was never calculated, with the payslip result only", async () => {
      const y = nextYear();
      const l = await leaver({ lastDay: `${y}-06-30`, joined: `${y - 1}-01-01` });
      const runId = await finalRun(l.emp.id, `${y}-06-30`);
      await f.payroll.finalizeRun(f.hr, runId);
      const done = await settlements.get(f.hr, l.settlementId);
      expect(done.status).toBe("finalized");
      expect(done.result).toMatchObject({ hadCalculation: false });
      expect(done.lines.map((x) => x.kind)).toEqual(expect.arrayContaining(["salary_due", "tax_finalization"]));
    });
  });

  describe("scheme definitions and ledgers (PAY-15)", () => {
    it("versions a scheme by effective date, validates its parameters and reports what is missing", async () => {
      const code = `sch_${Date.now() % 100000}`;
      const v1 = await schemes.upsertScheme(f.hr, { code, schemeType: "gratuity", name: "Gratuity", effectiveFrom: "2021-01-01", parameters: { daysPerYearOfService: 20 } });
      expect(v1).toMatchObject({ isComplete: false, effectiveTo: null });
      expect(v1.missingParameters).toEqual(expect.arrayContaining(["minimumServiceMonths", "dailyRateDivisor", "serviceRounding"]));
      const v2 = await schemes.upsertScheme(f.hr, { code, effectiveFrom: "2023-01-01", parameters: { daysPerYearOfService: 30, minimumServiceMonths: 12, dailyRateDivisor: 30, serviceRounding: "complete_years" } });
      expect(v2.isComplete).toBe(true);
      const history = (await schemes.listSchemes(f.hr, true)).filter((s) => s.code === code);
      expect(history.map((s) => [s.effectiveFrom, s.effectiveTo])).toEqual([["2023-01-01", null], ["2021-01-01", "2022-12-31"]]);
      await expect(schemes.upsertScheme(f.hr, { code, effectiveFrom: "2022-06-01", parameters: {} })).rejects.toThrow(/after the latest/);
      await expect(schemes.upsertScheme(f.hr, { code, effectiveFrom: "2024-01-01", schemeType: "provident_fund" })).rejects.toThrow(/type cannot change/);
      await expect(schemes.upsertScheme(f.hr, { code: `${code}x`, schemeType: "gratuity", name: "x", effectiveFrom: "2024-01-01", parameters: { dailyRateDivisor: 0 } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(schemes.upsertScheme(f.hr, { code: `${code}y`, schemeType: "provident_fund", name: "x", effectiveFrom: "2024-01-01", parameters: { daysPerYearOfService: 5 } })).rejects.toThrow(/gratuity scheme only/);
      await expect(schemes.upsertScheme(f.hr, { code: `${code}z`, schemeType: "other", name: "x", effectiveFrom: "2024-01-01", parameters: { rate: 12 } as never })).rejects.toThrow(/Unknown scheme parameter/);
      await expect(schemes.upsertScheme(f.staff, { code, effectiveFrom: "2025-01-01" })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("keeps an append-only ledger: opening balance once, withdrawals within the balance, reversals once", async () => {
      await schemes.upsertScheme(f.hr, { code: "pf_ledger", schemeType: "provident_fund", name: "PF", effectiveFrom: "2020-01-01" });
      const e = await f.createEmployee({});
      const acc = await schemes.openAccount(f.hr, e.id, "pf_ledger");
      await expect(schemes.openAccount(f.hr, e.id, "pf_ledger")).rejects.toThrow(/already has an account/);
      await expect(schemes.openAccount(f.hr, e.id, "nonexistent")).rejects.toBeInstanceOf(NotFoundException);
      await schemes.postEntry(f.hr, acc.id, { entryType: "opening_balance", amount: 1000 });
      await expect(schemes.postEntry(f.hr, acc.id, { entryType: "opening_balance", amount: 5 })).rejects.toThrow(/already has an opening balance/);
      await expect(schemes.postEntry(f.hr, acc.id, { entryType: "withdrawal", amount: 1500 })).rejects.toThrow(/cannot go below zero/);
      await expect(schemes.postEntry(f.hr, acc.id, { entryType: "adjustment", amount: 10 })).rejects.toThrow(/needs a note/);
      const w = await schemes.postEntry(f.hr, acc.id, { entryType: "withdrawal", amount: 400, note: "Approved withdrawal" });
      expect(w.amount).toBe(-400);
      const rev = await schemes.reverseEntry(f.hr, w.id, "Entered in error");
      expect(rev).toMatchObject({ entryType: "reversal", amount: 400, reversesEntryId: w.id });
      await expect(schemes.reverseEntry(f.hr, w.id, "again")).rejects.toThrow(/already been reversed/);
      await expect(schemes.reverseEntry(f.hr, rev.id, "again")).rejects.toThrow(/cannot itself be reversed/);
      expect((await schemes.listAccounts(f.hr, e.id))[0].balance).toBe(1000);
      await expect(schemes.postEntry(f.staff, acc.id, { entryType: "adjustment", amount: 1, note: "x" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.sql("DELETE FROM employee_scheme_ledger WHERE account_id = $1", [acc.id])).rejects.toThrow(/append-only|permission denied/);
    });

    it("posts the contributions a finalised run carries, once, and takes them back when the run is reversed", async () => {
      const y = nextYear();
      const pfEmp = await f.compensation.createCompensationComponent(f.hr, { name: `PF employee ${Date.now()}`, componentType: "deduction", calculationType: "fixed" } as never) as CompensationComponentView;
      const pfEr = await f.compensation.createCompensationComponent(f.hr, { name: `PF employer ${Date.now()}`, componentType: "employer_contribution", calculationType: "fixed" } as never) as CompensationComponentView;
      await schemes.upsertScheme(f.hr, { code: "pf_posting", schemeType: "provident_fund", name: "PF posting", effectiveFrom: "2020-01-01", parameters: { employeeComponentKey: pfEmp.key, employerComponentKey: pfEr.key } });
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await f.compensation.setCompensationComponents(f.hr, { employeeId: e.id, effectiveFrom: "2020-01-01", components: [{ componentId: pfEmp.id, amount: 2500 }, { componentId: pfEr.id, amount: 2500 }] } as never);
      const runId = await f.finalizedRun(`${y}-01-01`, `${y}-01-31`);
      const acc = (await schemes.listAccounts(f.hr, e.id))[0];
      expect(acc).toMatchObject({ schemeCode: "pf_posting", balance: 5000 });
      const entries = await schemes.listLedger(f.hr, acc.id);
      expect(entries.map((x) => [x.entryType, x.amount, x.payrollRunId])).toEqual(expect.arrayContaining([["employee_contribution", 2500, runId], ["employer_contribution", 2500, runId]]));
      await f.payroll.reverseRun(f.hr, runId, { reason: "Rerun" });
      expect((await schemes.listAccounts(f.hr, e.id))[0].balance).toBe(0);
      expect((await schemes.listLedger(f.hr, acc.id)).filter((x) => x.entryType === "reversal")).toHaveLength(2);
    }, 60000);

    it("keeps settlement settings to people allowed to configure payroll and validates the divisor", async () => {
      await expect(schemes.getSettlementSettings(f.staff)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(setSettings({ dailyRateDivisor: 0 })).rejects.toBeInstanceOf(BadRequestException);
      const s = await setSettings({ dailyRateDivisor: 26, noticeRecoveryEnabled: true });
      expect(s).toMatchObject({ dailyRateDivisor: 26, noticeRecoveryEnabled: true });
      expect((await new PayrollSchemesService(other.db, other.rbac, other.entitlements, other.audit).getSettlementSettings(other.hr)).dailyRateDivisor).toBeNull();
      // the other tenant's services registered last took the hooks; this tenant's go back in place
      schemes = new PayrollSchemesService(f.db, f.rbac, f.entitlements, f.audit);
      settlements = new PayrollFinalSettlementService(f.db, f.rbac, f.entitlements, f.audit, schemes, new LeaveLedgerService(f.db, f.rbac, f.entitlements, f.audit));
    });
  });
});
