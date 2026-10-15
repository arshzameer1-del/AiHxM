import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService, combineFieldRules } from "./rbac.service";
import { RoleAssignmentsService } from "./role-assignments.service";
import { DataScopeAssignmentsService } from "./data-scope-assignments.service";
import { RolesService } from "./roles.service";
import { FieldPermissionRulesService } from "./field-permission-rules.service";
import { maskValue } from "./field-masking";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "acc-step3-fixtures" };
const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/** Gap Register ACC-01..04 -- field security, tenant roles, temporary grants, data scope. */
describe("Access control backbone (ACC-01..04)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let assignments: RoleAssignmentsService;
  let scopes: DataScopeAssignmentsService;
  let roles: RolesService;
  let fieldRules: FieldPermissionRulesService;
  let companyId: string;
  let otherCompanyId: string;
  let admin: RequestClaims; // system_admin of companyId
  let plain: RequestClaims; // no roles
  let otherAdmin: RequestClaims;
  let userCounter = 0;

  async function mkCompany(prefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE, async (c) =>
      (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`${prefix} ${stamp}`, `${prefix.toLowerCase()}-${stamp}`])).rows[0].id as string
    );
  }
  async function mkUser(company: string, roleKey?: string): Promise<RequestClaims> {
    return db.withClaims(FIXTURE, async (c) => {
      const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`acc3-${Date.now()}-${++userCounter}@example.com`])).rows[0].id;
      if (roleKey) await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u, company, roleKey]);
      return { sub: u, company_id: company, is_platform_admin: false } as RequestClaims;
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    const audit = new AuditService();
    assignments = new RoleAssignmentsService(db, audit);
    scopes = new DataScopeAssignmentsService(db, audit);
    roles = new RolesService(db, rbac, audit);
    fieldRules = new FieldPermissionRulesService(db, rbac, audit);
    companyId = await mkCompany("Acc3");
    otherCompanyId = await mkCompany("Acc3Other");
    admin = await mkUser(companyId, "system_admin");
    plain = await mkUser(companyId);
    otherAdmin = await mkUser(otherCompanyId, "system_admin");
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  // ---------------------------------------------------------------- ACC-02
  describe("tenant roles and the permission matrix (ACC-02)", () => {
    let roleId: string;

    it("derives object, action and scope on every permission key", async () => {
      const perms = await roles.listPermissions(admin);
      const p = perms.find((x) => x.key === "hr_reference_catalog.manage.all")!;
      expect(p).toMatchObject({ objectKey: "hr_reference_catalog", action: "manage", scope: "all" });
      const unparsed = perms.filter((x) => x.objectKey === null);
      expect(unparsed.every((x) => x.key.split(".").length < 3)).toBe(true);
    });

    it("a company creates its own role under a company-scoped key; system roles stay separate", async () => {
      const role = await roles.createCustom(admin, { key: "shift_lead", name: "Shift lead", permissionKeys: ["workflow_template.manage.all"] });
      roleId = role.id;
      expect(role.isSystem).toBe(false);
      expect(role.companyId).toBe(companyId);
      expect(role.key).toMatch(/^c[0-9a-f]{8}_shift_lead$/);
      await expect(roles.createCustom(admin, { key: "shift_lead", name: "dup" })).rejects.toThrow(ConflictException);
      await expect(roles.createCustom(admin, { key: "Bad Key", name: "x" })).rejects.toThrow(BadRequestException);
      // the other company can reuse the same name without collision
      const theirs = await roles.createCustom(otherAdmin, { key: "shift_lead", name: "Theirs" });
      expect(theirs.id).not.toBe(roleId);
    });

    it("roles are invisible across companies", async () => {
      const mine = (await roles.list(admin)).map((r) => r.id);
      expect(mine).toContain(roleId);
      const theirs = (await roles.list(otherAdmin)).map((r) => r.id);
      expect(theirs).not.toContain(roleId);
      await expect(roles.setPermissions(otherAdmin, roleId, [])).rejects.toThrow(); // not visible / not theirs
    });

    it("cannot grant a permission the editor does not hold, or edit system roles", async () => {
      await expect(roles.setPermissions(admin, roleId, ["hr_reference_catalog.manage.all"])).rejects.toThrow(ForbiddenException);
      await expect(roles.setPermissions(admin, roleId, ["no.such.permission"])).rejects.toThrow(BadRequestException);
      const sys = (await roles.list(admin)).find((r) => r.key === "hr_admin")!;
      await expect(roles.setPermissions(admin, sys.id, [])).rejects.toThrow(ForbiddenException);
      await expect(roles.createCustom(plain, { key: "sneaky", name: "x" })).rejects.toThrow(ForbiddenException);
    });

    it("the database protects system roles and role identity", async () => {
      await expect(db.withClaims(admin, (c) => c.query("UPDATE roles SET name = 'hacked' WHERE key = 'hr_admin'"))).resolves.toBeDefined(); // RLS: 0 rows, no effect
      const still = await db.withClaims(FIXTURE, (c) => c.query("SELECT name FROM roles WHERE key = 'hr_admin'"));
      expect(still.rows[0].name).not.toBe("hacked");
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE roles SET key = 'renamed' WHERE id = $1", [roleId]))).rejects.toThrow(/immutable/);
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE roles SET is_system = true WHERE id = $1", [roleId]))).rejects.toThrow(/immutable/);
      await expect(db.withClaims(admin, (c) => c.query("INSERT INTO roles (key, name, company_id) VALUES ('c00000000_x','x',$1)", [otherCompanyId]))).rejects.toThrow();
    });

    it("a custom role grants its permissions only while assigned and active", async () => {
      const holder = await mkUser(companyId);
      await assignments.assign(FIXTURE, { userAccountId: holder.sub, companyId, roleKey: (await roles.list(admin)).find((r) => r.id === roleId)!.key });
      expect(await rbac.can(holder, "workflow_template.manage.all")).toBe(true);
      await roles.setActive(admin, roleId, false);
      expect(await rbac.can(holder, "workflow_template.manage.all")).toBe(false);
      await expect(assignments.assign(FIXTURE, { userAccountId: (await mkUser(companyId)).sub, companyId, roleKey: (await roles.list(admin)).find((r) => r.id === roleId)!.key })).rejects.toThrow(BadRequestException);
      await roles.setActive(admin, roleId, true);
      expect(await rbac.can(holder, "workflow_template.manage.all")).toBe(true);
    });

    it("a tenant role cannot be granted in another company", async () => {
      const foreign = await mkUser(otherCompanyId);
      const key = (await roles.list(admin)).find((r) => r.id === roleId)!.key;
      await expect(assignments.assign(FIXTURE, { userAccountId: foreign.sub, companyId: otherCompanyId, roleKey: key })).rejects.toThrow(BadRequestException);
      await expect(
        db.withClaims(FIXTURE, (c) => c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [foreign.sub, otherCompanyId, roleId]))
      ).rejects.toThrow(/different company/);
    });
  });

  // ---------------------------------------------------------------- ACC-03
  describe("temporary and renewable role grants (ACC-03)", () => {
    it("records source, granter, window and reason, and audits the grant", async () => {
      const u = await mkUser(companyId);
      const a = await assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey: "hr_admin", effectiveFrom: days(-1), effectiveTo: days(5), source: "workflow", reason: "cover for leave" });
      expect(a).toMatchObject({ source: "workflow", reason: "cover for leave", effectiveFrom: days(-1), effectiveTo: days(5) });
      const audit = await db.withClaims(FIXTURE, (c) => c.query("SELECT reason FROM audit_log WHERE action = 'rbac.role_assigned' AND target = $1", [u.sub]));
      expect(audit.rows[0].reason).toBe("cover for leave");
    });

    it("a future grant gives nothing yet, an expired grant gives nothing any more", async () => {
      const future = await mkUser(companyId);
      await assignments.assign(FIXTURE, { userAccountId: future.sub, companyId, roleKey: "hr_admin", effectiveFrom: days(3) });
      expect(await rbac.can(future, "hr_reference_catalog.manage.all")).toBe(false);

      const lapsed = await mkUser(companyId);
      await assignments.assign(FIXTURE, { userAccountId: lapsed.sub, companyId, roleKey: "hr_admin", effectiveFrom: days(-10), effectiveTo: days(2) });
      expect(await rbac.can(lapsed, "hr_reference_catalog.manage.all")).toBe(true);
      // time passes: move the window into the past
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE user_role_assignments SET effective_from = CURRENT_DATE - 10, effective_to = CURRENT_DATE - 1 WHERE user_account_id = $1", [lapsed.sub]));
      expect(await rbac.can(lapsed, "hr_reference_catalog.manage.all")).toBe(false);
    });

    it("a lapsed grant is renewed in place; a live one conflicts; bad windows are rejected", async () => {
      const u = await mkUser(companyId);
      await assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey: "hr_admin", effectiveTo: days(30) });
      await expect(assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey: "hr_admin" })).rejects.toThrow(ConflictException);
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE user_role_assignments SET effective_to = CURRENT_DATE - 1, effective_from = CURRENT_DATE - 9 WHERE user_account_id = $1", [u.sub]));
      const renewed = await assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey: "hr_admin", effectiveTo: days(10) });
      expect(renewed.effectiveTo).toBe(days(10));
      expect(await rbac.can(u, "hr_reference_catalog.manage.all")).toBe(true);
      await expect(assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey: "line_manager", effectiveFrom: days(5), effectiveTo: days(1) })).rejects.toThrow(BadRequestException);
      await expect(assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey: "line_manager", source: "bogus" as never })).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------- ACC-01
  describe("field security (ACC-01)", () => {
    const OBJ = "acc01_object";
    let roleA: string;
    let roleB: string;
    let userA: RequestClaims;

    async function visible(user: RequestClaims, record: Record<string, unknown>) {
      const rules = await rbac.loadFieldPermissionRules(user, OBJ, ["secret"]);
      return rbac.filterRecordFieldsWithScope({ hasAll: true, hasSelf: false, hasTeam: false }, rules, record, ["secret"], null, null, user.sub);
    }

    beforeAll(async () => {
      roleA = (await roles.createCustom(admin, { key: "fieldrole_a", name: "A" })).id;
      roleB = (await roles.createCustom(admin, { key: "fieldrole_b", name: "B" })).id;
      userA = await mkUser(companyId);
      for (const id of [roleA, roleB]) {
        const key = (await roles.list(admin)).find((r) => r.id === id)!.key;
        await assignments.assign(FIXTURE, { userAccountId: userA.sub, companyId, roleKey: key });
      }
    });

    it("pure combination: grants are additive, masked sits between hidden and view, deny_overrides is a ceiling", () => {
      const r = (access: never, extra: object = {}) => ({ field_key: "f", access, condition: null, ...extra });
      expect(combineFieldRules([]).access).toBe("hidden");
      expect(combineFieldRules([r("masked" as never, { mask_rule: "last4" }), r("view" as never)]).access).toBe("view");
      expect(combineFieldRules([r("edit" as never), r("masked" as never, { deny_overrides: true, mask_rule: "email" })])).toEqual({ access: "masked", maskRule: "email" });
      expect(combineFieldRules([r("edit" as never), r("hidden" as never, { deny_overrides: true })]).access).toBe("hidden");
      expect(combineFieldRules([r("masked" as never, { priority: 50, mask_rule: "first1" }), r("masked" as never, { priority: 10, mask_rule: "last4" })]).maskRule).toBe("last4");
    });

    it("maskValue obscures without leaking structure", () => {
      const dot = "\u2022";
      expect(maskValue("42101-1234567-1", "last4")).toBe(dot.repeat(11) + "67-1");
      expect(maskValue("abc", "last4")).toBe(dot.repeat(3));
      expect(maskValue("Zameer", "first1")).toBe("Z" + dot.repeat(5));
      expect(maskValue("kumail@example.com", "email")).toBe("k" + dot.repeat(5) + "@example.com");
      expect(maskValue("a-very-long-secret-value", "full")).toBe(dot.repeat(8));
      expect(maskValue({ nested: "x" }, "last4")).toBe(dot.repeat(4));
      expect(maskValue(null, "full")).toBeNull();
    });

    it("end to end: hidden by default, masked by a tenant rule, view/edit by a stronger grant", async () => {
      const record = { secret: "12345678", other: "visible" };
      expect(await visible(userA, record)).toEqual({ other: "visible" });

      await fieldRules.create(admin, { roleId: roleA, objectKey: OBJ, fieldKey: "secret", access: "masked", maskRule: "last4" });
      expect(await visible(userA, record)).toEqual({ secret: "••••" + "5678", other: "visible" });

      await fieldRules.create(admin, { roleId: roleB, objectKey: OBJ, fieldKey: "secret", access: "view" });
      expect((await visible(userA, record))?.secret).toBe("12345678");
    });

    it("deny_overrides caps the result even when another role grants more", async () => {
      await fieldRules.create(admin, { roleId: roleA, objectKey: OBJ, fieldKey: "secret", access: "hidden", denyOverrides: true });
      expect(await visible(userA, { secret: "12345678" })).toEqual({});
    });

    it("rules respect their effective window and company", async () => {
      const lone = await mkUser(companyId);
      const key = (await roles.list(admin)).find((r) => r.id === roleB)!.key;
      await assignments.assign(FIXTURE, { userAccountId: lone.sub, companyId, roleKey: key });
      // roleB's existing 'view' rule applies; add a future-dated hide ceiling: not yet in force
      await fieldRules.create(admin, { roleId: roleB, objectKey: OBJ, fieldKey: "secret", access: "hidden", denyOverrides: true, effectiveFrom: days(7) });
      expect((await visible(lone, { secret: "abc" }))?.secret).toBe("abc");
      // a rule written by another company never reaches this company's users
      const foreignRole = (await roles.createCustom(otherAdmin, { key: "fr", name: "fr" })).id;
      await expect(fieldRules.create(otherAdmin, { roleId: roleB, objectKey: OBJ, fieldKey: "secret", access: "hidden", denyOverrides: true })).rejects.toThrow();
      expect(foreignRole).toBeTruthy();
    });

    it("validates input and refuses to touch platform default rows", async () => {
      await expect(fieldRules.create(admin, { roleId: roleA, objectKey: OBJ, fieldKey: "x", access: "view", maskRule: "full" })).rejects.toThrow(BadRequestException);
      await expect(fieldRules.create(admin, { roleId: roleA, objectKey: OBJ, fieldKey: "x", access: "nope" as never })).rejects.toThrow(BadRequestException);
      await expect(fieldRules.create(plain, { roleId: roleA, objectKey: OBJ, fieldKey: "x", access: "view" })).rejects.toThrow(ForbiddenException);
      const platformRow = await db.withClaims(FIXTURE, (c) => c.query("SELECT id FROM field_permission_rules WHERE company_id IS NULL LIMIT 1"));
      await expect(fieldRules.remove(admin, platformRow.rows[0].id)).rejects.toThrow(ForbiddenException);
      const mine = (await fieldRules.list(admin, roleA)).find((r) => r.companyId === companyId)!;
      await fieldRules.remove(admin, mine.id);
      await expect(fieldRules.remove(admin, mine.id)).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------- ACC-04
  describe("data scope assignments (ACC-04)", () => {
    let parent: string;
    let child: string;
    let area: string;
    let user: RequestClaims;

    beforeAll(async () => {
      user = await mkUser(companyId);
      await db.withClaims(FIXTURE, async (c) => {
        parent = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'division','P') RETURNING id", [companyId])).rows[0].id;
        child = (await c.query("INSERT INTO org_units (company_id, unit_type, name, parent_id) VALUES ($1,'department','C',$2) RETURNING id", [companyId, parent])).rows[0].id;
        area = (await c.query("INSERT INTO payroll_areas (company_id, code, name) VALUES ($1,'KHI','Karachi') RETURNING id", [companyId])).rows[0].id;
      });
    });

    it("include_descendants defaults to true; false is returned only by the exact resolver", async () => {
      const a = await scopes.assign(FIXTURE, { userAccountId: user.sub, companyId, scopeType: "org_unit", scopeEntityId: parent });
      expect(a.includeDescendants).toBe(true);
      expect(await rbac.resolveDataScopeEntityIds(user, "org_unit")).toEqual([parent]);
      expect(await rbac.resolveDataScopeExactIds(user, "org_unit")).toEqual([]);

      const b = await scopes.assign(FIXTURE, { userAccountId: user.sub, companyId, scopeType: "org_unit", scopeEntityId: child, includeDescendants: false });
      expect(b.includeDescendants).toBe(false);
      expect(await rbac.resolveDataScopeEntityIds(user, "org_unit")).toEqual([parent]);
      expect(await rbac.resolveDataScopeExactIds(user, "org_unit")).toEqual([child]);
    });

    it("assignments honour their effective window", async () => {
      const u = await mkUser(companyId);
      await scopes.assign(FIXTURE, { userAccountId: u.sub, companyId, scopeType: "org_unit", scopeEntityId: parent, effectiveFrom: days(2) });
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit")).toEqual([]);
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE data_scope_assignments SET effective_from = CURRENT_DATE - 5, effective_to = CURRENT_DATE + 5 WHERE user_account_id = $1", [u.sub]));
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit")).toEqual([parent]);
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE data_scope_assignments SET effective_to = CURRENT_DATE - 1 WHERE user_account_id = $1", [u.sub]));
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit")).toEqual([]);
      // a lapsed assignment can be renewed; a live one conflicts
      const renewed = await scopes.assign(FIXTURE, { userAccountId: u.sub, companyId, scopeType: "org_unit", scopeEntityId: parent, effectiveTo: days(30) });
      expect(renewed.effectiveTo).toBe(days(30));
      await expect(scopes.assign(FIXTURE, { userAccountId: u.sub, companyId, scopeType: "org_unit", scopeEntityId: parent })).rejects.toThrow(ConflictException);
    });

    it("supports the payroll_area scope and validates the entity belongs to the company", async () => {
      const u = await mkUser(companyId);
      await scopes.assign(FIXTURE, { userAccountId: u.sub, companyId, scopeType: "payroll_area", scopeEntityId: area, reason: "regional payroll" });
      expect(await rbac.resolveDataScopeEntityIds(u, "payroll_area")).toEqual([area]);
      await expect(scopes.assign(FIXTURE, { userAccountId: u.sub, companyId: otherCompanyId, scopeType: "payroll_area", scopeEntityId: area })).rejects.toThrow(NotFoundException);
      // the database refuses a dangling reference even for a direct insert
      await expect(
        db.withClaims(FIXTURE, (c) =>
          c.query("INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1,$2,'payroll_area',gen_random_uuid())", [u.sub, companyId])
        )
      ).rejects.toThrow();
    });

    it("a role-linked assignment applies only while the user holds that role", async () => {
      const u = await mkUser(companyId);
      const roleKey = "regional_hr";
      const roleId = (await db.withClaims(FIXTURE, (c) => c.query("SELECT id FROM roles WHERE key = $1", [roleKey]))).rows[0].id;
      await scopes.assign(FIXTURE, { userAccountId: u.sub, companyId, scopeType: "org_unit", scopeEntityId: parent, roleId });
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit")).toEqual([]);
      await assignments.assign(FIXTURE, { userAccountId: u.sub, companyId, roleKey });
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit")).toEqual([parent]);
    });

    it("an object-linked assignment applies only to callers asking for that object", async () => {
      const u = await mkUser(companyId);
      await scopes.assign(FIXTURE, { userAccountId: u.sub, companyId, scopeType: "org_unit", scopeEntityId: parent, objectKey: "payroll_run" });
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit")).toEqual([]);
      expect(await rbac.resolveDataScopeEntityIds(u, "org_unit", "payroll_run")).toEqual([parent]);
    });
  });
});
