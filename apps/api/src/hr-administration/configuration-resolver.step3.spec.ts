import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ConfigurationRuleMappingService } from "./configuration-rule-mapping.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "resolver-step3-fixtures" };

/** Gap Register CFG-04 / CFG-05 -- typed scopes, resolution order, windows, provenance. */
describe("ConfigurationRuleMappingService -- resolver (CFG-04, CFG-05)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: ConfigurationRuleMappingService;
  let companyId: string;
  let otherCompanyId: string;
  let hr: RequestClaims;
  let parentUnit: string;
  let childUnit: string;
  let jobId: string;
  let positionId: string;
  let groupId: string;
  let employeeId: string;
  let locationId: string;
  const DOMAIN = "hr_business_policy";

  async function mkCompany(prefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE, async (c) => {
      const id = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`${prefix} ${stamp}`, `${prefix.toLowerCase()}-${stamp}`])).rows[0].id as string;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [id]);
      return id;
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    svc = new ConfigurationRuleMappingService(db, rbac, new EntitlementsService(db), new AuditService());
    companyId = await mkCompany("Resolver");
    otherCompanyId = await mkCompany("ResolverOther");
    await db.withClaims(FIXTURE, async (c) => {
      const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`res-hr-${Date.now()}@example.com`])).rows[0].id;
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key='hr_admin'))", [u, companyId]);
      hr = { sub: u, company_id: companyId, is_platform_admin: false } as RequestClaims;
      parentUnit = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'division','Parent') RETURNING id", [companyId])).rows[0].id;
      childUnit = (await c.query("INSERT INTO org_units (company_id, unit_type, name, parent_id) VALUES ($1,'department','Child',$2) RETURNING id", [companyId, parentUnit])).rows[0].id;
      jobId = (await c.query("INSERT INTO jobs (company_id, title) VALUES ($1,'J') RETURNING id", [companyId])).rows[0].id;
      positionId = (await c.query("INSERT INTO positions (company_id, org_unit_id, position_title, job_id) VALUES ($1,$2,'P',$3) RETURNING id", [companyId, childUnit, jobId])).rows[0].id;
      locationId = (await c.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1,'site','HQ') RETURNING id", [companyId])).rows[0].id;
      employeeId = (
        await c.query(
          "INSERT INTO employees (company_id, employee_number, first_name, last_name, org_unit_id, position_id, location_id) VALUES ($1,'RES-1','R','E',$2,$3,$4) RETURNING id",
          [companyId, childUnit, positionId, locationId]
        )
      ).rows[0].id;
      groupId = (await c.query("INSERT INTO employee_groups (company_id, name) VALUES ($1,'Res group') RETURNING id", [companyId])).rows[0].id;
      await c.query("INSERT INTO employee_group_memberships (company_id, group_id, employee_id, effective_from) VALUES ($1,$2,$3,'2020-01-01')", [companyId, groupId, employeeId]);
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  const resolve = (key: string, extra: Record<string, unknown> = {}, base: Record<string, unknown> = {}) =>
    db.withClaims(hr, (c) => svc.resolveWithProvenance(c, companyId, DOMAIN, key, { employeeId, ...extra }, base));

  it("derives position, job, org unit and group memberships from the employee, and orders layers most-specific first", async () => {
    const key = "order";
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "tenant", scopeValue: companyId, ruleValue: { v: "tenant" } });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "org_unit", scopeValue: parentUnit, ruleValue: { v: "parent-unit" } });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "org_unit", scopeValue: childUnit, ruleValue: { v: "own-unit" } });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "location", scopeValue: locationId, ruleValue: { v: "location" } });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "employee_group", scopeValue: groupId, ruleValue: { v: "group" } });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "job", scopeValue: jobId, ruleValue: { v: "job" } });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "position", scopeValue: positionId, ruleValue: { v: "position" } });
    const emp = await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "employee", scopeValue: employeeId, ruleValue: { v: "employee" } });

    const r = await resolve(key, {}, { v: "default", other: 1 });
    expect(r.chain.map((c) => c.layer)).toEqual(["employee", "position", "job", "employee_group", "location", "org_unit", "org_unit", "tenant", "default"]);
    expect(r.chain.filter((c) => c.layer === "org_unit").map((c) => c.ruleValue.v)).toEqual(["own-unit", "parent-unit"]); // nearest ancestor first
    expect(r.winner?.ruleValue.v).toBe("employee");
    expect(r.chain[0].shadowed).toBe(false);
    expect(r.chain.slice(1).every((c) => c.shadowed)).toBe(true);
    expect(r.value).toEqual({ v: "employee", other: 1 }); // base value kept for keys the winner doesn't set

    // retire the employee override: position wins next
    await svc.update(hr, emp.id, { isActive: false });
    expect((await resolve(key)).winner?.ruleValue.v).toBe("position");
  });

  it("returns only the default layer when nothing matches", async () => {
    const r = await resolve("nothing-here", {}, { d: 1 });
    expect(r.winner).toBeNull();
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0].layer).toBe("default");
    expect(r.chain[0].shadowed).toBe(false);
    expect(r.value).toEqual({ d: 1 });
  });

  it("among overrides of the same specificity the lower priority number wins", async () => {
    const key = "prio";
    const g2 = await db.withClaims(FIXTURE, async (c) => (await c.query("INSERT INTO employee_groups (company_id, name) VALUES ($1,'Res group 2') RETURNING id", [companyId])).rows[0].id as string);
    await db.withClaims(FIXTURE, (c) => c.query("INSERT INTO employee_group_memberships (company_id, group_id, employee_id, effective_from) VALUES ($1,$2,$3,'2020-01-01')", [companyId, g2, employeeId]));
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "employee_group", scopeValue: groupId, ruleValue: { v: "g1" }, priority: 50 });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "employee_group", scopeValue: g2, ruleValue: { v: "g2" }, priority: 10 });
    expect((await resolve(key)).winner?.ruleValue.v).toBe("g2");
  });

  it("honours effective windows: not yet started and already ended overrides are ignored; asOf selects the past", async () => {
    const key = "window";
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "tenant", scopeValue: companyId, ruleValue: { v: "old" }, effectiveFrom: "2020-01-01", effectiveTo: "2020-12-31" });
    await svc.create(hr, { configDomain: DOMAIN, configKey: key, scopeType: "employee", scopeValue: employeeId, ruleValue: { v: "future" }, effectiveFrom: "2999-01-01" });
    expect((await resolve(key)).winner).toBeNull();
    expect((await resolve(key, { asOf: "2020-06-01" })).winner?.ruleValue.v).toBe("old");
    expect((await resolve(key, { asOf: "2999-06-01" })).winner?.ruleValue.v).toBe("future");
    await expect(resolve(key, { asOf: "June 1" })).rejects.toThrow(BadRequestException);
  });

  it("resolveOverride keeps its old contract (single winner or null)", async () => {
    const o = await db.withClaims(hr, (c) => svc.resolveOverride(c, companyId, DOMAIN, "order", { employeeId }));
    expect(o).toMatchObject({ scopeType: "position", ruleValue: { v: "position" } });
    expect(await db.withClaims(hr, (c) => svc.resolveOverride(c, companyId, DOMAIN, "absent", { employeeId }))).toBeNull();
  });

  it("scope values are verified per type, and tenant scope must be your own company", async () => {
    await expect(svc.create(hr, { configDomain: DOMAIN, configKey: "v", scopeType: "position", scopeValue: "not-a-uuid" })).rejects.toThrow(BadRequestException);
    const foreignGroup = await db.withClaims(FIXTURE, async (c) => (await c.query("INSERT INTO employee_groups (company_id, name) VALUES ($1,'foreign') RETURNING id", [otherCompanyId])).rows[0].id as string);
    await expect(svc.create(hr, { configDomain: DOMAIN, configKey: "v", scopeType: "employee_group", scopeValue: foreignGroup })).rejects.toThrow(BadRequestException);
    await expect(svc.create(hr, { configDomain: DOMAIN, configKey: "v", scopeType: "tenant", scopeValue: otherCompanyId })).rejects.toThrow(BadRequestException);
    await expect(svc.create(hr, { configDomain: DOMAIN, configKey: "v", scopeType: "tenant", scopeValue: companyId, effectiveFrom: "2030-01-01", effectiveTo: "2029-01-01" })).rejects.toThrow(BadRequestException);
  });

  it("stores typed scope_id, defaults priority to 100 (never NULL) and keeps status in step with is_active", async () => {
    const m = await svc.create(hr, { configDomain: DOMAIN, configKey: "typed", scopeType: "job", scopeValue: jobId, ruleValue: {}, fieldKey: "durationDays", objectType: "probation", changeReason: "test" });
    expect(m.scopeId).toBe(jobId);
    expect(m.priority).toBe(100);
    expect(m.status).toBe("active");
    expect(m.fieldKey).toBe("durationDays");
    expect(m.changeReason).toBe("test");
    const off = await svc.update(hr, m.id, { isActive: false });
    expect(off.status).toBe("retired");
    await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE configuration_rule_mappings SET priority = NULL WHERE id = $1", [m.id]))).rejects.toThrow(/null value/);
  });
});
