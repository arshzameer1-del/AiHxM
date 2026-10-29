import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";

/**
 * A salary that is prorated by scheduled working days (an assigned Mon-Fri schedule: 23 working days in July) must still
 * be projected as twelve full months for tax. It used to fall back to the daily-rate path (23 working days never equals 31
 * calendar days), which projected 11,185,483.87 for the year instead of 11,400,000 and under-withheld ~1,640 a month.
 */
describe("Income tax projection for a full month prorated by working days", () => {
  let f: PayrollFixture;

  beforeAll(async () => {
    f = await buildPayrollFixture("taxproj");
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("a Mon-Fri employee on 950,000 a month is taxed on 11,400,000 a year: 2,964,000, i.e. 247,000 in July", async () => {
    const shiftId = (
      await f.sql<{ id: string }>("INSERT INTO shifts (company_id, name, start_time, end_time, is_default) VALUES ($1, 'Office Hours (Mon-Fri)', '09:00', '17:00', false) RETURNING id", [f.companyId])
    )[0].id;
    for (let dow = 0; dow <= 6; dow++) {
      const working = dow >= 1 && dow <= 5;
      await f.sql("INSERT INTO work_schedule_days (company_id, shift_id, day_of_week, is_working, start_time, end_time) VALUES ($1,$2,$3,$4,$5,$6)", [
        f.companyId, shiftId, dow, working, working ? "09:00" : null, working ? "17:00" : null,
      ]);
    }
    const emp = await f.createEmployee({ dateOfJoining: "2020-01-01", monthlySalary: 950000 });
    await f.sql("INSERT INTO shift_assignments (company_id, employee_id, shift_id, effective_from, created_by_user_account_id) VALUES ($1,$2,$3,'2020-01-01',$4)", [
      f.companyId, emp.id, shiftId, f.hr.sub,
    ]);

    const run = await f.payroll.createRun(f.hr, { periodStart: "2036-07-01", periodEnd: "2036-07-31" });
    const result = await f.payroll.calculateRun(f.hr, run.id);
    expect(result.errors.filter((e) => e.employeeId === emp.id)).toEqual([]);
    const slip = (await f.payroll.listPayslips(f.hr, { payrollRunId: run.id })).find((p) => p.employeeId === emp.id)!;

    // the pay really is prorated by working days (the situation the bug needed)
    expect(slip.calculationBreakdown.some((s) => String(s.label).startsWith("Proration basis: scheduled working days"))).toBe(true);
    expect(slip.grossPay).toBe(950000);
    const projected = slip.calculationBreakdown.find((s) => String(s.label).startsWith("Estimated full tax-year taxable income"))!;
    expect(projected.value).toBe(11400000);
    // company slabs: 7,000,000+ is 1,424,000 + 35% of the excess -> 1,424,000 + 0.35 x 4,400,000 = 2,964,000
    expect(slip.incomeTaxMonthly).toBeCloseTo(247000, 2);
    expect(slip.netPay).toBeCloseTo(950000 - 247000 - slip.eobiEmployeeContribution, 2);
  });
});
