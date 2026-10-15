import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { HolidaysService } from "../holidays/holidays.service";
import { HolidayCalendarsService } from "../holidays/holiday-calendars.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { OvertimeService } from "./overtime.service";
import { OnDutyService } from "./on-duty.service";
import { WorkProfileService } from "./work-profile.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { AttendanceEvaluationService } from "./attendance-evaluation.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "overtime-step8c-fixtures" };

/** Gap Register TLM-07 / TLM-08 / TLM-10 / TLM-11 against real Postgres. */
describe("Overtime policy scopes, work profiles, holiday calendars (Step 8C)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let overtime: OvertimeService;
  let workProfiles: WorkProfileService;
  let holidays: HolidaysService;
  let calendars: HolidayCalendarsService;
  let schedule: WorkScheduleResolutionService;
  let onDuty: OnDutyService;
  let evaluation: AttendanceEvaluationService;
  let ledger: LeaveLedgerService;
  let companyId: string;
  let hr: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let otherClaims: RequestClaims;
  let managerEmployeeId: string;
  let staffEmployeeId: string;
  let otherEmployeeId: string;
  let groupId: string;
  let karachiId: string;
  let lahoreId: string;
  let sindhId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);
  /** setScopedPolicy takes effect today; the claims in this spec are for past dates, so move the new version back and drop superseded ones. */
  const setScoped = async (claims: RequestClaims, input: Parameters<OvertimeService["setScopedPolicy"]>[1]) => {
    const view = await overtime.setScopedPolicy(claims, input);
    await sql("DELETE FROM overtime_policies WHERE company_id = $1 AND scope_key = $2 AND id <> $3", [companyId, view.scopeKey, view.id]);
    await sql("UPDATE overtime_policies SET effective_from = '2020-01-01' WHERE id = $1", [view.id]);
    return view;
  };

  /** Closed attendance on `date` at UTC times (the overtime service sums clock-in/out minutes). */
  async function attend(employeeId: string, date: string, inHm: string, outHm: string) {
    await sql(
      `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
       SELECT $1, e.id, e.employee_number, 'manual', $3, $4 FROM employees e WHERE e.id = $2`,
      [companyId, employeeId, `${date}T${inHm}:00.000Z`, `${date}T${outHm}:00.000Z`]
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    holidays = new HolidaysService(db, rbac, ent, audit);
    calendars = new HolidayCalendarsService(db, rbac, ent, audit);
    const shifts = new ShiftsService(db, rbac, ent, audit, eff, new RulesEngine());
    schedule = new WorkScheduleResolutionService(db, shifts, holidays);
    workProfiles = new WorkProfileService(db, rbac, ent, audit, eff);
    ledger = new LeaveLedgerService(db, rbac, ent, audit);
    overtime = new OvertimeService(db, rbac, ent, audit, eff, schedule, undefined, workProfiles, ledger);
    onDuty = new OnDutyService(db, rbac, ent, audit);
    evaluation = new AttendanceEvaluationService(db, rbac, ent, audit, schedule, workProfiles);
    const compensation = new EmployeeCompensationService(db, rbac, ent, audit, eff);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Ot8c ${stamp}`, `ot8c-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, roles: string[]) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`o8c-${label}-${stamp}@example.com`]);
        for (const role of roles) {
          await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        }
        return { claims: { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims, uid: u.rows[0].id as string };
      });
    const hrU = await mk("hr", ["hr_admin", "rbac_demo_full_access"]);
    const mgrU = await mk("mgr", ["line_manager", "employee_self_service"]);
    const staffU = await mk("staff", ["employee_self_service"]);
    const otherU = await mk("other", ["employee_self_service"]);
    hr = hrU.claims;
    managerClaims = mgrU.claims;
    staffClaims = staffU.claims;
    otherClaims = otherU.claims;
    managerEmployeeId = (await employees.create(hr, { firstName: "Maya", lastName: "Manager", userAccountId: mgrU.uid })).id;
    staffEmployeeId = (await employees.create(hr, { firstName: "Sam", lastName: "Staff", managerId: managerEmployeeId, userAccountId: staffU.uid })).id;
    otherEmployeeId = (await employees.create(hr, { firstName: "Olu", lastName: "Other", managerId: managerEmployeeId, userAccountId: otherU.uid })).id;
    await sql("UPDATE employees SET date_of_joining = '2026-01-01' WHERE company_id = $1", [companyId]);

    for (const id of [staffEmployeeId, otherEmployeeId]) {
      await compensation.setCompensation(hr, { employeeId: id, monthlySalary: 104000, effectiveFrom: "2020-01-01" });
    }

    // Mon-Fri 09:00-17:00 for everyone
    const shift = await shifts.createShift(hr, { name: "Office", startTime: "09:00", endTime: "17:00", isDefault: true });
    await shifts.setWeeklyPattern(hr, shift.id, {
      days: Array.from({ length: 7 }, (_, d) => (d >= 1 && d <= 5 ? { dayOfWeek: d, isWorking: true, startTime: "09:00", endTime: "17:00" } : { dayOfWeek: d, isWorking: false })),
    });

    // locations: Sindh > Karachi, and Lahore; one employee group with Olu in it
    sindhId = (await sql<{ id: string }>("INSERT INTO locations (company_id, location_type, name) VALUES ($1,'region','Sindh') RETURNING id", [companyId]))[0].id;
    karachiId = (await sql<{ id: string }>("INSERT INTO locations (company_id, location_type, name, parent_id) VALUES ($1,'city','Karachi',$2) RETURNING id", [companyId, sindhId]))[0].id;
    lahoreId = (await sql<{ id: string }>("INSERT INTO locations (company_id, location_type, name) VALUES ($1,'city','Lahore') RETURNING id", [companyId]))[0].id;
    await sql("UPDATE employees SET location_id = $2 WHERE id = $1", [staffEmployeeId, karachiId]);
    await sql("UPDATE employees SET location_id = $2 WHERE id = $1", [otherEmployeeId, lahoreId]);
    groupId = (await sql<{ id: string }>("INSERT INTO employee_groups (company_id, name) VALUES ($1,'Shift workers') RETURNING id", [companyId]))[0].id;
    await sql("INSERT INTO employee_group_memberships (company_id, group_id, employee_id, effective_from) VALUES ($1,$2,$3,'2026-01-01')", [companyId, groupId, otherEmployeeId]);
  }, 60000);

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  // ================================================================ TLM-07
  describe("TLM-07 overtime policies, caps, pre-approval, comp-off", () => {
    it("keeps the company default separate from scoped policies, and resolves group > location > company", async () => {
      await overtime.setPolicy(hr, { weekdayRateMultiplier: 1.5 });
      await expect(overtime.setScopedPolicy(hr, { weekdayRateMultiplier: 2 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(overtime.setScopedPolicy(staffClaims, { locationId: karachiId })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(overtime.setScopedPolicy(hr, { locationId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(NotFoundException);

      // Sindh policy (Karachi is a sub-location of Sindh); a different one for the shift-workers group
      const sindh = await setScoped(hr, { name: "Sindh sites", locationId: sindhId, weekdayRateMultiplier: 1.75, maxDailyMinutes: 120 });
      expect(sindh).toMatchObject({ name: "Sindh sites", locationId: sindhId, weekdayRateMultiplier: 1.75, maxDailyMinutes: 120, restDayRateMultiplier: 2 });
      const grp = await setScoped(hr, { name: "Shift workers", employeeGroupId: groupId, weekdayRateMultiplier: 2.5 });
      expect(grp.scopeKey).toContain(groupId);

      const all = await overtime.listPolicies(hr);
      expect(all[0].scopeKey).toBe("company");
      expect(all.map((p) => p.name)).toEqual(expect.arrayContaining(["Sindh sites", "Shift workers"]));
      // the company default is untouched
      expect(all[0].weekdayRateMultiplier).toBe(1.5);
      expect((await overtime.getPolicy(hr)).weekdayRateMultiplier).toBe(1.5);

      const resolve = (employeeId: string) => db.withClaims(hr, async (c) => (await overtime.resolvePolicyFor(c, companyId, employeeId, "2026-06-01")).scope_key);
      expect(await resolve(staffEmployeeId)).toBe(`g:-|l:${sindhId}`); // Karachi -> Sindh policy
      expect(await resolve(otherEmployeeId)).toBe(`g:${groupId}|l:-`); // group policy for Olu (Lahore has none)
      expect(await resolve(managerEmployeeId)).toBe("company");
    });

    it("applies the daily cap of the policy that fits the employee, and records what was capped", async () => {
      // Sam is in Karachi: weekday 2026-06-01 worked 12h against 8h scheduled = 240 min overtime, daily cap 120
      await attend(staffEmployeeId, "2026-06-01", "09:00", "21:00");
      const claim = await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-06-01" });
      expect(claim).toMatchObject({ overtimeMinutes: 120, cappedMinutes: 120, rateMultiplier: 1.75, payoutMode: "pay", status: "pending" });
    });

    it("enforces the monthly cap across the month's claims", async () => {
      await setScoped(hr, { name: "Sindh sites", locationId: sindhId, maxMonthlyMinutes: 200 });
      await attend(staffEmployeeId, "2026-06-02", "09:00", "21:00"); // raw 240, daily cap 120, monthly remaining 200 - 120 = 80
      const second = await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-06-02" });
      expect(second.overtimeMinutes).toBe(80);
      expect(second.cappedMinutes).toBe(160);
      await attend(staffEmployeeId, "2026-06-03", "09:00", "21:00");
      await expect(overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-06-03" })).rejects.toThrow(/monthly overtime cap/);
      // another month starts fresh
      await attend(staffEmployeeId, "2026-07-01", "09:00", "21:00");
      expect((await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-07-01" })).overtimeMinutes).toBe(120);
    });

    it("needs a prior authorisation when the policy requires one; the manager (not the employee) grants it, and it limits the claim", async () => {
      await setScoped(hr, { name: "Sindh sites", locationId: sindhId, maxMonthlyMinutes: null, maxDailyMinutes: null, requiresPreApproval: true });
      await attend(staffEmployeeId, "2026-08-03", "09:00", "20:00"); // 180 min overtime
      await expect(overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-08-03" })).rejects.toThrow(/prior approval/);

      await expect(overtime.authorize(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-08-03" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(overtime.authorize(otherClaims, { employeeId: staffEmployeeId, workDate: "2026-08-03" })).rejects.toBeInstanceOf(ForbiddenException);
      const auth = await overtime.authorize(managerClaims, { employeeId: staffEmployeeId, workDate: "2026-08-03", maxMinutes: 90, reason: "Month-end close" });
      expect(auth).toMatchObject({ status: "active", maxMinutes: 90 });
      await expect(overtime.authorize(hr, { employeeId: staffEmployeeId, workDate: "2026-08-03" })).rejects.toBeInstanceOf(ConflictException);

      const claim = await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-08-03" });
      expect(claim).toMatchObject({ overtimeMinutes: 90, cappedMinutes: 90 });
      expect((await overtime.listAuthorizations(hr, staffEmployeeId)).find((a) => a.id === auth.id)!.status).toBe("used");
      await expect(overtime.revokeAuthorization(hr, auth.id)).rejects.toBeInstanceOf(ConflictException);

      // a rejected claim gives the authorisation back
      await overtime.decide(managerClaims, claim.id, { decision: "rejected", comment: "Not needed" });
      expect((await overtime.listAuthorizations(hr, staffEmployeeId)).find((a) => a.id === auth.id)!.status).toBe("active");
      await overtime.revokeAuthorization(managerClaims, auth.id);
      await expect(overtime.listAuthorizations(otherClaims, staffEmployeeId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("takes overtime as compensatory leave when the policy allows it: refused until the type is on, then credited to the ledger and the claim becomes paid", async () => {
      await setScoped(hr, { name: "Sindh sites", locationId: sindhId, requiresPreApproval: false, compOffAllowed: true, compOffMinutesPerDay: 240 });
      await attend(staffEmployeeId, "2026-09-01", "09:00", "21:00"); // 240 overtime minutes
      // compensatory leave is seeded switched off
      await expect(overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-09-01", payoutMode: "comp_off" })).rejects.toThrow(/Compensatory leave is not switched on/);
      await sql("UPDATE leave_types SET is_active = true, tracks_balance = true, accrual_method = 'none' WHERE company_id = $1 AND code = 'compensatory'", [companyId]);
      // an employee outside the policy that allows it is refused
      await attend(otherEmployeeId, "2026-09-01", "09:00", "21:00");
      await expect(overtime.submit(hr, { employeeId: otherEmployeeId, workDate: "2026-09-01", payoutMode: "comp_off" })).rejects.toThrow(/does not allow/);

      const claim = await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-09-01", payoutMode: "comp_off" });
      expect(claim.payoutMode).toBe("comp_off");
      const decided = await overtime.decide(managerClaims, claim.id, { decision: "approved" });
      expect(decided).toMatchObject({ status: "paid", compOffDays: 1, payoutMode: "comp_off" });
      const year = new Date().getUTCFullYear();
      const bal = await sql<{ entitled_days: string }>("SELECT entitled_days FROM leave_balances WHERE employee_id = $1 AND leave_type = 'compensatory' AND year = $2", [staffEmployeeId, year]);
      expect(Number(bal[0].entitled_days)).toBe(1);
      // payroll never sees it, and the ledger holds a single credit
      const seen = await db.withClaims(hr, (c) => overtime.getApprovedOvertimeInRange(c, staffEmployeeId, "2026-09-01", "2026-09-30"));
      expect(seen).toEqual([]);
      const entries = await sql("SELECT 1 FROM leave_ledger WHERE employee_id = $1 AND source_type = 'overtime' AND source_id = $2", [staffEmployeeId, claim.id]);
      expect(entries).toHaveLength(1);
    });

    it("a paid claim still blocks a second claim for the same day, and a normal approval stays approved until payroll consumes it", async () => {
      await expect(overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-09-01" })).rejects.toBeInstanceOf(ConflictException);
      await setScoped(hr, { name: "Sindh sites", locationId: sindhId, compOffAllowed: false });
      await attend(staffEmployeeId, "2026-09-02", "09:00", "19:00");
      const claim = await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-09-02" });
      const approved = await overtime.decide(managerClaims, claim.id, { decision: "approved" });
      expect(approved.status).toBe("approved");
      expect(approved.consumedPayrollRunId).toBeNull();
      const picked = await db.withClaims(hr, (c) => overtime.getApprovedOvertimeInRange(c, staffEmployeeId, "2026-09-01", "2026-09-30"));
      expect(picked.map((p) => p.workDate)).toEqual(["2026-09-02"]);
    });

    it("ends a scoped policy; employees fall back to the next applicable one", async () => {
      const all = await overtime.listPolicies(hr);
      const sindh = all.find((p) => p.name === "Sindh sites")!;
      await expect(overtime.endScopedPolicy(hr, all[0].id)).rejects.toBeInstanceOf(BadRequestException);
      await overtime.endScopedPolicy(hr, sindh.id);
      const resolveOn = (date: string) => db.withClaims(hr, async (c) => (await overtime.resolvePolicyFor(c, companyId, staffEmployeeId, date)).scope_key);
      // work already done under the policy keeps being priced by it; from today on the company default applies
      expect(await resolveOn("2026-10-01")).toContain("l:");
      expect(await resolveOn(new Date().toISOString().slice(0, 10))).toBe("company");
    });
  });

  // ================================================================ TLM-08
  describe("TLM-08 employee work profile", () => {
    it("has no profile by default; HR sets one effective-dated and the history keeps the earlier row", async () => {
      expect(await workProfiles.current(hr, staffEmployeeId)).toBeNull();
      await expect(workProfiles.set(staffClaims, staffEmployeeId, { employmentPercentage: 50 })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(workProfiles.set(hr, staffEmployeeId, { employmentPercentage: 60, weeklyHours: 40, monthlyHours: 100 })).rejects.toThrow(/disagree/);

      const first = await workProfiles.set(hr, staffEmployeeId, { employmentPercentage: 50, weeklyHours: 24, effectiveFrom: "2026-01-01" });
      expect(first).toMatchObject({ employmentPercentage: 50, weeklyHours: 24, isPartTime: true, timeRecordingProfile: "clock" });
      expect(first.effectiveMonthlyHours).toBeCloseTo(104, 1); // 24 x 52 / 12

      const second = await workProfiles.set(hr, staffEmployeeId, { employmentPercentage: 100, weeklyHours: 40, timeRecordingProfile: "timesheet", effectiveFrom: "2026-07-01" });
      expect(second).toMatchObject({ employmentPercentage: 100, isPartTime: false, timeRecordingProfile: "timesheet" });
      expect((await workProfiles.current(hr, staffEmployeeId, "2026-03-01"))!.employmentPercentage).toBe(50);
      expect((await workProfiles.current(hr, staffEmployeeId, "2026-08-01"))!.employmentPercentage).toBe(100);
      const history = await workProfiles.history(hr, staffEmployeeId);
      expect(history).toHaveLength(2);
      expect(history[1].effectiveTo).toBe("2026-06-30");
      await expect(workProfiles.set(hr, staffEmployeeId, { employmentPercentage: 80, effectiveFrom: "2026-02-01" })).rejects.toThrow(/cannot start before/);
    });

    it("reads are scoped: self and manager can read, a colleague cannot", async () => {
      expect(await workProfiles.current(staffClaims, staffEmployeeId)).not.toBeNull();
      expect(await workProfiles.current(managerClaims, staffEmployeeId)).not.toBeNull();
      await expect(workProfiles.current(otherClaims, staffEmployeeId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("prices overtime on the employee's own planned hours instead of the tenant-wide figure", async () => {
      // Olu: monthly hours 160 from 2026-01-01 (the tenant default is 208). 104,000 / 160 = 650 / hour.
      await workProfiles.set(hr, otherEmployeeId, { monthlyHours: 160, effectiveFrom: "2026-01-01" });
      await attend(otherEmployeeId, "2026-10-05", "09:00", "19:00"); // 120 min overtime, group policy x2.5
      const claim = await overtime.submit(otherClaims, { employeeId: otherEmployeeId, workDate: "2026-10-05" });
      await overtime.decide(managerClaims, claim.id, { decision: "approved" });
      const [row] = await sql<{ hourly_rate: string; amount: string }>("SELECT hourly_rate, amount FROM overtime_records WHERE id = $1", [claim.id]);
      expect(Number(row.hourly_rate)).toBe(650);
      expect(Number(row.amount)).toBe(3250); // 2 h x 650 x 2.5 (the shift-workers group policy)
    });

    it("lets the time-recording profile decide who counts as absent without a punch", async () => {
      // Sam has the 'timesheet' profile from 2026-07-01: no punches and no approved timesheet -> absent
      await evaluation.run({ from: "2026-07-07", to: "2026-07-07", companyId, employeeId: staffEmployeeId });
      expect((await sql<{ status: string }>("SELECT status FROM attendance_daily_results WHERE employee_id = $1 AND work_date = '2026-07-07'", [staffEmployeeId]))[0].status).toBe("absent");
      // with an approved timesheet entry for that day the day counts as worked
      const ts = await sql<{ id: string }>(
        "INSERT INTO timesheets (company_id, employee_id, period_start, period_end, status, total_minutes) VALUES ($1,$2,'2026-07-06','2026-07-12','approved',480) RETURNING id",
        [companyId, staffEmployeeId]
      );
      await sql("INSERT INTO timesheet_entries (company_id, timesheet_id, work_date, minutes) VALUES ($1,$2,'2026-07-07',480)", [companyId, ts[0].id]);
      await evaluation.run({ from: "2026-07-07", to: "2026-07-07", companyId, employeeId: staffEmployeeId });
      expect((await sql<Record<string, unknown>>("SELECT status, worked_minutes, exceptions FROM attendance_daily_results WHERE employee_id = $1 AND work_date = '2026-07-07'", [staffEmployeeId]))[0])
        .toMatchObject({ status: "present", worked_minutes: 480, exceptions: ["from_timesheet"] });
      // 'none' = not expected to clock at all
      await workProfiles.set(hr, otherEmployeeId, { timeRecordingProfile: "none", effectiveFrom: "2026-10-06" });
      await evaluation.run({ from: "2026-10-07", to: "2026-10-07", companyId, employeeId: otherEmployeeId });
      expect((await sql<Record<string, unknown>>("SELECT status, exceptions FROM attendance_daily_results WHERE employee_id = $1 AND work_date = '2026-10-07'", [otherEmployeeId]))[0])
        .toMatchObject({ status: "present", exceptions: ["time_not_recorded"] });
    });
  });

  // ================================================================ TLM-10
  describe("TLM-10 holiday calendars", () => {
    let sindhCal: string;

    it("keeps company-wide holidays for everyone and adds calendar holidays only where the calendar applies", async () => {
      await holidays.createHoliday(hr, { name: "Pakistan Day", holidayDate: "2027-03-23", isGazetted: true });
      const cal = await calendars.create(hr, { name: "Sindh provincial", locationIds: [sindhId] });
      sindhCal = cal.id;
      expect(cal).toMatchObject({ status: "active", locationIds: [sindhId], holidayCount: 0 });
      await expect(calendars.create(hr, { name: "Sindh provincial" })).rejects.toBeInstanceOf(ConflictException);
      await expect(calendars.create(staffClaims, { name: "Mine" })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(calendars.create(hr, { name: "Bad", locationIds: ["00000000-0000-0000-0000-000000000000"] })).rejects.toBeInstanceOf(NotFoundException);

      await holidays.createHoliday(hr, { name: "Sindh Culture Day", holidayDate: "2027-12-04", calendarId: sindhCal });
      const on = (employeeId: string, date: string) => db.withClaims(hr, async (c) => (await schedule.resolve(c, employeeId, date)).holidayName);
      // Karachi (inside Sindh) gets the Sindh holiday, Lahore does not; both get the company-wide one
      expect(await on(staffEmployeeId, "2027-12-04")).toBe("Sindh Culture Day");
      expect(await on(otherEmployeeId, "2027-12-04")).toBeNull();
      expect(await on(staffEmployeeId, "2027-03-23")).toBe("Pakistan Day");
      expect(await on(otherEmployeeId, "2027-03-23")).toBe("Pakistan Day");

      // the same holiday can sit in two calendars, but not twice in one
      await holidays.createHoliday(hr, { name: "Pakistan Day", holidayDate: "2027-03-23", calendarId: sindhCal });
      await expect(holidays.createHoliday(hr, { name: "Pakistan Day", holidayDate: "2027-03-23", calendarId: sindhCal })).rejects.toBeInstanceOf(ConflictException);
      await expect(holidays.createHoliday(hr, { name: "Pakistan Day", holidayDate: "2027-03-23" })).rejects.toBeInstanceOf(ConflictException);
      await expect(holidays.createHoliday(hr, { name: "X", holidayDate: "2027-05-01", calendarId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(NotFoundException);

      expect((await holidays.listHolidays(hr, "2027", sindhCal)).map((h) => h.name).sort()).toEqual(["Pakistan Day", "Sindh Culture Day"]);
      expect((await holidays.listHolidays(hr, "2027", "company")).map((h) => h.name)).toEqual(["Pakistan Day"]);
      expect((await calendars.list(hr))[0].holidayCount).toBe(2);
    });

    it("an unscoped calendar applies to everyone; an archived one to nobody", async () => {
      const open = await calendars.create(hr, { name: "Company events" });
      await holidays.createHoliday(hr, { name: "Founders Day", holidayDate: "2027-06-15", calendarId: open.id });
      const on = (employeeId: string) => db.withClaims(hr, async (c) => (await schedule.resolve(c, employeeId, "2027-06-15")).holidayName);
      expect(await on(staffEmployeeId)).toBe("Founders Day");
      expect(await on(otherEmployeeId)).toBe("Founders Day");
      await calendars.update(hr, open.id, { status: "archived" });
      expect(await on(staffEmployeeId)).toBeNull();
      await expect(holidays.createHoliday(hr, { name: "Late", holidayDate: "2027-06-16", calendarId: open.id })).rejects.toBeInstanceOf(ConflictException);
    });

    it("a calendar can be scoped by org unit as well", async () => {
      const unit = (await sql<{ id: string }>("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Plant') RETURNING id", [companyId]))[0].id;
      await sql("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [otherEmployeeId, unit]);
      const cal = await calendars.create(hr, { name: "Plant shutdown", orgUnitIds: [unit] });
      await holidays.createHoliday(hr, { name: "Plant shutdown day", holidayDate: "2027-08-02", calendarId: cal.id });
      const on = (employeeId: string) => db.withClaims(hr, async (c) => (await schedule.resolve(c, employeeId, "2027-08-02")).holidayName);
      expect(await on(otherEmployeeId)).toBe("Plant shutdown day");
      expect(await on(staffEmployeeId)).toBeNull();
    });

    it("rolls a year forward: fixed dates copied, lunar dates copied as tentative until confirmed; safe to run twice", async () => {
      await holidays.createHoliday(hr, { name: "Labour Day", holidayDate: "2028-05-01", isGazetted: true });
      const eid = await holidays.createHoliday(hr, { name: "Eid ul Fitr", holidayDate: "2028-03-01", dateBasis: "lunar", isGazetted: true });
      expect(eid).toMatchObject({ dateBasis: "lunar", isTentative: false });
      const r1 = await holidays.rollForward(hr, { fromYear: 2028, toYear: 2029 });
      expect(r1).toEqual({ created: 2, skipped: 0, tentative: 1 });
      const copied = await holidays.listHolidays(hr, "2029", "company");
      expect(copied.map((h) => [h.name, h.holidayDate, h.isTentative])).toEqual([
        ["Eid ul Fitr", "2029-03-01", true],
        ["Labour Day", "2029-05-01", false],
      ]);
      expect(await holidays.rollForward(hr, { fromYear: 2028, toYear: 2029 })).toEqual({ created: 0, skipped: 2, tentative: 0 });
      // moving the date to the announced day confirms it
      const moved = await holidays.updateHoliday(hr, copied[0].id, { holidayDate: "2029-02-18" });
      expect(moved).toMatchObject({ holidayDate: "2029-02-18", isTentative: false });
      await expect(holidays.rollForward(hr, { fromYear: 2028, toYear: 2028 })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ================================================================ TLM-11
  describe("TLM-11 on-duty location reference", () => {
    it("links a configured location (the name is kept for display) and refuses an unknown one", async () => {
      await expect(onDuty.submit(staffClaims, { employeeId: staffEmployeeId, startDate: "2026-11-02", endDate: "2026-11-03", locationId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(NotFoundException);
      const req = await onDuty.submit(staffClaims, { employeeId: staffEmployeeId, startDate: "2026-11-02", endDate: "2026-11-03", locationId: lahoreId, reason: "Client visit" });
      expect(req).toMatchObject({ locationId: lahoreId, locationName: "Lahore", location: "Lahore" });
      const free = await onDuty.submit(staffClaims, { employeeId: staffEmployeeId, startDate: "2026-11-10", endDate: "2026-11-10", location: "Client office, Gulberg" });
      expect(free).toMatchObject({ locationId: null, locationName: null, location: "Client office, Gulberg" });
    });
  });
});
