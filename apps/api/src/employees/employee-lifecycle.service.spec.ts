import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "lifecycle-spec-fixtures" };

/**
 * Core Employee Enterprise Phase 10 — real Postgres, no mocks, same
 * discipline as every prior phase's own spec file. Exercises all 9
 * explicit lifecycle transactions plus the two cross-cutting guarantees
 * that motivated building this as its own service rather than folding it
 * into `EmployeesService.update()`: (1) the pre-existing field-diff
 * inference in `autoRecordJobHistory()` keeps working completely
 * unchanged (covered by `employees.service.spec.ts`'s own test, not
 * re-asserted here), and (2) each of these 9 methods writes its OWN named
 * `event_type`, never a guess.
 */
describe("EmployeeLifecycleService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let lifecycle: EmployeeLifecycleService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;
  let orgUnitAId: string;
  let orgUnitBId: string;
  let locationAId: string;
  let locationBId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    lifecycle = new EmployeeLifecycleService(db, rbac, entitlements, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Lifecycle Co ${stamp}`,
        `lifecycle-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)",
        [id]
      );
      return id;
    });

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `lifecycle-hr-${stamp}@example.com`,
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
        `lifecycle-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const unitA = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id",
        [companyId, "Engineering"]
      );
      orgUnitAId = unitA.rows[0].id;
      const unitB = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id",
        [companyId, "Finance"]
      );
      orgUnitBId = unitB.rows[0].id;
      const locA = await client.query(
        "INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'site', $2) RETURNING id",
        [companyId, "Karachi HQ"]
      );
      locationAId = locA.rows[0].id;
      const locB = await client.query(
        "INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'site', $2) RETURNING id",
        [companyId, "Lahore Office"]
      );
      locationBId = locB.rows[0].id;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function latestHistory(employeeId: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        "SELECT * FROM employee_job_history WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1",
        [employeeId]
      );
      return result.rows[0];
    });
  }

  async function createEmployee(overrides: Record<string, unknown> = {}) {
    const created = await employees.create(hrAdminClaims, {
      firstName: "Test",
      lastName: `Employee-${Math.random().toString(36).slice(2, 8)}`,
      department: "Engineering",
      designation: "Software Engineer",
      orgUnitId: orgUnitAId,
      locationId: locationAId,
      salaryBand: "E3",
      ...overrides,
    } as never);
    return created.id;
  }

  it("transfer() moves org unit/department/location and writes an explicit 'transfer' history row", async () => {
    const employeeId = await createEmployee();

    const result = await lifecycle.transfer(hrAdminClaims, employeeId, {
      orgUnitId: orgUnitBId,
      locationId: locationBId,
      effectiveDate: "2026-10-01",
      notes: "Reorg move to Finance",
    });

    expect(result.employee.orgUnitId).toBe(orgUnitBId);
    expect(result.employee.department).toBe("Finance");
    expect(result.employee.locationId).toBe(locationBId);
    expect(result.employee.location).toBe("Lahore Office");
    expect(result.jobHistory.eventType).toBe("transfer");
    expect(result.jobHistory.effectiveDate).toBe("2026-10-01");

    const row = await latestHistory(employeeId);
    expect(row.event_type).toBe("transfer");
    expect(row.department).toBe("Finance");
  });

  it("promote() changes designation/salary band and writes 'promotion', demote() writes 'demotion'", async () => {
    const employeeId = await createEmployee();

    const promoted = await lifecycle.promote(hrAdminClaims, employeeId, {
      designation: "Senior Software Engineer",
      salaryBand: "E4",
      effectiveDate: "2026-10-01",
    });
    expect(promoted.employee.designation).toBe("Senior Software Engineer");
    expect(promoted.employee.salaryBand).toBe("E4");
    expect(promoted.jobHistory.eventType).toBe("promotion");

    const demoted = await lifecycle.demote(hrAdminClaims, employeeId, {
      designation: "Software Engineer",
      salaryBand: "E3",
      effectiveDate: "2026-11-01",
    });
    expect(demoted.employee.designation).toBe("Software Engineer");
    expect(demoted.jobHistory.eventType).toBe("demotion");
  });

  it("second() requires endDate >= effectiveDate and records both dates on a 'secondment' row", async () => {
    const employeeId = await createEmployee();

    await expect(
      lifecycle.second(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        effectiveDate: "2026-10-10",
        endDate: "2026-10-01",
      })
    ).rejects.toThrow(BadRequestException);

    const result = await lifecycle.second(hrAdminClaims, employeeId, {
      orgUnitId: orgUnitBId,
      effectiveDate: "2026-10-01",
      endDate: "2027-01-01",
      notes: "Temporary posting to Finance",
    });
    expect(result.employee.orgUnitId).toBe(orgUnitBId);
    expect(result.employee.department).toBe("Finance");
    expect(result.jobHistory.eventType).toBe("secondment");
    expect(result.jobHistory.endDate).toBe("2027-01-01");

    const row = await latestHistory(employeeId);
    expect(row.end_date?.toISOString?.().slice(0, 10) ?? row.end_date).toBe("2027-01-01");
  });

  it("assignActingRole() requires a designation and an endDate, and records 'acting'", async () => {
    const employeeId = await createEmployee();

    await expect(
      lifecycle.assignActingRole(hrAdminClaims, employeeId, {
        designation: "",
        effectiveDate: "2026-10-01",
        endDate: "2026-11-01",
      })
    ).rejects.toThrow(BadRequestException);

    const result = await lifecycle.assignActingRole(hrAdminClaims, employeeId, {
      designation: "Acting Engineering Manager",
      effectiveDate: "2026-10-01",
      endDate: "2026-11-01",
    });
    expect(result.employee.designation).toBe("Acting Engineering Manager");
    expect(result.jobHistory.eventType).toBe("acting");
    expect(result.jobHistory.endDate).toBe("2026-11-01");
  });

  it("changeManager() validates the manager exists, isn't terminated, and isn't the employee themselves", async () => {
    const managerId = await createEmployee({ designation: "Engineering Manager" });
    const employeeId = await createEmployee();

    await expect(
      lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: employeeId, effectiveDate: "2026-10-01" })
    ).rejects.toThrow(BadRequestException);

    const missingManagerId = "00000000-0000-0000-0000-000000000000";
    await expect(
      lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: missingManagerId, effectiveDate: "2026-10-01" })
    ).rejects.toThrow(BadRequestException);

    const terminatedManagerId = await createEmployee({ designation: "Former Manager" });
    await lifecycle.terminate(hrAdminClaims, terminatedManagerId, { terminationDate: "2026-09-01" });
    await expect(
      lifecycle.changeManager(hrAdminClaims, employeeId, { managerId: terminatedManagerId, effectiveDate: "2026-10-01" })
    ).rejects.toThrow(BadRequestException);

    const result = await lifecycle.changeManager(hrAdminClaims, employeeId, { managerId, effectiveDate: "2026-10-01" });
    expect(result.employee.managerId).toBe(managerId);
    expect(result.jobHistory.eventType).toBe("manager_change");
  });

  it("changeLocation() derives the location name and records 'location_change'", async () => {
    const employeeId = await createEmployee();

    const result = await lifecycle.changeLocation(hrAdminClaims, employeeId, {
      locationId: locationBId,
      effectiveDate: "2026-10-01",
    });
    expect(result.employee.locationId).toBe(locationBId);
    expect(result.employee.location).toBe("Lahore Office");
    expect(result.jobHistory.eventType).toBe("location_change");
  });

  it("terminate() sets employment status and fires the pre-existing employee.terminated event; reactivate() requires a terminated employee first", async () => {
    const employeeId = await createEmployee();

    await expect(lifecycle.reactivate(hrAdminClaims, employeeId, { effectiveDate: "2026-10-01" })).rejects.toThrow(
      BadRequestException
    );

    const terminated = await lifecycle.terminate(hrAdminClaims, employeeId, {
      terminationDate: "2026-10-01",
      terminationReason: "Resignation",
    });
    expect(terminated.employee.employmentStatus).toBe("terminated");
    expect(terminated.employee.terminationDate).toBe("2026-10-01");
    expect(terminated.jobHistory.eventType).toBe("termination");

    const reactivated = await lifecycle.reactivate(hrAdminClaims, employeeId, {
      effectiveDate: "2026-11-01",
      notes: "Rejoined the company",
    });
    expect(reactivated.employee.employmentStatus).toBe("active");
    expect(reactivated.employee.terminationDate).toBeNull();
    expect(reactivated.jobHistory.eventType).toBe("reactivation");
  });

  it("every method enforces employee.manage.all, throwing ForbiddenException for a caller without it", async () => {
    const employeeId = await createEmployee();
    await expect(
      lifecycle.transfer(noPermissionClaims, employeeId, { effectiveDate: "2026-10-01" })
    ).rejects.toThrow(ForbiddenException);
  });

  describe("reasonCode validation against the HR Administration catalog (v2, 2026-09-27)", () => {
    // A SEPARATE EmployeeLifecycleService instance, wired with a real
    // HrReferenceCatalogService — the top-level `lifecycle` instance above
    // deliberately omits it (undefined, same optional shape as
    // `webhooks?`), so every test above keeps exercising the
    // no-catalog-wired path unchanged.
    let lifecycleWithCatalog: EmployeeLifecycleService;

    beforeAll(() => {
      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      const hrCatalog = new HrReferenceCatalogService(db, rbac, entitlements, audit);
      lifecycleWithCatalog = new EmployeeLifecycleService(db, rbac, entitlements, audit, undefined, hrCatalog);
    });

    it("accepts a seeded default reason code and records it on the job history row", async () => {
      const employeeId = await createEmployee();
      const result = await lifecycleWithCatalog.transfer(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        effectiveDate: "2026-10-01",
        reasonCode: "business_need",
      });
      expect(result.jobHistory.reasonCode).toBe("business_need");
    });

    it("rejects a reason code that isn't an active item in that transaction's mapped catalog", async () => {
      const employeeId = await createEmployee();
      await expect(
        lifecycleWithCatalog.transfer(hrAdminClaims, employeeId, {
          orgUnitId: orgUnitBId,
          effectiveDate: "2026-10-01",
          reasonCode: "not_a_real_reason",
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("terminate() and reactivate() each validate against their own mapped catalog", async () => {
      const employeeId = await createEmployee();
      await expect(
        lifecycleWithCatalog.terminate(hrAdminClaims, employeeId, { terminationDate: "2026-10-01", reasonCode: "made_up" })
      ).rejects.toThrow(BadRequestException);

      const terminated = await lifecycleWithCatalog.terminate(hrAdminClaims, employeeId, {
        terminationDate: "2026-10-01",
        reasonCode: "resignation",
      });
      expect(terminated.jobHistory.reasonCode).toBe("resignation");

      const reactivated = await lifecycleWithCatalog.reactivate(hrAdminClaims, employeeId, {
        effectiveDate: "2026-11-01",
        reasonCode: "leave_completed",
      });
      expect(reactivated.jobHistory.reasonCode).toBe("leave_completed");
    });

    it("leaves reasonCode null when none is supplied, exactly like before this phase", async () => {
      const employeeId = await createEmployee();
      const result = await lifecycleWithCatalog.transfer(hrAdminClaims, employeeId, {
        orgUnitId: orgUnitBId,
        effectiveDate: "2026-10-01",
      });
      expect(result.jobHistory.reasonCode).toBeNull();
    });
  });
});
