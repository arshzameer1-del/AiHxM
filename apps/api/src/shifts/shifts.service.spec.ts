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
import { ShiftsService, computeAttendanceStatus, dayOfWeekForIsoDate } from "./shifts.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "shifts-spec-fixtures" };

/**
 * Real Postgres, no mocks — same discipline as every other service spec
 * in this codebase (see EmployeeGroupsService's own spec doc comment).
 * Covers: shift CRUD + the "at most one default" constraint, assignment
 * supersession (mirrors PayrollService.setCompensation's own test
 * coverage for the identical effective-dating shape), the default-shift
 * fallback when no explicit assignment covers a date, and self/team/all
 * view-permission enforcement.
 */
describe("ShiftsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let shifts: ShiftsService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
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

  describe("shift definitions", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Shifts Co");
      const hrAdminUserId = await createUser(`shifts-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    });

    it("creates a shift and enforces unique names per company", async () => {
      const morning = await shifts.createShift(hrAdminClaims, {
        name: "Morning Shift",
        startTime: "09:00",
        endTime: "17:00",
        graceMinutesLate: 10,
        graceMinutesEarly: 5,
      });
      expect(morning.name).toBe("Morning Shift");
      expect(morning.graceMinutesLate).toBe(10);

      await expect(
        shifts.createShift(hrAdminClaims, { name: "Morning Shift", startTime: "10:00", endTime: "18:00" })
      ).rejects.toThrow(ConflictException);
    });

    it("allows at most one default shift per company", async () => {
      const first = await shifts.createShift(hrAdminClaims, {
        name: "Default A",
        startTime: "08:00",
        endTime: "16:00",
        isDefault: true,
      });
      expect(first.isDefault).toBe(true);

      const second = await shifts.createShift(hrAdminClaims, {
        name: "Default B",
        startTime: "08:00",
        endTime: "16:00",
        isDefault: true,
      });
      expect(second.isDefault).toBe(true);

      const list = await shifts.listShifts(hrAdminClaims);
      const firstAfter = list.find((s) => s.id === first.id)!;
      expect(firstAfter.isDefault).toBe(false);
    });

    it("updates a shift's grace periods", async () => {
      const created = await shifts.createShift(hrAdminClaims, {
        name: "Night Shift",
        startTime: "22:00",
        endTime: "06:00",
        crossesMidnight: true,
      });
      const updated = await shifts.updateShift(hrAdminClaims, created.id, { graceMinutesLate: 15 });
      expect(updated.graceMinutesLate).toBe(15);
      expect(updated.crossesMidnight).toBe(true);
    });

    it("rejects a non-manager from creating shifts", async () => {
      const staffUserId = await createUser(`shifts-staff-${Date.now()}@example.com`);
      await assignRole(staffUserId, companyId, "employee_self_service");
      const staffClaims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

      await expect(
        shifts.createShift(staffClaims, { name: "Sneaky Shift", startTime: "09:00", endTime: "17:00" })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("effective-dated assignment + resolution", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let staffClaims: RequestClaims;
    let outsiderClaims: RequestClaims;
    let employeeId: string;
    let morningId: string;
    let eveningId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Assign Co");
      const hrAdminUserId = await createUser(`assign-hr-${Date.now()}@example.com`);
      const staffUserId = await createUser(`assign-staff-${Date.now()}@example.com`);
      const outsiderUserId = await createUser(`assign-outsider-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(staffUserId, companyId, "employee_self_service");
      await assignRole(outsiderUserId, companyId, "employee_self_service");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
      outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

      const created = await employees.create(hrAdminClaims, { firstName: "Assigned", lastName: "Employee" });
      employeeId = created.id;
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [staffUserId, employeeId]);
      });

      morningId = (
        await shifts.createShift(hrAdminClaims, { name: "AM Shift", startTime: "09:00", endTime: "17:00" })
      ).id;
      eveningId = (
        await shifts.createShift(hrAdminClaims, { name: "PM Shift", startTime: "14:00", endTime: "22:00" })
      ).id;
    });

    it("assigns a shift and supersedes the prior open-ended assignment", async () => {
      await shifts.assignShift(hrAdminClaims, { employeeId, shiftId: morningId, effectiveFrom: "2026-01-01" });
      const second = await shifts.assignShift(hrAdminClaims, {
        employeeId,
        shiftId: eveningId,
        effectiveFrom: "2026-06-01",
      });
      expect(second.shiftId).toBe(eveningId);

      const history = await shifts.getAssignmentHistory(hrAdminClaims, employeeId);
      expect(history).toHaveLength(2);
      const first = history.find((a) => a.shiftId === morningId)!;
      expect(first.effectiveTo).toBe("2026-05-31");
      const latest = history.find((a) => a.shiftId === eveningId)!;
      expect(latest.effectiveTo).toBeNull();
    });

    it("collapses a same-day reassignment into the still-open row rather than opening a second one (fixed via the shared EffectiveDatingEngine retrofit)", async () => {
      const fresh = await employees.create(hrAdminClaims, { firstName: "SameDay", lastName: "Reassign" });
      const today = new Date().toISOString().slice(0, 10);

      // Before the shared-engine retrofit, assignShift had no same-day
      // collapse guard at all — a second assignment on the same day the
      // first was opened would attempt to close it at (today - 1 day),
      // an invalid effective_to < effective_from range. This is the
      // regression test for that fix.
      const first = await shifts.assignShift(hrAdminClaims, { employeeId: fresh.id, shiftId: morningId, effectiveFrom: today });
      const second = await shifts.assignShift(hrAdminClaims, { employeeId: fresh.id, shiftId: eveningId, effectiveFrom: today });
      expect(second.id).toBe(first.id);
      expect(second.shiftId).toBe(eveningId);

      const history = await shifts.getAssignmentHistory(hrAdminClaims, fresh.id);
      expect(history).toHaveLength(1);
    });

    it("supports a bounded (temporary) assignment with an explicit effectiveTo, distinct from the ordinary open-ended case", async () => {
      const fresh = await employees.create(hrAdminClaims, { firstName: "Temp", lastName: "Cover" });
      const covering = await shifts.assignShift(hrAdminClaims, {
        employeeId: fresh.id,
        shiftId: eveningId,
        effectiveFrom: "2026-02-01",
        effectiveTo: "2026-02-07",
      });
      expect(covering.effectiveTo).toBe("2026-02-07");

      const duringCoverage = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, fresh.id, "2026-02-03")
      );
      expect(duringCoverage?.shiftId).toBe(eveningId);

      const afterCoverage = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, fresh.id, "2026-02-10")
      );
      // The bounded assignment ended, no open-ended assignment covers
      // this later date, and this fixture company has no default shift
      // configured yet — same "nothing resolves" outcome as an employee
      // with no assignment at all.
      expect(afterCoverage).toBeNull();
    });

    it("resolves the shift that was actually in effect on a historical date, not today's", async () => {
      const historical = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, employeeId, "2026-03-15")
      );
      expect(historical?.shiftId).toBe(morningId);
      // Regression coverage: resolveForEmployeeOnDate's query used to
      // select only `s.*` (the shifts table) and never `sa.effective_from`/
      // `sa.effective_to` from the assignment row, so these silently fell
      // back to "today"/null for every real assignment (only the
      // default-shift fallback path happened to leave them unset on
      // purpose). Caught via live HTTP verification of GET
      // /employees/:id/shift returning today's date instead of the
      // assignment's actual start date, not by any existing test.
      expect(historical?.effectiveFrom).toBe("2026-01-01");
      expect(historical?.effectiveTo).toBe("2026-05-31");

      const current = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, employeeId, "2026-07-01")
      );
      expect(current?.shiftId).toBe(eveningId);
      expect(current?.effectiveFrom).toBe("2026-06-01");
      expect(current?.effectiveTo).toBeNull();
    });

    it("falls back to the company default shift when no assignment covers the date", async () => {
      const fresh = await employees.create(hrAdminClaims, { firstName: "No", lastName: "Shift" });
      const defaultShift = await shifts.createShift(hrAdminClaims, {
        name: "Fallback Shift",
        startTime: "10:00",
        endTime: "18:00",
        isDefault: true,
      });
      const resolved = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, fresh.id, "2026-01-01")
      );
      expect(resolved?.shiftId).toBe(defaultShift.id);
    });

    it("lets the employee view their own current shift, but not another employee's", async () => {
      const own = await shifts.getCurrentShift(staffClaims, employeeId);
      expect(own?.shiftId).toBe(eveningId);

      await expect(shifts.getCurrentShift(outsiderClaims, employeeId)).rejects.toThrow(ForbiddenException);
    });

    it("404s (via NotFoundException) for an employee that doesn't exist", async () => {
      await expect(shifts.getCurrentShift(hrAdminClaims, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("weekly pattern (Work Schedule architecture)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let scheduleId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Weekly Pattern Co");
      const hrAdminUserId = await createUser(`weekly-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      scheduleId = (
        await shifts.createShift(hrAdminClaims, { name: "Office Hours", startTime: "09:00", endTime: "17:00" })
      ).id;
    });

    it("auto-seeds a 7-day all-working pattern from the shift's own hours on create", async () => {
      const pattern = await shifts.getWeeklyPattern(hrAdminClaims, scheduleId);
      expect(pattern).toHaveLength(7);
      expect(pattern.every((d) => d.isWorking)).toBe(true);
      expect(pattern.every((d) => d.startTime === "09:00:00")).toBe(true);
    });

    it("replaces the weekly pattern, marking Friday/Saturday off and Monday flexible with a paid break", async () => {
      const isOff = (dayOfWeek: number) => dayOfWeek === 5 || dayOfWeek === 6;
      const days = Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        isWorking: !isOff(dayOfWeek),
        startTime: isOff(dayOfWeek) ? undefined : dayOfWeek === 1 ? "07:00" : "09:00",
        endTime: isOff(dayOfWeek) ? undefined : dayOfWeek === 1 ? "20:00" : "17:00",
        isFlexible: dayOfWeek === 1,
        coreStartTime: dayOfWeek === 1 ? "10:00" : undefined,
        coreEndTime: dayOfWeek === 1 ? "16:00" : undefined,
        breaks: dayOfWeek === 1 ? [{ startTime: "13:00", endTime: "14:00", isPaid: true }] : [],
      }));
      const saved = await shifts.setWeeklyPattern(hrAdminClaims, scheduleId, { days });
      expect(saved).toHaveLength(7);

      const friday = saved.find((d) => d.dayOfWeek === 5)!;
      expect(friday.isWorking).toBe(false);
      expect(friday.startTime).toBeNull();

      const monday = saved.find((d) => d.dayOfWeek === 1)!;
      expect(monday.isFlexible).toBe(true);
      expect(monday.coreStartTime).toBe("10:00:00");
      expect(monday.breaks).toHaveLength(1);
      expect(monday.breaks[0].isPaid).toBe(true);
    });

    it("rejects a pattern missing a day, a duplicate day, or a working day with no start/end time", async () => {
      const base = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isWorking: false }));

      await expect(shifts.setWeeklyPattern(hrAdminClaims, scheduleId, { days: base.slice(0, 6) })).rejects.toThrow(
        BadRequestException
      );

      const duplicated = [...base.slice(0, 6), { dayOfWeek: 0, isWorking: false }];
      await expect(shifts.setWeeklyPattern(hrAdminClaims, scheduleId, { days: duplicated })).rejects.toThrow(
        BadRequestException
      );

      const missingHours = base.map((d) => (d.dayOfWeek === 0 ? { dayOfWeek: 0, isWorking: true } : d));
      await expect(shifts.setWeeklyPattern(hrAdminClaims, scheduleId, { days: missingHours })).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("assignment rules (Rules-Engine-backed schedule resolution)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let flexScheduleId: string;
    let nightScheduleId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Assignment Rules Co");
      const hrAdminUserId = await createUser(`rules-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      flexScheduleId = (
        await shifts.createShift(hrAdminClaims, { name: "FLEX-01", startTime: "10:00", endTime: "18:00" })
      ).id;
      nightScheduleId = (
        await shifts.createShift(hrAdminClaims, { name: "NIGHT-01", startTime: "22:00", endTime: "06:00", crossesMidnight: true })
      ).id;
    });

    it("rejects a rule expression naming a field outside the allowed employee-attribute vocabulary", async () => {
      await expect(
        shifts.createAssignmentRule(hrAdminClaims, {
          name: "Bad Rule",
          conditionExpression: { field: "favoriteColor", operator: "equals", value: "blue" },
          scheduleId: flexScheduleId,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("resolves an employee to a rule-matched schedule when no direct assignment exists, and a direct assignment still wins over a matching rule", async () => {
      const engineer = await employees.create(hrAdminClaims, {
        firstName: "Rule",
        lastName: "Matched",
        department: "IT",
        designation: "Software Engineer",
      });

      await shifts.createAssignmentRule(hrAdminClaims, {
        name: "IT -> FLEX-01",
        conditionExpression: { field: "department", operator: "equals", value: "IT" },
        scheduleId: flexScheduleId,
      });

      const viaRule = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, engineer.id, "2026-05-01")
      );
      expect(viaRule?.shiftId).toBe(flexScheduleId);
      expect(viaRule?.assignmentSource).toBe("rule");
      expect(viaRule?.assignmentRuleName).toBe("IT -> FLEX-01");

      // A direct (individual) assignment takes precedence over any
      // matching rule — Section 14's precedence model.
      await shifts.assignShift(hrAdminClaims, { employeeId: engineer.id, shiftId: nightScheduleId, effectiveFrom: "2026-05-01" });
      const viaDirect = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, engineer.id, "2026-05-01")
      );
      expect(viaDirect?.shiftId).toBe(nightScheduleId);
      expect(viaDirect?.assignmentSource).toBe("individual");
    });

    it("breaks a tie between two equal-priority matching rules by specificity (more conditions wins), matching Employee Groups' own tie-break convention", async () => {
      const guard = await employees.create(hrAdminClaims, {
        firstName: "Specific",
        lastName: "Match",
        department: "Operations",
        location: "Karachi Plant",
      });

      await shifts.createAssignmentRule(hrAdminClaims, {
        name: "Operations -> FLEX-01",
        priority: 50,
        conditionExpression: { field: "department", operator: "equals", value: "Operations" },
        scheduleId: flexScheduleId,
      });
      await shifts.createAssignmentRule(hrAdminClaims, {
        name: "Operations+Karachi -> NIGHT-01",
        priority: 50,
        conditionExpression: {
          all: [
            { field: "department", operator: "equals", value: "Operations" },
            { field: "location", operator: "equals", value: "Karachi Plant" },
          ],
        },
        scheduleId: nightScheduleId,
      });

      const resolved = await db.withClaims(hrAdminClaims, (client) =>
        shifts.resolveForEmployeeOnDate(client, guard.id, "2026-05-01")
      );
      expect(resolved?.shiftId).toBe(nightScheduleId);
      expect(resolved?.assignmentRuleName).toBe("Operations+Karachi -> NIGHT-01");
    });

    it("prevents two rules with the same name in a company, and lets an admin deactivate/delete one", async () => {
      const rule = await shifts.createAssignmentRule(hrAdminClaims, {
        name: "Unique Rule",
        conditionExpression: { field: "department", operator: "equals", value: "Finance" },
        scheduleId: flexScheduleId,
      });
      await expect(
        shifts.createAssignmentRule(hrAdminClaims, {
          name: "Unique Rule",
          conditionExpression: { field: "department", operator: "equals", value: "Sales" },
          scheduleId: flexScheduleId,
        })
      ).rejects.toThrow(ConflictException);

      const deactivated = await shifts.updateAssignmentRule(hrAdminClaims, rule.id, { isActive: false });
      expect(deactivated.isActive).toBe(false);

      await shifts.deleteAssignmentRule(hrAdminClaims, rule.id);
      await expect(shifts.updateAssignmentRule(hrAdminClaims, rule.id, { isActive: true })).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("computeAttendanceStatus (pure function)", () => {
    const shift = { startTime: "09:00", endTime: "17:00", graceMinutesLate: 10, graceMinutesEarly: 5 };

    it("is on_time within grace", () => {
      const clockIn = new Date(2026, 0, 1, 9, 8);
      expect(computeAttendanceStatus(clockIn, null, shift)).toBe("on_time");
    });

    it("is late beyond grace", () => {
      const clockIn = new Date(2026, 0, 1, 9, 11);
      expect(computeAttendanceStatus(clockIn, null, shift)).toBe("late");
    });

    it("is early_departure when clocking out before end time minus grace", () => {
      const clockIn = new Date(2026, 0, 1, 9, 0);
      const clockOut = new Date(2026, 0, 1, 16, 50);
      expect(computeAttendanceStatus(clockIn, clockOut, shift)).toBe("early_departure");
    });

    it("is no_shift_assigned when no shift resolves", () => {
      const clockIn = new Date(2026, 0, 1, 9, 30);
      expect(computeAttendanceStatus(clockIn, null, null)).toBe("no_shift_assigned");
    });
  });
});
