import { Pool } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { WorkflowService } from "./workflow.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "approver-options-spec" };

/**
 * BACKLOG56: whoever holds `workflow_template.manage.all` through ANY role (a company's own custom role included) can
 * load the pickers the template editor needs, and nobody else can. Real Postgres.
 */
describe("WorkflowService approver options (permission based)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let companyId: string;
  let otherCompanyId: string;
  let helper: RequestClaims; // custom role with only the workflow permission
  let hrAdmin: RequestClaims; // built-in HR Admin: must not have the permission by default
  let customRoleId: string;
  const stamp = Date.now();

  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query(text, params)).rows as T[]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    workflow = new WorkflowService(db, new RbacService(db), new AuditService());
    companyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`ApprOpt ${stamp}`, `appr-opt-${stamp}`]))[0].id;
    otherCompanyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`ApprOpt Other ${stamp}`, `appr-opt-o-${stamp}`]))[0].id;

    customRoleId = (await sql<{ id: string }>("INSERT INTO roles (key, name, company_id, is_system) VALUES ($1, 'Workflow Helper', $2, false) RETURNING id", [`c${String(stamp).slice(-7)}_wf_helper`, companyId]))[0].id;
    await sql("INSERT INTO roles (key, name, company_id, is_system) VALUES ($1, 'Foreign Role', $2, false)", [`c${String(stamp).slice(-7)}_foreign`, otherCompanyId]);
    await sql("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = 'workflow_template.manage.all'", [customRoleId]);

    const user = async (email: string, company: string, roleId: string, first: string, number: string) => {
      const id = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]))[0].id;
      await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [id, company, roleId]);
      await sql(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, email, user_account_id, employment_type, employment_status, date_of_joining)
         VALUES ($1, $2, $3, 'Tester', $4, $5, 'permanent', 'active', now())`,
        [company, number, first, email, id]
      );
      return { is_platform_admin: false, company_id: company, sub: id } as RequestClaims;
    };
    const hrRole = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = 'hr_admin'"))[0].id;
    helper = await user(`apprOpt-helper-${stamp}@example.com`, companyId, customRoleId, "Helper", "AO-1");
    hrAdmin = await user(`apprOpt-hr-${stamp}@example.com`, companyId, hrRole, "Hira", "AO-2");
    await user(`apprOpt-other-${stamp}@example.com`, otherCompanyId, hrRole, "Outsider", "AO-9");
  });

  afterAll(async () => {
    await sql("DELETE FROM workflow_templates WHERE company_id = ANY($1::uuid[])", [[companyId, otherCompanyId]]);
    await sql("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]);
    await pool.end();
  });

  it("the built-in HR Admin role does not hold the permission by default", async () => {
    await expect(workflow.listApproverOptions(hrAdmin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(workflow.listTemplates(hrAdmin)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a custom role holding only workflow_template.manage.all gets roles (built-in and custom) and its own company's people", async () => {
    const options = await workflow.listApproverOptions(helper);
    const keys = options.roles.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["hr_admin", "line_manager", "payroll_approver", `c${String(stamp).slice(-7)}_wf_helper`]));
    expect(keys.some((k) => k.endsWith("_foreign"))).toBe(false);
    expect(keys.some((k) => k.startsWith("rbac_demo"))).toBe(false);
    const names = options.people.map((p) => p.fullName);
    expect(names).toEqual(expect.arrayContaining(["Helper Tester", "Hira Tester"]));
    expect(names).not.toContain("Outsider Tester");
    expect(options.people.every((p) => p.userAccountId)).toBe(true);
  });

  it("the same holder can create a template pointing at the custom role", async () => {
    const key = `apprOpt-${stamp}`;
    const created = await workflow.createTemplate(helper, {
      key,
      name: "Approver options template",
      objectKey: "dummy_record",
      steps: [{ stepOrder: 1, name: "Approve", approvers: [{ approverType: "role", roleId: customRoleId }] }],
    });
    expect(created.key).toBe(key);
  });

  it("switching the permission off the role locks the holder out again", async () => {
    await sql("DELETE FROM role_permissions WHERE role_id = $1", [customRoleId]);
    await expect(workflow.listApproverOptions(helper)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
