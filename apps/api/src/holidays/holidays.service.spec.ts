import { Pool } from "pg";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { HolidaysService } from "./holidays.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "holidays-spec-fixtures" };

/**
 * Real Postgres, no mocks — same discipline as ShiftsService's own spec.
 * Covers: CRUD + the per-company (date, name) uniqueness constraint,
 * year filtering, manage-vs-view permission enforcement, and that
 * "manage implies view" for hr_admin without a separate grant.
 */
describe("HolidaysService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let holidays: HolidaysService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    holidays = new HolidaysService(db, rbac, entitlements, audit);
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

  describe("holiday CRUD", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let staffClaims: RequestClaims;
    let managerClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Holidays Co");
      const hrAdminUserId = await createUser(`holidays-hr-${Date.now()}@example.com`);
      const staffUserId = await createUser(`holidays-staff-${Date.now()}@example.com`);
      const managerUserId = await createUser(`holidays-mgr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(staffUserId, companyId, "employee_self_service");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };
    });

    it("creates a holiday and enforces uniqueness per company/date/name", async () => {
      const eid = await holidays.createHoliday(hrAdminClaims, {
        name: "Independence Day",
        holidayDate: "2026-08-14",
      });
      expect(eid.name).toBe("Independence Day");
      expect(eid.isOptional).toBe(false);

      await expect(
        holidays.createHoliday(hrAdminClaims, { name: "Independence Day", holidayDate: "2026-08-14" })
      ).rejects.toThrow(ConflictException);
    });

    it("allows an optional holiday on the same date with a different name", async () => {
      const created = await holidays.createHoliday(hrAdminClaims, {
        name: "Ashura (optional observance)",
        holidayDate: "2026-08-14",
        isOptional: true,
      });
      expect(created.isOptional).toBe(true);
    });

    it("updates a holiday's date and name", async () => {
      const created = await holidays.createHoliday(hrAdminClaims, {
        name: "Draft Holiday",
        holidayDate: "2026-03-23",
      });
      const updated = await holidays.updateHoliday(hrAdminClaims, created.id, {
        name: "Pakistan Day",
        holidayDate: "2026-03-23",
      });
      expect(updated.name).toBe("Pakistan Day");
    });

    it("deletes a holiday", async () => {
      const created = await holidays.createHoliday(hrAdminClaims, {
        name: "To Be Removed",
        holidayDate: "2026-05-01",
      });
      await holidays.deleteHoliday(hrAdminClaims, created.id);
      await expect(holidays.deleteHoliday(hrAdminClaims, created.id)).rejects.toThrow(NotFoundException);
    });

    it("rejects a non-hr_admin from managing the calendar", async () => {
      await expect(
        holidays.createHoliday(staffClaims, { name: "Sneaky Holiday", holidayDate: "2026-12-25" })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        holidays.createHoliday(managerClaims, { name: "Sneaky Holiday 2", holidayDate: "2026-12-25" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("lets every role view the calendar, including hr_admin without a separate view grant", async () => {
      const asStaff = await holidays.listHolidays(staffClaims);
      const asManager = await holidays.listHolidays(managerClaims);
      const asHrAdmin = await holidays.listHolidays(hrAdminClaims);
      expect(asStaff.length).toBeGreaterThan(0);
      expect(asManager.length).toBe(asStaff.length);
      expect(asHrAdmin.length).toBe(asStaff.length);
    });

    it("filters the calendar by year", async () => {
      await holidays.createHoliday(hrAdminClaims, { name: "Next Year Holiday", holidayDate: "2027-01-01" });
      const in2026 = await holidays.listHolidays(hrAdminClaims, "2026");
      const in2027 = await holidays.listHolidays(hrAdminClaims, "2027");
      expect(in2026.every((h) => h.holidayDate.startsWith("2026"))).toBe(true);
      expect(in2027).toHaveLength(1);
      expect(in2027[0].name).toBe("Next Year Holiday");
    });
  });
});
