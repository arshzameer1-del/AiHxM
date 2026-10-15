import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ConfigurationVersionService } from "./configuration-version.service";
import { ConfigurationChangeRequestService } from "./configuration-change-request.service";
import { RuleRegistryService } from "./rule-registry.service";
import { riskFor } from "./configuration-impact";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "backbone-step3-fixtures" };

/** Gap Register CFG-02 (versions), CFG-07 (impact), CFG-14 (rule registry). */
describe("Configuration backbone -- versions, impact preview, rule registry", () => {
  let pool: Pool;
  let db: DatabaseService;
  let versions: ConfigurationVersionService;
  let rules: RuleRegistryService;
  let changes: ConfigurationChangeRequestService;
  let companyId: string;
  let otherCompanyId: string;
  let a: RequestClaims;
  let b: RequestClaims;
  let outsider: RequestClaims;
  let other: RequestClaims;

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
  async function mkUser(company: string, role: string | null) {
    return db.withClaims(FIXTURE, async (c) => {
      const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`bb3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`])).rows[0].id;
      if (role) await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u, company, role]);
      return { sub: u, company_id: company, is_platform_admin: false } as RequestClaims;
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    versions = new ConfigurationVersionService(db, rbac, ent, audit);
    rules = new RuleRegistryService(db, rbac, ent, audit);
    changes = new ConfigurationChangeRequestService(db, rbac, ent, audit);
    companyId = await mkCompany("Backbone");
    otherCompanyId = await mkCompany("BackboneOther");
    a = await mkUser(companyId, "hr_admin");
    b = await mkUser(companyId, "hr_admin");
    outsider = await mkUser(companyId, null);
    other = await mkUser(otherCompanyId, "hr_admin");
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  // ------------------------------------------------------------ CFG-02
  describe("configuration versions (CFG-02)", () => {
    it("numbers versions per domain and walks draft -> validated -> published", async () => {
      const d = await versions.createDraft(a, { domain: "hr_business_policy", changeReason: "first" });
      expect(d.versionNo).toBe(1);
      expect(d.status).toBe("draft");
      await expect(versions.publish(a, d.id)).rejects.toThrow(BadRequestException); // not validated yet
      const v = await versions.validate(a, d.id);
      expect(v.status).toBe("validated");
      const p = await versions.publish(a, d.id, "2026-01-01");
      expect(p.status).toBe("published");
      expect(p.effectiveFrom).toBe("2026-01-01");
      expect(p.effectiveTo).toBeNull();
    });

    it("a later publish closes the earlier window the day before; an as-of read picks the right one", async () => {
      const d2 = await versions.createDraft(a, { domain: "hr_business_policy", snapshot: { marker: "v2" } });
      expect(d2.versionNo).toBe(2);
      await versions.validate(a, d2.id);
      await versions.publish(a, d2.id, "2026-06-01");
      const v1 = (await versions.list(a, "hr_business_policy", "published")).find((x) => x.versionNo === 1)!;
      expect(v1.effectiveTo).toBe("2026-05-31");
      expect((await versions.getEffective(a, "hr_business_policy", "2026-03-01"))?.versionNo).toBe(1);
      expect((await versions.getEffective(a, "hr_business_policy", "2026-06-01"))?.versionNo).toBe(2);
      expect(await versions.getEffective(a, "hr_business_policy", "2025-12-31")).toBeNull();
    });

    it("publishing on or before an existing start retires the older version instead of overlapping it", async () => {
      const d3 = await versions.createDraft(a, { domain: "hr_business_policy", snapshot: { marker: "v3" } });
      await versions.validate(a, d3.id);
      await versions.publish(a, d3.id, "2026-06-01");
      const all = await versions.list(a, "hr_business_policy");
      expect(all.find((x) => x.versionNo === 2)?.status).toBe("retired");
      expect((await versions.getEffective(a, "hr_business_policy", "2026-07-01"))?.versionNo).toBe(3);
    });

    it("a published snapshot cannot be edited or deleted, and a retired one cannot be reopened (database guard)", async () => {
      const pub = (await versions.list(a, "hr_business_policy", "published"))[0];
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE configuration_versions SET snapshot = '{}'::jsonb WHERE id = $1", [pub.id]))).rejects.toThrow(/immutable/);
      await expect(db.withClaims(FIXTURE, (c) => c.query("DELETE FROM configuration_versions WHERE id = $1", [pub.id]))).rejects.toThrow();
      const retired = (await versions.list(a, "hr_business_policy", "retired"))[0];
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE configuration_versions SET status = 'published' WHERE id = $1", [retired.id]))).rejects.toThrow();
    });

    it("rejects unknown domains, domains with no capture and no snapshot, and bad dates", async () => {
      await expect(versions.createDraft(a, { domain: "not_a_domain" })).rejects.toThrow(BadRequestException);
      await expect(versions.createDraft(a, { domain: "shift" })).rejects.toThrow(BadRequestException); // no built-in capture
      await expect(versions.getEffective(a, "hr_business_policy", "31-12-2026")).rejects.toThrow(BadRequestException);
    });

    it("is tenant-isolated and permission-gated", async () => {
      await expect(versions.list(outsider)).rejects.toThrow(ForbiddenException);
      await expect(versions.createDraft(outsider, { domain: "hr_business_policy" })).rejects.toThrow(ForbiddenException);
      expect(await versions.list(other, "hr_business_policy")).toHaveLength(0);
      const mine = (await versions.list(a))[0];
      await expect(versions.get(other, mine.id)).rejects.toThrow(NotFoundException);
    });

    it("publishing a change request records an immutable version linked to it", async () => {
      const before = (await versions.list(a, "hr_reference_catalog_item")).length;
      const cr = await changes.create(a, { configDomain: "hr_reference_catalog_item", operation: "create", payload: { catalogType: "employment_type", code: "intern_x", label: "Intern X" } });
      await changes.validate(a, cr.id);
      await changes.submitForApproval(a, cr.id);
      await changes.approve(b, cr.id);
      await changes.publish(a, cr.id);
      const list = await versions.list(a, "hr_reference_catalog_item");
      expect(list.length).toBe(before + 1);
      const latest = list[0];
      expect(latest.status).toBe("published");
      expect(latest.changeRequestId).toBe(cr.id);
      expect(JSON.stringify(latest.snapshot)).toContain("intern_x");
    });
  });

  // ------------------------------------------------------------ CFG-07
  describe("impact preview (CFG-07)", () => {
    it("validate stores summary, counts and risk; approve is refused without them", async () => {
      const cr = await changes.create(a, { configDomain: "hr_business_policy", operation: "create", payload: { policyType: "probation", code: "imp_x", name: "Impact X", isDefault: false } });
      await changes.validate(a, cr.id);
      await changes.submitForApproval(a, cr.id);
      const row = await db.withClaims(FIXTURE, (c) => c.query("SELECT impact_summary, affected_counts, risk_level, impact_computed_at FROM configuration_change_requests WHERE id = $1", [cr.id]));
      expect(row.rows[0].impact_computed_at).not.toBeNull();
      expect(row.rows[0].risk_level).toBe("low");
      expect(Array.isArray(row.rows[0].impact_summary)).toBe(true);
      expect(row.rows[0].affected_counts).toHaveProperty("openHireDrafts");

      // wipe the impact and approval must fail
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE configuration_change_requests SET impact_computed_at = NULL WHERE id = $1", [cr.id]));
      await expect(changes.approve(b, cr.id)).rejects.toThrow(BadRequestException);
    });

    it("riskFor scales with reach and escalates for used items and company-wide changes", () => {
      expect(riskFor(0, {})).toBe("low");
      expect(riskFor(11, {})).toBe("medium");
      expect(riskFor(101, {})).toBe("high");
      expect(riskFor(1, { deactivatesUsedItem: true })).toBe("medium");
      expect(riskFor(50, { companyWide: true })).toBe("high");
    });
  });

  // ------------------------------------------------------------ CFG-14
  describe("rule registry (CFG-14)", () => {
    let defId: string;

    it("creates a definition and rejects duplicates / bad keys / bad types", async () => {
      const d = await rules.createDefinition(a, { ruleKey: "cnic.required", ruleType: "validation", name: "CNIC required", targetObject: "employee", targetField: "cnic" });
      defId = d.id;
      expect(d.isActive).toBe(true);
      await expect(rules.createDefinition(a, { ruleKey: "cnic.required", ruleType: "validation", name: "dup" })).rejects.toThrow();
      await expect(rules.createDefinition(a, { ruleKey: "Bad Key", ruleType: "validation", name: "x" })).rejects.toThrow(BadRequestException);
      await expect(rules.createDefinition(a, { ruleKey: "ok.key", ruleType: "nope" as never, name: "x" })).rejects.toThrow(BadRequestException);
    });

    it("rejects an invalid expression before it is ever stored", async () => {
      await expect(rules.createVersion(a, defId, { expression: { field: "cnic", operator: "bogus", value: 1 } })).rejects.toThrow(BadRequestException);
      await expect(rules.createVersion(a, defId, { expression: { all: [] } })).rejects.toThrow(BadRequestException);
    });

    it("versions are effective-dated: older dates keep resolving to the version then in force", async () => {
      const v1 = await rules.createVersion(a, defId, { expression: { field: "cnic", operator: "isNotEmpty" }, message: "CNIC is required" });
      await rules.publishVersion(a, v1.id, "2026-01-01");
      const v2 = await rules.createVersion(a, defId, { expression: { field: "cnic", operator: "equals", value: "X" }, message: "must be X" });
      expect(v2.versionNo).toBe(2);
      await rules.publishVersion(a, v2.id, "2026-07-01");

      const early = await rules.evaluate(a, "cnic.required", { cnic: "42101-1234567-1" }, "2026-03-01");
      expect(early).toMatchObject({ versionNo: 1, result: true });
      const late = await rules.evaluate(a, "cnic.required", { cnic: "42101-1234567-1" }, "2026-08-01");
      expect(late).toMatchObject({ versionNo: 2, result: false, message: "must be X" });
      await expect(rules.evaluate(a, "cnic.required", {}, "2025-01-01")).rejects.toThrow(NotFoundException);
    });

    it("a published rule version is immutable and not reopenable", async () => {
      const pub = (await rules.listVersions(a, defId)).find((v) => v.status === "published")!;
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE rule_versions SET expression = '{}'::jsonb WHERE id = $1", [pub.id]))).rejects.toThrow(/immutable/);
      await rules.retireVersion(a, pub.id, "superseded by policy");
      await expect(rules.retireVersion(a, pub.id)).rejects.toThrow(BadRequestException);
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE rule_versions SET status = 'published' WHERE id = $1", [pub.id]))).rejects.toThrow();
    });

    it("an inactive rule does not resolve; tenants and permissions are isolated", async () => {
      await rules.setActive(a, defId, false);
      await expect(rules.evaluate(a, "cnic.required", { cnic: "1" })).rejects.toThrow(NotFoundException);
      await rules.setActive(a, defId, true);
      await expect(rules.createDefinition(outsider, { ruleKey: "x.y", ruleType: "default", name: "x" })).rejects.toThrow(ForbiddenException);
      expect(await rules.listDefinitions(other)).toHaveLength(0);
      await expect(rules.listVersions(other, defId)).rejects.toThrow(NotFoundException);
    });
  });
});
