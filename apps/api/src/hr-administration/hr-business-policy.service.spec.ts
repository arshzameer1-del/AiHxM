import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { HrBusinessPolicyService } from "./hr-business-policy.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "hr-business-policy-spec-fixtures" };

/**
 * HR Administration business-policy engine ("then 2" Phase 2, 2026-10-02,
 * gap-table item #8) — real Postgres, no mocks, same discipline as
 * `hr-reference-catalog.service.spec.ts`. Covers: the registry-driven
 * type summary (including the migration's own seeded default per type),
 * CRUD + reorder + default-switching for one company's policies, the
 * RBAC gate (`hr_business_policy.manage.all`/`.view.all`, granted to
 * hr_admin by the same migration), and `resolveDefaultPolicy()` — the
 * enforcement half `EmployeesService` calls into for the Probation and
 * Rehire policies.
 */
describe("HrBusinessPolicyService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let policies: HrBusinessPolicyService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    policies = new HrBusinessPolicyService(db, new RbacService(db), new EntitlementsService(db), new AuditService());

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `HR Policy Co ${stamp}`,
        `hr-policy-co-${stamp}`,
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

    const hrAdminUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `hr-policy-admin-${stamp}@example.com`,
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
        `hr-policy-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };
  });

  afterAll(async () => {
    await pool.end();
  });

  it("lists every registered policy type with this company's policy count and default flag", async () => {
    const types = await policies.listPolicyTypes(hrAdminClaims);
    const probation = types.find((t) => t.policyType === "probation");
    expect(probation?.policyCount).toBe(1);
    expect(probation?.hasDefault).toBe(true);
    expect(probation?.label).toBe("Probation Policy");
    const rehire = types.find((t) => t.policyType === "rehire");
    expect(rehire?.hasDefault).toBe(true);
  });

  it("rejects a request for a policy type that isn't registered", async () => {
    await expect(policies.listPolicies(hrAdminClaims, "not_a_real_policy_type")).rejects.toThrow(BadRequestException);
  });

  it("lists the seeded default probation policy with its rules", async () => {
    const list = await policies.listPolicies(hrAdminClaims, "probation");
    expect(list).toHaveLength(1);
    expect(list[0].code).toBe("default");
    expect(list[0].isDefault).toBe(true);
    expect(list[0].rules).toEqual({ durationDays: 90, maxExtensions: 1, extensionDays: 30 });
  });

  it("resolveDefaultPolicy returns the default policy's rules for a known type and null for one with no default", async () => {
    const rules = await db.withClaims(hrAdminClaims, (client) => policies.resolveDefaultPolicy(client, companyId, "probation"));
    expect(rules).toEqual({ durationDays: 90, maxExtensions: 1, extensionDays: 30 });
  });

  it("creates a second named policy of an existing type without disturbing the existing default", async () => {
    const created = await policies.create(hrAdminClaims, {
      policyType: "probation",
      code: "senior_hire",
      name: "Senior Hire Probation",
      rules: { durationDays: 180 },
    });
    expect(created.isDefault).toBe(false);
    expect(created.sortOrder).toBe(1);

    const list = await policies.listPolicies(hrAdminClaims, "probation");
    expect(list.map((p) => p.code).sort()).toEqual(["default", "senior_hire"]);
    const stillDefault = list.find((p) => p.code === "default");
    expect(stillDefault?.isDefault).toBe(true);

    // resolveDefaultPolicy still returns the ORIGINAL default's rules —
    // creating a second, non-default policy must not change what a
    // consuming service actually applies.
    const rules = await db.withClaims(hrAdminClaims, (client) => policies.resolveDefaultPolicy(client, companyId, "probation"));
    expect(rules).toEqual({ durationDays: 90, maxExtensions: 1, extensionDays: 30 });
  });

  it("rejects creating a duplicate code within the same policy type for this company", async () => {
    await expect(
      policies.create(hrAdminClaims, { policyType: "probation", code: "senior_hire", name: "Duplicate" })
    ).rejects.toThrow(BadRequestException);
  });

  it("switching a policy to default unsets the previous default for that type/company, and resolveDefaultPolicy picks it up", async () => {
    const list = await policies.listPolicies(hrAdminClaims, "probation");
    const seniorHire = list.find((p) => p.code === "senior_hire")!;

    const updated = await policies.update(hrAdminClaims, seniorHire.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);

    const after = await policies.listPolicies(hrAdminClaims, "probation");
    const originalDefault = after.find((p) => p.code === "default")!;
    expect(originalDefault.isDefault).toBe(false);

    const rules = await db.withClaims(hrAdminClaims, (client) => policies.resolveDefaultPolicy(client, companyId, "probation"));
    expect(rules).toEqual({ durationDays: 180 });

    // Restore the original default so later tests/assertions in this
    // file keep seeing the seeded starting state.
    await policies.update(hrAdminClaims, originalDefault.id, { isDefault: true });
  });

  it("updates a policy's name/description/rules and can deactivate it", async () => {
    const created = await policies.create(hrAdminClaims, {
      policyType: "document",
      code: "contractor",
      name: "Contractor Documents",
      rules: { requiredDocumentTypes: ["cnic"] },
    });
    const updated = await policies.update(hrAdminClaims, created.id, {
      name: "Contractor Document Set",
      rules: { requiredDocumentTypes: ["cnic", "passport"] },
      isActive: false,
    });
    expect(updated.name).toBe("Contractor Document Set");
    expect(updated.rules).toEqual({ requiredDocumentTypes: ["cnic", "passport"] });
    expect(updated.isActive).toBe(false);

    const active = await policies.listPolicies(hrAdminClaims, "document");
    expect(active.find((p) => p.id === created.id)).toBeUndefined();

    const all = await policies.listPolicies(hrAdminClaims, "document", true);
    expect(all.find((p) => p.id === created.id)?.isActive).toBe(false);
  });

  it("reorders policies within a policy type", async () => {
    const items = await policies.listPolicies(hrAdminClaims, "probation");
    const reversed = [...items].reverse().map((i) => i.id);
    const reordered = await policies.reorder(hrAdminClaims, "probation", reversed);
    expect(reordered.map((i) => i.id)).toEqual(reversed);
  });

  it("resolveDefaultPolicy returns null for a company with a default that was deactivated, rather than throwing", async () => {
    const standaloneCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `HR Policy No-Default Co ${Date.now()}`,
        `hr-policy-no-default-${Date.now()}`,
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
    const standaloneUserId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `hr-policy-no-default-admin-${Date.now()}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        standaloneUserId,
        standaloneCompanyId,
        role.rows[0].id,
      ]);
    });
    const standaloneClaims: RequestClaims = { is_platform_admin: false, company_id: standaloneCompanyId, sub: standaloneUserId };
    const list = await policies.listPolicies(standaloneClaims, "rehire");
    await policies.update(standaloneClaims, list[0].id, { isActive: false });
    const rules = await db.withClaims(standaloneClaims, (client) => policies.resolveDefaultPolicy(client, standaloneCompanyId, "rehire"));
    expect(rules).toBeNull();
  });

  it("denies a login without hr_business_policy permissions", async () => {
    await expect(policies.listPolicyTypes(noPermissionClaims)).rejects.toThrow(ForbiddenException);
    await expect(
      policies.create(noPermissionClaims, { policyType: "probation", code: "x", name: "X" })
    ).rejects.toThrow(ForbiddenException);
  });
});
