import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { addMonthsClamped, buildSchedule, installmentFor } from "../employees/loan-schedule";
import { InboxService } from "../workflow/inbox.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { WorkProfileService } from "../leave/work-profile.service";
import { LocationsService } from "../organization/locations.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { resolveCompanyMonthlyHours } from "../leave/work-time-defaults";
import { resolveStatutoryJurisdiction } from "./payroll-jurisdiction";

/** Gap Register Step 10A - PAY-13 (loan schedules and policy), PAY-24 (working-time defaults), PAY-28 (jurisdiction). */
describe("Loan schedules, working-time defaults and jurisdiction (Step 10A)", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let appr: PayrollFixture;
  let loans: EmployeeLoansService;
  let year = 2050; // each test uses its own year so the runs of one never touch another's periods

  beforeAll(async () => {
    f = await buildPayrollFixture("l10a");
    other = await buildPayrollFixture("l10b");
    appr = await buildPayrollFixture("l10c");
    loans = new EmployeeLoansService(f.db, f.rbac, f.entitlements, f.audit);
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
    await appr.cleanup();
  });

  const nextYear = () => ++year;
  const deductionsOf = async (runId: string, employeeId: string) => {
    const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((s) => s.employeeId === employeeId)!;
    return slip.loanDeductions;
  };
  const calc = async (start: string, end: string) => {
    const run = await f.payroll.createRun(f.hr, { periodStart: start, periodEnd: end });
    await f.payroll.calculateRun(f.hr, run.id);
    return run.id;
  };
  const newLoan = (employeeId: string, y: number, extra: Record<string, unknown> = {}) =>
    loans.create(f.hr, { employeeId, loanType: "loan", principalAmount: 9000, installmentAmount: 3000, issuedDate: `${y}-01-10`, ...extra } as never);

  describe("schedule arithmetic", () => {
    it("builds equal instalments with a remainder in the last, and keeps the day of month through short months", () => {
      const rows = buildSchedule(10000, 3000, "2051-01-31");
      expect(rows.map((r) => r.amount)).toEqual([3000, 3000, 3000, 1000]);
      expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(10000);
      expect(rows.map((r) => r.dueDate)).toEqual(["2051-01-31", "2051-02-28", "2051-03-31", "2051-04-30"]);
      expect(addMonthsClamped("2052-01-31", 1)).toBe("2052-02-29"); // leap year
      expect(installmentFor(10000, 3)).toBe(3333.34);
    });
  });

  describe("creating a loan (PAY-13)", () => {
    it("creates the repayment schedule with the loan, from either an instalment or a count", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const byAmount = await newLoan(e.id, y);
      expect(byAmount).toMatchObject({ status: "active", installmentsCount: 3, hasSchedule: true, deductionStartDate: `${y}-01-10`, outstandingBalance: 9000 });
      const rows = await loans.getSchedule(f.hr, byAmount.id);
      expect(rows.map((r) => [r.installmentNo, r.dueDate, r.amount, r.status])).toEqual([
        [1, `${y}-01-10`, 3000, "scheduled"], [2, `${y}-02-10`, 3000, "scheduled"], [3, `${y}-03-10`, 3000, "scheduled"],
      ]);
      const byCount = await loans.create(f.hr, { employeeId: e.id, loanType: "salary_advance", principalAmount: 10000, installmentsCount: 3, issuedDate: `${y}-01-10`, deductionStartDate: `${y}-02-01` } as never);
      expect(byCount.installmentAmount).toBe(3333.34);
      const rows2 = await loans.getSchedule(f.hr, byCount.id);
      expect(rows2.map((r) => r.amount)).toEqual([3333.34, 3333.34, 3333.32]);
      expect(rows2[0].dueDate).toBe(`${y}-02-01`);
      await expect(loans.create(f.hr, { employeeId: e.id, loanType: "loan", principalAmount: 1000, issuedDate: `${y}-01-10` } as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("checks the loan type's policy limits against the employee's earnings, and its guarantor rule", async () => {
      const y = nextYear();
      const type = await loans.createType(f.hr, { code: `staff_${y}`, name: "Staff loan", kind: "loan", maxInstallmentPercent: 10, maxPrincipalMultiple: 1, maxInstallments: 12, requiresGuarantor: true });
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const g = await f.createEmployee({ monthlySalary: 100000 });
      const base = { employeeId: e.id, loanType: "loan", issuedDate: `${y}-01-10`, loanTypeId: type.id, guarantorEmployeeId: g.id };
      // 10% of 100,000 = 10,000 a month; 1 x 100,000 at most; 12 instalments at most
      await expect(loans.create(f.hr, { ...base, principalAmount: 60000, installmentAmount: 12000 } as never)).rejects.toThrow(/above 10%/);
      await expect(loans.create(f.hr, { ...base, principalAmount: 350000, installmentAmount: 10000 } as never)).rejects.toThrow(/at most 12 instalments/);
      await expect(loans.create(f.hr, { ...base, principalAmount: 110000, installmentAmount: 10000 } as never)).rejects.toThrow(/above 1 times/);
      await expect(loans.create(f.hr, { ...base, principalAmount: 60000, installmentAmount: 10000, guarantorEmployeeId: undefined } as never)).rejects.toThrow(/requires a guarantor/);
      await expect(loans.create(f.hr, { ...base, principalAmount: 60000, installmentAmount: 10000, guarantorEmployeeId: e.id } as never)).rejects.toThrow(/own loan/);
      const ok = await loans.create(f.hr, { ...base, principalAmount: 60000, installmentAmount: 10000 } as never);
      expect(ok).toMatchObject({ loanTypeId: type.id, loanTypeName: "Staff loan", guarantorEmployeeId: g.id, installmentsCount: 6 });
      // the type decides the kind
      await expect(loans.create(f.hr, { ...base, loanType: "salary_advance", principalAmount: 1000, installmentAmount: 500 } as never)).rejects.toBeInstanceOf(BadRequestException);
      // a limit needs earnings to measure against
      const none = await f.createEmployee({ monthlySalary: null });
      await expect(loans.create(f.hr, { ...base, employeeId: none.id, principalAmount: 1000, installmentAmount: 500, guarantorEmployeeId: g.id } as never)).rejects.toThrow(/no earnings on record/);
    });

    it("seeds the two original types without limits, refuses duplicates, and keeps changes to the catalogue off issued loans", async () => {
      const types = await loans.listTypes(f.hr);
      expect(types.map((t) => t.code)).toEqual(expect.arrayContaining(["loan", "salary_advance"]));
      expect(types.find((t) => t.code === "loan")).toMatchObject({ maxInstallmentPercent: null, maxPrincipalMultiple: null, maxInstallments: null });
      await expect(loans.createType(f.hr, { code: "loan", name: "Again", kind: "loan" })).rejects.toBeInstanceOf(ConflictException);
      await expect(loans.createType(f.hr, { code: "Bad Code", name: "x", kind: "loan" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(loans.createType(f.hr, { code: "pct_bad", name: "x", kind: "loan", maxInstallmentPercent: 150 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("lets only people who manage employees change loans or the catalogue", async () => {
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await expect(loans.create(f.staff, { employeeId: e.id, loanType: "loan", principalAmount: 1000, installmentAmount: 500, issuedDate: "2051-01-01" } as never)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(loans.createType(f.staff, { code: "nope", name: "Nope", kind: "loan" })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("payroll consumes the schedule", () => {
    it("recovers only the instalments due by the period end, marks them paid at finalize, and catches up a missed month", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await newLoan(e.id, y);

      expect(await deductionsOf(await calc(`${y}-01-01`, `${y}-01-31`), e.id)).toEqual([{ loanId: loan.id, amount: 3000 }]);
      const run = (await f.payroll.listRuns(f.hr)).find((r) => r.periodStart === `${y}-01-01`)!;
      await f.submitAndApprove(run.id);
      await f.payroll.finalizeRun(f.hr, run.id);
      let rows = await loans.getSchedule(f.hr, loan.id);
      expect(rows[0]).toMatchObject({ status: "paid", paidAmount: 3000, paidRunId: run.id });
      expect(rows[1].status).toBe("scheduled");
      expect((await loans.list(f.hr, e.id))[0].outstandingBalance).toBe(6000);

      // February is never run; March recovers the two instalments that are due by then
      expect(await deductionsOf(await calc(`${y}-03-01`, `${y}-03-31`), e.id)).toEqual([{ loanId: loan.id, amount: 6000 }]);
      const marRun = (await f.payroll.listRuns(f.hr)).find((r) => r.periodStart === `${y}-03-01`)!;
      await f.submitAndApprove(marRun.id);
      await f.payroll.finalizeRun(f.hr, marRun.id);
      rows = await loans.getSchedule(f.hr, loan.id);
      expect(rows.map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
      expect((await loans.list(f.hr, e.id))[0]).toMatchObject({ outstandingBalance: 0, status: "closed", closedReason: "repaid" });
    });

    it("does not recover an instalment before it is due", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await newLoan(e.id, y, { deductionStartDate: `${y}-06-15` });
      expect(await deductionsOf(await calc(`${y}-05-01`, `${y}-05-31`), e.id)).toEqual([]);
    });

    it("keeps the fixed instalment for a loan created before schedules, and lets HR give it a schedule", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const legacy = (
        await f.sql<{ id: string }>(
          `INSERT INTO employee_loans (company_id, employee_id, loan_type, principal_amount, installment_amount, outstanding_balance, issued_date, created_by_user_account_id)
           VALUES ($1,$2,'loan',5000,2000,5000,$3,$4) RETURNING id`,
          [f.companyId, e.id, `${y}-01-01`, f.hr.uid]
        )
      )[0];
      expect((await loans.list(f.hr, e.id))[0]).toMatchObject({ hasSchedule: false });
      expect(await deductionsOf(await calc(`${y}-01-01`, `${y}-01-31`), e.id)).toEqual([{ loanId: legacy.id, amount: 2000 }]);
      const rows = await loans.generateSchedule(f.hr, legacy.id, { startDate: `${y}-02-01` });
      expect(rows.map((r) => r.amount)).toEqual([2000, 2000, 1000]);
      await expect(loans.generateSchedule(f.hr, legacy.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("hold, skip and settlement", () => {
    it("holds recovery without losing the schedule, and resumes it from a later date", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await newLoan(e.id, y);
      await expect(loans.hold(f.hr, loan.id, { reason: "x" })).rejects.toBeInstanceOf(BadRequestException);
      const held = await loans.hold(f.hr, loan.id, { reason: "Medical leave" });
      expect(held).toMatchObject({ status: "on_hold", holdReason: "Medical leave" });
      expect(await deductionsOf(await calc(`${y}-01-01`, `${y}-01-31`), e.id)).toEqual([]);
      const resumed = await loans.resume(f.hr, loan.id, { resumeFrom: `${y}-04-15` });
      expect(resumed).toMatchObject({ status: "active", holdReason: null });
      expect((await loans.getSchedule(f.hr, loan.id)).map((r) => r.dueDate)).toEqual([`${y}-04-15`, `${y}-05-15`, `${y}-06-15`]);
      await expect(loans.resume(f.hr, loan.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("skips an instalment by adding an identical one at the end, and refuses to skip one already paid", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await newLoan(e.id, y);
      await expect(loans.skipInstallments(f.hr, loan.id, { installmentNos: [2], reason: "" })).rejects.toBeInstanceOf(BadRequestException);
      const rows = await loans.skipInstallments(f.hr, loan.id, { installmentNos: [2], reason: "Eid expenses" });
      expect(rows.map((r) => [r.installmentNo, r.status, r.dueDate])).toEqual([
        [1, "scheduled", `${y}-01-10`], [2, "skipped", `${y}-02-10`], [3, "scheduled", `${y}-03-10`], [4, "scheduled", `${y}-04-10`],
      ]);
      expect((await loans.list(f.hr, e.id))[0].outstandingBalance).toBe(9000);
      await expect(loans.skipInstallments(f.hr, loan.id, { installmentNos: [2], reason: "again" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(loans.skipInstallments(f.hr, loan.id, { installmentNos: [9], reason: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("settles early through payroll: the next run recovers the whole balance and closes the loan", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await newLoan(e.id, y);
      const settled = await loans.settle(f.hr, loan.id, { mode: "payroll" });
      expect(settled.settlementRequested).toBe(true);
      const runId = await calc(`${y}-01-01`, `${y}-01-31`);
      expect(await deductionsOf(runId, e.id)).toEqual([{ loanId: loan.id, amount: 9000 }]);
      const detail = await f.payroll.getPayslipDetail(f.hr, (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((s) => s.employeeId === e.id)!.id);
      expect(detail.components.find((c) => c.key === "loan_repayment")).toBeDefined();
      await f.submitAndApprove(runId);
      await f.payroll.finalizeRun(f.hr, runId);
      expect((await loans.list(f.hr, e.id))[0]).toMatchObject({ status: "closed", outstandingBalance: 0, settlementRequested: false });
      expect((await loans.getSchedule(f.hr, loan.id)).map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
    });

    it("can withdraw a payroll settlement request, and records a cash repayment against the schedule", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await loans.create(f.hr, { employeeId: e.id, loanType: "loan", principalAmount: 10000, installmentAmount: 2500, issuedDate: `${y}-01-10` } as never);
      await loans.settle(f.hr, loan.id, { mode: "payroll" });
      expect((await loans.settle(f.hr, loan.id, { mode: "withdraw" })).settlementRequested).toBe(false);

      await expect(loans.settle(f.hr, loan.id, { mode: "cash", amount: 20000, receivedOn: `${y}-01-20` })).rejects.toThrow(/exceeds the outstanding/);
      await expect(loans.settle(f.hr, loan.id, { mode: "cash", amount: 2500 })).rejects.toThrow(/receivedOn/);
      const partial = await loans.settle(f.hr, loan.id, { mode: "cash", amount: 2500, receivedOn: `${y}-01-20`, reference: "CHQ-1" });
      expect(partial).toMatchObject({ outstandingBalance: 7500, status: "active" });
      expect((await loans.getSchedule(f.hr, loan.id))[0].status).toBe("paid");
      const full = await loans.settle(f.hr, loan.id, { mode: "cash", amount: 7500, receivedOn: `${y}-01-25` });
      expect(full).toMatchObject({ outstandingBalance: 0, status: "closed", closedReason: "early_settlement" });
      expect((await loans.getSchedule(f.hr, loan.id)).every((r) => r.status === "paid")).toBe(true);
      const repayments = await loans.listRepayments(f.hr, loan.id);
      expect(repayments.map((r) => [r.source, r.amount, r.payslipId])).toEqual([["cash", 2500, null], ["cash", 7500, null]]);
      await expect(loans.hold(f.hr, loan.id, { reason: "closed already" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("cancels the open instalments with the loan", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await newLoan(e.id, y);
      await loans.cancel(f.hr, loan.id, { reason: "Entered in error" });
      expect((await loans.getSchedule(f.hr, loan.id)).every((r) => r.status === "cancelled")).toBe(true);
      expect(await deductionsOf(await calc(`${y}-01-01`, `${y}-01-31`), e.id)).toEqual([]);
    });
  });

  describe("approval (PAY-13)", () => {
    it("recovers nothing until the workflow approves the loan, and drops a rejected one", async () => {
      const y = nextYear();
      const svc = new EmployeeLoansService(appr.db, appr.rbac, appr.entitlements, appr.audit, appr.workflow);
      const inbox = new InboxService(appr.db, appr.rbac, appr.audit, appr.workflow, appr.workflow.adapters, new LocalFileStorageService());
      await appr.workflow.createTemplate(appr.hr, {
        key: "employee_loan", name: "Loan approval", objectKey: "employee_loan",
        steps: [{ stepOrder: 1, name: "Review", approvers: [{ approverType: "specific_user", userAccountId: appr.approver.uid }] }],
      } as never);
      const e = await appr.createEmployee({ monthlySalary: 100000 });
      const loan = await svc.create(appr.hr, { employeeId: e.id, loanType: "loan", principalAmount: 9000, installmentAmount: 3000, issuedDate: `${y}-01-10` } as never);
      expect(loan).toMatchObject({ status: "pending_approval", approvalStatus: "pending" });
      const run = await appr.payroll.createRun(appr.hr, { periodStart: `${y}-01-01`, periodEnd: `${y}-01-31` });
      await appr.payroll.calculateRun(appr.hr, run.id);
      const slipOf = async () => (await appr.payroll.listPayslips(appr.hr, { payrollRunId: run.id })).find((s) => s.employeeId === e.id)!;
      expect((await slipOf()).loanDeductions).toEqual([]);

      const instance = (await appr.workflow.listInstancesForRecord(appr.hr, "employee_loan", loan.id))[0];
      await inbox.decide(appr.approver, instance.id, { decision: "approved" } as never);
      expect((await svc.list(appr.hr, e.id))[0]).toMatchObject({ status: "active", approvalStatus: "approved" });
      await appr.payroll.calculateRun(appr.hr, run.id);
      expect((await slipOf()).loanDeductions).toEqual([{ loanId: loan.id, amount: 3000 }]);

      const second = await svc.create(appr.hr, { employeeId: e.id, loanType: "salary_advance", principalAmount: 1000, installmentAmount: 500, issuedDate: `${y}-01-10` } as never);
      const instance2 = (await appr.workflow.listInstancesForRecord(appr.hr, "employee_loan", second.id))[0];
      await inbox.decide(appr.approver, instance2.id, { decision: "rejected", comment: "Not eligible" } as never);
      expect((await svc.list(appr.hr, e.id)).find((l) => l.id === second.id)).toMatchObject({ status: "rejected", approvalStatus: "rejected" });
      expect((await svc.getSchedule(appr.hr, second.id)).every((r) => r.status === "cancelled")).toBe(true);
    });
  });

  describe("tenant isolation", () => {
    it("keeps loans, schedules and loan types of one company invisible to another", async () => {
      const y = nextYear();
      const e = await f.createEmployee({ monthlySalary: 100000 });
      const loan = await newLoan(e.id, y);
      const foreign = new EmployeeLoansService(other.db, other.rbac, other.entitlements, other.audit);
      await expect(foreign.getSchedule(other.hr, loan.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(foreign.hold(other.hr, loan.id, { reason: "not mine" })).rejects.toBeInstanceOf(NotFoundException);
      const ownTypes = await loans.listTypes(f.hr, true);
      const foreignTypes = await foreign.listTypes(other.hr, true);
      expect(foreignTypes.some((t) => ownTypes.some((o) => o.id === t.id))).toBe(false);
      await expect(foreign.updateType(other.hr, ownTypes[0].id, { name: "Hijack" })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("working-time defaults (PAY-24)", () => {
    it("keeps the standard hours with working time: an old payroll-settings write goes through, and the work profile still wins", async () => {
      const workProfiles = new WorkProfileService(f.db, f.rbac, f.entitlements, f.audit, new EffectiveDatingEngine());
      const before = await workProfiles.companyDefault(f.hr);
      expect(["built_in", "payroll_settings", "work_time_defaults"]).toContain(before.source);

      await f.payroll.updateSettings(f.hr, { standardMonthlyHours: 180 } as never);
      const viaSettings = await workProfiles.companyDefault(f.hr);
      expect(viaSettings).toMatchObject({ standardMonthlyHours: 180, source: "work_time_defaults" });

      const set = await workProfiles.setCompanyDefault(f.hr, { standardMonthlyHours: 190, standardWeeklyHours: 44 });
      expect(set).toMatchObject({ standardMonthlyHours: 190, standardWeeklyHours: 44, source: "work_time_defaults" });
      const today = new Date().toISOString().slice(0, 10);
      expect(await f.db.withClaims(f.hr, (c) => resolveCompanyMonthlyHours(c, f.companyId, today))).toBe(190);

      await expect(workProfiles.setCompanyDefault(f.hr, { standardMonthlyHours: 50 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(workProfiles.setCompanyDefault(f.staff, { standardMonthlyHours: 190 })).rejects.toBeInstanceOf(ForbiddenException);

      // an employee's own profile still wins over the tenant default
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await workProfiles.set(f.hr, e.id, { monthlyHours: 150 } as never);
      expect(await f.db.withClaims(f.hr, (c) => workProfiles.monthlyHoursAsOf(c, e.id, today))).toBe(150);
    });

    it("does not show one company's default to another", async () => {
      const mine = new WorkProfileService(f.db, f.rbac, f.entitlements, f.audit, new EffectiveDatingEngine());
      const theirs = new WorkProfileService(other.db, other.rbac, other.entitlements, other.audit, new EffectiveDatingEngine());
      await mine.setCompanyDefault(f.hr, { standardMonthlyHours: 201 });
      expect((await theirs.companyDefault(other.hr)).standardMonthlyHours).not.toBe(201);
    });
  });

  describe("statutory jurisdiction (PAY-28)", () => {
    it("takes the jurisdiction from the nearest place up the location tree, else from the payroll area, and records it on the payslip", async () => {
      const y = nextYear();
      const locations = new LocationsService(f.db, f.rbac, f.entitlements, f.audit, new EffectiveDatingEngine());
      const province = await locations.create(f.hr, { name: `Province ${y}`, locationType: "region" } as never);
      const city = await locations.create(f.hr, { name: `City ${y}`, locationType: "city", parentId: province.id } as never);
      const site = await locations.create(f.hr, { name: `Site ${y}`, locationType: "site", parentId: city.id } as never);
      const e = await f.createEmployee({ monthlySalary: 100000 });
      await f.sql("UPDATE employees SET location_id = $2 WHERE id = $1", [e.id, site.id]);

      const none = await f.db.withClaims(f.hr, (c) => resolveStatutoryJurisdiction(c, e.id));
      expect(none).toMatchObject({ code: null, source: "none" });

      await expect(locations.setStatutoryJurisdiction(f.hr, province.id, "Not Valid")).rejects.toBeInstanceOf(BadRequestException);
      await expect(locations.setStatutoryJurisdiction(f.staff, province.id, "north")).rejects.toBeInstanceOf(ForbiddenException);
      const set = await locations.setStatutoryJurisdiction(f.hr, province.id, "north");
      expect(set.statutoryJurisdiction).toBe("north");
      const fromTree = await f.db.withClaims(f.hr, (c) => resolveStatutoryJurisdiction(c, e.id));
      expect(fromTree).toMatchObject({ code: "north", source: "location", locationId: province.id });

      // a nearer place overrides the one above it
      await locations.setStatutoryJurisdiction(f.hr, city.id, "coastal");
      expect((await f.db.withClaims(f.hr, (c) => resolveStatutoryJurisdiction(c, e.id))).code).toBe("coastal");

      const runId = await calc(`${y}-01-01`, `${y}-01-31`);
      const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((s) => s.employeeId === e.id)!;
      const snap = (await f.sql<{ snapshot: { jurisdiction: { code: string; source: string } } }>("SELECT snapshot FROM payroll_input_snapshots WHERE payslip_id = $1", [slip.id]))[0];
      expect(snap.snapshot.jurisdiction).toMatchObject({ code: "coastal", source: "location" });

      // no location jurisdiction: the payroll area's applies
      const noLoc = await f.createEmployee({ monthlySalary: 100000 });
      const area = await f.sql<{ id: string }>("INSERT INTO payroll_areas (company_id, code, name, jurisdiction) VALUES ($1, $2, 'Area', 'inland') RETURNING id", [f.companyId, `AR${y}`]);
      await f.sql("UPDATE employees SET payroll_area_id = $2 WHERE id = $1", [noLoc.id, area[0].id]);
      expect(await f.db.withClaims(f.hr, (c) => resolveStatutoryJurisdiction(c, noLoc.id))).toMatchObject({ code: "inland", source: "payroll_area" });
    });
  });
});
