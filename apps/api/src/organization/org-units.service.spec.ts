import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
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

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-units-spec-fixtures" };

/**
 * Organization Management, Phase 1 (see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md and
 * 0065_organization_units.sql). Proven the same way every prior phase's
 * new object was: real Postgres, no mocks — hierarchy CRUD, the recursive-
 * descendant query, the cycle guard on reparenting, RLS/tenant isolation,
 * and the department-sync-on-set behavior in EmployeesService.
 */
describe("OrgUnitsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let orgUnits: OrgUnitsService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
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

  describe("hierarchy CRUD, tree/descendant queries, and move/archive", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineeringId: string;
    let backendId: string;
    let frontendId: string;
    let salesId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Org Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`org-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`org-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      //        Engineering (division)
      //         /              \
      //     Backend          Frontend        Sales (root, sibling)
      engineeringId = (
        await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "division", code: "ENG" })
      ).id;
      backendId = (
        await orgUnits.create(hrAdminClaims, { name: "Backend", unitType: "department", parentId: engineeringId })
      ).id;
      frontendId = (
        await orgUnits.create(hrAdminClaims, { name: "Frontend", unitType: "department", parentId: engineeringId })
      ).id;
      salesId = (await orgUnits.create(hrAdminClaims, { name: "Sales", unitType: "department" })).id;
    });

    it("creates a unit with an initial version effective today", async () => {
      const unit = await orgUnits.get(hrAdminClaims, engineeringId);
      expect(unit).toMatchObject({ name: "Engineering", unitType: "division", code: "ENG", status: "active", parentId: null });

      const history = await orgUnits.getHistory(hrAdminClaims, engineeringId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ name: "Engineering", effectiveTo: null });
    });

    it("rejects a duplicate code within the same tenant", async () => {
      await expect(
        orgUnits.create(hrAdminClaims, { name: "Engineering Duplicate", unitType: "division", code: "ENG" })
      ).rejects.toThrow(ConflictException);
    });

    it("404s when creating under a nonexistent parent", async () => {
      await expect(
        orgUnits.create(hrAdminClaims, { name: "Orphan", unitType: "department", parentId: "00000000-0000-0000-0000-000000000000" })
      ).rejects.toThrow(NotFoundException);
    });

    it("listRoots returns only top-level units", async () => {
      const roots = await orgUnits.listRoots(hrAdminClaims);
      const rootNames = roots.map((r) => r.name);
      expect(rootNames).toEqual(expect.arrayContaining(["Engineering", "Sales"]));
      expect(rootNames).not.toContain("Backend");
      expect(rootNames).not.toContain("Frontend");
    });

    it("listChildren returns only direct children, not grandchildren", async () => {
      const children = await orgUnits.listChildren(hrAdminClaims, engineeringId);
      expect(children.map((c) => c.name).sort()).toEqual(["Backend", "Frontend"]);
    });

    it("getDescendants (recursive CTE) returns every descendant, not just direct children", async () => {
      const descendants = await orgUnits.getDescendants(hrAdminClaims, engineeringId);
      expect(descendants.map((d) => d.id).sort()).toEqual([backendId, frontendId].sort());
      // Sales is a sibling, not a descendant, of Engineering.
      expect(descendants.map((d) => d.id)).not.toContain(salesId);
    });

    it("getDescendants of a leaf node is empty", async () => {
      const descendants = await orgUnits.getDescendants(hrAdminClaims, backendId);
      expect(descendants).toEqual([]);
    });

    it("getTree nests the whole company's hierarchy", async () => {
      const tree = await orgUnits.getTree(hrAdminClaims);
      const engineeringNode = tree.find((n) => n.id === engineeringId)!;
      expect(engineeringNode.children.map((c) => c.name).sort()).toEqual(["Backend", "Frontend"]);
      const salesNode = tree.find((n) => n.id === salesId)!;
      expect(salesNode.children).toEqual([]);
    });

    it("update() renames in place and opens a new version (unless same-day, then collapses)", async () => {
      const updated = await orgUnits.update(hrAdminClaims, salesId, { name: "Sales & Marketing" });
      expect(updated.name).toBe("Sales & Marketing");
      // Same-day collapse — the original create() and this update() both
      // land on today, so this is still exactly one version, in place,
      // matching EffectiveDatingEngine's documented collapse rule.
      const history = await orgUnits.getHistory(hrAdminClaims, salesId);
      expect(history).toHaveLength(1);
      expect(history[0].name).toBe("Sales & Marketing");
    });

    it("rejects parent_id = id (a unit cannot be its own parent)", async () => {
      await expect(orgUnits.move(hrAdminClaims, backendId, { parentId: backendId })).rejects.toThrow(BadRequestException);
    });

    it("rejects moving a unit under its own descendant (cycle guard)", async () => {
      // Engineering -> Backend already exists; moving Engineering under
      // Backend would create a cycle and disconnect the whole subtree.
      await expect(orgUnits.move(hrAdminClaims, engineeringId, { parentId: backendId })).rejects.toThrow(
        BadRequestException
      );
      // The hierarchy must be completely unaffected by the rejected move.
      const stillRoot = await orgUnits.get(hrAdminClaims, engineeringId);
      expect(stillRoot.parentId).toBeNull();
    });

    it("move() reparents a unit and getDescendants/getTree reflect it immediately", async () => {
      const moved = await orgUnits.move(hrAdminClaims, frontendId, { parentId: null });
      expect(moved.parentId).toBeNull();

      const engineeringDescendants = await orgUnits.getDescendants(hrAdminClaims, engineeringId);
      expect(engineeringDescendants.map((d) => d.id)).not.toContain(frontendId);
      expect(engineeringDescendants.map((d) => d.id)).toContain(backendId);

      const roots = await orgUnits.listRoots(hrAdminClaims);
      expect(roots.map((r) => r.id)).toContain(frontendId);

      // Move it back so later tests in this block see the original shape.
      await orgUnits.move(hrAdminClaims, frontendId, { parentId: engineeringId });
    });

    it("archive()/activate() toggle status without touching the hierarchy", async () => {
      const archived = await orgUnits.archive(hrAdminClaims, backendId);
      expect(archived.status).toBe("archived");
      expect(archived.parentId).toBe(engineeringId);

      const reactivated = await orgUnits.activate(hrAdminClaims, backendId);
      expect(reactivated.status).toBe("active");
    });

    it("a Line Manager (org_unit.view.all only) can read the hierarchy but not mutate it", async () => {
      const tree = await orgUnits.getTree(managerClaims);
      expect(tree.length).toBeGreaterThan(0);
      await expect(orgUnits.create(managerClaims, { name: "Nope", unitType: "department" })).rejects.toThrow(
        ForbiddenException
      );
      await expect(orgUnits.update(managerClaims, salesId, { name: "Nope" })).rejects.toThrow(ForbiddenException);
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(orgUnits.getTree(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a unit created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Isolation A");
      const companyBId = await createFixtureCompany("Isolation B");
      const hrAdminA = await createUser(`iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const unitA = await orgUnits.create(claimsA, { name: "A-Only Unit", unitType: "department" });

      await expect(orgUnits.get(claimsB, unitA.id)).rejects.toThrow(NotFoundException);
      const treeB = await orgUnits.getTree(claimsB);
      expect(treeB.find((n) => n.id === unitA.id)).toBeUndefined();
    });
  });

  describe("EmployeesService integration — department-sync-on-set", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let engineeringId: string;
    let salesId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Sync Co");
      const hrAdminUserId = await createUser(`sync-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      engineeringId = (await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "department" })).id;
      salesId = (await orgUnits.create(hrAdminClaims, { name: "Sales", unitType: "department" })).id;
    });

    it("create(): setting orgUnitId derives `department` from the unit's current name", async () => {
      const employee = await employees.create(hrAdminClaims, {
        firstName: "Synced",
        lastName: "Employee",
        orgUnitId: engineeringId,
        department: "This text should be ignored",
      });
      expect(employee.orgUnitId).toBe(engineeringId);
      expect(employee.department).toBe("Engineering");
    });

    it("update(): re-linking to a different org unit re-derives `department`", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Move", lastName: "Me", orgUnitId: engineeringId });
      expect(created.department).toBe("Engineering");

      const updated = await employees.update(hrAdminClaims, created.id, { orgUnitId: salesId });
      expect(updated.orgUnitId).toBe(salesId);
      expect(updated.department).toBe("Sales");
    });

    it("an employee with no orgUnitId keeps the legacy free-text behavior completely unchanged", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Free", lastName: "Text", department: "Legal" });
      expect(created.orgUnitId).toBeNull();
      expect(created.department).toBe("Legal");

      const updated = await employees.update(hrAdminClaims, created.id, { department: "Compliance" });
      expect(updated.orgUnitId).toBeNull();
      expect(updated.department).toBe("Compliance");
    });

    it("renaming an org unit does not retroactively change already-synced employees until they're re-saved", async () => {
      // This is a deliberate, documented Phase 1 scope limit — see this
      // service's own summary notes: a live "rename cascades to every
      // linked employee's department text" propagation is not built in
      // this phase (employees.department is a point-in-time sync, not a
      // live view of org_units.name).
      const created = await employees.create(hrAdminClaims, { firstName: "Stale", lastName: "Text", orgUnitId: engineeringId });
      await orgUnits.update(hrAdminClaims, engineeringId, { name: "Engineering (Renamed)" });
      const fetched = await employees.get(hrAdminClaims, created.id);
      expect(fetched.department).toBe("Engineering");

      // But the NEXT save re-derives it from the (now renamed) unit.
      const resaved = await employees.update(hrAdminClaims, created.id, { orgUnitId: engineeringId });
      expect(resaved.department).toBe("Engineering (Renamed)");
    });

    it("rejects linking an employee to a nonexistent org unit", async () => {
      await expect(
        employees.create(hrAdminClaims, { firstName: "Bad", lastName: "Link", orgUnitId: "00000000-0000-0000-0000-000000000000" })
      ).rejects.toThrow(BadRequestException);
    });
  });

  /**
   * Organization Management, Phase 6 — Events. Confirms `org.unit.changed`
   * really enqueues end to end through a real WebhookDispatchService, the
   * same pattern `employees.service.spec.ts`'s own "webhook events" block
   * proved for `employee.created`/`employee.terminated`. `orgUnits` above
   * (this file's shared instance) is built WITHOUT a WebhookDispatchService
   * — proving the optional-dependency design doesn't secretly break
   * anything for it — so this uses its own instance instead.
   */
  describe("webhook events (Organization Management Phase 6)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let orgUnitsWithWebhooks: OrgUnitsService;
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-unit-webhook-spec" };

    beforeAll(async () => {
      companyId = await createFixtureCompany("Org Unit Webhook Co");
      const hrAdminUserId = await createUser(`org-unit-webhook-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "org-unit-trigger-secret" },
      });

      orgUnitsWithWebhooks = new OrgUnitsService(
        db,
        new RbacService(db),
        new EntitlementsService(db),
        new AuditService(),
        new EffectiveDatingEngine(),
        new WebhookDispatchService(db, new AuditService())
      );
    });

    async function latestEventFor(type: string) {
      // enqueue() is fire-and-forget — give its own DB write a moment to
      // land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 200));
      // webhook_events RLS gates on is_platform_admin() OR is_service() —
      // read it back with platformClaims, not the tenant-side hrAdminClaims
      // that drove the create()/update()/move() calls above.
      const result = await db.withClaims(platformClaims, (client) =>
        client.query(
          "SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1",
          [companyId, type]
        )
      );
      return result.rows[0];
    }

    it("enqueues org.unit.changed on create()", async () => {
      const created = await orgUnitsWithWebhooks.create(hrAdminClaims, { name: "Engineering", unitType: "department" });
      const event = await latestEventFor("org.unit.changed");
      expect(event).toBeDefined();
      expect(event.payload.eventVersion).toBe(1);
      expect(event.payload.changeType).toBe("create");
      expect(event.payload.orgUnit.id).toBe(created.id);
    });

    it("enqueues org.unit.changed with changeType 'update' on update()", async () => {
      const created = await orgUnitsWithWebhooks.create(hrAdminClaims, { name: "Sales", unitType: "department" });
      await orgUnitsWithWebhooks.update(hrAdminClaims, created.id, { name: "Sales & Marketing" });
      const event = await latestEventFor("org.unit.changed");
      expect(event.payload.changeType).toBe("update");
      expect(event.payload.orgUnit.name).toBe("Sales & Marketing");
    });

    it("enqueues org.unit.changed with changeType 'move' on move()", async () => {
      const parent = await orgUnitsWithWebhooks.create(hrAdminClaims, { name: "Operations", unitType: "department" });
      const child = await orgUnitsWithWebhooks.create(hrAdminClaims, { name: "Logistics", unitType: "department" });
      await orgUnitsWithWebhooks.move(hrAdminClaims, child.id, { parentId: parent.id });
      const event = await latestEventFor("org.unit.changed");
      expect(event.payload.changeType).toBe("move");
      expect(event.payload.orgUnit.parentId).toBe(parent.id);
    });

    it("enqueues org.unit.changed with changeType 'archive'/'activate' on setStatus()", async () => {
      const unit = await orgUnitsWithWebhooks.create(hrAdminClaims, { name: "Temp Unit", unitType: "department" });
      await orgUnitsWithWebhooks.archive(hrAdminClaims, unit.id);
      const archivedEvent = await latestEventFor("org.unit.changed");
      expect(archivedEvent.payload.changeType).toBe("archive");
      expect(archivedEvent.payload.orgUnit.status).toBe("archived");

      await orgUnitsWithWebhooks.activate(hrAdminClaims, unit.id);
      const activatedEvent = await latestEventFor("org.unit.changed");
      expect(activatedEvent.payload.changeType).toBe("activate");
      expect(activatedEvent.payload.orgUnit.status).toBe("active");
    });
  });
});
