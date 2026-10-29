import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { RULES, SmartChecksService } from "./smart-checks.service";

/** The smart checks against real Postgres: each rule fires on a planted case, stays quiet on clean data, and dismissals stick. */
describe("Smart checks", () => {
  let f: PayrollFixture;
  let svc: SmartChecksService;
  let staff: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  const finding = async (key: string) => (await svc.run(f.hr)).findings.find((x) => x.ruleKey === key)!;
  const emp = (over: Parameters<PayrollFixture["createEmployee"]>[0] = {}) => f.createEmployee(over);
  const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

  beforeAll(async () => {
    f = await buildPayrollFixture("smc1");
    svc = new SmartChecksService(f.db, f.rbac, f.entitlements, f.audit);
    staff = await f.makeUser("smc-staff", ["employee_self_service"]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("is for HR only, and every rule's query is valid", async () => {
    await expect(svc.run(staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.dismiss(staff, { ruleKey: "shared_bank_account", subjectKey: "x", reason: "fine" })).rejects.toBeInstanceOf(ForbiddenException);
    const report = await svc.run(f.hr);
    expect(report.findings.map((x) => x.ruleKey).sort()).toEqual(RULES.map((r) => r.key).sort());
    expect(report.totalOpen).toBe(report.high + report.medium);
  });

  it("flags a shared bank account, with the people named", async () => {
    const a = await emp();
    const b = await emp();
    for (const e of [a, b]) {
      await f.sql(
        `INSERT INTO employee_payment_accounts (company_id, employee_id, payment_method, account_number_bidx, status, approval_status) VALUES ($1,$2,'bank_transfer','bidx-shared','active','approved')`,
        [f.companyId, e.id]
      );
    }
    const bank = await finding("shared_bank_account");
    expect(bank.severity).toBe("high");
    expect(bank.count).toBe(1);
    expect(bank.samples[0]!.label).toContain(a.employeeNumber);
    expect(bank.samples[0]!.label).toContain(b.employeeNumber);
  });

  it("flags a leaver who still holds roles, but not one whose roles were taken away, nor a current employee", async () => {
    const live = await emp({ userAccountId: staff.uid, terminationDate: day(-10) });
    await f.sql("UPDATE employees SET employment_status = 'terminated' WHERE id = $1", [live.id]);
    const strippedUser = await f.makeUser("smc-stripped", []);
    const stripped = await emp({ userAccountId: strippedUser.uid, terminationDate: day(-10) });
    await f.sql("UPDATE employees SET employment_status = 'terminated' WHERE id = $1", [stripped.id]);
    const currentUser = await f.makeUser("smc-current", ["employee_self_service"]);
    const current = await emp({ userAccountId: currentUser.uid });
    const r = await finding("leaver_keeps_access");
    expect(r.severity).toBe("high");
    expect(r.samples.map((s) => s.employeeId)).toContain(live.id);
    expect(r.samples.find((s) => s.employeeId === live.id)!.detail).toMatch(/still holds 1 role/);
    expect(r.samples.map((s) => s.employeeId)).not.toContain(stripped.id);
    expect(r.samples.map((s) => s.employeeId)).not.toContain(current.id);
  });

  it("flags a circular reporting line", async () => {
    const x = await emp();
    const y = await emp();
    await f.sql("UPDATE employees SET manager_id = $2 WHERE id = $1", [x.id, y.id]);
    await f.sql("UPDATE employees SET manager_id = $2 WHERE id = $1", [y.id, x.id]);
    const r = await finding("reporting_loop");
    expect(r.samples.map((s) => s.employeeId).sort()).toEqual([x.id, y.id].sort());
  });

  it("flags no salary and no bank account after 30 days, not for a new joiner", async () => {
    const old = await emp({ monthlySalary: null, dateOfJoining: day(-90) });
    const fresh = await emp({ monthlySalary: null, dateOfJoining: day(-5) });
    const paid = await emp({ monthlySalary: 100000, dateOfJoining: day(-90) });
    const nosal = await finding("no_salary");
    expect(nosal.samples.map((s) => s.employeeId)).toContain(old.id);
    expect(nosal.samples.map((s) => s.employeeId)).not.toContain(fresh.id);
    expect(nosal.samples.map((s) => s.employeeId)).not.toContain(paid.id);
    const nobank = await finding("no_payment_account");
    expect(nobank.samples.map((s) => s.employeeId)).toContain(old.id);
    expect(nobank.samples.map((s) => s.employeeId)).not.toContain(fresh.id);
  });

  it("flags a salary far from the designation's median, only with enough peers", async () => {
    const peers = [];
    for (let i = 0; i < 4; i++) peers.push(await emp({ monthlySalary: 100000 }));
    const high = await emp({ monthlySalary: 600000 });
    const lonely = await emp({ monthlySalary: 900000 });
    for (const e of [...peers, high]) await f.sql("UPDATE employees SET designation = 'Analyst' WHERE id = $1", [e.id]);
    await f.sql("UPDATE employees SET designation = 'Only One' WHERE id = $1", [lonely.id]);
    const r = await finding("salary_outlier");
    expect(r.samples.map((s) => s.employeeId)).toContain(high.id);
    expect(r.samples.map((s) => s.employeeId)).not.toContain(lonely.id);
    expect(r.samples.map((s) => s.employeeId)).not.toContain(peers[0]!.id);
  });

  it("flags repeated absence", async () => {
    const e = await emp();
    const once = await emp();
    for (let i = 1; i <= 4; i++) await f.sql("INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status) VALUES ($1,$2,$3,'absent')", [f.companyId, e.id, day(-i)]);
    await f.sql("INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status) VALUES ($1,$2,$3,'absent')", [f.companyId, once.id, day(-1)]);
    const r = await finding("repeat_absence");
    expect(r.samples.map((s) => s.employeeId)).toContain(e.id);
    expect(r.samples.map((s) => s.employeeId)).not.toContain(once.id);
  });

  it("flags a big swing in take-home between two payslips", async () => {
    const e = await emp({ monthlySalary: 100000 });
    await f.finalizedRun("2025-01-01", "2025-01-31");
    await f.compensation.setCompensation(f.hr, { employeeId: e.id, monthlySalary: 300000, effectiveFrom: "2025-02-01" });
    await f.finalizedRun("2025-02-01", "2025-02-28");
    const r = await finding("payslip_swing");
    expect(r.samples.map((s) => s.employeeId)).toContain(e.id);
    expect(r.samples.find((s) => s.employeeId === e.id)!.detail).toMatch(/% change/);
  }, 120000);

  it("a dismissal removes the finding with its reason, and restoring brings it back", async () => {
    const before = await finding("reporting_loop");
    const target = before.samples[0]!;
    await expect(svc.dismiss(f.hr, { ruleKey: "nope", subjectKey: "x", reason: "fine" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.dismiss(f.hr, { ruleKey: "reporting_loop", subjectKey: target.subjectKey, reason: " " })).rejects.toBeInstanceOf(BadRequestException);
    await svc.dismiss(f.hr, { ruleKey: "reporting_loop", subjectKey: target.subjectKey, reason: "Temporary during the restructure" });
    const after = await finding("reporting_loop");
    expect(after.count).toBe(before.count - 1);
    expect(after.dismissedCount).toBe(1);
    const list = await svc.listDismissed(f.hr);
    expect(list[0]).toMatchObject({ ruleKey: "reporting_loop", reason: "Temporary during the restructure" });
    await svc.restore(f.hr, list[0]!.id);
    expect((await finding("reporting_loop")).count).toBe(before.count);
    await expect(svc.restore(f.hr, list[0]!.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
