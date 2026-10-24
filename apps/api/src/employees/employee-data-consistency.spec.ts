import { Pool, type PoolClient } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { EmployeeDataConsistencyService } from "./employee-data-consistency.service";
import { EmployeeContactsService } from "./employee-contacts.service";
import { CONSISTENCY_CHECKS } from "./employee-data-consistency.checks";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-data-consistency-spec" };

/**
 * BACKLOG46 against real Postgres: the employee row's department, designation, location, email, phone and manager
 * always agree with the place that owns the value, renames reach every employee, and the consistency report finds and
 * repairs whatever drifted before the triggers existed.
 */
describe("Employee data consistency", () => {
  let pool: Pool;
  let owner: Pool;
  let db: DatabaseService;
  let service: EmployeeDataConsistencyService;
  let contacts: EmployeeContactsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let b: string;
  let hr: RequestClaims;
  let plain: RequestClaims;
  let eng: string;
  let ops: string;
  let posDev: string;
  let karachi: string;
  let n = 0;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  async function makeEmployee(c: PoolClient, companyId: string, o: Record<string, unknown> = {}) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [companyId, `Person ${n}`]);
    const r = await c.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, org_unit_id, position_id, location_id,
                              department, designation, location, email, phone, manager_id, employment_status, termination_date)
       VALUES ($1, $2, 'C', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        companyId, `DC-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id,
        o.unit ?? null, o.position ?? null, o.location ?? null,
        o.department ?? null, o.designation ?? null, o.locationText ?? null,
        o.email ?? null, o.phone ?? null, o.manager ?? null, o.status ?? "active", o.left ?? null,
      ]
    );
    return r.rows[0].id as string;
  }
  const emp = async (id: string) => (await fx((c) => c.query("SELECT * FROM employees WHERE id = $1", [id]))).rows[0];
  const contactRows = async (id: string, type: string) =>
    (await fx((c) => c.query("SELECT * FROM employee_contacts WHERE employee_id = $1 AND contact_type = $2 ORDER BY created_at", [id, type]))).rows;
  const check = async (id: string, claims = hr) => (await service.getReport(claims)).checks.find((x) => x.id === id)!;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    service = new EmployeeDataConsistencyService(db, ent, rbac, audit);
    contacts = new EmployeeContactsService(db, rbac, ent, audit, { validateActiveCode: async () => undefined } as never);
    await fx(async (c) => {
      const mk = async (label: string) => {
        const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`DC ${label} ${stamp}`, `dc-${label}-${stamp}`.toLowerCase()]);
        await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(["employee"])]);
        await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [r.rows[0].id]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`dc-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id } as RequestClaims;
      };
      hr = await mkUser("hr", "hr_admin");
      plain = await mkUser("ess", "employee_self_service");
      eng = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [a])).rows[0].id;
      ops = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Operations') RETURNING id", [a])).rows[0].id;
      posDev = (await c.query("INSERT INTO positions (company_id, org_unit_id, position_code, position_title) VALUES ($1, $2, 'DEV', 'Software Engineer') RETURNING id", [a, eng])).rows[0].id;
      karachi = (await c.query("INSERT INTO locations (company_id, name, location_type) VALUES ($1, 'Karachi HQ', 'city') RETURNING id", [a])).rows[0].id;
    });
  });

  afterAll(async () => {
    await pool.end();
    await owner.end();
  });

  it("department, designation and location always come from the unit, position and location chosen", async () => {
    const id = await fx((c) => makeEmployee(c, a, { unit: eng, position: posDev, location: karachi, department: "Typo Dept", designation: "Typo", locationText: "Typo City" }));
    const row = await emp(id);
    expect([row.department, row.designation, row.location]).toEqual(["Engineering", "Software Engineer", "Karachi HQ"]);

    // moving the employee to another unit changes the department text in the same statement
    await fx((c) => c.query("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [id, ops]));
    expect((await emp(id)).department).toBe("Operations");

    // clearing the unit clears the text that came from it
    await fx((c) => c.query("UPDATE employees SET org_unit_id = NULL WHERE id = $1", [id]));
    expect((await emp(id)).department).toBeNull();
  });

  it("an employee with no unit keeps the department that was typed in (older records)", async () => {
    const id = await fx((c) => makeEmployee(c, a, { department: "Legacy Dept" }));
    expect((await emp(id)).department).toBe("Legacy Dept");
    const found = await check("department_text_only");
    expect(found.samples.some((s) => s.employeeId === id)).toBe(true);
  });

  it("renaming an org unit, a location or a position updates every employee that uses it", async () => {
    const unit = await fx(async (c) => (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Finance') RETURNING id", [a])).rows[0].id);
    const loc = await fx(async (c) => (await c.query("INSERT INTO locations (company_id, name, location_type) VALUES ($1, 'Lahore', 'city') RETURNING id", [a])).rows[0].id);
    const pos = await fx(async (c) => (await c.query("INSERT INTO positions (company_id, org_unit_id, position_code, position_title) VALUES ($1, $2, 'ACC', 'Accountant') RETURNING id", [a, unit])).rows[0].id);
    const ids = await fx(async (c) => [
      await makeEmployee(c, a, { unit, position: pos, location: loc }),
      await makeEmployee(c, a, { unit, position: pos, location: loc }),
    ]);
    await fx((c) => c.query("UPDATE org_units SET name = 'Finance & Accounts' WHERE id = $1", [unit]));
    await fx((c) => c.query("UPDATE locations SET name = 'Lahore Office' WHERE id = $1", [loc]));
    await fx((c) => c.query("UPDATE positions SET position_title = 'Senior Accountant' WHERE id = $1", [pos]));
    for (const id of ids) {
      const row = await emp(id);
      expect([row.department, row.location, row.designation]).toEqual(["Finance & Accounts", "Lahore Office", "Senior Accountant"]);
    }
  });

  it("an employee's email and phone become the primary contact records, and changes replace the primary without duplicates", async () => {
    const id = await fx((c) => makeEmployee(c, a, { email: "first@example.com", phone: "0300-1111111" }));
    expect((await contactRows(id, "business_email")).map((r) => [r.value, r.is_primary, r.status])).toEqual([["first@example.com", true, "active"]]);
    expect((await contactRows(id, "personal_phone")).map((r) => [r.value, r.is_primary])).toEqual([["0300-1111111", true]]);

    await fx((c) => c.query("UPDATE employees SET email = 'second@example.com' WHERE id = $1", [id]));
    const rows = await contactRows(id, "business_email");
    expect(rows.map((r) => [r.value, r.is_primary])).toEqual([["first@example.com", false], ["second@example.com", true]]);

    // going back to an earlier address reuses that row
    await fx((c) => c.query("UPDATE employees SET email = 'FIRST@example.com' WHERE id = $1", [id]));
    const again = await contactRows(id, "business_email");
    expect(again).toHaveLength(2);
    expect(again.filter((r) => r.is_primary).map((r) => r.value)).toEqual(["first@example.com"]);
  });

  it("a primary contact record changes the email and phone shown on the employee", async () => {
    const id = await fx((c) => makeEmployee(c, a, { email: "old@example.com", phone: "0300-0000000" }));
    await fx((c) => c.query("UPDATE employee_contacts SET is_primary = false WHERE employee_id = $1 AND contact_type = 'business_email'", [id]));
    await fx((c) => c.query("INSERT INTO employee_contacts (company_id, employee_id, contact_type, value, is_primary) VALUES ($1, $2, 'business_email', 'work@example.com', true)", [a, id]));
    expect((await emp(id)).email).toBe("work@example.com");

    // a business phone outranks the personal phone
    await fx((c) => c.query("INSERT INTO employee_contacts (company_id, employee_id, contact_type, value, is_primary) VALUES ($1, $2, 'business_phone', '021-111-222', true)", [a, id]));
    expect((await emp(id)).phone).toBe("021-111-222");
  });

  it("adding the same contact twice through the service keeps one row and can promote it to primary", async () => {
    const id = await fx((c) => makeEmployee(c, a));
    const first = await db.withClaims(hr, (c) => contacts.createWithinTransaction(c, hr, { employeeId: id, contactType: "personal_email", value: "me@example.com", isPrimary: false }));
    const second = await db.withClaims(hr, (c) => contacts.createWithinTransaction(c, hr, { employeeId: id, contactType: "personal_email", value: "ME@example.com", isPrimary: true }));
    expect(second.id).toBe(first.id);
    expect(second.isPrimary).toBe(true);
    expect(await contactRows(id, "personal_email")).toHaveLength(1);
  });

  it("the report finds drift that cannot be prevented, and repair fixes what has one right answer", async () => {
    const mgr = await fx((c) => makeEmployee(c, a, { unit: eng }));
    const wrongMgr = await fx((c) => makeEmployee(c, a, { unit: eng }));
    const worker = await fx((c) => makeEmployee(c, a, { unit: eng, manager: wrongMgr }));
    await fx((c) => c.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1,$2,$3,'direct')", [a, worker, mgr]));
    const noLine = await fx((c) => makeEmployee(c, a, { unit: eng, manager: mgr }));
    // department and email drifted while the triggers did not exist (what the older data looked like). The owner
    // connection switches the two triggers off inside one transaction, so no other test ever sees them off.
    const drifted = await fx((c) => makeEmployee(c, a, { unit: eng }));
    await fx((c) => c.query("INSERT INTO employee_contacts (company_id, employee_id, contact_type, value, is_primary) VALUES ($1,$2,'business_email','real@example.com',true)", [a, drifted]));
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('request.jwt.claims', '{\"is_service\": true}', true)");
      await client.query("ALTER TABLE employees DISABLE TRIGGER trg_employee_05_canonical_text");
      await client.query("ALTER TABLE employees DISABLE TRIGGER trg_employee_60_to_contact");
      await client.query("UPDATE employees SET department = 'Old Name', email = 'stale@example.com' WHERE id = $1", [drifted]);
      await client.query("ALTER TABLE employees ENABLE TRIGGER trg_employee_05_canonical_text");
      await client.query("ALTER TABLE employees ENABLE TRIGGER trg_employee_60_to_contact");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    expect((await check("manager_differs_from_reporting_line")).samples.map((s) => s.employeeId)).toContain(worker);
    expect((await check("manager_without_reporting_line")).samples.map((s) => s.employeeId)).toContain(noLine);
    expect((await check("department_differs_from_org_unit")).samples.map((s) => s.employeeId)).toContain(drifted);
    expect((await check("email_differs_from_contact")).samples.map((s) => s.employeeId)).toContain(drifted);

    const result = await service.repair(hr);
    expect(result.repaired.managerFixed).toBeGreaterThanOrEqual(1);
    expect(result.repaired.reportingLinesCreated).toBeGreaterThanOrEqual(1);
    expect((await emp(worker)).manager_id).toBe(mgr);
    expect((await emp(drifted)).department).toBe("Engineering");
    expect((await emp(drifted)).email).toBe("real@example.com");
    const rel = await fx((c) => c.query("SELECT manager_employee_id FROM org_relationships WHERE employee_id = $1 AND relationship_type = 'direct' AND status = 'active'", [noLine]));
    expect(rel.rows[0].manager_employee_id).toBe(mgr);

    for (const id of ["department_differs_from_org_unit", "email_differs_from_contact", "manager_differs_from_reporting_line", "manager_without_reporting_line"]) {
      expect(result.report.checks.find((x) => x.id === id)!.count).toBe(0);
    }
    expect(result.report.fixableIssues).toBe(0);
  });

  it("reports dates and pay set-up problems without touching them", async () => {
    const noDate = await fx((c) => makeEmployee(c, a, { status: "terminated" }));
    const active = await fx((c) => makeEmployee(c, a));
    expect((await check("terminated_without_date")).samples.map((s) => s.employeeId)).toContain(noDate);
    expect((await check("no_current_salary")).samples.map((s) => s.employeeId)).toContain(active);
    expect((await check("no_payment_account")).samples.map((s) => s.employeeId)).toContain(active);
    await service.repair(hr);
    expect((await emp(noDate)).termination_date).toBeNull();
  });

  it("never counts another company's employees", async () => {
    const other = await fx((c) => makeEmployee(c, b, { status: "terminated" }));
    const found = await check("terminated_without_date");
    expect(found.samples.map((s) => s.employeeId)).not.toContain(other);
    const row = await emp(other);
    await service.repair(hr);
    expect((await emp(other)).updated_at).toEqual(row.updated_at);
  });

  it("only HR with manage-all can open or run it", async () => {
    await expect(service.getReport(plain)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.repair(plain)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("every check has a unique id and runs without a SQL error", async () => {
    const ids = CONSISTENCY_CHECKS.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const report = await service.getReport(hr);
    expect(report.checks).toHaveLength(CONSISTENCY_CHECKS.length);
    expect(report.totalIssues).toBe(report.checks.reduce((t, x) => t + x.count, 0));
  });
});
