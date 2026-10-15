import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "./testing/payroll-fixture";
import { PayrollPeriodsService, assertPeriodAcceptsRun } from "./payroll-periods.service";
import { PayrollAreasService } from "./payroll-areas.service";
import { PayrollRunControlService } from "./payroll-run-control.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { ConfigurationRuleMappingService } from "../hr-administration/configuration-rule-mapping.service";

/** Gap Register Step 9B - PAY-03 (calendars and periods) and PAY-04 (area attributes, run population). */
describe("Payroll calendars, periods and run population (Step 9B)", () => {
  let f: PayrollFixture;
  let periods: PayrollPeriodsService;
  let areas: PayrollAreasService;
  let monthlyId: string;

  beforeAll(async () => {
    f = await buildPayrollFixture("per");
    periods = new PayrollPeriodsService(f.db, f.rbac, f.entitlements, f.audit);
    areas = new PayrollAreasService(f.db, f.rbac, f.entitlements, f.audit);
    monthlyId = (await periods.createCalendar(f.hr, { code: "MONTHLY", name: "Monthly salary", frequency: "monthly", payDayOffset: 1, cutoffDaysBeforeEnd: 5 })).id;
    await f.createEmployee({ userAccountId: f.staff.uid, monthlySalary: 150000 });
  }, 60000);

  afterAll(async () => {
    await f.cleanup();
  });

  const gen = async (calendarId: string, fromDate: string, count: number) => periods.generatePeriods(f.hr, calendarId, { fromDate, count });

  // ======================================================================= PAY-03
  describe("PAY-03 calendars and periods", () => {
    it("generates monthly periods with pay date and cut-off derived from the calendar, including a leap February", async () => {
      const res = await gen(monthlyId, "2040-01-01", 3);
      expect(res.skipped).toEqual([]);
      expect(res.created.map((p) => [p.label, p.periodStart, p.periodEnd, p.payDate, p.cutoffDate, p.status])).toEqual([
        ["2040-01", "2040-01-01", "2040-01-31", "2040-02-01", "2040-01-26", "open"],
        ["2040-02", "2040-02-01", "2040-02-29", "2040-03-01", "2040-02-24", "open"],
        ["2040-03", "2040-03-01", "2040-03-31", "2040-04-01", "2040-03-26", "open"],
      ]);
    });

    it("is safe to run twice, and reports overlaps instead of creating them", async () => {
      const again = await gen(monthlyId, "2040-02-01", 2);
      expect(again.created).toEqual([]);
      expect(again.skipped.map((s) => s.reason)).toEqual(["already exists", "already exists"]);
      const weekly = await periods.createCalendar(f.hr, { code: "WEEKLY", name: "Weekly wages", frequency: "weekly" });
      const w = await gen(weekly.id, "2040-01-03", 2);
      expect(w.created.map((p) => [p.periodStart, p.periodEnd])).toEqual([["2040-01-03", "2040-01-09"], ["2040-01-10", "2040-01-16"]]);
      // a different calendar may overlap this one; inside one calendar it cannot
      const clash = await gen(weekly.id, "2040-01-10", 1);
      expect(clash.created).toEqual([]);
      expect(clash.skipped[0].reason).toBe("already exists");
      const misaligned = await gen(weekly.id, "2040-01-12", 1);
      expect(misaligned.skipped[0].reason).toMatch(/overlaps the existing period/);
    });

    it("builds semi-monthly and bi-weekly cycles and refuses a start date that does not fit the frequency", async () => {
      const semi = await periods.createCalendar(f.hr, { code: "SEMI", name: "Semi-monthly", frequency: "semi_monthly" });
      const s = await gen(semi.id, "2041-02-01", 3);
      expect(s.created.map((p) => [p.periodStart, p.periodEnd])).toEqual([["2041-02-01", "2041-02-15"], ["2041-02-16", "2041-02-28"], ["2041-03-01", "2041-03-15"]]);
      const bi = await periods.createCalendar(f.hr, { code: "BIWK", name: "Bi-weekly", frequency: "bi_weekly" });
      const b = await gen(bi.id, "2041-01-06", 2);
      expect(b.created.map((p) => [p.periodStart, p.periodEnd])).toEqual([["2041-01-06", "2041-01-19"], ["2041-01-20", "2041-02-02"]]);
      await expect(gen(monthlyId, "2042-01-15", 1)).rejects.toThrow(/start on the 1st/);
      await expect(gen(semi.id, "2042-01-10", 1)).rejects.toThrow(/1st or the 16th/);
      await expect(gen(monthlyId, "2042-01-01", 0)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("the database itself refuses overlapping periods in one calendar", async () => {
      await expect(
        f.sql(
          `INSERT INTO payroll_periods (company_id, calendar_id, label, period_start, period_end, pay_date, cutoff_date)
           VALUES ($1,$2,'overlap','2040-01-15','2040-02-15','2040-02-16','2040-02-10')`,
          [f.companyId, monthlyId]
        )
      ).rejects.toThrow(/conflicting key value|exclusion/);
    });

    it("rejects a duplicate calendar code and lets only the calendar manager change calendars", async () => {
      await expect(periods.createCalendar(f.hr, { code: "MONTHLY", name: "dup" })).rejects.toBeInstanceOf(ConflictException);
      await expect(periods.createCalendar(f.approver, { code: "X1", name: "x" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(gen(monthlyId, "2043-01-01", 1)).resolves.toBeDefined();
      await expect(periods.generatePeriods(f.staff, monthlyId, { fromDate: "2044-01-01", count: 1 })).rejects.toBeInstanceOf(ForbiddenException);
      // an approver may read the calendar and periods (they approve runs created from them)
      expect((await periods.listCalendars(f.approver)).map((c) => c.code)).toContain("MONTHLY");
      await expect(periods.listPeriods(f.staff)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("moves a period open -> locked -> closed, refusing to close while a real run is unfinished", async () => {
      const [jan] = (await periods.listPeriods(f.hr, { calendarId: monthlyId, year: 2040 })).filter((p) => p.label === "2040-01");
      const run = await f.payroll.createRun(f.hr, { payrollPeriodId: jan.id });
      expect(run.payrollPeriodId).toBe(jan.id);
      expect([run.periodStart, run.periodEnd]).toEqual(["2040-01-01", "2040-01-31"]);

      const locked = await periods.lockPeriod(f.hr, jan.id);
      expect(locked.status).toBe("locked");
      expect(locked.lockedAt).not.toBeNull();
      await expect(periods.lockPeriod(f.hr, jan.id)).rejects.toThrow(/Cannot lock/);
      await expect(periods.closePeriod(f.hr, jan.id)).rejects.toThrow(/have not been closed yet/);
      expect((await periods.unlockPeriod(f.hr, jan.id)).status).toBe("open");

      await f.control.cancel(f.hr, run.id, "created for the test only");
      const closed = await periods.closePeriod(f.hr, jan.id);
      expect(closed.status).toBe("closed");
      expect(closed.closedAt).not.toBeNull();
      await expect(periods.unlockPeriod(f.hr, jan.id)).rejects.toThrow(/Cannot unlock/);
      // reopening a closed period is its own restricted action
      await expect(periods.reopenPeriod(f.approver, jan.id, "need to add a run")).rejects.toBeInstanceOf(ForbiddenException);
      await expect(periods.reopenPeriod(f.hr, jan.id, "no")).rejects.toThrow(/reason/);
      expect((await periods.reopenPeriod(f.hr, jan.id, "A late run is needed")).status).toBe("locked");
    });

    it("a period only accepts the runs its state allows", async () => {
      expect(() => assertPeriodAcceptsRun({ status: "open" }, "regular")).not.toThrow();
      expect(() => assertPeriodAcceptsRun({ status: "locked" }, "regular")).toThrow(/locked/);
      expect(() => assertPeriodAcceptsRun({ status: "locked" }, "off_cycle")).not.toThrow();
      expect(() => assertPeriodAcceptsRun({ status: "closed" }, "off_cycle")).toThrow(/closed/);

      const [feb] = (await periods.listPeriods(f.hr, { calendarId: monthlyId, year: 2040 })).filter((p) => p.label === "2040-02");
      await periods.lockPeriod(f.hr, feb.id);
      await expect(f.payroll.createRun(f.hr, { payrollPeriodId: feb.id })).rejects.toThrow(/locked/);
      const bonus = await f.payroll.createRun(f.hr, { payrollPeriodId: feb.id, runType: "off_cycle", offCycleReason: "bonus" });
      expect(bonus.payrollPeriodId).toBe(feb.id);
      await f.control.cancel(f.hr, bonus.id, "test bonus not needed");
      await periods.closePeriod(f.hr, feb.id);
      await expect(f.payroll.createRun(f.hr, { payrollPeriodId: feb.id, runType: "off_cycle", offCycleReason: "bonus" })).rejects.toThrow(/closed/);
    });

    it("takes the period's dates, refuses dates that disagree, and needs dates when there is no period", async () => {
      const [mar] = (await periods.listPeriods(f.hr, { calendarId: monthlyId, year: 2040 })).filter((p) => p.label === "2040-03");
      await expect(f.payroll.createRun(f.hr, { payrollPeriodId: mar.id, periodStart: "2040-03-02", periodEnd: "2040-03-31" })).rejects.toThrow(/must equal the payroll period/);
      await expect(f.payroll.createRun(f.hr, {})).rejects.toThrow(/required unless/);
      await expect(f.payroll.createRun(f.hr, { payrollPeriodId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/not found/);
      const ok = await f.payroll.createRun(f.hr, { payrollPeriodId: mar.id, periodStart: "2040-03-01", periodEnd: "2040-03-31" });
      expect(ok.payrollPeriodId).toBe(mar.id);
      // idempotent replay returns the same run; a second run for the same period is still refused
      await expect(f.payroll.createRun(f.hr, { payrollPeriodId: mar.id })).rejects.toThrow(/already exists/);
      const list = await periods.listPeriods(f.hr, { calendarId: monthlyId, year: 2040 });
      expect(list.find((p) => p.id === mar.id)!.runCount).toBe(1);
    });

    it("a tenant policy can require every regular run to come from a period", async () => {
      await f.sql(
        `INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default) VALUES ($1,'payroll','default','Payroll','{"requirePeriodForRun": true}'::jsonb, true)`,
        [f.companyId]
      );
      const strictControl = new PayrollRunControlService(f.db, f.rbac, f.entitlements, f.audit, new HrBusinessPolicyService(f.db, f.rbac, f.entitlements, f.audit, new ConfigurationRuleMappingService(f.db, f.rbac, f.entitlements, f.audit)));
      const { PayrollService } = await import("./payroll.service");
      const { ImportExportService } = await import("../import-export/import-export.service");
      const { EffectiveDatingEngine } = await import("../effective-dating/effective-dating.engine");
      const strict = new PayrollService(
        f.db, f.rbac, f.entitlements, f.audit, new ImportExportService(), new EffectiveDatingEngine(), f.workflow,
        f.leaveRequests, f.overtime, f.workSchedule, undefined, undefined, f.loans, f.additionalPayments, f.offCyclePayments, strictControl
      );
      try {
        await expect(strict.createRun(f.hr, { periodStart: "2040-06-01", periodEnd: "2040-06-30" })).rejects.toThrow(/requires a regular payroll run to be created for a payroll period/);
        // simulations and off-cycle runs are exempt
        const sim = await strict.createRun(f.hr, { periodStart: "2040-06-01", periodEnd: "2040-06-30", isSimulation: true });
        expect(sim.isSimulation).toBe(true);
      } finally {
        await f.sql("UPDATE hr_business_policies SET is_active = false, is_default = false WHERE company_id = $1 AND policy_type = 'payroll'", [f.companyId]);
      }
    });

    it("a corrective run opened by a reversal stays in the original period; a closed run's period must be reopened before the run can be", async () => {
      const [apr] = await (async () => {
        await gen(monthlyId, "2040-04-01", 1);
        return (await periods.listPeriods(f.hr, { calendarId: monthlyId, year: 2040 })).filter((p) => p.label === "2040-04");
      })();
      const run = await f.payroll.createRun(f.hr, { payrollPeriodId: apr.id });
      await f.payroll.calculateRun(f.hr, run.id);
      await f.submitAndApprove(run.id);
      await f.payroll.finalizeRun(f.hr, run.id);
      const reversed = await f.payroll.reverseRun(f.hr, run.id, { reason: "Allowance applied to the wrong grade" });
      const corrective = await f.payroll.getRun(f.hr, reversed.correctiveRunId!);
      expect(corrective.payrollPeriodId).toBe(apr.id);

      await f.payroll.calculateRun(f.hr, corrective.id);
      await f.submitAndApprove(corrective.id);
      await f.payroll.finalizeRun(f.hr, corrective.id);
      await f.control.close(f.hr, corrective.id);
      await expect(periods.closePeriod(f.hr, apr.id)).resolves.toMatchObject({ status: "closed" });
      await expect(f.control.reopen(f.hr, corrective.id, "Need to correct a figure")).rejects.toThrow(/reopen the period first/);
      await periods.reopenPeriod(f.hr, apr.id, "Correct a figure in April");
      await expect(f.control.reopen(f.hr, corrective.id, "Need to correct a figure")).resolves.toMatchObject({ status: "reopened" });
    });
  });

  // ======================================================================= PAY-04 area attributes
  describe("PAY-04 payroll area attributes", () => {
    it("an area takes its calendar's frequency and currency, and must stay consistent with them", async () => {
      const weekly = (await periods.listCalendars(f.hr)).find((c) => c.code === "WEEKLY")!;
      const area = await areas.create(f.hr, { code: "KHI", name: "Karachi weekly", calendarId: weekly.id, jurisdiction: "PK-SD" });
      expect(area).toMatchObject({ frequency: "weekly", currencyCode: "PKR", calendarId: weekly.id, jurisdiction: "PK-SD" });
      await expect(areas.update(f.hr, area.id, { frequency: "monthly" })).rejects.toThrow(/must match its calendar/);
      await expect(areas.update(f.hr, area.id, { currencyCode: "USD" })).rejects.toThrow(/must match its calendar/);
      const cleared = await areas.update(f.hr, area.id, { calendarId: null, frequency: "monthly", currencyCode: "USD" });
      expect(cleared).toMatchObject({ frequency: "monthly", currencyCode: "USD", calendarId: null });
      await expect(areas.create(f.hr, { code: "BAD", name: "bad", calendarId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/not found/);
    });

    it("changing those attributes needs the calendar permission, and a run uses a period of its area's calendar", async () => {
      const mgr = await f.makeUser("areamgr", ["payroll_approver"]);
      const area = await areas.create(f.hr, { code: "LHE", name: "Lahore monthly" });
      await expect(areas.update(mgr, area.id, { jurisdiction: "PK-PB" })).rejects.toBeInstanceOf(ForbiddenException);

      const monthlyArea = await areas.update(f.hr, area.id, { calendarId: monthlyId });
      expect(monthlyArea.frequency).toBe("monthly");
      const weekly = (await periods.listCalendars(f.hr)).find((c) => c.code === "WEEKLY")!;
      const [wk] = (await periods.listPeriods(f.hr, { calendarId: weekly.id })).slice(-1);
      await expect(f.payroll.createRun(f.hr, { payrollPeriodId: wk.id, payrollAreaId: area.id })).rejects.toThrow(/different calendar/);
    });
  });

  // ======================================================================= PAY-04 population
  describe("PAY-04 run population", () => {
    it("records who a calculation covered and why, one set per calculation", async () => {
      const area = await areas.create(f.hr, { code: "POP", name: "Population area" });
      const a = await f.createEmployee({ monthlySalary: 90000, payrollAreaId: area.id });
      const b = await f.createEmployee({ monthlySalary: null, payrollAreaId: area.id }); // no compensation -> fails
      await f.createEmployee({ monthlySalary: 70000 }); // another area (none) -> not in scope

      const run = await f.payroll.createRun(f.hr, { periodStart: "2040-09-01", periodEnd: "2040-09-30", payrollAreaId: area.id });
      const calc = await f.payroll.calculateRun(f.hr, run.id);
      expect(calc.errors.map((e) => e.employeeId)).toEqual([b.id]);

      const pop = await f.control.listPopulation(f.hr, run.id);
      expect(pop.map((p) => [p.employeeNumber, p.inclusionReason, p.status, p.calculationSequence])).toEqual(
        [[a.employeeNumber, "area_member", "calculated", 1], [b.employeeNumber, "area_member", "failed", 1]].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
      );
      const failed = pop.find((p) => p.employeeId === b.id)!;
      expect(failed.exclusionReason).toMatch(/compensation/i);
      expect(failed.snapshot).toMatchObject({ employeeNumber: b.employeeNumber, payrollAreaId: area.id, dateOfJoining: "2020-01-01" });

      // the second calculation adds its own set; the first stays reproducible
      await f.sql("DELETE FROM employee_compensation WHERE employee_id = $1", [b.id]).catch(() => undefined);
      await f.payroll.calculateRun(f.hr, run.id);
      const second = await f.control.listPopulation(f.hr, run.id);
      expect(second.every((p) => p.calculationSequence === 2)).toBe(true);
      const first = await f.control.listPopulation(f.hr, run.id, 1);
      expect(first).toHaveLength(2);
      expect(first.find((p) => p.employeeId === b.id)!.status).toBe("failed");
    });

    it("labels a company-wide run, a targeted run and a final settlement", async () => {
      const left = await f.createEmployee({ monthlySalary: 80000, terminationDate: "2040-10-20" });
      const settlement = await f.payroll.createRun(f.hr, { periodStart: "2040-10-01", periodEnd: "2040-10-31", runType: "off_cycle", offCycleReason: "final_settlement", targetEmployeeId: left.id });
      await f.payroll.calculateRun(f.hr, settlement.id);
      const pop = await f.control.listPopulation(f.hr, settlement.id);
      expect(pop.map((p) => [p.employeeId, p.inclusionReason])).toEqual([[left.id, "final_settlement"]]);

      const bonus = await f.payroll.createRun(f.hr, { periodStart: "2040-11-01", periodEnd: "2040-11-30", runType: "off_cycle", offCycleReason: "bonus", targetEmployeeId: left.id });
      await f.payroll.calculateRun(f.hr, bonus.id).catch(() => undefined);
      const targeted = await f.control.listPopulation(f.hr, bonus.id);
      expect(targeted.every((p) => p.inclusionReason === "target_employee")).toBe(true);

      const company = await f.payroll.createRun(f.hr, { periodStart: "2040-12-01", periodEnd: "2040-12-31" });
      await f.payroll.calculateRun(f.hr, company.id);
      expect((await f.control.listPopulation(f.hr, company.id)).every((p) => p.inclusionReason === "company_wide")).toBe(true);
    });

    it("keeps calendars, periods and population invisible to another tenant", async () => {
      const other = await buildPayrollFixture("per2");
      try {
        const otherPeriods = new PayrollPeriodsService(other.db, other.rbac, other.entitlements, other.audit);
        expect(await otherPeriods.listCalendars(other.hr)).toEqual([]);
        expect(await otherPeriods.listPeriods(other.hr)).toEqual([]);
        const [mine] = await periods.listPeriods(f.hr, { calendarId: monthlyId });
        await expect(other.payroll.createRun(other.hr, { payrollPeriodId: mine.id })).rejects.toThrow(/not found/);
        await expect(otherPeriods.lockPeriod(other.hr, mine.id)).rejects.toThrow(/not found/);
        const rows = await other.db.withClaims(other.hr, async (c) => (await c.query("SELECT 1 FROM payroll_run_population")).rows);
        expect(rows).toHaveLength(0);
      } finally {
        await other.cleanup();
      }
    });
  });
});
