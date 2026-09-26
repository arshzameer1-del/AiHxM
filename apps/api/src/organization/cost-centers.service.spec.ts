import { Pool } from "pg";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { OrgUnitsService } from "./org-units.service";
import { CostCentersService } from "./cost-centers.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "cost-centers-spec-fixtures" };

/**
 * Organization Management, Phase 4 (see the Master Engineering
 * Instruction doc's Section 14, and 0073_locations_and_financial_centers.sql).
 * Proven the same way JobsService was — real Postgres, no mocks — flat
 * catalog CRUD, effective-dating/versioning, RBAC, tenant isolation, and
 * the optional org-unit link.
 */
describe("CostCentersService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let costCenters: CostCentersService;
  let orgUnits: OrgUnitsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    costCenters = new CostCentersService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
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

  describe("catalog CRUD, effective-dating, and RBAC", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineeringId: string;
    let engineeringCostCenterId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Cost Center Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`cost-center-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`cost-center-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      engineeringId = (await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "division" })).id;
      engineeringCostCenterId = (
        await costCenters.create(hrAdminClaims, { name: "Engineering Cost Center", code: "CC-ENG", orgUnitId: engineeringId })
      ).id;
    });

    it("creates a cost center with an initial version effective today", async () => {
      const costCenter = await costCenters.get(hrAdminClaims, engineeringCostCenterId);
      expect(costCenter).toMatchObject({
        name: "Engineering Cost Center",
        code: "CC-ENG",
        orgUnitId: engineeringId,
        status: "active",
      });

      const history = await costCenters.getHistory(hrAdminClaims, engineeringCostCenterId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ name: "Engineering Cost Center", effectiveTo: null });
    });

    it("rejects a duplicate code within the same tenant", async () => {
      await expect(
        costCenters.create(hrAdminClaims, { name: "Duplicate Code Cost Center", code: "CC-ENG" })
      ).rejects.toThrow(ConflictException);
    });

    it("allows a cost center with no code or orgUnitId at all — neither is required", async () => {
      const minimal = await costCenters.create(hrAdminClaims, { name: "Minimal Cost Center" });
      expect(minimal).toMatchObject({ name: "Minimal Cost Center", code: null, orgUnitId: null });
    });

    it("404s when creating with a nonexistent orgUnitId", async () => {
      await expect(
        costCenters.create(hrAdminClaims, { name: "Orphan Cost Center", orgUnitId: "00000000-0000-0000-0000-000000000000" })
      ).rejects.toThrow(NotFoundException);
    });

    it("list() returns every cost center in the tenant, alphabetical", async () => {
      const list = await costCenters.list(hrAdminClaims);
      const names = list.map((c) => c.name);
      expect(names).toEqual([...names].sort());
      expect(names).toContain("Engineering Cost Center");
    });

    it("update() renames in place and opens a new version (unless same-day, then collapses)", async () => {
      const updated = await costCenters.update(hrAdminClaims, engineeringCostCenterId, { name: "Engineering Cost Center (Renamed)" });
      expect(updated.name).toBe("Engineering Cost Center (Renamed)");
      const history = await costCenters.getHistory(hrAdminClaims, engineeringCostCenterId);
      expect(history).toHaveLength(1);
      expect(history[0].name).toBe("Engineering Cost Center (Renamed)");
    });

    it("update(): orgUnitId: null explicitly clears the link", async () => {
      const cleared = await costCenters.update(hrAdminClaims, engineeringCostCenterId, { orgUnitId: null });
      expect(cleared.orgUnitId).toBeNull();
      // Restore for the remaining tests in this block.
      await costCenters.update(hrAdminClaims, engineeringCostCenterId, { orgUnitId: engineeringId });
    });

    it("archive()/activate() toggle status", async () => {
      const archived = await costCenters.archive(hrAdminClaims, engineeringCostCenterId);
      expect(archived.status).toBe("archived");
      const reactivated = await costCenters.activate(hrAdminClaims, engineeringCostCenterId);
      expect(reactivated.status).toBe("active");
    });

    it("404s on a nonexistent cost center id", async () => {
      await expect(costCenters.get(hrAdminClaims, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
        NotFoundException
      );
    });

    it("a Line Manager (cost_center.view.all only) can read the catalog but not mutate it", async () => {
      const list = await costCenters.list(managerClaims);
      expect(list.length).toBeGreaterThan(0);
      await expect(costCenters.create(managerClaims, { name: "Nope" })).rejects.toThrow(ForbiddenException);
      await expect(costCenters.update(managerClaims, engineeringCostCenterId, { name: "Nope" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("404s the whole module when `employee` is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(costCenters.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  describe("tenant isolation (RLS)", () => {
    it("a cost center created in one tenant is invisible to another tenant's session", async () => {
      const companyAId = await createFixtureCompany("Cost Center Isolation A");
      const companyBId = await createFixtureCompany("Cost Center Isolation B");
      const hrAdminA = await createUser(`cost-center-iso-a-${Date.now()}@example.com`);
      const hrAdminB = await createUser(`cost-center-iso-b-${Date.now()}@example.com`);
      await assignRole(hrAdminA, companyAId, "hr_admin");
      await assignRole(hrAdminB, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: hrAdminA };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: hrAdminB };

      const costCenterA = await costCenters.create(claimsA, { name: "A-Only Cost Center" });

      await expect(costCenters.get(claimsB, costCenterA.id)).rejects.toThrow(NotFoundException);
      const listB = await costCenters.list(claimsB);
      expect(listB.find((c) => c.id === costCenterA.id)).toBeUndefined();
    });
  });

  /**
   * Organization Management, Phase 7 (Unified Integration & Synchronization
   * Requirements, Section 14). Confirms the shared `org.financial_center.changed`
   * event really enqueues end to end through a real WebhookDispatchService
   * for this side (Cost Center), with `payload.centerType === "cost_center"`
   * distinguishing it from Profit Center's own events on the same event
   * type, plus the new flat `tenantId`/`entityId`/`effectiveDate`/
   * `occurredAt` fields per `buildOrgEventPayload()`'s contract.
   * `costCenters` above (this file's shared instance) is built WITHOUT a
   * WebhookDispatchService — proving the optional-dependency design
   * doesn't secretly break anything for it — so this uses its own instance
   * instead.
   */
  describe("webhook events (Organization Management Phase 7)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let costCentersWithWebhooks: CostCentersService;
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "cost-center-webhook-spec" };

    beforeAll(async () => {
      companyId = await createFixtureCompany("Cost Center Webhook Co");
      const hrAdminUserId = await createUser(`cost-center-webhook-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "cost-center-trigger-secret" },
      });

      costCentersWithWebhooks = new CostCentersService(
        db,
        new RbacService(db),
        new EntitlementsService(db),
        new AuditService(),
        new EffectiveDatingEngine(),
        new WebhookDispatchService(db, new AuditService())
      );
    });

    async function latestEventFor(type: string) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await db.withClaims(platformClaims, (client) =>
        client.query(
          "SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1",
          [companyId, type]
        )
      );
      return result.rows[0];
    }

    it("enqueues org.financial_center.changed with centerType 'cost_center' on create()", async () => {
      const created = await costCentersWithWebhooks.create(hrAdminClaims, { name: "Webhook Cost Center" });
      const event = await latestEventFor("org.financial_center.changed");
      expect(event).toBeDefined();
      expect(event.payload.eventVersion).toBe(1);
      expect(event.payload.changeType).toBe("create");
      expect(event.payload.centerType).toBe("cost_center");
      expect(event.payload.tenantId).toBe(companyId);
      expect(event.payload.entityId).toBe(created.id);
      expect(event.payload.costCenter.id).toBe(created.id);
    });
  });

  describe("Data Scope (Organization Management Phase 11, Section 19)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let regionalFinanceClaims: RequestClaims;
    let assignedCostCenterId: string;
    let otherCostCenterId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Finance Scope Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`cc-scope-hr-${stamp}@example.com`);
      const regionalFinanceUserId = await createUser(`cc-scope-finance-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(regionalFinanceUserId, companyId, "regional_finance");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      regionalFinanceClaims = { is_platform_admin: false, company_id: companyId, sub: regionalFinanceUserId };

      // Cost Center is a flat catalog (Phase 4) — no subtree to expand,
      // the assignment applies to exactly the one center.
      assignedCostCenterId = (await costCenters.create(hrAdminClaims, { name: "North Region CC" })).id;
      otherCostCenterId = (await costCenters.create(hrAdminClaims, { name: "South Region CC" })).id;

      await assignDataScope(regionalFinanceUserId, companyId, "cost_center", assignedCostCenterId);
    });

    it("list()/get() restrict a regional_finance caller to their assigned cost center only (flat, no expansion)", async () => {
      const visible = await costCenters.list(regionalFinanceClaims);
      expect(visible.map((c) => c.id)).toEqual([assignedCostCenterId]);

      await expect(costCenters.get(regionalFinanceClaims, otherCostCenterId)).rejects.toThrow(NotFoundException);
      await expect(costCenters.get(regionalFinanceClaims, assignedCostCenterId)).resolves.toMatchObject({
        id: assignedCostCenterId,
      });
    });
  });
});
