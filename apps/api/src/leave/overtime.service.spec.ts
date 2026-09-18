import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
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
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { OvertimeService } from "./overtime.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "overtime-fixtures" };

/**
 * Real Postgres, no mocks. Covers the first increment of Overtime & On-
 * Duty (0038_overtime.sql): policy get/set (seeded defaults, HR-only
 * manage), the three day types (ordinary weekday beyond scheduled hours,
 * a scheduled rest day, a mandatory holiday) each resolving through the
 * real WorkScheduleResolutionService rather than a hand-rolled
 * comparison, the "no schedule configured" / "no completed attendance
 * record" / "nothing to claim" refusal paths, the one-active-claim-per-
 * day conflict, and the same self/team/all submit+decide shape
 * AttendanceCorrectionsService already established.
 */
describe("OvertimeService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let shifts: ShiftsService;
  let holidays: HolidaysService;
  let workSchedule: WorkScheduleResolutionService;
  let overtime: OvertimeService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let staffEmployeeId: string;
  let shiftId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    const effectiveDating = new EffectiveDatingEngine();
    shifts = new ShiftsService(db, rbac, entitlements, audit, effectiveDating, new RulesEngine());
    holidays = new HolidaysService(db, rbac, entitlements, audit);
    workSchedule = new WorkScheduleResolutionService(db, shifts, holidays);
    overtime = new OvertimeService(db, rbac, entitlements, audit, effectiveDating, workSchedule);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Overtime Co ${stamp}`,
        `overtime-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true)",
        [id]
      );
      return id;
    });

    async function makeUser(email: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
          email,
        ]);
        return result.rows[0].id as string;
      });
    }
    async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      });
    }

    const hrAdminUserId = await makeUser(`ot-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const managerUserId = await makeUser(`ot-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    const staffUserId = await makeUser(`ot-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`ot-outsider-${stamp}@example.com`);
    await assignRole(outsiderUserId, "employee_self_service");
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    const managerEmployeeId = (
      await employees.create(hrAdminClaims, { firstName: "Maya", lastName: "Manager", userAccountId: managerUserId })
    ).id;
    const staffEmployee = await employees.create(hrAdminClaims, {
      firstName: "Sam",
      lastName: "Staff",
      managerId: managerEmployeeId,
      userAccountId: staffUserId,
    });
    staffEmployeeId = staffEmployee.id;

    // A real weekly-pattern-aware schedule: Mon-Fri working 09:00-17:00,
    // Saturday/Sunday off — 2026-02-02 through -06 are Mon-Fri, -07/-08
    // are Sat/Sun, per the fixture dates used below.
    const schedule = await shifts.createShift(hrAdminClaims, { name: "Ordinary Office", startTime: "09:00", endTime: "17:00" });
    shiftId = schedule.id;
    await shifts.setWeeklyPattern(hrAdminClaims, shiftId, {
      days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        isWorking: dayOfWeek >= 1 && dayOfWeek <= 5,
        startTime: dayOfWeek >= 1 && dayOfWeek <= 5 ? "09:00" : undefined,
        endTime: dayOfWeek >= 1 && dayOfWeek <= 5 ? "17:00" : undefined,
      })),
    });
    await shifts.assignShift(hrAdminClaims, { employeeId: staffEmployeeId, shiftId, effectiveFrom: "2026-01-01" });
    await holidays.createHoliday(hrAdminClaims, { name: "Overtime Test Holiday", holidayDate: "2026-02-09" });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertAttendance(date: string, clockIn: string, clockOut: string): Promise<void> {
    await db.withClaims(hrAdminClaims, (client) =>
      client.query(
        `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
         VALUES ($1, $2, (SELECT employee_number FROM employees WHERE id = $2), 'manual', $3, $4)`,
        [companyId, staffEmployeeId, `${date}T${clockIn}:00.000Z`, `${date}T${clockOut}:00.000Z`]
      )
    );
  }

  describe("policy", () => {
    it("seeds sensible defaults the first time a company has none, and only HR can manage it", async () => {
      const policy = await overtime.getPolicy(hrAdminClaims);
      expect(policy.weekdayRateMultiplier).toBe(1.5);
      expect(policy.restDayRateMultiplier).toBe(2);
      expect(policy.holidayRateMultiplier).toBe(2);
      expect(policy.dailyThresholdMinutes).toBe(0);

      await expect(overtime.getPolicy(staffClaims)).rejects.toThrow(ForbiddenException);
    });

    it("lets HR partially update the policy, merging onto the current values", async () => {
      const updated = await overtime.setPolicy(hrAdminClaims, { dailyThresholdMinutes: 15, weekdayRateMultiplier: 1.25 });
      expect(updated.dailyThresholdMinutes).toBe(15);
      expect(updated.weekdayRateMultiplier).toBe(1.25);
      // Untouched fields carry over from the seeded defaults.
      expect(updated.restDayRateMultiplier).toBe(2);
      expect(updated.holidayRateMultiplier).toBe(2);
    });
  });

  describe("submit — refusal paths", () => {
    it("refuses when no completed attendance record exists for that date", async () => {
      await expect(
        overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-02-02" })
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses when actual time doesn't exceed the resolved schedule plus threshold", async () => {
      // Worked exactly the scheduled 09:00-17:00 window, no extra time.
      await insertAttendance("2026-02-03", "09:00", "17:00");
      await expect(
        overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-02-03" })
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses an outsider with no relationship to the employee", async () => {
      await insertAttendance("2026-02-04", "09:00", "20:00");
      await expect(
        overtime.submit(outsiderClaims, { employeeId: staffEmployeeId, workDate: "2026-02-04" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("refuses when the employee has no work schedule configured at all", async () => {
      const noScheduleEmployee = await employees.create(hrAdminClaims, { firstName: "No", lastName: "Schedule" });
      await insertAttendanceFor(noScheduleEmployee.id, "2026-02-04", "09:00", "20:00");
      await expect(
        overtime.submit(hrAdminClaims, { employeeId: noScheduleEmployee.id, workDate: "2026-02-04" })
      ).rejects.toThrow(BadRequestException);
    });

    async function insertAttendanceFor(employeeId: string, date: string, clockIn: string, clockOut: string): Promise<void> {
      await db.withClaims(hrAdminClaims, (client) =>
        client.query(
          `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
           VALUES ($1, $2, (SELECT employee_number FROM employees WHERE id = $2), 'manual', $3, $4)`,
          [companyId, employeeId, `${date}T${clockIn}:00.000Z`, `${date}T${clockOut}:00.000Z`]
        )
      );
    }
  });

  describe("weekday overtime — beyond scheduled hours, threshold and rounding applied", () => {
    let claimId: string;

    it("computes overtime as actual minus scheduled, respecting the policy's threshold and rounding", async () => {
      // Policy at this point: dailyThresholdMinutes=15, weekdayRateMultiplier=1.25.
      // Scheduled 09:00-17:00 (480 min); worked 09:00-20:00 (660 min, inserted
      // by the "refuses an outsider..." refusal-path test above) -> 180 min
      // extra, >= 15 min threshold, rounded down to the (default) 1-minute
      // increment (unaffected by this test file's rounding since it's never
      // set away from its seeded default of 1).
      const claim = await overtime.submit(staffClaims, {
        employeeId: staffEmployeeId,
        workDate: "2026-02-04",
        reason: "Quarter-end close",
      });
      expect(claim.dayType).toBe("weekday");
      expect(claim.scheduledMinutes).toBe(480);
      expect(claim.actualMinutes).toBe(660);
      expect(claim.overtimeMinutes).toBe(180);
      expect(claim.rateMultiplier).toBe(1.25);
      expect(claim.status).toBe("pending");
      expect(claim.isOnBehalf).toBe(false);
      claimId = claim.id;
    });

    it("refuses a second active claim for the same employee/date", async () => {
      await expect(
        overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-02-04" })
      ).rejects.toThrow(ConflictException);
    });

    it("lets the manager approve a direct report's claim, and refuses deciding it twice", async () => {
      const decided = await overtime.decide(managerClaims, claimId, { decision: "approved", comment: "Verified against the close checklist" });
      expect(decided.status).toBe("approved");

      await expect(overtime.decide(managerClaims, claimId, { decision: "rejected" })).rejects.toThrow(ConflictException);
    });

    it("refuses an outsider manager from deciding it", async () => {
      await insertAttendance("2026-02-05", "09:00", "18:00");
      const claim = await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-02-05" });
      await expect(overtime.decide(outsiderClaims, claim.id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      // Clean up so it doesn't count against the "one active claim" index for later tests.
      await overtime.decide(hrAdminClaims, claim.id, { decision: "rejected" });
    });
  });

  describe("rest-day overtime — the whole worked span counts, at the rest-day rate", () => {
    it("treats a Saturday (off in this employee's weekly pattern) as fully overtime", async () => {
      // 2026-02-07 is a Saturday under the Mon-Fri pattern set in beforeAll.
      await insertAttendance("2026-02-07", "10:00", "14:00");
      const claim = await overtime.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        workDate: "2026-02-07",
        reason: "Emergency server migration",
      });
      expect(claim.dayType).toBe("rest_day");
      expect(claim.scheduledMinutes).toBe(0);
      expect(claim.actualMinutes).toBe(240);
      expect(claim.overtimeMinutes).toBe(240);
      expect(claim.rateMultiplier).toBe(2);
      expect(claim.isOnBehalf).toBe(true);
    });
  });

  describe("holiday overtime — a mandatory holiday overrides the weekly pattern's own working-day default", () => {
    it("treats a mandatory holiday (2026-02-09, otherwise a working Monday) as fully overtime at the holiday rate", async () => {
      await insertAttendance("2026-02-09", "09:00", "13:00");
      const claim = await overtime.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        workDate: "2026-02-09",
      });
      expect(claim.dayType).toBe("holiday");
      expect(claim.actualMinutes).toBe(240);
      expect(claim.overtimeMinutes).toBe(240);
      expect(claim.rateMultiplier).toBe(2);
    });
  });

  describe("listPendingForDecider / listForEmployee scoping", () => {
    it("shows the manager only their own team's pending claims, and HR everything", async () => {
      await insertAttendance("2026-02-10", "09:00", "19:00");
      await overtime.submit(staffClaims, { employeeId: staffEmployeeId, workDate: "2026-02-10" });

      const managerPending = await overtime.listPendingForDecider(managerClaims);
      expect(managerPending.some((c) => c.workDate === "2026-02-10")).toBe(true);

      const hrPending = await overtime.listPendingForDecider(hrAdminClaims);
      expect(hrPending.some((c) => c.workDate === "2026-02-10")).toBe(true);

      const outsiderPending = await overtime.listPendingForDecider(outsiderClaims);
      expect(outsiderPending.length).toBe(0);
    });

    it("lets the employee see their own claim history, and refuses an outsider", async () => {
      const list = await overtime.listForEmployee(staffClaims, staffEmployeeId);
      expect(list.length).toBeGreaterThan(0);

      await expect(overtime.listForEmployee(outsiderClaims, staffEmployeeId)).rejects.toThrow(ForbiddenException);
    });
  });
});
