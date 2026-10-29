import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";

/** R3: days the attendance evaluation marks absent reduce pay (opt-in), and HR sees who is affected before the run. */
describe("Payroll absence deduction from attendance (R3)", () => {
  let f: PayrollFixture;
  let empId: string;
  let lateOnlyId: string;

  const att = (employeeId: string, date: string, status: string) =>
    f.sql(
      `INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET status = EXCLUDED.status`,
      [f.companyId, employeeId, date, status]
    );
  const slipFor = async (runId: string, employeeId: string) => (await f.payroll.listPayslips(f.hr, { payrollRunId: runId })).find((p) => p.employeeId === employeeId)!;

  beforeAll(async () => {
    f = await buildPayrollFixture("absence");
    empId = (await f.createEmployee({ userAccountId: f.staff.uid, monthlySalary: 93000 })).id;
  }, 60000);
  afterAll(async () => {
    await f.cleanup();
  });

  it("changes nothing while the setting is off (default)", async () => {
    await att(empId, "2027-03-03", "absent");
    const run = await f.payroll.createRun(f.hr, { periodStart: "2027-03-01", periodEnd: "2027-03-31" });
    await f.payroll.calculateRun(f.hr, run.id);
    const slip = await slipFor(run.id, empId);
    expect(slip.grossPay).toBe(93000);
  });

  it("deducts each absent day (and half a day for a half-day result) at the daily rate when switched on, with a preview first", async () => {
    await f.payroll.updateSettings(f.hr, { absenceDeductionMode: "absent_days" });
    await att(empId, "2027-04-05", "absent");
    await att(empId, "2027-04-06", "absent");
    await att(empId, "2027-04-07", "half_day");
    await att(empId, "2027-04-08", "present");
    await att(empId, "2027-04-09", "on_leave"); // leave is handled by the leave rules, never counted here
    const run = await f.payroll.createRun(f.hr, { periodStart: "2027-04-01", periodEnd: "2027-04-30" });

    const check = await f.control.preValidate(f.hr, run.id);
    const hit = check.findings.find((x) => x.code === "ABSENCE_DEDUCTION" && x.employeeId === empId);
    expect(hit?.message).toMatch(/2\.5 day/);
    expect(check.findings.some((x) => x.code === "ABSENCE_DEDUCTION_ON")).toBe(true);

    await f.payroll.calculateRun(f.hr, run.id);
    const slip = await slipFor(run.id, empId);
    // 93,000 over 30 days = 3,100 a day; 2.5 days = 7,750
    expect(slip.grossPay).toBe(93000 - 7750);
    expect(slip.calculationBreakdown.some((l) => String(l.label).startsWith("Absence deduction: 2.5"))).toBe(true);
  });

  it("counts every N late marks as one absent day when configured, and never deducts more than the month holds", async () => {
    await f.payroll.updateSettings(f.hr, { lateMarksPerAbsence: 3 });
    lateOnlyId = empId;
    for (const d of ["2027-05-03", "2027-05-04", "2027-05-05", "2027-05-06", "2027-05-07", "2027-05-10", "2027-05-11"]) await att(lateOnlyId, d, d === "2027-05-11" ? "late_and_early" : "late");
    const run = await f.payroll.createRun(f.hr, { periodStart: "2027-05-01", periodEnd: "2027-05-31" });
    await f.payroll.calculateRun(f.hr, run.id);
    const slip = await slipFor(run.id, lateOnlyId);
    // 7 late marks -> 2 whole days (floor(7/3)); 93,000 / 31 = 3,000 a day
    expect(slip.grossPay).toBe(93000 - 6000);
  });

  it("rejects an invalid late-mark rule", async () => {
    await expect(f.payroll.updateSettings(f.hr, { lateMarksPerAbsence: 1 })).rejects.toThrow(/2 to 31/);
    await f.payroll.updateSettings(f.hr, { lateMarksPerAbsence: null });
    expect((await f.payroll.getSettings(f.hr)).lateMarksPerAbsence).toBeNull();
  });
});
