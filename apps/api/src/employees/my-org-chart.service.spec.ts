import { Pool } from "pg";
import { NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { MyOrgChartService } from "./my-org-chart.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "my-org-chart-spec" };

/** Real Postgres. A small tree across two departments:  CEO -> (Mgr[Sales] -> Ann, Bob ; Dev[Tech]) and Ann -> Cy[Support]. */
describe("MyOrgChartService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: MyOrgChartService;
  let companyId: string;
  const users: Record<string, string> = {};
  const emp: Record<string, string> = {};

  const claimsFor = (key: string, cid = companyId): RequestClaims => ({ is_platform_admin: false, company_id: cid, sub: users[key] });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new MyOrgChartService(db, new RbacService(db), new EntitlementsService(db));
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`OrgChart ${stamp}`, `orgchart-${stamp}`])).rows[0].id;
      await c.query(`INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, '["employee"]'::jsonb)`, [companyId]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [companyId]);

      const people: Array<[string, string, string | null, string]> = [
        ["ceo", "Cee Oh", null, "Management"],
        ["mgr", "Mia Manager", "ceo", "Sales"],
        ["dev", "Dev Lead", "ceo", "Tech"],
        ["ann", "Ann Rep", "mgr", "Sales"],
        ["bob", "Bob Rep", "mgr", "Sales"],
        ["cy", "Cy Support", "ann", "Support"],
      ];
      let n = 0;
      for (const [key, name, mgr, dept] of people) {
        const [first, ...rest] = name.split(" ");
        users[key] = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`${key}-${stamp}@example.test`])).rows[0].id;
        const role = (await c.query("SELECT id FROM roles WHERE key = 'employee_self_service'")).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [users[key], companyId, role]);
        emp[key] = (
          await c.query(
            `INSERT INTO employees (company_id, employee_number, first_name, last_name, department, designation, manager_id, user_account_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [companyId, `OC-${++n}-${stamp.slice(-4)}`, first, rest.join(" "), dept, `${dept} role`, mgr ? emp[mgr] : null, users[key]]
          )
        ).rows[0].id;
      }
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("an employee sees the manager chain, colleagues and nothing below when they have no reports", async () => {
    const chart = await svc.get(claimsFor("bob"));
    expect(chart.me.fullName).toBe("Bob Rep");
    expect(chart.managerChain.map((p) => p.fullName)).toEqual(["Cee Oh", "Mia Manager"]);
    expect(chart.peers.map((p) => p.fullName)).toEqual(["Ann Rep"]);
    expect(chart.downline).toEqual([]);
    expect(chart.departments).toEqual(["Sales"]);
  });

  it("a manager sees their whole downline across departments", async () => {
    const chart = await svc.get(claimsFor("mgr"));
    expect(chart.managerChain.map((p) => p.fullName)).toEqual(["Cee Oh"]);
    expect(chart.peers.map((p) => p.fullName)).toEqual(["Dev Lead"]);
    expect(chart.downline.map((n) => n.fullName)).toEqual(["Ann Rep", "Bob Rep"]);
    expect(chart.downline[0].directReports.map((n) => n.fullName)).toEqual(["Cy Support"]);
    expect(chart.departments).toEqual(["Sales", "Support"]);
    expect(chart.truncated).toBe(false);
  });

  it("the top of the line has no chain and no peers outside their department", async () => {
    const chart = await svc.get(claimsFor("ceo"));
    expect(chart.managerChain).toEqual([]);
    expect(chart.peers).toEqual([]);
    expect(chart.departments).toEqual(["Management", "Sales", "Support", "Tech"]);
  });

  it("only public fields leave the service", async () => {
    const chart = await svc.get(claimsFor("ann"));
    expect(Object.keys(chart.me).sort()).toEqual(["department", "designation", "employeeNumber", "fullName", "id"]);
  });

  it("a login with no employee record gets 404, not someone else's chart", async () => {
    const stray = await db.withClaims(FIXTURE, async (c) => {
      const id = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`stray-${Date.now()}@example.test`])).rows[0].id;
      const role = (await c.query("SELECT id FROM roles WHERE key = 'employee_self_service'")).rows[0].id;
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [id, companyId, role]);
      return id as string;
    });
    await expect(svc.get({ is_platform_admin: false, company_id: companyId, sub: stray })).rejects.toBeInstanceOf(NotFoundException);
  });
});
