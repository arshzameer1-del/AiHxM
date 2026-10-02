import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ConfigurationRuleMappingService } from "./configuration-rule-mapping.service";
import { HrBusinessPolicyService } from "./hr-business-policy.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "configuration-rule-mapping-spec-fixtures" };

/**
 * The consolidated Configuration Hierarchy & Resolution / Mapping Engine
 * ("then 2" Phases 4+5, 2026-10-02, gap-table items #11+#12) — real
 * Postgres, no mocks, same discipline as `hr-business-policy.service.spec.ts`.
 * Covers: CRUD + the RBAC gate on `configuration_rule_mappings`,
 * `resolveOverride()`'s own most-specific-wins resolution (employee >
 * location > org_unit, with org_unit ancestor-walking up to the root),
 * and `HrBusinessPolicyService.resolveEffectivePolicy()` as the real
 * consumer layering an override on top of a plain company-wide default.
 */
describe("ConfigurationRuleMappingService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let mappings: ConfigurationRuleMappingService;
  let policies: HrBusinessPolicyService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let noPermissionClaims: RequestClaims;

  // department (leaf) -> division -> businessUnit (root)
  let businessUnitId: string;
  let divisionId: string;
  let departmentId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    mappings = new ConfigurationRuleMappingService(db, rbac, entitlements, audit);
    policies = new HrBusinessPolicyService(db, rbac, entitlements, audit, mappings);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Config Mapping Co ${stamp}`,
        `config-mapping-co-${stamp}`,
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
        `config-mapping-admin-${stamp}@example.com`,
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
        `config-mapping-outsider-${stamp}@example.com`,
      ]);
      return result.rows[0].id as string;
    });
    noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    await db.withClaims(hrAdminClaims, async (client) => {
      const bu = await client.query(
        "INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'business_unit', 'Operations') RETURNING id",
        [companyId]
      );
      businessUnitId = bu.rows[0].id;
      const div = await client.query(
        "INSERT INTO org_units (company_id, parent_id, unit_type, name) VALUES ($1, $2, 'division', 'Field Services') RETURNING id",
        [companyId, businessUnitId]
      );
      divisionId = div.rows[0].id;
      const dept = await client.query(
        "INSERT INTO org_units (company_id, parent_id, unit_type, name) VALUES ($1, $2, 'department', 'Dispatch') RETURNING id",
        [companyId, divisionId]
      );
      departmentId = dept.rows[0].id;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates an org_unit-scoped override and lists it", async () => {
    const created = await mappings.create(hrAdminClaims, {
      configDomain: "hr_business_policy",
      configKey: "probation",
      scopeType: "org_unit",
      scopeValue: divisionId,
      ruleValue: { durationDays: 60 },
    });
    expect(created.scopeType).toBe("org_unit");
    expect(created.ruleValue).toEqual({ durationDays: 60 });
    expect(created.isActive).toBe(true);

    const list = await mappings.list(hrAdminClaims, "hr_business_policy", "probation");
    expect(list.map((m) => m.id)).toContain(created.id);
  });

  it("rejects an unknown scope type", async () => {
    await expect(
      mappings.create(hrAdminClaims, {
        configDomain: "hr_business_policy",
        configKey: "probation",
        scopeType: "position" as never,
        scopeValue: "x",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an org_unit scopeValue that doesn't exist for this company", async () => {
    await expect(
      mappings.create(hrAdminClaims, {
        configDomain: "hr_business_policy",
        configKey: "probation",
        scopeType: "org_unit",
        scopeValue: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a duplicate (configDomain, configKey, scopeType, scopeValue) combination", async () => {
    await expect(
      mappings.create(hrAdminClaims, {
        configDomain: "hr_business_policy",
        configKey: "probation",
        scopeType: "org_unit",
        scopeValue: divisionId,
        ruleValue: { durationDays: 999 },
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("updates an override's ruleValue and can deactivate it", async () => {
    const list = await mappings.list(hrAdminClaims, "hr_business_policy", "probation");
    const divisionOverride = list.find((m) => m.scopeValue === divisionId)!;

    const updated = await mappings.update(hrAdminClaims, divisionOverride.id, { ruleValue: { durationDays: 45 } });
    expect(updated.ruleValue).toEqual({ durationDays: 45 });

    const deactivated = await mappings.update(hrAdminClaims, divisionOverride.id, { isActive: false });
    expect(deactivated.isActive).toBe(false);

    const activeOnly = await mappings.list(hrAdminClaims, "hr_business_policy", "probation");
    expect(activeOnly.find((m) => m.id === divisionOverride.id)).toBeUndefined();

    // Restore for the resolution tests below.
    await mappings.update(hrAdminClaims, divisionOverride.id, { isActive: true });
  });

  it("resolveOverride finds an exact org_unit match directly, with no ancestor walk needed", async () => {
    const result = await db.withClaims(hrAdminClaims, (client) =>
      mappings.resolveOverride(client, companyId, "hr_business_policy", "probation", { orgUnitId: divisionId })
    );
    expect(result).toEqual({ scopeType: "org_unit", scopeValue: divisionId, ruleValue: { durationDays: 45 } });
  });

  it("resolveOverride walks org_unit ancestry up from a leaf department to find the division's override", async () => {
    const result = await db.withClaims(hrAdminClaims, (client) =>
      mappings.resolveOverride(client, companyId, "hr_business_policy", "probation", { orgUnitId: departmentId })
    );
    expect(result).toEqual({ scopeType: "org_unit", scopeValue: divisionId, ruleValue: { durationDays: 45 } });
  });

  it("resolveOverride returns null when no ancestor has a matching override", async () => {
    const result = await db.withClaims(hrAdminClaims, (client) =>
      mappings.resolveOverride(client, companyId, "hr_business_policy", "rehire", { orgUnitId: departmentId })
    );
    expect(result).toBeNull();
  });

  it("resolveOverride prefers employee over location over org_unit when more than one matches", async () => {
    await mappings.create(hrAdminClaims, {
      configDomain: "hr_business_policy",
      configKey: "rehire",
      scopeType: "location",
      scopeValue: "karachi-hq",
      ruleValue: { cooldownDays: 30 },
    });
    await mappings.create(hrAdminClaims, {
      configDomain: "hr_business_policy",
      configKey: "rehire",
      scopeType: "employee",
      scopeValue: "emp-123",
      ruleValue: { cooldownDays: 0 },
    });

    const employeeWins = await db.withClaims(hrAdminClaims, (client) =>
      mappings.resolveOverride(client, companyId, "hr_business_policy", "rehire", {
        employeeId: "emp-123",
        locationId: "karachi-hq",
        orgUnitId: departmentId,
      })
    );
    expect(employeeWins).toEqual({ scopeType: "employee", scopeValue: "emp-123", ruleValue: { cooldownDays: 0 } });

    const locationWins = await db.withClaims(hrAdminClaims, (client) =>
      mappings.resolveOverride(client, companyId, "hr_business_policy", "rehire", {
        employeeId: "someone-else",
        locationId: "karachi-hq",
        orgUnitId: departmentId,
      })
    );
    expect(locationWins).toEqual({ scopeType: "location", scopeValue: "karachi-hq", ruleValue: { cooldownDays: 30 } });
  });

  it("HrBusinessPolicyService.resolveEffectivePolicy merges an org_unit override over the plain company-wide default", async () => {
    // The seeded probation default for this company is {durationDays: 90, maxExtensions: 1, extensionDays: 30}.
    const atDivision = await db.withClaims(hrAdminClaims, (client) =>
      policies.resolveEffectivePolicy(client, companyId, "probation", { orgUnitId: divisionId })
    );
    expect(atDivision).toEqual({ durationDays: 45, maxExtensions: 1, extensionDays: 30 });

    // Outside any org_unit/location/employee context, falls back to the plain default untouched.
    const noContext = await db.withClaims(hrAdminClaims, (client) => policies.resolveEffectivePolicy(client, companyId, "probation"));
    expect(noContext).toEqual({ durationDays: 90, maxExtensions: 1, extensionDays: 30 });
  });

  it("mustExist throws NotFoundException for an unknown id", async () => {
    await expect(mappings.update(hrAdminClaims, "00000000-0000-0000-0000-000000000000", { isActive: false })).rejects.toThrow(
      NotFoundException
    );
  });

  it("denies a login without configuration_rule_mapping permissions", async () => {
    await expect(mappings.list(noPermissionClaims, "hr_business_policy", "probation")).rejects.toThrow(ForbiddenException);
    await expect(
      mappings.create(noPermissionClaims, {
        configDomain: "hr_business_policy",
        configKey: "probation",
        scopeType: "org_unit",
        scopeValue: divisionId,
      })
    ).rejects.toThrow(ForbiddenException);
  });
});
