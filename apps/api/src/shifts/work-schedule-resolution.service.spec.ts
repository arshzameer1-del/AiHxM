import { Pool } from "pg";
import { ForbiddenException } from "@nestjs/common";
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
import { ShiftsService } from "./shifts.service";
import { WorkScheduleResolutionService } from "./work-schedule-resolution.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "work-schedule-resolution-spec" };

/**
 * Real Postgres, no mocks. Covers the composition
 * WorkScheduleResolutionService exists for (Section 20 of
 * claude/aihxm-work-schedule-architecture.md): weekly-pattern-aware
 * attendance status (rest_day/holiday, not just on_time/late), the
 * mandatory-holiday exclusion surviving even when no Work Schedule is
 * configured at all (the real bug this increment's own regression suite
 * caught — see the roadmap doc's verification note), and view-access
 * enforcement on the resolution preview endpoint.
 */
describe("WorkScheduleResolutionService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let shifts: ShiftsService;
  let holidays: HolidaysService;
  let workSchedule: WorkScheduleResolutionService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    holidays = new HolidaysService(db, rbac, entitlements, audit);
    workSchedule = new WorkScheduleResolutionService(db, shifts, holidays);
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureCompany(namePrefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
      ]);
      const companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true)",
        [companyId]
      );
      return companyId as string;
    });
  }

  async function createUser(email: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, companyId: string, roleKey: string) {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, role.rows[0].id]
      );
    });
  }

  describe("resolveAttendanceStatus", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let employeeId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Attendance Status Co");
      const hrAdminUserId = await createUser(`status-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      const employee = await employees.create(hrAdminClaims, { firstName: "Status", lastName: "Test" });
      employeeId = employee.id;

      const schedule = await shifts.createShift(hrAdminClaims, {
        name: "Weekday Office",
        startTime: "09:00",
        endTime: "17:00",
        graceMinutesLate: 15,
      });
      await shifts.setWeeklyPattern(hrAdminClaims, schedule.id, {
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          isWorking: dayOfWeek !== 5 && dayOfWeek !== 6, // Friday/Saturday off
          startTime: dayOfWeek !== 5 && dayOfWeek !== 6 ? "09:00" : undefined,
          endTime: dayOfWeek !== 5 && dayOfWeek !== 6 ? "17:00" : undefined,
        })),
      });
      await shifts.assignShift(hrAdminClaims, { employeeId, shiftId: schedule.id, effectiveFrom: "2026-01-01" });
      await holidays.createHoliday(hrAdminClaims, { name: "Independence Day", holidayDate: "2026-03-23" });
    });

    it("flags a punch on a weekly-pattern day off as rest_day rather than comparing it to a different day's hours", async () => {
      // 2026-03-20 is a Friday (marked off above).
      const { status } = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.resolveAttendanceStatus(client, employeeId, "2026-03-20", new Date(2026, 2, 20, 9, 30), null)
      );
      expect(status).toBe("rest_day");
    });

    it("flags a punch on a mandatory holiday as holiday, even though it falls on an otherwise-working day", async () => {
      // 2026-03-23 is a Monday (a working day per the pattern) that's also the seeded holiday.
      const { status } = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.resolveAttendanceStatus(client, employeeId, "2026-03-23", new Date(2026, 2, 23, 9, 30), null)
      );
      expect(status).toBe("holiday");
    });

    it("still computes on_time/late normally on an ordinary working day", async () => {
      const onTime = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.resolveAttendanceStatus(client, employeeId, "2026-03-24", new Date(2026, 2, 24, 9, 5), null)
      );
      expect(onTime.status).toBe("on_time");

      const late = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.resolveAttendanceStatus(client, employeeId, "2026-03-24", new Date(2026, 2, 24, 9, 45), null)
      );
      expect(late.status).toBe("late");
    });
  });

  describe("isWorkingDay", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Working Day Co");
      const hrAdminUserId = await createUser(`workday-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      await holidays.createHoliday(hrAdminClaims, { name: "Mandatory Holiday", holidayDate: "2026-03-25" });
    });

    it("still excludes a mandatory holiday even when the employee has no Work Schedule configured at all — the no-schedule branch must not skip the holiday check", async () => {
      const employee = await employees.create(hrAdminClaims, { firstName: "No", lastName: "Schedule" });
      const onHoliday = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.isWorkingDay(client, employee.id, "2026-03-25")
      );
      expect(onHoliday).toBe(false);

      const ordinaryDay = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.isWorkingDay(client, employee.id, "2026-03-26")
      );
      expect(ordinaryDay).toBe(true);
    });

    it("excludes a day the resolved weekly pattern marks off, once a schedule is configured", async () => {
      const employee = await employees.create(hrAdminClaims, { firstName: "Has", lastName: "Schedule" });
      const schedule = await shifts.createShift(hrAdminClaims, { name: "Mon-Thu", startTime: "09:00", endTime: "17:00" });
      await shifts.setWeeklyPattern(hrAdminClaims, schedule.id, {
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          isWorking: dayOfWeek >= 1 && dayOfWeek <= 4,
          startTime: dayOfWeek >= 1 && dayOfWeek <= 4 ? "09:00" : undefined,
          endTime: dayOfWeek >= 1 && dayOfWeek <= 4 ? "17:00" : undefined,
        })),
      });
      await shifts.assignShift(hrAdminClaims, { employeeId: employee.id, shiftId: schedule.id, effectiveFrom: "2026-01-01" });

      // 2026-03-27 is a Friday — off under this 7-day pattern.
      const friday = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.isWorkingDay(client, employee.id, "2026-03-27")
      );
      expect(friday).toBe(false);

      // 2026-03-24 is a Tuesday — working.
      const tuesday = await db.withClaims(hrAdminClaims, (client) =>
        workSchedule.isWorkingDay(client, employee.id, "2026-03-24")
      );
      expect(tuesday).toBe(true);
    });
  });

  describe("getEffectiveSchedule (HTTP-facing preview)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let outsiderClaims: RequestClaims;
    let employeeId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Preview Co");
      const hrAdminUserId = await createUser(`preview-hr-${Date.now()}@example.com`);
      const outsiderUserId = await createUser(`preview-outsider-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(outsiderUserId, companyId, "employee_self_service");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

      const employee = await employees.create(hrAdminClaims, { firstName: "Preview", lastName: "Target" });
      employeeId = employee.id;
      const schedule = await shifts.createShift(hrAdminClaims, { name: "Preview Schedule", startTime: "09:00", endTime: "17:00" });
      await shifts.assignShift(hrAdminClaims, { employeeId, shiftId: schedule.id, effectiveFrom: "2026-01-01" });
    });

    it("returns the resolved schedule for an authorized caller, and 403s a stranger", async () => {
      const resolved = await workSchedule.getEffectiveSchedule(hrAdminClaims, employeeId, "2026-04-01");
      expect(resolved.hasSchedule).toBe(true);
      expect(resolved.scheduleName).toBe("Preview Schedule");
      expect(resolved.isWorking).toBe(true);

      await expect(workSchedule.getEffectiveSchedule(outsiderClaims, employeeId, "2026-04-01")).rejects.toThrow(
        ForbiddenException
      );
    });
  });
});
