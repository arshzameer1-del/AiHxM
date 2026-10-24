import { Pool, type PoolClient } from "pg";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { EmployeeDisciplinaryService } from "./employee-disciplinary.service";
import { EmployeeLanguagesService } from "./employee-languages.service";
import { EmployeeMedicalInfoService } from "./employee-medical-info.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-sensitive-spec" };

/** BACKLOG54 against real Postgres: languages, medical information and disciplinary records, and who may see them. */
describe("Languages, medical information and disciplinary records", () => {
  let pool: Pool;
  let db: DatabaseService;
  let languages: EmployeeLanguagesService;
  let medical: EmployeeMedicalInfoService;
  let disciplinary: EmployeeDisciplinaryService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let colleague: RequestClaims;
  let manager: RequestClaims;
  let me: string;
  let notified: Array<{ userAccountIds: string[]; title: string }> = [];
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  let n = 0;
  async function makeEmployee(c: PoolClient, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [a, `P ${n}`]);
    return (
      await c.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'K',$3,$4,$5) RETURNING id",
        [a, `SR-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    languages = new EmployeeLanguagesService(db, rbac, ent, audit);
    medical = new EmployeeMedicalInfoService(db, rbac, ent, audit);
    const inbox = { notify: async (i: { userAccountIds: string[]; title: string }) => void notified.push(i) } as never;
    disciplinary = new EmployeeDisciplinaryService(db, rbac, ent, audit, inbox);
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`SR ${stamp}`, `sr-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`sr-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
      };
      hr = await mkUser("hr", "hr_admin");
      ess = await mkUser("ess", "employee_self_service");
      colleague = await mkUser("col", "employee_self_service");
      manager = await mkUser("mgr", "line_manager");
      me = await makeEmployee(c, ess.sub as string);
      await makeEmployee(c, colleague.sub as string);
      await makeEmployee(c, manager.sub as string);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("only hr_admin holds the four new permissions", async () => {
    const r = await fx((c) =>
      c.query(
        `SELECT p.key, array_agg(r.key ORDER BY r.key) AS roles FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id
           JOIN roles r ON r.id = rp.role_id WHERE (p.key LIKE 'employee.medical.%' OR p.key LIKE 'employee.disciplinary.%') AND r.key IN ('hr_admin','line_manager','employee_self_service','ess_portal','system_admin','payroll_approver') GROUP BY p.key`
      )
    );
    expect(r.rowCount).toBe(4);
    for (const row of r.rows) expect(row.roles).toEqual(["hr_admin"]);
  });

  it("HR keeps a language list; one entry per language; the employee sees their own, a colleague does not", async () => {
    const urdu = await languages.create(hr, { employeeId: me, language: "Urdu", spokenLevel: "native", writtenLevel: "fluent" });
    expect(urdu).toMatchObject({ language: "Urdu", spokenLevel: "native", writtenLevel: "fluent" });
    await expect(languages.create(hr, { employeeId: me, language: " urdu " })).rejects.toBeInstanceOf(ConflictException);
    await languages.create(hr, { employeeId: me, language: "English" });
    expect((await languages.list(ess, me)).map((l) => l.language)).toEqual(["Urdu", "English"]);
    await expect(languages.list(colleague, me)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(languages.create(ess, { employeeId: me, language: "French" })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await languages.update(hr, urdu.id, { writtenLevel: "native" })).writtenLevel).toBe("native");
    await languages.remove(hr, urdu.id);
    expect((await languages.list(hr, me)).map((l) => l.language)).toEqual(["English"]);
  });

  it("medical information: the person and HR can read it, nobody else - not even a line manager", async () => {
    await medical.upsert(hr, { employeeId: me, bloodGroup: "O+", allergies: "Penicillin", chronicConditions: "Asthma" });
    const own = await medical.get(ess, me);
    expect(own).toMatchObject({ bloodGroup: "O+", allergies: "Penicillin", chronicConditions: "Asthma", isOwn: true });
    expect((await medical.get(hr, me)).isOwn).toBe(false);
    await expect(medical.get(colleague, me)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(medical.get(manager, me)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(medical.upsert(manager, { employeeId: me, allergies: "none" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(medical.upsert(colleague, { employeeId: me, allergies: "none" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("medical free text is encrypted in the table, the employee can update their own, and a field left out is unchanged", async () => {
    const raw = await fx((c) => c.query("SELECT allergies, chronic_conditions, blood_group FROM employee_medical_info WHERE employee_id = $1", [me]));
    expect(raw.rows[0].blood_group).toBe("O+");
    expect(raw.rows[0].allergies).not.toContain("Penicillin");
    expect(raw.rows[0].chronic_conditions).not.toContain("Asthma");
    const after = await medical.upsert(ess, { employeeId: me, emergencyMedicalNote: "Inhaler in the bag", allergies: null });
    expect(after).toMatchObject({ allergies: null, chronicConditions: "Asthma", emergencyMedicalNote: "Inhaler in the bag", bloodGroup: "O+" });
    // the audit trail names the fields, never what was written
    const audit = await fx((c) => c.query("SELECT metadata FROM audit_log WHERE action = 'employee_medical_info.update' AND target = $1 ORDER BY created_at DESC LIMIT 1", [me]));
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain("Inhaler");
    expect(audit.rows[0].metadata.bySelf).toBe(true);
  });

  it("disciplinary records: HR issues, the employee is told, reads and acknowledges; others cannot see them", async () => {
    notified = [];
    const rec = await disciplinary.create(hr, {
      employeeId: me,
      recordType: "written_warning",
      subject: "Repeated late arrival",
      description: "Late on six days in March without notice.",
      incidentDate: "2026-03-20",
      actionTaken: "Written warning; review in 3 months",
    });
    expect(rec).toMatchObject({ recordType: "written_warning", status: "active", acknowledgedAt: null });
    expect(notified).toHaveLength(1);
    expect(notified[0].userAccountIds).toEqual([ess.sub]);
    expect(notified[0].title).toContain("written warning");

    expect((await disciplinary.list(ess, me)).map((r) => r.subject)).toEqual(["Repeated late arrival"]);
    expect(await disciplinary.list(hr, me)).toHaveLength(1);
    await expect(disciplinary.list(colleague, me)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(disciplinary.list(manager, me)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(disciplinary.create(ess, { employeeId: me, recordType: "other", subject: "self", description: "self issued" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(disciplinary.create(manager, { employeeId: me, recordType: "other", subject: "x", description: "y" })).rejects.toBeInstanceOf(ForbiddenException);

    // only the person can acknowledge - not HR, not a colleague - and only once
    await expect(disciplinary.acknowledge(hr, rec.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(disciplinary.acknowledge(colleague, rec.id)).rejects.toBeInstanceOf(ForbiddenException);
    const ack = await disciplinary.acknowledge(ess, rec.id, "I was stuck in traffic; I will leave earlier.");
    expect(ack.acknowledgedAt).not.toBeNull();
    expect(ack.employeeComment).toContain("traffic");
    await expect(disciplinary.acknowledge(ess, rec.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("withdrawing keeps the record and says why; the wording never reaches the audit log", async () => {
    const [rec] = await disciplinary.list(hr, me);
    await expect(disciplinary.withdraw(ess, rec.id, "no")).rejects.toBeInstanceOf(ForbiddenException);
    const w = await disciplinary.withdraw(hr, rec.id, "Late arrivals were approved by the manager");
    expect(w).toMatchObject({ status: "withdrawn", withdrawnReason: "Late arrivals were approved by the manager" });
    await expect(disciplinary.withdraw(hr, rec.id, "again")).rejects.toBeInstanceOf(ConflictException);
    expect((await disciplinary.list(ess, me))[0].status).toBe("withdrawn");
    const audit = await fx((c) => c.query("SELECT metadata FROM audit_log WHERE action = 'employee_disciplinary.create' AND target = $1", [rec.id]));
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain("six days");
    // no way to delete through the app role
    await expect(fx((c) => c.query("SET LOCAL ROLE app_role").then(() => c.query("DELETE FROM employee_disciplinary_records WHERE id = $1", [rec.id])))).rejects.toBeDefined();
  });

  it("a record belongs to its company: another tenant's HR cannot reach it", async () => {
    const other = await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`SR2 ${stamp}`, `sr2-${stamp}`]);
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [r.rows[0].id]);
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`sr-x-${stamp}@example.com`]);
      const role = await c.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, r.rows[0].id, role.rows[0].id]);
      return { is_platform_admin: false, company_id: r.rows[0].id, sub: u.rows[0].id } as RequestClaims;
    });
    expect(await disciplinary.list(other, me)).toEqual([]);
    await expect(medical.get(other, me)).rejects.toBeDefined();
  });
});
