import { Pool } from "pg";
import { NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { MyPersonalDataService } from "./my-personal-data.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "my-personal-data-spec" };

/** Real Postgres. Two employees in one company: each reads only their own person record. */
describe("MyPersonalDataService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: MyPersonalDataService;
  let companyId: string;
  const users: Record<string, string> = {};
  const emp: Record<string, string> = {};
  let unlinkedUser: string;

  const claimsFor = (sub: string): RequestClaims => ({ is_platform_admin: false, company_id: companyId, sub });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new MyPersonalDataService(db, new RbacService(db), new EntitlementsService(db));
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`PersonalData ${stamp}`, `personaldata-${stamp}`])).rows[0].id;
      await c.query(`INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, '["employee"]'::jsonb)`, [companyId]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [companyId]);
      const role = (await c.query("SELECT id FROM roles WHERE key = 'employee_self_service'")).rows[0].id;
      let n = 0;
      for (const [key, first, last] of [["ann", "Ann", "Khan"], ["bob", "Bob", "Ali"]]) {
        users[key] = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`${key}-${stamp}@example.test`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [users[key], companyId, role]);
        emp[key] = (
          await c.query(
            `INSERT INTO employees (company_id, employee_number, first_name, last_name, user_account_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [companyId, `PD-${++n}-${stamp.slice(-4)}`, first, last, users[key]]
          )
        ).rows[0].id;
      }
      unlinkedUser = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`none-${stamp}@example.test`])).rows[0].id;
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [unlinkedUser, companyId, role]);
      const personId = (await c.query("SELECT person_id FROM employees WHERE id = $1", [emp.ann])).rows[0].person_id;
      if (personId) {
        await c.query("UPDATE persons SET nationality = 'Pakistani', place_of_birth = 'Lahore', language = 'Urdu' WHERE id = $1", [personId]);
      }
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns the caller's own person record and history, never someone else's", async () => {
    const mine = await svc.get(claimsFor(users.ann));
    expect(mine.employeeId).toBe(emp.ann);
    expect(mine.person?.firstName).toBe("Ann");
    expect(mine.person?.lastName).toBe("Khan");
    expect(mine.person?.nationality).toBe("Pakistani");
    expect(mine.person?.placeOfBirth).toBe("Lahore");
    expect(mine.history.length).toBeGreaterThan(0);
    expect(mine.history[mine.history.length - 1].validTo).toBeNull();

    const bobs = await svc.get(claimsFor(users.bob));
    expect(bobs.employeeId).toBe(emp.bob);
    expect(bobs.person?.firstName).toBe("Bob");
    expect(bobs.person?.nationality).toBeNull();
  });

  it("never includes CNIC or date of birth (those stay on the field-rule-filtered employee record)", async () => {
    const mine = await svc.get(claimsFor(users.ann));
    expect(mine.person).not.toBeNull();
    expect("cnic" in (mine.person as object)).toBe(false);
    expect("dateOfBirth" in (mine.person as object)).toBe(false);
  });

  it("says so plainly when the login is not linked to an employee", async () => {
    await expect(svc.get(claimsFor(unlinkedUser))).rejects.toThrow(NotFoundException);
  });

  it("refuses a caller with no company", async () => {
    await expect(svc.get({ is_platform_admin: false, company_id: null, sub: users.ann })).rejects.toThrow(NotFoundException);
  });
});
