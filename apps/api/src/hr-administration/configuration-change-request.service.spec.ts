import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ConfigurationChangeRequestService } from "./configuration-change-request.service";
import { HrBusinessPolicyService } from "./hr-business-policy.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "configuration-change-request-spec-fixtures" };

/**
 * The Configuration Publish Lifecycle ("then 2" Phase 6, 2026-10-02,
 * gap-table item #13) — real Postgres, no mocks, same discipline as
 * every other HR Administration spec file. Covers: the full
 * draft -> validate -> submit -> approve -> publish -> retire happy
 * path for a `hr_reference_catalog_item` create; the maker-checker rule
 * (an approver can't be the submitter); the blocking dependency check
 * (deactivating a policy type's only active default); and rollback
 * (restoring an update's `before_snapshot`).
 */
describe("ConfigurationChangeRequestService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let changes: ConfigurationChangeRequestService;
  let policies: HrBusinessPolicyService;
  let companyId: string;
  let adminAClaims: RequestClaims;
  let adminBClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    changes = new ConfigurationChangeRequestService(db, rbac, entitlements, audit);
    policies = new HrBusinessPolicyService(db, rbac, entitlements, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Config Change Co ${stamp}`,
        `config-change-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });

    async function makeHrAdmin(label: string): Promise<RequestClaims> {
      const userId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
          `config-change-${label}-${stamp}@example.com`,
        ]);
        return result.rows[0].id as string;
      });
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
          userId,
          companyId,
          role.rows[0].id,
        ]);
      });
      return { is_platform_admin: false, company_id: companyId, sub: userId };
    }

    adminAClaims = await makeHrAdmin("admin-a");
    adminBClaims = await makeHrAdmin("admin-b");

    const outsiderUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `config-change-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };
  });

  afterAll(async () => {
    await pool.end();
  });

  it("walks a hr_reference_catalog_item create through the full draft -> publish pipeline", async () => {
    const created = await changes.create(adminAClaims, {
      configDomain: "hr_reference_catalog_item",
      operation: "create",
      payload: { catalogType: "employment_type", code: "apprentice", label: "Apprentice" },
    });
    expect(created.status).toBe("draft");

    const validated = await changes.validate(adminAClaims, created.id);
    expect(validated.status).toBe("validated");
    expect(validated.validationResult?.hasBlockingIssues).toBe(false);
    expect(validated.validationResult?.impactPreview).toContain("Creates a new");

    const submitted = await changes.submitForApproval(adminAClaims, created.id);
    expect(submitted.status).toBe("pending_approval");

    // The submitter can't approve their own change.
    await expect(changes.approve(adminAClaims, created.id)).rejects.toThrow(ForbiddenException);

    const approved = await changes.approve(adminBClaims, created.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(adminBClaims.sub);

    const published = await changes.publish(adminAClaims, created.id);
    expect(published.status).toBe("published");
    expect(published.targetId).toBeTruthy();

    // The underlying hr_reference_catalog_items row really exists now.
    const row = await db.withClaims(adminAClaims, (client) =>
      client.query("SELECT code, label, is_active FROM hr_reference_catalog_items WHERE id = $1", [published.targetId])
    );
    expect(row.rows[0]).toEqual({ code: "apprentice", label: "Apprentice", is_active: true });

    const retired = await changes.retire(adminAClaims, created.id);
    expect(retired.status).toBe("retired");
    const afterRetire = await db.withClaims(adminAClaims, (client) =>
      client.query("SELECT is_active FROM hr_reference_catalog_items WHERE id = $1", [published.targetId])
    );
    expect(afterRetire.rows[0].is_active).toBe(false);
  });

  it("rejects submitting a change that hasn't been validated yet", async () => {
    const created = await changes.create(adminAClaims, {
      configDomain: "hr_reference_catalog_item",
      operation: "create",
      payload: { catalogType: "employment_type", code: "temp_worker", label: "Temp Worker" },
    });
    await expect(changes.submitForApproval(adminAClaims, created.id)).rejects.toThrow(BadRequestException);
  });

  it("blocks validation of deactivating a policy type's only active default, and keeps it in draft", async () => {
    const list = await policies.listPolicies(adminAClaims, "probation");
    const defaultPolicy = list.find((p) => p.isDefault)!;

    const created = await changes.create(adminAClaims, {
      configDomain: "hr_business_policy",
      operation: "deactivate",
      targetId: defaultPolicy.id,
    });
    const validated = await changes.validate(adminAClaims, created.id);
    expect(validated.status).toBe("draft");
    expect(validated.validationResult?.hasBlockingIssues).toBe(true);
    expect(validated.validationResult?.warnings.some((w) => w.includes("ACTIVE DEFAULT"))).toBe(true);

    // A blocked change can never be submitted for approval.
    await expect(changes.submitForApproval(adminAClaims, created.id)).rejects.toThrow(BadRequestException);
  });

  it("rolls back a published update by restoring the before_snapshot, through the same full pipeline", async () => {
    const list = await policies.listPolicies(adminAClaims, "document");
    const target = list[0];
    const originalName = target.name;

    const created = await changes.create(adminAClaims, {
      configDomain: "hr_business_policy",
      operation: "update",
      targetId: target.id,
      payload: { name: "Renamed Document Policy" },
    });
    expect(created.beforeSnapshot?.name).toBe(originalName);

    await changes.validate(adminAClaims, created.id);
    await changes.submitForApproval(adminAClaims, created.id);
    await changes.approve(adminBClaims, created.id);
    await changes.publish(adminAClaims, created.id);

    const renamed = await policies.listPolicies(adminAClaims, "document", true);
    expect(renamed.find((p) => p.id === target.id)?.name).toBe("Renamed Document Policy");

    const rollbackDraft = await changes.rollback(adminAClaims, created.id);
    expect(rollbackDraft.status).toBe("draft");
    expect(rollbackDraft.operation).toBe("update");
    expect(rollbackDraft.payload.name).toBe(originalName);
    expect(rollbackDraft.previousChangeId).toBe(created.id);

    // Rollback is never auto-applied — the underlying row is unchanged
    // until this new draft runs through the pipeline itself.
    const stillRenamed = await policies.listPolicies(adminAClaims, "document", true);
    expect(stillRenamed.find((p) => p.id === target.id)?.name).toBe("Renamed Document Policy");

    await changes.validate(adminAClaims, rollbackDraft.id);
    await changes.submitForApproval(adminAClaims, rollbackDraft.id);
    await changes.approve(adminBClaims, rollbackDraft.id);
    await changes.publish(adminAClaims, rollbackDraft.id);

    const restored = await policies.listPolicies(adminAClaims, "document", true);
    expect(restored.find((p) => p.id === target.id)?.name).toBe(originalName);
  });

  it("denies a login without configuration_change permissions", async () => {
    await expect(changes.list(noPermissionClaims)).rejects.toThrow(ForbiddenException);
    await expect(
      changes.create(noPermissionClaims, { configDomain: "hr_reference_catalog_item", operation: "create", payload: {} })
    ).rejects.toThrow(ForbiddenException);
  });
});
