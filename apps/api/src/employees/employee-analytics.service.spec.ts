import { Pool } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { EmployeeAnalyticsService } from "./employee-analytics.service";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "analytics-spec-fixtures" };

/**
 * Core Employee Enterprise Phase 12 — Workforce Analytics. Real Postgres,
 * no mocks. One fixture company with a deliberately small, hand-computable
 * population so every aggregate's expected value can be checked exactly
 * rather than just asserting shape.
 */
describe("EmployeeAnalyticsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let lifecycle: EmployeeLifecycleService;
  let analytics: EmployeeAnalyticsService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    lifecycle = new EmployeeLifecycleService(db, rbac, entitlements, audit);
    analytics = new EmployeeAnalyticsService(db, entitlements, rbac);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Analytics Co ${stamp}`,
        `analytics-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
      return id;
    });

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `analytics-hr-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        hrAdminUserId,
        companyId,
        role.rows[0].id,
      ]);
    });
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const outsiderUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `analytics-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    // Population: 2 active Engineering employees (one male, one female,
    // both permanent), 1 active Finance employee (contract, unspecified
    // gender), and 1 terminated employee (terminated 10 days ago — inside
    // the 90-day window). Every active employee joined exactly 2 years ago
    // so averageTenureYears is hand-computable.
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const joinDate = twoYearsAgo.toISOString().slice(0, 10);

    const eng1 = await employees.create(hrAdminClaims, {
      firstName: "Eng",
      lastName: "One",
      department: "Engineering",
      employmentType: "permanent",
      gender: "male",
      dateOfJoining: joinDate,
    });
    await employees.create(hrAdminClaims, {
      firstName: "Eng",
      lastName: "Two",
      department: "Engineering",
      employmentType: "permanent",
      gender: "female",
      dateOfJoining: joinDate,
    });
    await employees.create(hrAdminClaims, {
      firstName: "Fin",
      lastName: "One",
      department: "Finance",
      employmentType: "contract",
      dateOfJoining: joinDate,
    });

    const toTerminate = await employees.create(hrAdminClaims, {
      firstName: "Terminated",
      lastName: "Recently",
      department: "Sales",
      dateOfJoining: joinDate,
    });
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    await lifecycle.terminate(hrAdminClaims, toTerminate.id, {
      terminationDate: tenDaysAgo.toISOString().slice(0, 10),
      terminationReason: "Resignation",
    });

    // An important date due in 10 days, and an asset currently assigned —
    // both on eng1, exercising the two Phase 7/9 table joins directly.
    await db.withClaims(hrAdminClaims, async (client) => {
      const tenDaysFromNow = new Date();
      tenDaysFromNow.setDate(tenDaysFromNow.getDate() + 10);
      await client.query(
        "INSERT INTO employee_important_dates (company_id, employee_id, date_type, date_value) VALUES ($1, $2, 'contract_end', $3)",
        [companyId, eng1.id, tenDaysFromNow.toISOString().slice(0, 10)]
      );
      await client.query(
        "INSERT INTO employee_assets (company_id, employee_id, asset_type, description, assigned_date) VALUES ($1, $2, 'laptop', 'ThinkPad X1', CURRENT_DATE)",
        [companyId, eng1.id]
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("requires employee.manage.all", async () => {
    await expect(analytics.getSummary(noPermissionClaims)).rejects.toThrow(ForbiddenException);
  });

  it("computes headcount, breakdowns, tenure, terminations, and the Phase 7/9 cross-table counts, all against real rows", async () => {
    const summary = await analytics.getSummary(hrAdminClaims);

    expect(summary.totalActiveEmployees).toBe(3);

    const deptByKey = Object.fromEntries(summary.headcountByDepartment.map((d) => [d.key, d.count]));
    expect(deptByKey.Engineering).toBe(2);
    expect(deptByKey.Finance).toBe(1);
    expect(deptByKey.Sales).toBeUndefined(); // the terminated employee is excluded entirely

    const typeByKey = Object.fromEntries(summary.headcountByEmploymentType.map((d) => [d.key, d.count]));
    expect(typeByKey.permanent).toBe(2);
    expect(typeByKey.contract).toBe(1);

    const genderByKey = Object.fromEntries(summary.genderBreakdown.map((d) => [d.key, d.count]));
    expect(genderByKey.male).toBe(1);
    expect(genderByKey.female).toBe(1);
    expect(genderByKey.Unspecified).toBe(1);

    expect(summary.averageTenureYears).not.toBeNull();
    expect(summary.averageTenureYears!).toBeGreaterThan(1.9);
    expect(summary.averageTenureYears!).toBeLessThan(2.1);

    expect(summary.terminationsLast90Days).toBe(1);
    expect(summary.upcomingImportantDatesNext30Days).toBe(1);
    expect(summary.assetsCurrentlyAssigned).toBe(1);
  });
});
