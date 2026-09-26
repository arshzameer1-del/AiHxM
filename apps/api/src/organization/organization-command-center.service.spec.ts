import { Pool } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OrgUnitsService } from "./org-units.service";
import { PositionsService } from "./positions.service";
import { EmployeeOrgAssignmentsService } from "./employee-org-assignments.service";
import { OrgChangesService } from "./org-changes.service";
import { OrganizationCommandCenterService } from "./organization-command-center.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "command-center-spec-fixtures" };

/**
 * Organization Management, Phase 6 — the scoped Organization Command
 * Center panel (see `OrganizationCommandCenterService`'s own class doc
 * comment). Real Postgres, no mocks. Since the service does nothing but
 * compose four already-tested `list()` calls, this suite is deliberately
 * thin: it proves the counts/filters/sort are correct against a small
 * known fixture, and that the panel is invisible (propagates
 * ForbiddenException) to a caller with no role at all — it does not
 * re-prove any of the underlying services' own RBAC/RLS behavior.
 */
describe("OrganizationCommandCenterService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let orgUnits: OrgUnitsService;
  let positions: PositionsService;
  let assignments: EmployeeOrgAssignmentsService;
  let employees: EmployeesService;
  let workflow: WorkflowService;
  let orgChanges: OrgChangesService;
  let commandCenter: OrganizationCommandCenterService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    positions = new PositionsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    assignments = new EmployeeOrgAssignmentsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    workflow = new WorkflowService(db, rbac, audit);
    orgChanges = new OrgChangesService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), workflow);
    commandCenter = new OrganizationCommandCenterService(orgUnits, positions, assignments, orgChanges);
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
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        companyId,
      ]);
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

  describe("getSummary()", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let noRoleClaims: RequestClaims;
    let engineeringId: string;
    let salesId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Command Center Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`cc-hr-${stamp}@example.com`);
      const noRoleUserId = await createUser(`cc-norole-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      // Also needed to create a fixture workflow template below (mirrors
      // org-changes.service.spec.ts's own fixture, and the
      // leave-requests.service.spec.ts precedent it in turn follows).
      await assignRole(hrAdminUserId, companyId, "rbac_demo_full_access");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      // Deliberately never assigned any role in this company — proves the
      // panel is invisible end to end, not just gated at one layer.
      noRoleClaims = { is_platform_admin: false, company_id: companyId, sub: noRoleUserId };

      const engineering = await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "division" });
      engineeringId = engineering.id;
      const sales = await orgUnits.create(hrAdminClaims, { name: "Sales", unitType: "division" });
      salesId = sales.id;

      // Positions: one filled, one vacant, one frozen, one abolished.
      const filledJob = await positions.create(hrAdminClaims, { orgUnitId: engineeringId, positionTitle: "Filled Seat" });
      const employee = await employees.create(hrAdminClaims, { firstName: "Command", lastName: "Center" });
      await positions.assignEmployee(hrAdminClaims, filledJob.id, employee.id);

      await positions.create(hrAdminClaims, { orgUnitId: engineeringId, positionTitle: "Vacant Seat" });

      const frozenJob = await positions.create(hrAdminClaims, { orgUnitId: salesId, positionTitle: "Frozen Seat" });
      await positions.freeze(hrAdminClaims, frozenJob.id);

      const abolishedJob = await positions.create(hrAdminClaims, { orgUnitId: salesId, positionTitle: "Abolished Seat" });
      await positions.abolish(hrAdminClaims, abolishedJob.id);

      // One active assignment, one ended.
      await assignments.create(hrAdminClaims, { employeeId: employee.id, assignmentType: "primary", orgUnitId: engineeringId });
      const secondEmployee = await employees.create(hrAdminClaims, { firstName: "Ended", lastName: "Assignment" });
      const endedAssignment = await assignments.create(hrAdminClaims, {
        employeeId: secondEmployee.id,
        assignmentType: "secondary",
        orgUnitId: salesId,
      });
      await assignments.end(hrAdminClaims, endedAssignment.id);

      // Two reorganizations: one draft (in flight), one that stays
      // untouched so recentReorganizations' sort/slice can be checked
      // against a known pair.
      await orgChanges.create(hrAdminClaims, {
        title: "Draft Reorg",
        effectiveDate: "2099-01-01",
        items: [{ orgUnitId: engineeringId, action: "rename", newName: "Engineering (Draft)" }],
      });
      await orgChanges.create(hrAdminClaims, {
        title: "Another Draft Reorg",
        effectiveDate: "2099-01-01",
        items: [{ orgUnitId: salesId, action: "rename", newName: "Sales (Draft)" }],
      });
    });

    it("composes counts across org units, positions, assignments, and reorganizations", async () => {
      const summary = await commandCenter.getSummary(hrAdminClaims);

      expect(summary.totalOrgUnits).toBe(2);
      expect(summary.totalPositions).toBe(4);
      expect(summary.filledPositions).toBe(1);
      expect(summary.vacantPositions).toBe(1);
      expect(summary.frozenPositions).toBe(1);
      expect(summary.abolishedPositions).toBe(1);
      expect(summary.activeAssignments).toBe(1);
      expect(summary.reorganizationsInFlight).toBe(2);
      expect(typeof summary.generatedAt).toBe("string");
    });

    it("returns the most recently updated reorganizations first, capped at 5", async () => {
      const summary = await commandCenter.getSummary(hrAdminClaims);

      expect(summary.recentReorganizations.length).toBeLessThanOrEqual(5);
      const titles = summary.recentReorganizations.map((c) => c.title);
      expect(titles).toEqual(expect.arrayContaining(["Draft Reorg", "Another Draft Reorg"]));
      for (let i = 1; i < summary.recentReorganizations.length; i++) {
        expect(summary.recentReorganizations[i - 1].updatedAt >= summary.recentReorganizations[i].updatedAt).toBe(true);
      }
    });

    it("propagates ForbiddenException for a caller with no role assigned in the company", async () => {
      await expect(commandCenter.getSummary(noRoleClaims)).rejects.toThrow(ForbiddenException);
    });
  });
});
