import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { sensitive } from "../crypto/sensitive-fields";
import { PayrollStatutoryReportsService } from "./payroll-statutory-reports.service";

/** Statutory reports (income tax withheld, EOBI, social security) of a finalised run. */
describe("Payroll statutory reports", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let reports: PayrollStatutoryReportsService;
  let otherReports: PayrollStatutoryReportsService;
  let runId: string;
  let withCnic: string;

  const build = (fx: PayrollFixture) => new PayrollStatutoryReportsService(fx.db, fx.rbac, fx.entitlements, fx.audit);

  beforeAll(async () => {
    f = await buildPayrollFixture("stat");
    other = await buildPayrollFixture("stat2");
    reports = build(f);
    otherReports = build(other);
    const a = await f.createEmployee({ monthlySalary: 150000 });
    await f.createEmployee({ monthlySalary: 90000 });
    withCnic = a.employeeNumber;
    await f.sql("UPDATE employees SET cnic = '35202-1234567-1' WHERE id = $1", [a.id]);
    runId = await f.finalizedRun("2071-03-01", "2071-03-31");
  }, 90000);

  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  });

  it("the income tax statement lists everyone with the tax the payslips withheld, and the totals add up", async () => {
    const r = await reports.get(f.hr, runId, "income_tax");
    expect(r).toMatchObject({ kind: "income_tax", periodStart: "2071-03-01", periodEnd: "2071-03-31", omittedCount: 0 });
    expect(r.columns.map((c) => c.key)).toEqual(["grossPay", "taxableIncome", "taxWithheld"]);
    const slips = await f.sql<{ employee_number: string; income_tax_monthly: string; gross_pay: string }>("SELECT employee_number, income_tax_monthly, gross_pay FROM payslips WHERE payroll_run_id = $1", [runId]);
    expect(r.rows).toHaveLength(slips.length);
    for (const s of slips) {
      const row = r.rows.find((x) => x.employeeNumber === s.employee_number)!;
      expect(row.values[2]).toBeCloseTo(Number(s.income_tax_monthly), 2);
      expect(row.values[0]).toBeCloseTo(Number(s.gross_pay), 2);
    }
    expect(r.totals[2]).toBeCloseTo(slips.reduce((a, s) => a + Number(s.income_tax_monthly), 0), 1);
    expect(r.rows.find((x) => x.employeeNumber === withCnic)!.cnic).toBe("35202-1234567-1");
    expect(r.missingCnicCount).toBe(r.rows.length - 1);
  });

  it("EOBI lists only people who have a contribution; a report with nothing in it says so with a count", async () => {
    const eobi = await reports.get(f.hr, runId, "eobi");
    expect(eobi.rows.length).toBeGreaterThan(0);
    expect(eobi.totals[0]).toBeGreaterThan(0);
    expect(eobi.rows.length + eobi.omittedCount).toBe((await f.sql("SELECT 1 FROM payslips WHERE payroll_run_id = $1", [runId])).length);
    const ss = await reports.get(f.hr, runId, "social_security");
    expect(ss.rows.length + ss.omittedCount).toBe((await f.sql("SELECT 1 FROM payslips WHERE payroll_run_id = $1", [runId])).length);
  });

  it("downloads as a CSV with a header, one line per person and a total", async () => {
    const csv = await reports.csv(f.hr, runId, "income_tax");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("period_start,period_end,employee_number,employee_name,cnic,Gross pay,Taxable income this period,Tax withheld");
    expect(lines.length).toBe((await reports.get(f.hr, runId, "income_tax")).rows.length + 2);
    expect(lines[lines.length - 1]).toContain(",TOTAL,");
    expect(csv).toContain("35202-1234567-1");
  });

  it("the challan working file lists the registration number and what to pay, and refuses an unknown layout", async () => {
    const people = await f.sql<{ employee_number: string }>("SELECT employee_number FROM payslips WHERE payroll_run_id = $1 ORDER BY employee_number", [runId]);
    const first = (await f.sql<{ id: string }>("SELECT id FROM employees WHERE employee_number = $1 AND company_id = $2", [people[0].employee_number, f.companyId]))[0].id;
    await f.sql("INSERT INTO employee_statutory_ids (company_id, employee_id, eobi_number) VALUES ($1,$2,$3)", [f.companyId, first, sensitive.encrypt(f.companyId, "EOBI-998877")]);
    const report = await reports.get(f.hr, runId, "eobi");
    expect(report.registrationLabel).toBe("EOBI number");
    expect(report.rows.find((r) => r.employeeNumber === people[0].employee_number)?.registration).toBe("EOBI-998877");
    expect(report.missingRegistrationCount).toBe(report.rows.length - 1);
    const lines = (await reports.csv(f.hr, runId, "eobi", "challan")).trim().split("\n");
    expect(lines[0]).toBe("month,employee_number,employee_name,cnic,EOBI number,Employee share,Employer share,amount_payable");
    expect(lines[1].startsWith("2071-03,")).toBe(true);
    const row = report.rows.find((r) => r.employeeNumber === people[0].employee_number)!;
    expect(lines.find((l) => l.includes("EOBI-998877"))).toContain(`,${(row.values[0] + row.values[1]).toFixed(2)}`);
    expect(lines[lines.length - 1]).toContain(",TOTAL,");
    const tax = (await reports.csv(f.hr, runId, "income_tax", "challan")).trim().split("\n");
    expect(tax[0]).toBe("month,employee_number,employee_name,cnic,Tax withheld,amount_payable");
    await expect(reports.csv(f.hr, runId, "eobi", "weird")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is refused for a run that is not finalised, for an unknown report, for a login without payroll rights, and across tenants", async () => {
    const draft = await f.payroll.createRun(f.hr, { periodStart: "2071-04-01", periodEnd: "2071-04-30" });
    await expect(reports.get(f.hr, draft.id, "income_tax")).rejects.toBeInstanceOf(BadRequestException);
    await expect(reports.get(f.hr, runId, "nonsense")).rejects.toBeInstanceOf(BadRequestException);
    await expect(reports.get(f.staff, runId, "income_tax")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(otherReports.get(other.hr, runId, "income_tax")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a viewing is recorded in the audit log", async () => {
    await reports.get(f.hr, runId, "eobi");
    const rows = await f.sql("SELECT 1 FROM audit_log WHERE action = 'payroll_statutory_report.view' AND target = $1", [runId]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
