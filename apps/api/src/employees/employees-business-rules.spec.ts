import { BadRequestException } from "@nestjs/common";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";
import { EmployeesService } from "./employees.service";
import { EmployeeDataConsistencyService } from "./employee-data-consistency.service";

/** Business sense checks found by probing the live API: dates that cannot be, money that cannot be recovered, duplicate hires. */
describe("Employees: business rules", () => {
  let f: PayrollFixture;
  let lifecycle: EmployeeLifecycleService;
  let employees: EmployeesService;
  let consistency: EmployeeDataConsistencyService;
  const msg = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const r = (e as BadRequestException).getResponse() as string | { message: string };
      return typeof r === "string" ? r : r.message;
    }
    throw new Error("expected the request to be refused");
  };

  beforeAll(async () => {
    f = await buildPayrollFixture("empbiz");
    lifecycle = new EmployeeLifecycleService(f.db, f.rbac, f.entitlements, f.audit);
    employees = new EmployeesService(f.db, f.rbac, f.entitlements, f.audit, new LocalFileStorageService());
    consistency = new EmployeeDataConsistencyService(f.db, f.entitlements, f.rbac, f.audit);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("a termination cannot be dated before the person joined, and cannot be recorded twice", async () => {
    const e = await f.createEmployee({ dateOfJoining: "2024-03-01", monthlySalary: null });
    expect(await msg(lifecycle.terminate(f.hr, e.id, { terminationDate: "2020-01-01" }))).toContain("before the joining date");
    const done = await lifecycle.terminate(f.hr, e.id, { terminationDate: "2026-10-20", terminationReason: "resigned" });
    expect(done.employee.employmentStatus).toBe("terminated");
    expect(await msg(lifecycle.terminate(f.hr, e.id, { terminationDate: "2026-10-25" }))).toContain("already terminated");
    // the end date on file did not move
    expect((await f.sql("SELECT termination_date::text AS d FROM employees WHERE id = $1", [e.id]))[0].d).toBe("2026-10-20");
  });

  it("loans: sensible amounts, dates and instalments only; nothing for someone who has left", async () => {
    const e = await f.createEmployee({ dateOfJoining: "2024-03-01", monthlySalary: 80000 });
    const base = { employeeId: e.id, loanType: "loan" as const, principalAmount: 12000, installmentsCount: 12, issuedDate: "2026-10-01" };
    expect((await f.loans.create(f.hr, base)).principalAmount).toBe(12000);
    expect(await msg(f.loans.create(f.hr, { ...base, principalAmount: 1000.005 }))).toContain("two decimal places");
    expect(await msg(f.loans.create(f.hr, { ...base, principalAmount: 5e9 }))).toContain("too large");
    expect(await msg(f.loans.create(f.hr, { ...base, installmentsCount: undefined, installmentAmount: 1 }))).toContain("more than 600");
    expect(await msg(f.loans.create(f.hr, { ...base, issuedDate: "1900-01-01" }))).toContain("too far in the past");
    expect(await msg(f.loans.create(f.hr, { ...base, deductionStartDate: "2020-01-01" }))).toContain("before the loan is issued");
    await lifecycle.terminate(f.hr, e.id, { terminationDate: "2026-10-20" });
    expect(await msg(f.loans.create(f.hr, base))).toContain("terminated employee");
  });

  it("pay changes: not after leaving, not at absurd dates or amounts", async () => {
    const e = await f.createEmployee({ dateOfJoining: "2024-03-01", monthlySalary: null });
    const set = (monthlySalary: number, effectiveFrom: string) => f.compensation.setCompensation(f.hr, { employeeId: e.id, monthlySalary, effectiveFrom });
    expect(await msg(set(50000, "1900-01-01"))).toContain("too far in the past");
    expect(await msg(set(50000, "2900-01-01"))).toContain("too far ahead");
    expect(await msg(set(5e9, "2024-03-01"))).toContain("too large");
    await set(80000, "2024-03-01");
    await lifecycle.terminate(f.hr, e.id, { terminationDate: "2026-10-20" });
    expect(await msg(set(90000, "2026-11-01"))).toContain("left on 2026-10-20");
  });

  it("two active records for the same CNIC are allowed (a genuine second role) but the data-consistency report lists them", async () => {
    const cnic = `35202-${String(Date.now()).slice(-7)}-1`;
    const first = await employees.create(f.hr, { firstName: "Sara", lastName: "Dup", employmentType: "permanent", dateOfJoining: "2024-03-01", cnic });
    const second = await employees.create(f.hr, { firstName: "Sara", lastName: "Dup", employmentType: "permanent", dateOfJoining: "2025-01-01", cnic });
    expect(second.id).not.toBe(first.id);
    const report = await consistency.getReport(f.hr);
    const check = report.checks.find((c) => c.id === "same_person_two_active_records");
    expect(check?.count).toBeGreaterThanOrEqual(2);
    expect(check?.fixable).toBe(false);
    expect(check?.samples.map((x) => x.employeeNumber)).toEqual(expect.arrayContaining([first.employeeNumber, second.employeeNumber]));
    // someone who has left is not a duplicate any more
    await lifecycle.terminate(f.hr, first.id, { terminationDate: "2025-06-30" });
    const after = (await consistency.getReport(f.hr)).checks.find((c) => c.id === "same_person_two_active_records");
    expect(after?.samples.map((x) => x.employeeNumber) ?? []).not.toEqual(expect.arrayContaining([second.employeeNumber]));
  });
});
