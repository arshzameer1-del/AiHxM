import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { OrgUnitsService } from "./org-units.service";
import { OrgChangesService } from "./org-changes.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-changes-spec-fixtures" };

/**
 * Organization Management, Phase 5 (see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md and
 * 0076_reorganization_changes.sql). Real Postgres, no mocks — the full
 * Draft -> Validate -> Impact Analysis -> Approval -> Effective-Date
 * Execution -> Publish lifecycle, plus the batch-aware cycle/orphan
 * detection `validate()` adds on top of `OrgUnitsService.move()`'s own
 * single-reparent guard.
 */
describe("OrgChangesService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let orgUnits: OrgUnitsService;
  let workflow: WorkflowService;
  let orgChanges: OrgChangesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    orgUnits = new OrgUnitsService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    workflow = new WorkflowService(db, rbac, audit);
    orgChanges = new OrgChangesService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), workflow);
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

  async function createEmployeeRow(companyId: string, orgUnitId: string, employeeNumber: string): Promise<string> {
    const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, org_unit_id) VALUES ($1, $2, 'Test', 'Employee', $3) RETURNING id`,
        [companyId, employeeNumber, orgUnitId]
      )
    );
    return result.rows[0].id as string;
  }

  // Organization Management Phase 10 — raw-SQL fixture helpers for the two
  // new impact counts, matching this file's own existing style
  // (`createEmployeeRow` above is already a raw INSERT, not a service call)
  // rather than pulling in OrgRelationshipsService/PositionsService/
  // CostCentersService/ProfitCentersService purely to seed rows these tests
  // never otherwise exercise the business logic of.
  async function createRelationshipRow(companyId: string, employeeId: string, managerEmployeeId: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type, status) VALUES ($1, $2, $3, 'direct', 'active')`,
        [companyId, employeeId, managerEmployeeId]
      )
    );
  }

  async function createPositionWithCenters(
    companyId: string,
    orgUnitId: string,
    costCenterId: string | null,
    profitCenterId: string | null
  ): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO positions (company_id, org_unit_id, position_title, cost_center_id, profit_center_id, status)
         VALUES ($1, $2, 'Impact Test Seat', $3, $4, 'vacant')`,
        [companyId, orgUnitId, costCenterId, profitCenterId]
      )
    );
  }

  async function createCostCenterRow(companyId: string, code: string): Promise<string> {
    const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(`INSERT INTO cost_centers (company_id, name, code, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [
        companyId,
        `Cost Center ${code}`,
        code,
      ])
    );
    return result.rows[0].id as string;
  }

  async function createProfitCenterRow(companyId: string, code: string): Promise<string> {
    const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(`INSERT INTO profit_centers (company_id, name, code, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [
        companyId,
        `Profit Center ${code}`,
        code,
      ])
    );
    return result.rows[0].id as string;
  }

  describe("Draft -> Validate -> Impact Analysis -> Approval -> Execution -> Publish", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let engineeringId: string;
    let backendId: string;
    let frontendId: string;
    let salesId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Reorg Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`reorg-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`reorg-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      // Also holds rbac_demo_full_access, which is what actually gates
      // WorkflowService.createTemplate() (0008_workflow_seed.sql) — the
      // same combination leave-requests.service.spec.ts's own fixture
      // uses to configure a tenant's approval routing in a test.
      await assignRole(hrAdminUserId, companyId, "rbac_demo_full_access");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      const engineering = await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "division" });
      engineeringId = engineering.id;
      const backend = await orgUnits.create(hrAdminClaims, { name: "Backend", unitType: "department", parentId: engineeringId });
      backendId = backend.id;
      const frontend = await orgUnits.create(hrAdminClaims, { name: "Frontend", unitType: "department", parentId: engineeringId });
      frontendId = frontend.id;
      const sales = await orgUnits.create(hrAdminClaims, { name: "Sales", unitType: "division" });
      salesId = sales.id;

      await workflow.createTemplate(hrAdminClaims, {
        key: "org_reorganization",
        name: "Reorganization Approval",
        objectKey: "org_reorganization",
        steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: await hrAdminRoleId() }] }],
      });
    });

    async function hrAdminRoleId(): Promise<string> {
      const result = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT id FROM roles WHERE key = 'hr_admin'"));
      return result.rows[0].id;
    }

    it("a line_manager (view-only) cannot draft a reorganization change", async () => {
      await expect(
        orgChanges.create(managerClaims, {
          title: "Rename Backend",
          effectiveDate: "2026-01-01",
          items: [{ orgUnitId: backendId, action: "rename", newName: "Platform Engineering" }],
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("drafts a change, validates it, and transitions draft -> validated", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Rename Backend",
        description: "Backend becomes Platform Engineering",
        effectiveDate: "2020-01-01", // deliberately in the past — exercises immediate execution later
        items: [{ orgUnitId: backendId, action: "rename", newName: "Platform Engineering" }],
      });
      expect(change.status).toBe("draft");
      expect(change.items).toHaveLength(1);

      const result = await orgChanges.validate(hrAdminClaims, change.id);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      const reloaded = await orgChanges.get(hrAdminClaims, change.id);
      expect(reloaded.status).toBe("validated");
      expect(reloaded.validatedAt).not.toBeNull();
    });

    it("validate() reports an error and stays draft when an item targets a nonexistent org unit", async () => {
      const bogusId = "00000000-0000-0000-0000-000000000000";
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Bad target",
        effectiveDate: "2026-01-01",
        items: [{ orgUnitId: bogusId, action: "archive" }],
      });
      const result = await orgChanges.validate(hrAdminClaims, change.id);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("not found");

      const reloaded = await orgChanges.get(hrAdminClaims, change.id);
      expect(reloaded.status).toBe("draft");
    });

    it("validate() rejects a move that would make a unit its own parent", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Self-parent",
        effectiveDate: "2026-01-01",
        items: [{ orgUnitId: frontendId, action: "move", newParentId: frontendId }],
      });
      const result = await orgChanges.validate(hrAdminClaims, change.id);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("own parent");
    });

    it("validate() catches a two-item cycle that neither item alone would create (batch-aware detection)", async () => {
      // Engineering moves under Sales, and in the SAME batch Sales moves
      // under Engineering — each individually cycle-free against today's
      // hierarchy, but combined they close a loop. This is exactly the
      // check 0065_organization_units.sql's own header comment deferred
      // to "Phase 5 territory."
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Swap Engineering and Sales",
        effectiveDate: "2026-01-01",
        items: [
          { orgUnitId: engineeringId, action: "move", newParentId: salesId },
          { orgUnitId: salesId, action: "move", newParentId: engineeringId },
        ],
      });
      const result = await orgChanges.validate(hrAdminClaims, change.id);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
    });

    it("validate() flags an orphan: moving under a unit this same batch archives", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Move under archived parent",
        effectiveDate: "2026-01-01",
        items: [
          { orgUnitId: salesId, action: "archive" },
          { orgUnitId: frontendId, action: "move", newParentId: salesId },
        ],
      });
      const result = await orgChanges.validate(hrAdminClaims, change.id);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("archives"))).toBe(true);
    });

    it("validate() warns (but doesn't fail) when another in-flight change targets the same org unit", async () => {
      const first = await orgChanges.create(hrAdminClaims, {
        title: "First change to Frontend",
        effectiveDate: "2026-06-01",
        items: [{ orgUnitId: frontendId, action: "rename", newName: "Frontend Guild" }],
      });
      await orgChanges.validate(hrAdminClaims, first.id);

      const second = await orgChanges.create(hrAdminClaims, {
        title: "Second change to Frontend",
        effectiveDate: "2026-06-01",
        items: [{ orgUnitId: frontendId, action: "retype", newUnitType: "function" }],
      });
      const result = await orgChanges.validate(hrAdminClaims, second.id);
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("in-flight"))).toBe(true);
    });

    it("analyzeImpact() requires a validated change and counts the affected subtree", async () => {
      await createEmployeeRow(companyId, backendId, `EMP-${Date.now()}-1`);
      await createEmployeeRow(companyId, engineeringId, `EMP-${Date.now()}-2`);

      const change = await orgChanges.create(hrAdminClaims, {
        title: "Archive Backend",
        effectiveDate: "2026-01-01",
        items: [{ orgUnitId: backendId, action: "archive" }],
      });

      await expect(orgChanges.analyzeImpact(hrAdminClaims, change.id)).rejects.toThrow(BadRequestException);

      await orgChanges.validate(hrAdminClaims, change.id);
      const summary = await orgChanges.analyzeImpact(hrAdminClaims, change.id);
      expect(summary.affectedOrgUnitCount).toBeGreaterThanOrEqual(1);
      expect(summary.affectedEmployeeCount).toBeGreaterThanOrEqual(1);

      const reloaded = await orgChanges.get(hrAdminClaims, change.id);
      expect(reloaded.impactSummary).toEqual(summary);
    });

    // Organization Management Phase 10 — the two counts Section 18 added.
    it("analyzeImpact() also counts affected reporting relationships and financial centers", async () => {
      const insider = await createEmployeeRow(companyId, backendId, `EMP-${Date.now()}-3`);
      const outsider = await createEmployeeRow(companyId, salesId, `EMP-${Date.now()}-4`);
      // One relationship entirely inside the affected subtree (both sides
      // in backendId), one crossing the boundary (manager outside, in
      // salesId) — both should count, proving the "either side" rule.
      const insider2 = await createEmployeeRow(companyId, backendId, `EMP-${Date.now()}-5`);
      await createRelationshipRow(companyId, insider2, insider);
      await createRelationshipRow(companyId, insider, outsider);

      const costCenterId = await createCostCenterRow(companyId, `CC-${Date.now()}`);
      const profitCenterId = await createProfitCenterRow(companyId, `PC-${Date.now()}`);
      await createPositionWithCenters(companyId, backendId, costCenterId, null);
      await createPositionWithCenters(companyId, backendId, null, profitCenterId);

      const change = await orgChanges.create(hrAdminClaims, {
        title: "Archive Backend (Phase 10 impact)",
        effectiveDate: "2026-01-01",
        items: [{ orgUnitId: backendId, action: "archive" }],
      });
      await orgChanges.validate(hrAdminClaims, change.id);
      const summary = await orgChanges.analyzeImpact(hrAdminClaims, change.id);

      expect(summary.affectedReportingRelationshipCount).toBeGreaterThanOrEqual(2);
      expect(summary.affectedFinancialCenterCount).toBeGreaterThanOrEqual(2);
    });

    it("submitForApproval() requires impact analysis first, then routes through the tenant's configured workflow", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Rename Frontend for approval flow",
        effectiveDate: "2020-01-01",
        items: [{ orgUnitId: frontendId, action: "rename", newName: "Client Experience" }],
      });
      await orgChanges.validate(hrAdminClaims, change.id);

      await expect(orgChanges.submitForApproval(hrAdminClaims, change.id)).rejects.toThrow(BadRequestException);

      await orgChanges.analyzeImpact(hrAdminClaims, change.id);
      const submitted = await orgChanges.submitForApproval(hrAdminClaims, change.id);
      expect(submitted.status).toBe("pending_approval");
      expect(submitted.workflowInstanceId).not.toBeNull();
    });

    it("decide('approved') on an already-due change executes immediately and publishes it", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Rename Sales (immediate execution)",
        effectiveDate: "2020-01-01",
        items: [{ orgUnitId: salesId, action: "rename", newName: "Revenue" }],
      });
      await orgChanges.validate(hrAdminClaims, change.id);
      await orgChanges.analyzeImpact(hrAdminClaims, change.id);
      const submitted = await orgChanges.submitForApproval(hrAdminClaims, change.id);

      const decided = await orgChanges.decide(hrAdminClaims, submitted.id, { decision: "approved" });
      expect(decided.status).toBe("published");
      expect(decided.publishedAt).not.toBeNull();
      expect(decided.items[0].appliedAt).not.toBeNull();

      const unit = await orgUnits.get(hrAdminClaims, salesId);
      expect(unit.name).toBe("Revenue");
    });

    it("decide('approved') on a change whose effective date is still in the future leaves it approved (not yet executed)", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Future retype",
        effectiveDate: "2099-01-01",
        items: [{ orgUnitId: engineeringId, action: "retype", newUnitType: "business_unit" }],
      });
      await orgChanges.validate(hrAdminClaims, change.id);
      await orgChanges.analyzeImpact(hrAdminClaims, change.id);
      const submitted = await orgChanges.submitForApproval(hrAdminClaims, change.id);

      const decided = await orgChanges.decide(hrAdminClaims, submitted.id, { decision: "approved" });
      expect(decided.status).toBe("approved");
      expect(decided.items[0].appliedAt).toBeNull();

      await expect(orgChanges.execute(hrAdminClaims, change.id)).rejects.toThrow(BadRequestException);
    });

    it("executeDueChanges() sweeps up an approved-but-not-yet-executed change once its effective date has passed", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Sweep-executed retype",
        effectiveDate: "2020-06-01",
        items: [{ orgUnitId: backendId, action: "retype", newUnitType: "function" }],
      });
      await orgChanges.validate(hrAdminClaims, change.id);
      await orgChanges.analyzeImpact(hrAdminClaims, change.id);
      const submitted = await orgChanges.submitForApproval(hrAdminClaims, change.id);

      // Approve via a role-based approver other than the submitter would
      // need a second HR Admin in a real tenant; this fixture's template
      // routes to the `hr_admin` role generally, so the same HR Admin
      // claims may decide it — mirrors how single-admin tenants actually
      // configure a role-based (not specific_user) approval step.
      const instance = await workflow.getInstance(hrAdminClaims, submitted.workflowInstanceId as string);
      await workflow.decide(hrAdminClaims, instance.steps[0].id, { decision: "approved" });
      await db.withClaims(hrAdminClaims, (client) =>
        client.query("UPDATE org_changes SET status = 'approved', updated_at = now() WHERE id = $1", [change.id])
      );

      const executedCount = await orgChanges.executeDueChanges();
      expect(executedCount).toBeGreaterThanOrEqual(1);

      const reloaded = await orgChanges.get(hrAdminClaims, change.id);
      expect(reloaded.status).toBe("published");
    });

    it("decide('rejected') leaves the change rejected and never touches org_units", async () => {
      const change = await orgChanges.create(hrAdminClaims, {
        title: "Rejected rename",
        effectiveDate: "2026-01-01",
        items: [{ orgUnitId: engineeringId, action: "rename", newName: "Should Not Apply" }],
      });
      await orgChanges.validate(hrAdminClaims, change.id);
      await orgChanges.analyzeImpact(hrAdminClaims, change.id);
      const submitted = await orgChanges.submitForApproval(hrAdminClaims, change.id);

      const decided = await orgChanges.decide(hrAdminClaims, submitted.id, { decision: "rejected", comment: "Not now" });
      expect(decided.status).toBe("rejected");

      const unit = await orgUnits.get(hrAdminClaims, engineeringId);
      expect(unit.name).not.toBe("Should Not Apply");
    });

    it("a line_manager can view reorganization changes but not manage them", async () => {
      const list = await orgChanges.list(managerClaims);
      expect(Array.isArray(list)).toBe(true);
      await expect(orgChanges.validate(managerClaims, list[0].id)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("tenant isolation", () => {
    it("a change created in one company is invisible to another company's claims", async () => {
      const companyAId = await createFixtureCompany("Reorg Tenant A");
      const companyBId = await createFixtureCompany("Reorg Tenant B");
      const stamp = Date.now();
      const userAId = await createUser(`reorg-tenant-a-${stamp}@example.com`);
      const userBId = await createUser(`reorg-tenant-b-${stamp}@example.com`);
      await assignRole(userAId, companyAId, "hr_admin");
      await assignRole(userBId, companyBId, "hr_admin");
      const claimsA: RequestClaims = { is_platform_admin: false, company_id: companyAId, sub: userAId };
      const claimsB: RequestClaims = { is_platform_admin: false, company_id: companyBId, sub: userBId };

      const unit = await orgUnits.create(claimsA, { name: "Isolated Unit", unitType: "department" });
      const change = await orgChanges.create(claimsA, {
        title: "Tenant A only",
        effectiveDate: "2026-01-01",
        items: [{ orgUnitId: unit.id, action: "archive" }],
      });

      await expect(orgChanges.get(claimsB, change.id)).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * Organization Management, Phase 7 (Unified Integration & Synchronization
   * Requirements, Section 14). Confirms `org.reorganization.published` — the
   * new event name that section's own catalog asks for — really enqueues
   * end to end alongside the pre-existing `org_change.published` (kept,
   * not renamed, so no existing subscriber breaks), with the new event's
   * payload carrying the change's own real `effectiveDate` (not "today" —
   * see `execute()`'s own comment on why this event is built by hand
   * rather than through `publishChanged()`/`buildOrgEventPayload()`'s
   * generic default). `orgChanges` above (this file's shared instance) is
   * built WITHOUT a WebhookDispatchService — proving the optional-
   * dependency design doesn't secretly break anything for it — so this
   * uses its own instance instead.
   */
  describe("webhook events (Organization Management Phase 7)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let engineeringId: string;
    let orgChangesWithWebhooks: OrgChangesService;
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "reorg-webhook-spec" };

    beforeAll(async () => {
      companyId = await createFixtureCompany("Reorg Webhook Co");
      const hrAdminUserId = await createUser(`reorg-webhook-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(hrAdminUserId, companyId, "rbac_demo_full_access");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      engineeringId = (await orgUnits.create(hrAdminClaims, { name: "Engineering", unitType: "division" })).id;

      const hrAdminRoleId = await db.withClaims(platformClaims, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", ["hr_admin"]);
        return role.rows[0].id as string;
      });

      await workflow.createTemplate(hrAdminClaims, {
        key: "org_reorganization",
        name: "Reorganization Approval",
        objectKey: "org_reorganization",
        steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: hrAdminRoleId }] }],
      });

      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "reorg-trigger-secret" },
      });

      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      orgChangesWithWebhooks = new OrgChangesService(
        db,
        rbac,
        entitlements,
        audit,
        new EffectiveDatingEngine(),
        workflow,
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

    it("enqueues both org_change.published and org.reorganization.published on publish", async () => {
      const change = await orgChangesWithWebhooks.create(hrAdminClaims, {
        title: "Rename Engineering (webhook test)",
        effectiveDate: "2020-01-01",
        items: [{ orgUnitId: engineeringId, action: "rename", newName: "Platform Engineering" }],
      });
      await orgChangesWithWebhooks.validate(hrAdminClaims, change.id);
      await orgChangesWithWebhooks.analyzeImpact(hrAdminClaims, change.id);
      const submitted = await orgChangesWithWebhooks.submitForApproval(hrAdminClaims, change.id);
      const decided = await orgChangesWithWebhooks.decide(hrAdminClaims, submitted.id, { decision: "approved" });
      expect(decided.status).toBe("published");

      const legacyEvent = await latestEventFor("org_change.published");
      expect(legacyEvent).toBeDefined();
      expect(legacyEvent.payload.orgChangeId).toBe(change.id);

      const newEvent = await latestEventFor("org.reorganization.published");
      expect(newEvent).toBeDefined();
      expect(newEvent.payload.eventVersion).toBe(1);
      expect(newEvent.payload.changeType).toBe("published");
      expect(newEvent.payload.tenantId).toBe(companyId);
      expect(newEvent.payload.entityId).toBe(change.id);
      expect(newEvent.payload.effectiveDate).toBe("2020-01-01");
      expect(newEvent.payload.reorganization.id).toBe(change.id);
    });
  });
});
