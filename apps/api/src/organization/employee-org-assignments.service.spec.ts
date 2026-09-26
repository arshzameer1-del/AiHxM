import { Pool } from "pg";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { OrgUnitsService } from "./org-units.service";
import { PositionsService } from "./positions.service";
import { LocationsService } from "./locations.service";
import { EmployeeOrgAssignmentsService } from "./employee-org-assignments.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "assignments-spec-fixtures" };

/**
 * Organization Management, Phase 3 (see the Master Engineering
 * Instruction doc's Section 11, and
 * 0071_employee_org_assignments_and_relationships.sql). Real Postgres, no
 * mocks — the two things this entity actually adds over Position/Job: at
 * most one open `primary` assignment per employee (DB + app enforced), and
 * any number of concurrently-open non-primary assignments.
 */
describe("EmployeeOrgAssignmentsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let orgUnits: OrgUnitsService;
  let positions: PositionsService;
  let locations: LocationsService;
  let employees: EmployeesService;
  let assignments: EmployeeOrgAssignmentsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    positions = new PositionsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    locations = new LocationsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    assignments = new EmployeeOrgAssignmentsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
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

  /** Organization Management Phase 11 (Section 19) — same raw-SQL fixture
   * convention `org-units.service.spec.ts` already established. */
  async function assignDataScope(userAccountId: string, companyId: string, scopeType: string, scopeEntityId: string) {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query(
        "INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1, $2, $3, $4)",
        [userAccountId, companyId, scopeType, scopeEntityId]
      );
    });
  }

  describe("CRUD, effective-dating, one-open-primary, and RBAC", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineeringUnitId: string;
    let salesUnitId: string;
    let employeeId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Assignment Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`assign-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`assign-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      engineeringUnitId = (await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "department" })).id;
      salesUnitId = (await orgUnits.create(hrAdminClaims, { name: "Sales", unitType: "department" })).id;
      employeeId = (await employees.create(hrAdminClaims, { firstName: "Assignment", lastName: "Target" })).id;
    });

    it("creates a primary assignment, active by default", async () => {
      const assignment = await assignments.create(hrAdminClaims, {
        employeeId,
        assignmentType: "primary",
        orgUnitId: engineeringUnitId,
      });
      expect(assignment).toMatchObject({
        employeeId,
        assignmentType: "primary",
        orgUnitId: engineeringUnitId,
        positionId: null,
        status: "active",
      });

      const history = await assignments.getHistory(hrAdminClaims, assignment.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: "active", effectiveTo: null });
    });

    it("404s creating against a nonexistent employee", async () => {
      await expect(
        assignments.create(hrAdminClaims, {
          employeeId: "00000000-0000-0000-0000-000000000000",
          assignmentType: "secondary",
          orgUnitId: engineeringUnitId,
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("404s creating against a nonexistent org unit", async () => {
      const otherEmployee = await employees.create(hrAdminClaims, { firstName: "Other", lastName: "Employee" });
      await expect(
        assignments.create(hrAdminClaims, {
          employeeId: otherEmployee.id,
          assignmentType: "secondary",
          orgUnitId: "00000000-0000-0000-0000-000000000000",
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("404s creating with a nonexistent position", async () => {
      const otherEmployee = await employees.create(hrAdminClaims, { firstName: "Another", lastName: "Employee" });
      await expect(
        assignments.create(hrAdminClaims, {
          employeeId: otherEmployee.id,
          assignmentType: "secondary",
          orgUnitId: engineeringUnitId,
          positionId: "00000000-0000-0000-0000-000000000000",
        })
      ).rejects.toThrow(NotFoundException);
    });

    describe("one open primary per employee, many open non-primary", () => {
      it("rejects a second open primary assignment for the same employee", async () => {
        const otherEmployee = await employees.create(hrAdminClaims, { firstName: "One", lastName: "Primary" });
        await assignments.create(hrAdminClaims, { employeeId: otherEmployee.id, assignmentType: "primary", orgUnitId: engineeringUnitId });

        await expect(
          assignments.create(hrAdminClaims, { employeeId: otherEmployee.id, assignmentType: "primary", orgUnitId: salesUnitId })
        ).rejects.toThrow(ConflictException);
      });

      it("allows multiple concurrently-open non-primary assignments for the same employee", async () => {
        const otherEmployee = await employees.create(hrAdminClaims, { firstName: "Many", lastName: "Concurrent" });
        const secondary = await assignments.create(hrAdminClaims, {
          employeeId: otherEmployee.id,
          assignmentType: "secondary",
          orgUnitId: engineeringUnitId,
        });
        const concurrent = await assignments.create(hrAdminClaims, {
          employeeId: otherEmployee.id,
          assignmentType: "concurrent",
          orgUnitId: salesUnitId,
        });
        const secondment = await assignments.create(hrAdminClaims, {
          employeeId: otherEmployee.id,
          assignmentType: "secondment",
          orgUnitId: salesUnitId,
        });

        const list = await assignments.list(hrAdminClaims, { employeeId: otherEmployee.id, status: "active" });
        expect(list.map((a) => a.id).sort()).toEqual([secondary.id, concurrent.id, secondment.id].sort());
      });

      it("allows a primary AND several non-primary assignments to coexist for the same employee", async () => {
        const otherEmployee = await employees.create(hrAdminClaims, { firstName: "Primary", lastName: "PlusExtra" });
        await assignments.create(hrAdminClaims, { employeeId: otherEmployee.id, assignmentType: "primary", orgUnitId: engineeringUnitId });
        await assignments.create(hrAdminClaims, { employeeId: otherEmployee.id, assignmentType: "acting", orgUnitId: salesUnitId });

        const list = await assignments.list(hrAdminClaims, { employeeId: otherEmployee.id });
        expect(list).toHaveLength(2);
      });

      it("a primary assignment can be created again once the prior one is ended", async () => {
        const otherEmployee = await employees.create(hrAdminClaims, { firstName: "Reprimary", lastName: "Employee" });
        const first = await assignments.create(hrAdminClaims, { employeeId: otherEmployee.id, assignmentType: "primary", orgUnitId: engineeringUnitId });
        await assignments.end(hrAdminClaims, first.id);

        const second = await assignments.create(hrAdminClaims, { employeeId: otherEmployee.id, assignmentType: "primary", orgUnitId: salesUnitId });
        expect(second.status).toBe("active");
      });
    });

    it("list() filters by orgUnitId and assignmentType", async () => {
      const filteredByUnit = await assignments.list(hrAdminClaims, { orgUnitId: salesUnitId });
      expect(filteredByUnit.every((a) => a.orgUnitId === salesUnitId)).toBe(true);

      const filteredByType = await assignments.list(hrAdminClaims, { assignmentType: "primary" });
      expect(filteredByType.every((a) => a.assignmentType === "primary")).toBe(true);
    });

    // Organization Management Phase 9 — the new `positionId` filter,
    // needed by PositionDetailPage's "Assignment History" tab (every
    // assignment slot that has ever pointed at one specific position).
    it("list() filters by positionId", async () => {
      const seat = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Filter Seat" });
      const otherSeat = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Other Seat" });
      const seatHolder = await employees.create(hrAdminClaims, { firstName: "Seat", lastName: "Holder" });
      const otherHolder = await employees.create(hrAdminClaims, { firstName: "Other", lastName: "Holder" });

      const onSeat = await assignments.create(hrAdminClaims, {
        employeeId: seatHolder.id,
        assignmentType: "secondary",
        orgUnitId: engineeringUnitId,
        positionId: seat.id,
      });
      await assignments.create(hrAdminClaims, {
        employeeId: otherHolder.id,
        assignmentType: "secondary",
        orgUnitId: engineeringUnitId,
        positionId: otherSeat.id,
      });
      await assignments.create(hrAdminClaims, {
        employeeId: otherHolder.id,
        assignmentType: "concurrent",
        orgUnitId: engineeringUnitId,
      });

      const filtered = await assignments.list(hrAdminClaims, { positionId: seat.id });
      expect(filtered.map((a) => a.id)).toEqual([onSeat.id]);
    });

    it("update() moves an assignment to a different org unit in place, keeping the same id", async () => {
      const target = await employees.create(hrAdminClaims, { firstName: "Move", lastName: "Me" });
      const assignment = await assignments.create(hrAdminClaims, { employeeId: target.id, assignmentType: "secondary", orgUnitId: engineeringUnitId });

      const moved = await assignments.update(hrAdminClaims, assignment.id, { orgUnitId: salesUnitId });
      expect(moved.id).toBe(assignment.id);
      expect(moved.orgUnitId).toBe(salesUnitId);

      const history = await assignments.getHistory(hrAdminClaims, assignment.id);
      expect(history.length).toBeGreaterThanOrEqual(1);
    });

    it("update() with positionId: null clears the position link", async () => {
      const target = await employees.create(hrAdminClaims, { firstName: "Clear", lastName: "Position" });
      const position = await positions.create(hrAdminClaims, { orgUnitId: engineeringUnitId, positionTitle: "Assignment Seat" });
      const assignment = await assignments.create(hrAdminClaims, {
        employeeId: target.id,
        assignmentType: "secondary",
        orgUnitId: engineeringUnitId,
        positionId: position.id,
      });
      expect(assignment.positionId).toBe(position.id);

      const cleared = await assignments.update(hrAdminClaims, assignment.id, { positionId: null });
      expect(cleared.positionId).toBeNull();
    });

    describe("end()", () => {
      it("ends an assignment — a no-op on an already-ended one", async () => {
        const target = await employees.create(hrAdminClaims, { firstName: "End", lastName: "Me" });
        const assignment = await assignments.create(hrAdminClaims, { employeeId: target.id, assignmentType: "secondary", orgUnitId: engineeringUnitId });

        const ended = await assignments.end(hrAdminClaims, assignment.id);
        expect(ended.status).toBe("ended");

        const endedAgain = await assignments.end(hrAdminClaims, assignment.id);
        expect(endedAgain.status).toBe("ended");
      });

      it("ending a primary assignment does not touch employees.orgUnitId/positionId (documented scope boundary)", async () => {
        const target = await employees.create(hrAdminClaims, { firstName: "Scope", lastName: "Boundary", orgUnitId: engineeringUnitId });
        const before = await employees.get(hrAdminClaims, target.id);
        const assignment = await assignments.create(hrAdminClaims, { employeeId: target.id, assignmentType: "primary", orgUnitId: salesUnitId });
        await assignments.end(hrAdminClaims, assignment.id);

        const after = await employees.get(hrAdminClaims, target.id);
        expect(after.orgUnitId).toBe(before.orgUnitId);
      });
    });

    it("a Line Manager (employee_org_assignment.view.all only) can read but not mutate", async () => {
      const list = await assignments.list(managerClaims);
      expect(Array.isArray(list)).toBe(true);
      await expect(
        assignments.create(managerClaims, { employeeId, assignmentType: "secondary", orgUnitId: engineeringUnitId })
      ).rejects.toThrow(ForbiddenException);
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(assignments.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("an assignment created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Assignment Isolation A");
      const companyBId = await createFixtureCompany("Assignment Isolation B");
      const hrAdminA = await createUser(`assign-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`assign-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const unitA = await orgUnits.create(claimsA, { name: "A-Only Unit", unitType: "department" });
      const employeeA = await employees.create(claimsA, { firstName: "A-Only", lastName: "Employee" });
      const assignmentA = await assignments.create(claimsA, { employeeId: employeeA.id, assignmentType: "primary", orgUnitId: unitA.id });

      await expect(assignments.get(claimsB, assignmentA.id)).rejects.toThrow(NotFoundException);
      const listB = await assignments.list(claimsB);
      expect(listB.find((a) => a.id === assignmentA.id)).toBeUndefined();
    });
  });

  /**
   * Organization Management, Phase 6 — Events. Confirms
   * `org.assignment.changed` really enqueues end to end through a real
   * WebhookDispatchService, the same pattern as
   * `employees.service.spec.ts`'s own "webhook events" block.
   * `assignments` above (this file's shared instance) is built WITHOUT a
   * WebhookDispatchService — proving the optional-dependency design
   * doesn't secretly break anything for it — so this uses its own instance
   * instead.
   */
  describe("webhook events (Organization Management Phase 6)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let orgUnitId: string;
    let employeeId: string;
    let assignmentsWithWebhooks: EmployeeOrgAssignmentsService;
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "assignment-webhook-spec" };

    beforeAll(async () => {
      companyId = await createFixtureCompany("Assignment Webhook Co");
      const hrAdminUserId = await createUser(`assignment-webhook-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "assignment-trigger-secret" },
      });

      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      orgUnitId = (
        await new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine()).create(hrAdminClaims, {
          name: "Webhook Dept",
          unitType: "department",
        })
      ).id;
      employeeId = (await employees.create(hrAdminClaims, { firstName: "Webhook", lastName: "Assignee" })).id;

      assignmentsWithWebhooks = new EmployeeOrgAssignmentsService(
        db,
        rbac,
        entitlements,
        audit,
        new EffectiveDatingEngine(),
        new WebhookDispatchService(db, new AuditService())
      );
    });

    async function latestEventFor(type: string) {
      // enqueue() is fire-and-forget — give its own DB write a moment to
      // land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await db.withClaims(platformClaims, (client) =>
        client.query(
          "SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1",
          [companyId, type]
        )
      );
      return result.rows[0];
    }

    it("enqueues org.assignment.changed on create()", async () => {
      const created = await assignmentsWithWebhooks.create(hrAdminClaims, {
        employeeId,
        assignmentType: "secondary",
        orgUnitId,
      });
      const event = await latestEventFor("org.assignment.changed");
      expect(event).toBeDefined();
      expect(event.payload.eventVersion).toBe(1);
      expect(event.payload.changeType).toBe("create");
      expect(event.payload.assignment.id).toBe(created.id);
    });

    it("enqueues org.assignment.changed with changeType 'end' on end()", async () => {
      const created = await assignmentsWithWebhooks.create(hrAdminClaims, {
        employeeId,
        assignmentType: "secondary",
        orgUnitId,
      });
      await assignmentsWithWebhooks.end(hrAdminClaims, created.id);
      const event = await latestEventFor("org.assignment.changed");
      expect(event.payload.changeType).toBe("end");
      expect(event.payload.assignment.status).toBe("ended");
    });
  });

  describe("Data Scope (Organization Management Phase 11, Section 19)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let regionalHrClaims: RequestClaims;
    let assignedOrgUnitId: string;
    let otherOrgUnitId: string;
    let assignedLocationId: string;
    let assignmentInScopeByOrgUnit: string;
    let assignmentInScopeByLocationOnly: string;
    let assignmentOutOfScope: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Assignment Scope Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`assign-scope-hr-${stamp}@example.com`);
      const regionalHrUserId = await createUser(`assign-scope-regional-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(regionalHrUserId, companyId, "regional_hr");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      regionalHrClaims = { is_platform_admin: false, company_id: companyId, sub: regionalHrUserId };

      assignedOrgUnitId = (await orgUnits.create(hrAdminClaims, { name: "Scoped Unit", unitType: "department" })).id;
      otherOrgUnitId = (await orgUnits.create(hrAdminClaims, { name: "Other Unit", unitType: "department" })).id;
      assignedLocationId = (await locations.create(hrAdminClaims, { name: "Scoped City", locationType: "city" })).id;

      const employeeInOrgUnit = await employees.create(hrAdminClaims, { firstName: "In", lastName: "OrgUnitScope" });
      const employeeInLocation = await employees.create(hrAdminClaims, { firstName: "In", lastName: "LocationScope" });
      const employeeOutOfScope = await employees.create(hrAdminClaims, { firstName: "Out", lastName: "OfScope" });

      assignmentInScopeByOrgUnit = (
        await assignments.create(hrAdminClaims, {
          employeeId: employeeInOrgUnit.id,
          assignmentType: "primary",
          orgUnitId: assignedOrgUnitId,
        })
      ).id;
      assignmentInScopeByLocationOnly = (
        await assignments.create(hrAdminClaims, {
          employeeId: employeeInLocation.id,
          assignmentType: "primary",
          orgUnitId: otherOrgUnitId,
          locationId: assignedLocationId,
        })
      ).id;
      assignmentOutOfScope = (
        await assignments.create(hrAdminClaims, {
          employeeId: employeeOutOfScope.id,
          assignmentType: "primary",
          orgUnitId: otherOrgUnitId,
        })
      ).id;

      await assignDataScope(regionalHrUserId, companyId, "org_unit", assignedOrgUnitId);
      await assignDataScope(regionalHrUserId, companyId, "location", assignedLocationId);
    });

    it("list() is visible along EITHER the org-unit or the location dimension the caller holds assignments for", async () => {
      const visible = await assignments.list(regionalHrClaims);
      const ids = visible.map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining([assignmentInScopeByOrgUnit, assignmentInScopeByLocationOnly]));
      expect(ids).not.toContain(assignmentOutOfScope);
    });

    it("get() 404s on an assignment outside both dimensions", async () => {
      await expect(assignments.get(regionalHrClaims, assignmentOutOfScope)).rejects.toThrow(NotFoundException);
      await expect(assignments.get(regionalHrClaims, assignmentInScopeByLocationOnly)).resolves.toMatchObject({
        id: assignmentInScopeByLocationOnly,
      });
    });
  });
});
