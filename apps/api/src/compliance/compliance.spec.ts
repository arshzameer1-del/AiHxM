import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { RULES, SmartChecksService } from "../smart-checks/smart-checks.service";
import { ComplianceService } from "./compliance.service";

describe("Statutory working papers", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let svc: ComplianceService;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  beforeAll(async () => {
    f = await buildPayrollFixture("cmp1");
    other = await buildPayrollFixture("cmp2");
    svc = new ComplianceService(f.db, f.rbac, f.entitlements, f.audit);
    ess = await f.makeUser("ess1", ["employee_self_service"]);
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("only HR can use the minimum wage table, levies and the statement", async () => {
    await expect(svc.listMinimumWages(ess)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.listLevies(ess)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.annualSalaryStatement(ess, 2070)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("starts empty: no minimum wage or levy ships with the product", async () => {
    expect(await svc.listMinimumWages(f.hr)).toEqual([]);
    expect(await svc.listLevies(f.hr)).toEqual([]);
  });

  it("keeps a dated minimum wage per province and refuses a duplicate or nonsense", async () => {
    const list = await svc.saveMinimumWage(f.hr, { province: "Sindh", monthlyAmount: 40000, effectiveFrom: "2070-07-01", sourceNote: "Notification typed in by finance" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ province: "Sindh", monthlyAmount: 40000 });
    await expect(svc.saveMinimumWage(f.hr, { province: "sindh", monthlyAmount: 41000, effectiveFrom: "2070-07-01" })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.saveMinimumWage(f.hr, { province: "", monthlyAmount: 1, effectiveFrom: "2070-07-01" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.saveMinimumWage(f.hr, { province: "Punjab", monthlyAmount: 0, effectiveFrom: "2070-07-01" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.saveMinimumWage(f.hr, { province: "Punjab", monthlyAmount: 10, effectiveFrom: "tomorrow" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the smart check flags a salary under the minimum for the employee's province, and not one above it", async () => {
    const loc = (await f.sql<{ id: string }>("INSERT INTO locations (company_id, name, location_type, statutory_jurisdiction) VALUES ($1,'Karachi office','site','sindh') RETURNING id", [f.companyId]))[0].id;
    const low = await f.createEmployee({ monthlySalary: 30000 });
    const fine = await f.createEmployee({ monthlySalary: 60000 });
    await f.sql("UPDATE employees SET location_id = $2 WHERE id = ANY($1)", [[low.id, fine.id], loc]);
    const rule = RULES.find((r) => r.key === "below_minimum_wage")!;
    expect(rule).toBeDefined();
    const found = await f.db.withClaims(f.hr, async (c) => (await c.query(rule.sql, ["2071-01-15"])).rows);
    const ids = found.map((r: { employee_id: string }) => r.employee_id);
    expect(ids).toContain(low.id);
    expect(ids).not.toContain(fine.id);
    const report = await new SmartChecksService(f.db, f.rbac, f.entitlements, f.audit).run(f.hr);
    expect(JSON.stringify(report)).toContain("below_minimum_wage");
  });

  it("a worksheet is base x rate for review; a final one is frozen", async () => {
    const w = await svc.createLevy(f.hr, { kind: "wwf", fiscalYear: "2070-71", baseLabel: "Profit before tax", baseAmount: 1_000_000, ratePercent: 2 });
    expect(w).toMatchObject({ amount: 20000, status: "draft" });
    await expect(svc.createLevy(f.hr, { kind: "wppf", fiscalYear: "2070-71", baseLabel: "x", baseAmount: -1, ratePercent: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createLevy(f.hr, { kind: "wppf", fiscalYear: "2070-71", baseLabel: "x", baseAmount: 10, ratePercent: 101 })).rejects.toBeInstanceOf(BadRequestException);
    const fin = await svc.finalizeLevy(f.hr, w.id);
    expect(fin.status).toBe("final");
    await expect(svc.finalizeLevy(f.hr, w.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.deleteLevy(f.hr, w.id)).rejects.toBeInstanceOf(ConflictException);
    const draft = await svc.createLevy(f.hr, { kind: "wppf", fiscalYear: "2070-71", baseLabel: "Profit", baseAmount: 500, ratePercent: 5 });
    await svc.deleteLevy(f.hr, draft.id);
    expect(await svc.listLevies(f.hr)).toHaveLength(1);
  });

  it("another company sees none of it", async () => {
    const o = new ComplianceService(other.db, other.rbac, other.entitlements, other.audit);
    expect(await o.listMinimumWages(other.hr)).toEqual([]);
    expect(await o.listLevies(other.hr)).toEqual([]);
  });

  it("the annual statement totals the payslips of finalised runs in the 1 July to 30 June year, and downloads as CSV", async () => {
    const a = await f.createEmployee({ monthlySalary: 150000 });
    await f.sql("UPDATE employees SET cnic = '35202-1234567-1' WHERE id = $1", [a.id]);
    const r1 = await f.finalizedRun("2070-09-01", "2070-09-30");
    const r2 = await f.finalizedRun("2070-10-01", "2070-10-31");
    await f.finalizedRun("2071-07-01", "2071-07-31"); // next tax year: must not count
    const v = await svc.annualSalaryStatement(f.hr, 2070);
    expect(v).toMatchObject({ taxYearStart: "2070-07-01", taxYearEnd: "2071-06-30", runCount: 2 });
    const slips = await f.sql<{ gross_pay: string; income_tax_monthly: string }>("SELECT gross_pay, income_tax_monthly FROM payslips WHERE payroll_run_id = ANY($1)", [[r1, r2]]);
    expect(v.totals.grossPay).toBeCloseTo(slips.reduce((x, s) => x + Number(s.gross_pay), 0), 1);
    expect(v.totals.taxWithheld).toBeCloseTo(slips.reduce((x, s) => x + Number(s.income_tax_monthly), 0), 1);
    expect(v.rows.find((x) => x.employeeNumber === a.employeeNumber)).toMatchObject({ monthsPaid: 2, cnic: "35202-1234567-1" });
    const csv = await svc.annualSalaryStatementCsv(f.hr, 2070);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("tax_year_start");
    expect(lines.length).toBe(v.rows.length + 2);
    expect(lines[lines.length - 1]).toContain(",TOTAL,");
    await expect(svc.annualSalaryStatement(f.hr, 1)).rejects.toBeInstanceOf(BadRequestException);
    const empty = await svc.annualSalaryStatement(f.hr, 2060);
    expect(empty.rows).toEqual([]);
  });
});
