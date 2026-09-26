import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OrgRelationshipsService } from "./org-relationships.service";
import { LegacyReconciliationService } from "./legacy-reconciliation.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "legacy-reconciliation-spec-fixtures" };

/**
 * Organization Management Phase 12 (Unified Integration & Synchronization
 * Requirements, Section 24 — Legacy Data Migration). Real Postgres, no
 * mocks, matching every prior phase of this initiative. One fixture
 * company carries every scenario this service needs to distinguish:
 * a department gap with an exact-name match, a location gap with only a
 * fuzzy match, a department gap with NO match at all (the org unit simply
 * doesn't exist yet — a legitimate, non-error outcome), a manager gap,
 * and one fully-modern employee with no gaps at all (proving the report
 * doesn't just list everyone in the tenant).
 */
describe("LegacyReconciliationService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let relationships: OrgRelationshipsService;
  let legacyReconciliation: LegacyReconciliationService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;
  let orgUnitEngineeringId: string;
  let locationLahoreOfficeId: string;
  let managerId: string;
  let managerFullName: string;
  let deptGapEmployeeId: string;
  let locationGapEmployeeId: string;
  let managerGapEmployeeId: string;
  let noMatchGapEmployeeId: string;
  let noGapEmployeeId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    relationships = new OrgRelationshipsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    legacyReconciliation = new LegacyReconciliationService(db, entitlements, rbac, employees, relationships);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Legacy Reconciliation Co ${stamp}`,
        `legacy-reconciliation-co-${stamp}`,
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
      const account = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `legacy-reconciliation-hr-${stamp}@example.com`,
      ]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        account.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return account.rows[0].id as string;
    });
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const noPermissionUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const account = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `legacy-reconciliation-noperm-${stamp}@example.com`,
      ]);
      // `system_admin` deliberately holds zero employee.*/org_unit.*
      // permissions — see that role's own migration header comment, and
      // the exact same "fails closed" precedent org-units.service.spec.ts's
      // own Data Scope tests already established for this role.
      const role = await client.query("SELECT id FROM roles WHERE key = 'system_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        account.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return account.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: noPermissionUserId };

    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const orgUnit = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id",
        [companyId]
      );
      orgUnitEngineeringId = orgUnit.rows[0].id;

      const location = await client.query(
        "INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'site', 'Lahore Office') RETURNING id",
        [companyId]
      );
      locationLahoreOfficeId = location.rows[0].id;
    });

    const manager = await employees.create(hrAdminClaims, { firstName: "Manager", lastName: "Person" });
    managerId = manager.id;
    managerFullName = "Manager Person";

    const deptGapEmployee = await employees.create(hrAdminClaims, {
      firstName: "Legacy",
      lastName: "Department",
      department: "Engineering",
    });
    deptGapEmployeeId = deptGapEmployee.id;

    const locationGapEmployee = await employees.create(hrAdminClaims, {
      firstName: "Legacy",
      lastName: "Location",
      location: "Lahore",
    });
    locationGapEmployeeId = locationGapEmployee.id;

    const managerGapEmployee = await employees.create(hrAdminClaims, {
      firstName: "Legacy",
      lastName: "Manager",
      managerId,
    });
    managerGapEmployeeId = managerGapEmployee.id;

    const noMatchGapEmployee = await employees.create(hrAdminClaims, {
      firstName: "Legacy",
      lastName: "NoMatch",
      department: "Business Transformation Office",
    });
    noMatchGapEmployeeId = noMatchGapEmployee.id;

    const noGapEmployee = await employees.create(hrAdminClaims, { firstName: "Fully", lastName: "Modern" });
    noGapEmployeeId = noGapEmployee.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("getReport()", () => {
    it("requires employee.manage.all — the same permission every write action here needs", async () => {
      await expect(legacyReconciliation.getReport(noPermissionClaims)).rejects.toThrow(ForbiddenException);
    });

    it("lists exactly the employees with at least one unmapped legacy field, each with its own gap(s)", async () => {
      const report = await legacyReconciliation.getReport(hrAdminClaims);
      const ids = report.employees.map((e) => e.employeeId);

      expect(ids).toContain(deptGapEmployeeId);
      expect(ids).toContain(locationGapEmployeeId);
      expect(ids).toContain(managerGapEmployeeId);
      expect(ids).toContain(noMatchGapEmployeeId);
      expect(ids).not.toContain(noGapEmployeeId);
      expect(ids).not.toContain(managerId);
    });

    it("suggests an exact match when the legacy department text equals a real org unit's name", async () => {
      const report = await legacyReconciliation.getReport(hrAdminClaims);
      const entry = report.employees.find((e) => e.employeeId === deptGapEmployeeId)!;
      expect(entry.gaps).toHaveLength(1);
      expect(entry.gaps[0]).toMatchObject({
        gapType: "department",
        legacyValue: "Engineering",
        suggestions: [{ id: orgUnitEngineeringId, name: "Engineering", matchType: "exact" }],
      });
    });

    it("suggests a fuzzy match when the legacy location text is a substring of a real location's name", async () => {
      const report = await legacyReconciliation.getReport(hrAdminClaims);
      const entry = report.employees.find((e) => e.employeeId === locationGapEmployeeId)!;
      expect(entry.gaps).toHaveLength(1);
      expect(entry.gaps[0]).toMatchObject({
        gapType: "location",
        legacyValue: "Lahore",
        suggestions: [{ id: locationLahoreOfficeId, name: "Lahore Office", matchType: "fuzzy" }],
      });
    });

    it("returns an empty suggestions list when nothing matches at all — a legitimate outcome, not an error", async () => {
      const report = await legacyReconciliation.getReport(hrAdminClaims);
      const entry = report.employees.find((e) => e.employeeId === noMatchGapEmployeeId)!;
      expect(entry.gaps).toEqual([
        { gapType: "department", legacyValue: "Business Transformation Office", suggestions: [] },
      ]);
    });

    it("surfaces a manager gap with the already-known manager, not a suggestions list", async () => {
      const report = await legacyReconciliation.getReport(hrAdminClaims);
      const entry = report.employees.find((e) => e.employeeId === managerGapEmployeeId)!;
      expect(entry.gaps).toEqual([{ gapType: "manager", legacyValue: managerFullName, managerEmployeeId: managerId }]);
    });
  });

  describe("linkOrgUnit()", () => {
    it("links the org unit, deriving `department` from its current name via EmployeesService.update()", async () => {
      const updated = await legacyReconciliation.linkOrgUnit(hrAdminClaims, deptGapEmployeeId, orgUnitEngineeringId);
      expect(updated.orgUnitId).toBe(orgUnitEngineeringId);
      expect(updated.department).toBe("Engineering");

      const report = await legacyReconciliation.getReport(hrAdminClaims);
      expect(report.employees.map((e) => e.employeeId)).not.toContain(deptGapEmployeeId);
    });

    it("refuses to re-point an employee who is already linked to an org unit", async () => {
      await expect(
        legacyReconciliation.linkOrgUnit(hrAdminClaims, deptGapEmployeeId, orgUnitEngineeringId)
      ).rejects.toThrow(BadRequestException);
    });

    it("404s for a nonexistent employee", async () => {
      await expect(
        legacyReconciliation.linkOrgUnit(hrAdminClaims, "00000000-0000-0000-0000-000000000000", orgUnitEngineeringId)
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("linkLocation()", () => {
    it("links the location, deriving `location` from its current name via EmployeesService.update()", async () => {
      const updated = await legacyReconciliation.linkLocation(hrAdminClaims, locationGapEmployeeId, locationLahoreOfficeId);
      expect(updated.locationId).toBe(locationLahoreOfficeId);
      expect(updated.location).toBe("Lahore Office");

      const report = await legacyReconciliation.getReport(hrAdminClaims);
      expect(report.employees.map((e) => e.employeeId)).not.toContain(locationGapEmployeeId);
    });

    it("refuses to re-point an employee who is already linked to a location", async () => {
      await expect(
        legacyReconciliation.linkLocation(hrAdminClaims, locationGapEmployeeId, locationLahoreOfficeId)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("linkManagerRelationship()", () => {
    it("creates the missing typed direct relationship from the employee's legacy managerId", async () => {
      await legacyReconciliation.linkManagerRelationship(hrAdminClaims, managerGapEmployeeId);

      const relationshipList = await relationships.list(hrAdminClaims, { employeeId: managerGapEmployeeId, status: "active" });
      expect(relationshipList).toHaveLength(1);
      expect(relationshipList[0]).toMatchObject({
        employeeId: managerGapEmployeeId,
        managerEmployeeId: managerId,
        relationshipType: "direct",
        status: "active",
      });

      const report = await legacyReconciliation.getReport(hrAdminClaims);
      expect(report.employees.map((e) => e.employeeId)).not.toContain(managerGapEmployeeId);
    });

    it("rejects an employee with no legacy manager to reconcile", async () => {
      await expect(legacyReconciliation.linkManagerRelationship(hrAdminClaims, noGapEmployeeId)).rejects.toThrow(
        BadRequestException
      );
    });

    it("404s for a nonexistent employee", async () => {
      await expect(
        legacyReconciliation.linkManagerRelationship(hrAdminClaims, "00000000-0000-0000-0000-000000000000")
      ).rejects.toThrow(NotFoundException);
    });
  });
});
