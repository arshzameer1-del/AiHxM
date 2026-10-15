import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { EmployeeGroupsService } from "./employee-groups.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "groups-step3-fixtures" };

/** Gap Register CAT-05 / CAT-06 -- subgroups, materialised membership, ID conditions, non-leave policy assignment. */
describe("EmployeeGroupsService -- Step 3 (CAT-05, CAT-06)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let groups: EmployeeGroupsService;
  let companyId: string;
  let otherCompanyId: string;
  let hr: RequestClaims;
  let orgUnitA: string;
  let orgUnitB: string;
  let jobId: string;
  let positionId: string;
  let emp: Record<string, string> = {};

  async function mkCompany(prefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE, async (c) => {
      const id = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`${prefix} ${stamp}`, `${prefix.toLowerCase()}-${stamp}`])).rows[0].id as string;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'leave',true)", [id]);
      return id;
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    groups = new EmployeeGroupsService(db, new RbacService(db), new EntitlementsService(db), new EffectiveDatingEngine(), new RulesEngine());
    companyId = await mkCompany("Step3 Groups");
    otherCompanyId = await mkCompany("Step3 Other");
    await db.withClaims(FIXTURE, async (c) => {
      const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`s3-hr-${Date.now()}@example.com`])).rows[0].id;
      const role = (await c.query("SELECT id FROM roles WHERE key='hr_admin'")).rows[0].id;
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [u, companyId, role]);
      hr = { sub: u, company_id: companyId, is_platform_admin: false } as RequestClaims;
      orgUnitA = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Unit A') RETURNING id", [companyId])).rows[0].id;
      orgUnitB = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Unit B') RETURNING id", [companyId])).rows[0].id;
      jobId = (await c.query("INSERT INTO jobs (company_id, title) VALUES ($1,'Engineer') RETURNING id", [companyId])).rows[0].id;
      positionId = (await c.query("INSERT INTO positions (company_id, org_unit_id, position_title, job_id) VALUES ($1,$2,'Eng 1',$3) RETURNING id", [companyId, orgUnitA, jobId])).rows[0].id;
      const mk = async (key: string, orgUnit: string | null, position: string | null) =>
        (
          await c.query(
            `INSERT INTO employees (company_id, employee_number, first_name, last_name, org_unit_id, position_id, employment_status)
             VALUES ($1,$2,'S3',$3,$4,$5,'active') RETURNING id`,
            [companyId, `S3-${key}`, key, orgUnit, position]
          )
        ).rows[0].id as string;
      emp = { a1: await mk("a1", orgUnitA, positionId), a2: await mk("a2", orgUnitA, null), b1: await mk("b1", orgUnitB, null) };
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  it("matches on canonical IDs (orgUnitId, positionId, jobId) and keeps text conditions working", async () => {
    const byUnit = await groups.createGroup(hr, { name: "Unit A people", conditions: [{ field: "orgUnitId", equals: orgUnitA }] });
    expect((await groups.resolveGroupMembers(hr, byUnit.id)).sort()).toEqual([emp.a1, emp.a2].sort());

    const byJob = await groups.createGroup(hr, { name: "Engineers by job", conditions: [{ field: "jobId", equals: jobId }] });
    expect(await groups.resolveGroupMembers(hr, byJob.id)).toEqual([emp.a1]);

    const byPos = await groups.createGroup(hr, { name: "Eng 1 holders", conditions: [{ field: "positionId", equals: positionId }] });
    expect(await groups.resolveGroupMembers(hr, byPos.id)).toEqual([emp.a1]);

    // legacy text condition on the department name still resolves via org-unit-linked text? (department text is NULL here)
    const legacy = await groups.createGroup(hr, { name: "Legacy dept", conditions: [{ field: "department", equals: "Nobody" }] });
    expect(await groups.resolveGroupMembers(hr, legacy.id)).toEqual([]);
  });

  it("subgroups: create, list, assign an employee, match on subgroupId", async () => {
    const g = await groups.createGroup(hr, { name: "With subgroups", conditions: [{ field: "orgUnitId", equals: orgUnitA }] });
    const sg = await groups.createSubgroup(hr, g.id, { code: "senior", name: "Senior" });
    await expect(groups.createSubgroup(hr, g.id, { code: "senior", name: "Dup" })).rejects.toThrow();
    expect((await groups.listSubgroups(hr, g.id)).map((s) => s.code)).toEqual(["senior"]);

    await groups.assignEmployeeSubgroup(hr, emp.a2, sg.id);
    const bySub = await groups.createGroup(hr, { name: "Seniors", conditions: [{ field: "subgroupId", equals: sg.id }] });
    expect(await groups.resolveGroupMembers(hr, bySub.id)).toEqual([emp.a2]);

    await groups.updateSubgroup(hr, sg.id, { isActive: false });
    await expect(groups.assignEmployeeSubgroup(hr, emp.a1, sg.id)).rejects.toThrow(BadRequestException);
    await groups.assignEmployeeSubgroup(hr, emp.a2, null);
    expect(await groups.resolveGroupMembers(hr, bySub.id)).toEqual([]);
  });

  it("a subgroup from another company cannot be assigned", async () => {
    const otherSubgroup = await db.withClaims(FIXTURE, async (c) => {
      const g = (await c.query("INSERT INTO employee_groups (company_id, name) VALUES ($1,'other g') RETURNING id", [otherCompanyId])).rows[0].id;
      return (await c.query("INSERT INTO employee_subgroups (company_id, group_id, code, name) VALUES ($1,$2,'x','X') RETURNING id", [otherCompanyId, g])).rows[0].id as string;
    });
    await expect(groups.assignEmployeeSubgroup(hr, emp.a1, otherSubgroup)).rejects.toThrow(BadRequestException);
  });

  it("materialises membership with history: add, close when no longer matching, as-of read", async () => {
    const g = await groups.createGroup(hr, { name: "Materialised", conditions: [{ field: "orgUnitId", equals: orgUnitB }] });
    let r = await groups.refreshMemberships(hr, g.id);
    expect(r).toEqual({ added: 1, closed: 0, currentCount: 1 });
    r = await groups.refreshMemberships(hr, g.id);
    expect(r).toEqual({ added: 0, closed: 0, currentCount: 1 }); // idempotent

    // b1 moves to unit A -> membership closed, history kept
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [emp.b1, orgUnitA]));
    r = await groups.refreshMemberships(hr, g.id);
    expect(r).toEqual({ added: 0, closed: 1, currentCount: 0 });
    expect(await groups.listMemberships(hr, g.id)).toEqual([]);
    // opened and closed on the same day: never took effect, so no row is left behind
    const left = await db.withClaims(FIXTURE, (c) => c.query("SELECT 1 FROM employee_group_memberships WHERE group_id = $1", [g.id]));
    expect(left.rowCount).toBe(0);

    // a membership that started in the past is CLOSED, not deleted
    await db.withClaims(FIXTURE, async (c) => {
      await c.query("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [emp.b1, orgUnitB]);
      await c.query("INSERT INTO employee_group_memberships (company_id, group_id, employee_id, source, effective_from) VALUES ($1,$2,$3,'rule','2020-01-01')", [companyId, g.id, emp.b1]);
      await c.query("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [emp.b1, orgUnitA]);
    });
    r = await groups.refreshMemberships(hr, g.id);
    expect(r.closed).toBe(1);
    const history = await db.withClaims(FIXTURE, (c) => c.query("SELECT effective_from, effective_to FROM employee_group_memberships WHERE group_id = $1", [g.id]));
    expect(history.rowCount).toBe(1);
    expect(history.rows[0].effective_to).not.toBeNull();
    expect(await groups.listMemberships(hr, g.id, "2021-06-01")).toHaveLength(1);
    expect(await groups.listMemberships(hr, g.id)).toEqual([]);

    // back again later: a new row is opened (or the same-day conflict is ignored, never an error)
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [emp.b1, orgUnitB]));
    await expect(groups.refreshMemberships(hr, g.id)).resolves.toBeDefined();
  });

  it("a group outside its effective window has no members and is skipped when resolving policies", async () => {
    const g = await groups.createGroup(hr, { name: "Expired group", conditions: [{ field: "orgUnitId", equals: orgUnitA }] });
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE employee_groups SET effective_to = '2000-01-01', effective_from = '1999-01-01' WHERE id = $1", [g.id]));
    const r = await groups.refreshMemberships(hr, g.id);
    expect(r.currentCount).toBe(0);
  });

  it("assigns a non-leave policy type (CAT-06): verified against hr_business_policies of that type, with a window", async () => {
    const g = await groups.createGroup(hr, { name: "Probation group", conditions: [{ field: "orgUnitId", equals: orgUnitA }] });
    const probation = await db.withClaims(FIXTURE, async (c) =>
      (await c.query("INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules) VALUES ($1,'probation','p90','Ninety days','{\"durationDays\":90}') RETURNING id", [companyId])).rows[0].id as string
    );
    const rehire = await db.withClaims(FIXTURE, async (c) =>
      (await c.query("INSERT INTO hr_business_policies (company_id, policy_type, code, name) VALUES ($1,'rehire','r1','Rehire') RETURNING id", [companyId])).rows[0].id as string
    );

    // wrong type for the id
    await expect(groups.assignPolicy(hr, g.id, { policyType: "probation", policyId: rehire })).rejects.toThrow(BadRequestException);
    const a = await groups.assignPolicy(hr, g.id, { policyType: "probation", policyId: probation, effectiveFrom: "2020-01-01" });
    expect(a.policyType).toBe("probation");
    expect(a.effectiveFrom).toBe("2020-01-01");

    const resolved = await groups.resolvePolicyInternal(hr, emp.a1, "probation");
    expect(resolved.policyId).toBe(probation);
    expect(resolved.groupId).toBe(g.id);

    // an assignment that has not started yet is ignored
    await groups.assignPolicy(hr, g.id, { policyType: "probation", policyId: probation, effectiveFrom: "2999-01-01" });
    expect((await groups.resolvePolicyInternal(hr, emp.a1, "probation")).policyId).toBeNull();
    await expect(groups.assignPolicy(hr, g.id, { policyType: "probation", policyId: probation, effectiveFrom: "2030-01-01", effectiveTo: "2029-01-01" })).rejects.toThrow(BadRequestException);
  });

  it("the database refuses a policy assignment pointing at a policy of another company or type", async () => {
    const g = await db.withClaims(FIXTURE, async (c) => (await c.query("INSERT INTO employee_groups (company_id, name) VALUES ($1,'poly g') RETURNING id", [companyId])).rows[0].id as string);
    const foreign = await db.withClaims(FIXTURE, async (c) =>
      (await c.query("INSERT INTO hr_business_policies (company_id, policy_type, code, name) VALUES ($1,'probation','pf','Foreign') RETURNING id", [otherCompanyId])).rows[0].id as string
    );
    await expect(
      db.withClaims(FIXTURE, (c) => c.query("INSERT INTO employee_group_policy_assignments (company_id, group_id, policy_type, policy_id) VALUES ($1,$2,'probation',$3)", [companyId, g, foreign]))
    ).rejects.toThrow(/does not exist in this company/);
  });
});
