import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "./rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OrgRelationshipsService } from "../organization/org-relationships.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "team-scope-step3-fixtures" };

/**
 * Gap Register ACC-05 -- ".team" scope follows the canonical reporting line.
 *
 * Resolution: EmployeesService reads a record's manager from employees.manager_id,
 * the mirror that OrgRelationshipsService (and the employee/lifecycle write paths)
 * keep in step with org_relationships, the canonical store. These tests prove the
 * visible effect: a Line Manager sees exactly the people the canonical direct
 * relationships say report to them, and nothing else.
 */
describe("Team scope follows canonical org_relationships (ACC-05)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let relationships: OrgRelationshipsService;
  let companyId: string;
  let hr: RequestClaims;
  let lineManager: RequestClaims;
  let otherManagerEmp: string;
  let managerEmp: string;
  let report: string;

  const visibleIds = async (c: RequestClaims) => (await employees.list(c)).map((e) => e.id);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    relationships = new OrgRelationshipsService(db, rbac, ent, audit, new EffectiveDatingEngine());

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Team ${stamp}`, `team-${stamp}`])).rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [companyId]);
      const mk = async (label: string, role: string) => {
        const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`team-${label}-${stamp}@example.com`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u, companyId, role]);
        return u as string;
      };
      const hrId = await mk("hr", "hr_admin");
      const lmId = await mk("lm", "line_manager");
      hr = { sub: hrId, company_id: companyId, is_platform_admin: false };
      lineManager = { sub: lmId, company_id: companyId, is_platform_admin: false };
      // the line manager's own employee record, linked to their login
      managerEmp = (await c.query("INSERT INTO employees (company_id, employee_number, first_name, last_name, user_account_id) VALUES ($1,'T-1','Line','Manager',$2) RETURNING id", [companyId, lmId])).rows[0].id;
    });
    otherManagerEmp = (await employees.create(hr, { firstName: "Other", lastName: "Boss" })).id;
    report = (await employees.create(hr, { firstName: "Direct", lastName: "Report" })).id;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("a Line Manager sees no one until a canonical direct relationship exists", async () => {
    expect(await visibleIds(lineManager)).not.toContain(report);
  });

  it("creating the canonical relationship grants team visibility; reassigning removes it; ending keeps it removed", async () => {
    const rel = await relationships.create(hr, { employeeId: report, managerEmployeeId: managerEmp, relationshipType: "direct" });
    expect(await visibleIds(lineManager)).toContain(report);

    await relationships.update(hr, rel.id, { managerEmployeeId: otherManagerEmp });
    expect(await visibleIds(lineManager)).not.toContain(report);

    await relationships.update(hr, rel.id, { managerEmployeeId: managerEmp });
    expect(await visibleIds(lineManager)).toContain(report);

    await relationships.end(hr, rel.id);
    expect(await visibleIds(lineManager)).not.toContain(report);
  });

  it("non-direct relationships (dotted line, matrix) do not confer team scope", async () => {
    const dotted = await relationships.create(hr, { employeeId: report, managerEmployeeId: managerEmp, relationshipType: "dotted_line" });
    expect(await visibleIds(lineManager)).not.toContain(report);
    await relationships.end(hr, dotted.id);
  });

  it("no drift: after all of the above the mirror equals the canonical reporting line for every employee", async () => {
    const drift = await db.withClaims(hr, (c) => c.query("SELECT * FROM app.manager_mirror_drift($1)", [companyId]));
    expect(drift.rows).toEqual([]);
  });

  it("the drift report catches a mirror changed behind the canonical store's back", async () => {
    const rel = await relationships.create(hr, { employeeId: report, managerEmployeeId: managerEmp, relationshipType: "direct" });
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE employees SET manager_id = $2 WHERE id = $1", [report, otherManagerEmp]));
    const drift = await db.withClaims(hr, (c) => c.query("SELECT * FROM app.manager_mirror_drift($1)", [companyId]));
    expect(drift.rows).toEqual([{ employee_id: report, mirror_manager_id: otherManagerEmp, canonical_manager_id: managerEmp }]);
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE employees SET manager_id = $2 WHERE id = $1", [report, managerEmp]));
    await relationships.end(hr, rel.id);
  });
});
