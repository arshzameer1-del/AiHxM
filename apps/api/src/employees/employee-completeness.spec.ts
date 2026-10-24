import { Pool, type PoolClient } from "pg";
import { NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { EmployeeCompletenessService } from "./employee-completeness.service";
import { EmployeeContactsService } from "./employee-contacts.service";
import { EmployeeDocumentComplianceService } from "./employee-document-compliance.service";
import { EmployeesService } from "./employees.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-completeness-spec" };
const pdf = { originalname: "cnic.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 test"), size: 13 };

/** BACKLOG53 against real Postgres: the completeness score, what is missing, who may see it, the emergency-contact relationship. */
describe("Profile completeness", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: EmployeeCompletenessService;
  let contacts: EmployeeContactsService;
  let employees: EmployeesService;
  let compliance: EmployeeDocumentComplianceService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let other: RequestClaims;
  let me: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  let n = 0;
  async function makeEmployee(c: PoolClient, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [a, `P ${n}`]);
    return (
      await c.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'K',$3,$4,$5) RETURNING id",
        [a, `CP-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
      )
    ).rows[0].id as string;
  }
  const state = async (claims: RequestClaims) => Object.fromEntries((await svc.forMe(claims)).items.map((i) => [i.key, i.done]));

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const cat = { validateActiveCode: async () => undefined } as never;
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService(), undefined, undefined, undefined, undefined, undefined, cat);
    compliance = new EmployeeDocumentComplianceService(db, rbac, ent, audit, employees, cat, new HrBusinessPolicyService(db, rbac, ent, audit));
    contacts = new EmployeeContactsService(db, rbac, ent, audit, cat);
    svc = new EmployeeCompletenessService(db, employees, compliance);
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`CP ${stamp}`, `cp-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`cp-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
      };
      hr = await mkUser("hr", "hr_admin");
      ess = await mkUser("ess", "employee_self_service");
      other = await mkUser("other", "employee_self_service");
      me = await makeEmployee(c, ess.sub as string);
      await makeEmployee(c, other.sub as string);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("a bare record scores low and every missing item says what to do", async () => {
    const r = await svc.forMe(ess);
    expect(r.employeeId).toBe(me);
    expect(r.totalCount).toBeGreaterThanOrEqual(11);
    expect(r.score).toBeLessThan(30);
    const missing = r.items.filter((i) => !i.done);
    expect(missing.length).toBeGreaterThan(8);
    for (const m of missing) expect(m.hint.length).toBeGreaterThan(5);
    expect(r.items.find((i) => i.key === "photo")?.tab).toBe("documents");
  });

  it("an emergency contact only counts once it says who the person is", async () => {
    await contacts.create(hr, { employeeId: me, contactType: "emergency_contact", value: "0300-1112223", label: "Sana Khan" });
    expect((await state(ess)).emergency_contact).toBe(false);
    await contacts.create(hr, { employeeId: me, contactType: "emergency_contact", value: "0300-9998887", label: "Imran Khan", relationship: "Brother" });
    expect((await state(ess)).emergency_contact).toBe(true);
    const listed = await contacts.list(hr, me);
    expect(listed.find((c) => c.label === "Imran Khan")?.relationship).toBe("Brother");
    // the relationship can be filled in later
    const first = listed.find((c) => c.label === "Sana Khan")!;
    expect((await contacts.update(hr, first.id, { relationship: "Sister" })).relationship).toBe("Sister");
  });

  it("each piece of data that gets added moves the score up", async () => {
    const before = (await svc.forMe(ess)).score;
    await contacts.create(hr, { employeeId: me, contactType: "personal_phone", value: "0321-5550000", isPrimary: true });
    await contacts.create(hr, { employeeId: me, contactType: "personal_email", value: `k-${stamp}@example.com` });
    await fx((c) => c.query("INSERT INTO employee_addresses (company_id, employee_id, address_type, line1, city) VALUES ($1,$2,'permanent','1 Road','Lahore')", [a, me]));
    await fx((c) => c.query("UPDATE employees SET marital_status = 'single', date_of_birth = '1992-02-02', cnic = '35202-1111111-1' WHERE id = $1", [me]));
    await fx((c) => c.query("INSERT INTO employee_statutory_ids (company_id, employee_id, cnic_lifetime) VALUES ($1,$2,true)", [a, me]));
    const s = await state(ess);
    expect(s).toMatchObject({ personal_phone: true, personal_email: true, address: true, marital_status: true, date_of_birth: true, cnic: true, cnic_expiry: true });
    expect((await svc.forMe(ess)).score).toBeGreaterThan(before + 40);
  });

  it("an approved photo counts, a pending one does not", async () => {
    // BACKLOG55: employee photos show at once unless the company asks for HR approval first
    await fx((c) => c.query("INSERT INTO company_appearance (company_id, photo_needs_hr_approval) VALUES ($1, true) ON CONFLICT (company_id) DO UPDATE SET photo_needs_hr_approval = true", [a]));
    const pending = await employees.addOwnDocument(ess, me, "photograph", { ...pdf, originalname: "me.png", mimetype: "image/png" });
    expect((await state(ess)).photo).toBe(false);
    await compliance.review(hr, pending.id, "approved");
    expect((await state(ess)).photo).toBe(true);
  });

  it("the mandatory documents HR chose become one more line", async () => {
    await compliance.setRequired(hr, ["cnic_copy"]);
    const r = await svc.forMe(ess);
    const line = r.items.find((i) => i.key === "mandatory_documents")!;
    expect(line.done).toBe(false);
    expect(line.label).toContain("0 of 1");
    await employees.addDocument(hr, me, "cnic_copy", pdf);
    expect((await svc.forMe(ess)).items.find((i) => i.key === "mandatory_documents")?.done).toBe(true);
  });

  it("HR can read anyone's, a colleague cannot, and a login with no employee record gets a clear error", async () => {
    expect((await svc.forEmployee(hr, me)).employeeId).toBe(me);
    expect((await svc.forEmployee(ess, me)).employeeId).toBe(me);
    await expect(svc.forEmployee(other, me)).rejects.toBeDefined();
    const stray = await fx(async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`cp-stray-${stamp}@example.com`]);
      return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
    });
    await expect(svc.forMe(stray)).rejects.toBeInstanceOf(NotFoundException);
  });
});
