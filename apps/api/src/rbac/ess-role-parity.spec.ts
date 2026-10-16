import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "./rbac.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "ess-role-parity-fixtures" };

/**
 * "Employee Self Service" (ess_portal) is a separate role with the same access as employee_self_service (migration 0154).
 * If a later migration grants a permission or field rule to one of them, it has to grant it to the other too -- this
 * spec fails on drift so the two cannot silently diverge.
 */
describe("Employee Self Service role (ess_portal)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let companyId: string;
  let essUser: RequestClaims;
  let baseUser: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`EssParity ${stamp}`, `ess-parity-${stamp}`])).rows[0].id;
    });
    const mk = async (roleKey: string, n: number) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`ess-parity-${stamp}-${n}@example.com`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u, companyId, roleKey]);
        return { sub: u, company_id: companyId, is_platform_admin: false } as RequestClaims;
      });
    essUser = await mk("ess_portal", 1);
    baseUser = await mk("employee_self_service", 2);
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("exists under the name Employee Self Service", async () => {
    const r = await db.withClaims(FIXTURE, (c) => c.query("SELECT name FROM roles WHERE key = 'ess_portal'"));
    expect(r.rows[0].name).toBe("Employee Self Service");
  });

  it("holds exactly the permissions employee_self_service holds", async () => {
    const keys = async (role: string) =>
      (
        await db.withClaims(FIXTURE, (c) =>
          c.query("SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id WHERE r.key = $1 ORDER BY p.key", [role])
        )
      ).rows.map((x) => x.key as string);
    const ess = await keys("ess_portal");
    expect(ess.length).toBeGreaterThan(0);
    expect(ess).toEqual(await keys("employee_self_service"));
  });

  it("holds exactly the field rules employee_self_service holds", async () => {
    const rules = async (role: string) =>
      (
        await db.withClaims(FIXTURE, (c) =>
          c.query(
            "SELECT f.object_key, f.field_key, f.access, f.condition::text AS condition FROM field_permission_rules f JOIN roles r ON r.id = f.role_id WHERE r.key = $1 ORDER BY 1,2,3,4",
            [role]
          )
        )
      ).rows;
    expect(await rules("ess_portal")).toEqual(await rules("employee_self_service"));
  });

  it("authorizes a user holding only ess_portal for the same own-data permissions", async () => {
    for (const perm of ["employee.view.self", "leave_request.create.self"]) {
      expect(await rbac.can(essUser, perm, { ownerId: essUser.sub })).toBe(true);
      expect(await rbac.can(baseUser, perm, { ownerId: baseUser.sub })).toBe(true);
    }
    expect(await rbac.can(essUser, "employee.view.self", { ownerId: baseUser.sub })).toBe(false); // someone else's record
    expect(await rbac.can(essUser, "employee.manage.all")).toBe(false);
  });
});
