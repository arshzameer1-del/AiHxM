import { Pool } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "./employees.service";
import { PersonsService } from "./persons.service";
import { PersonDirectoryService } from "./person-directory.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "identity-step4-fixtures" };
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);

/**
 * Gap Register EMP-01..EMP-06 (Step 4A/4B): canonical person, employment
 * periods, effective-dated versions, as-of reads, catalog-backed status.
 */
describe("Identity & employment model (EMP-01..06)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let directory: PersonDirectoryService;
  let companyId: string;
  let hr: RequestClaims;
  let lm: RequestClaims;
  const today = new Date();

  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.withClaims(FIXTURE, async (c) => (await c.query(text, params)).rows as T[]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    directory = new PersonDirectoryService(db, rbac, ent, audit, new PersonsService());
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Ident ${stamp}`, `ident-${stamp}`])).rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [companyId]);
      const mk = async (label: string, role: string) => {
        const u = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`id-${label}-${stamp}@example.com`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u, companyId, role]);
        return u as string;
      };
      hr = { sub: await mk("hr", "hr_admin"), company_id: companyId, is_platform_admin: false };
      lm = { sub: await mk("lm", "line_manager"), company_id: companyId, is_platform_admin: false };
      await c.query(
        `INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label) VALUES
           ($1,'employment_status','suspended','Suspended'), ($1,'marital_status','single','Single'), ($1,'marital_status','married','Married')`,
        [companyId]
      );
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  const insertEmp = (num: string, first: string, last: string, extra: { cnic?: string; joined?: string } = {}) =>
    sql<{ id: string; person_id: string; employment_id: string }>(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, cnic, date_of_joining)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE)) RETURNING id, person_id, employment_id`,
      [companyId, num, first, last, extra.cnic ?? null, extra.joined ?? null]
    ).then((r) => r[0]);

  it("EMP-01/02: an employee inserted without a person gets one, plus employment period 1 and first versions", async () => {
    const e = await insertEmp("S4-1", "Amna", "Khan");
    expect(e.person_id).toBeTruthy();
    expect(e.employment_id).toBeTruthy();
    const [p] = await sql("SELECT first_name, last_name, full_name FROM persons WHERE id = $1", [e.person_id]);
    expect(p).toEqual({ first_name: "Amna", last_name: "Khan", full_name: "Amna Khan" });
    const [m] = await sql<{ period_number: number; status: string }>("SELECT period_number, status FROM employments WHERE id = $1", [e.employment_id]);
    expect(m).toEqual({ period_number: 1, status: "active" });
    expect((await sql("SELECT 1 FROM employee_versions WHERE employee_id = $1", [e.id])).length).toBe(1);
    expect((await sql("SELECT 1 FROM employment_versions WHERE employment_id = $1", [e.employment_id])).length).toBe(1);
    expect((await sql("SELECT 1 FROM person_versions WHERE person_id = $1", [e.person_id])).length).toBe(1);
  });

  it("EMP-01: two employee rows with the same CNIC share one person; the second is period 2, linked as a rehire", async () => {
    const first = await insertEmp("S4-2", "Bilal", "Raza", { cnic: "35202-9999999-1", joined: addDays(today, -400) });
    await sql("UPDATE employees SET employment_status='terminated', termination_date=$2 WHERE id=$1", [first.id, addDays(today, -100)]);
    const second = await insertEmp("S4-3", "Bilal", "Raza", { cnic: "35202-9999999-1" });
    expect(second.person_id).toBe(first.person_id);
    const periods = await sql<{ id: string; period_number: number; rehire_of_employment_id: string | null; end_date: string | null }>(
      "SELECT id, period_number, rehire_of_employment_id, end_date FROM employments WHERE person_id = $1 ORDER BY period_number", [first.person_id]);
    expect(periods.map((p) => p.period_number)).toEqual([1, 2]);
    expect(periods[0].end_date).not.toBeNull();
    expect(periods[1].rehire_of_employment_id).toBe(periods[0].id);
    const listed = await directory.employments(hr, first.person_id);
    expect(listed.map((x) => x.status)).toEqual(["ended", "active"]);
  });

  it("EMP-04: reactivating a terminated employee opens a new employment period", async () => {
    const e = await insertEmp("S4-4", "Sana", "Iqbal", { joined: addDays(today, -300) });
    await sql("UPDATE employees SET employment_status='terminated', termination_date=$2 WHERE id=$1", [e.id, addDays(today, -50)]);
    await sql("UPDATE employees SET employment_status='active', termination_date=NULL, termination_reason=NULL WHERE id=$1", [e.id]);
    const periods = await sql<{ period_number: number; status: string; rehire_of_employment_id: string | null }>(
      "SELECT period_number, status, rehire_of_employment_id FROM employments WHERE person_id = $1 ORDER BY period_number", [e.person_id]);
    expect(periods.map((p) => [p.period_number, p.status])).toEqual([[1, "ended"], [2, "active"]]);
    expect(periods[1].rehire_of_employment_id).not.toBeNull();
    const [row] = await sql<{ employment_id: string }>("SELECT employment_id FROM employees WHERE id = $1", [e.id]);
    expect(row.employment_id).not.toBe(e.employment_id);
  });

  it("EMP-01: persons -> employees propagation and employees -> persons write-through, with no drift and no recursion", async () => {
    const e = await insertEmp("S4-5", "Zara", "Ahmed");
    await directory.update(hr, e.person_id, { firstName: "Zaira", maritalStatus: "married" });
    const [viaPerson] = await sql<{ first_name: string; last_name: string; marital_status: string }>("SELECT first_name, last_name, marital_status FROM employees WHERE id = $1", [e.id]);
    expect(viaPerson).toEqual({ first_name: "Zaira", last_name: "Ahmed", marital_status: "married" });

    await sql("UPDATE employees SET last_name = 'Malik' WHERE id = $1", [e.id]);
    const [p] = await sql<{ last_name: string; full_name: string }>("SELECT last_name, full_name FROM persons WHERE id = $1", [e.person_id]);
    expect(p).toEqual({ last_name: "Malik", full_name: "Zaira Malik" });
    expect(await sql("SELECT * FROM app.identity_drift($1)", [companyId])).toEqual([]);
  });

  it("EMP-03: person edits are effective-dated, validated and audited; passport/NTN round-trip", async () => {
    const e = await insertEmp("S4-6", "Hamza", "Sheikh", { joined: addDays(today, -60) });
    await directory.update(hr, e.person_id, { preferredName: "Hammy", placeOfBirth: "Lahore", secondNationality: "British", passportNumber: "AB1234567", passportExpiry: "2031-01-01", ntn: "1234567-8", nationalIdType: "cnic" });
    const v = await directory.get(hr, e.person_id);
    expect(v).toMatchObject({ preferredName: "Hammy", placeOfBirth: "Lahore", passportNumber: "AB1234567", ntn: "1234567-8", passportExpiry: "2031-01-01" });
    const raw = await sql<{ passport_number: string }>("SELECT passport_number FROM persons WHERE id = $1", [e.person_id]);
    if (process.env.FIELD_ENCRYPTION_KEY || raw[0].passport_number.startsWith("enc:v1:")) expect(raw[0].passport_number).not.toBe("AB1234567");

    await directory.update(hr, e.person_id, { title: "Dr", effectiveDate: addDays(today, 0) });
    const hist = await directory.history(hr, e.person_id);
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect(hist[hist.length - 1].title).toBe("Dr");
    await expect(directory.update(hr, e.person_id, { maritalStatus: "divorced-not-in-catalog" })).rejects.toBeInstanceOf(BadRequestException);
    const audits = await sql("SELECT 1 FROM audit_log WHERE action = 'person.update' AND target = $1", [e.person_id]);
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("EMP-03: sensitive identity fields are hidden from callers without sensitive access, and writes need manage", async () => {
    const e = await insertEmp("S4-7", "Noor", "Fatima");
    await expect(directory.update(lm, e.person_id, { title: "Ms" })).rejects.toBeInstanceOf(ForbiddenException);
    const asLm = await directory.get(lm, e.person_id).catch((err) => err);
    if (!(asLm instanceof Error)) {
      expect(asLm).not.toHaveProperty("passportNumber");
      expect(asLm).not.toHaveProperty("cnic");
    } else {
      expect(asLm).toBeInstanceOf(ForbiddenException);
    }
  });

  it("EMP-02: duplicate detection - same CNIC links, different DOB on the same CNIC blocks, same name+DOB without CNIC blocks unless confirmed", async () => {
    const a = await employees.create(hr, { firstName: "Imran", lastName: "Ali", cnic: "35202-1111111-1", dateOfBirth: "1990-05-17" });
    const probe = await directory.duplicates(hr, { cnic: "35202-1111111-1" });
    expect(probe.map((p) => p.matchedOn)).toEqual(["cnic"]);
    await expect(employees.create(hr, { firstName: "Imran", lastName: "Ali", cnic: "35202-1111111-1", dateOfBirth: "1991-01-01" })).rejects.toBeInstanceOf(BadRequestException);

    await employees.create(hr, { firstName: "Kamran", lastName: "Butt", dateOfBirth: "1988-03-03" });
    await expect(employees.create(hr, { firstName: "Kamran", lastName: "Butt", dateOfBirth: "1988-03-03" })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await employees.create(hr, { firstName: "Kamran", lastName: "Butt", dateOfBirth: "1988-03-03", confirmNotDuplicate: true });
    expect(ok.id).toBeTruthy();
    const dup = await directory.duplicates(hr, { firstName: "Kamran", lastName: "Butt", dateOfBirth: "1988-03-03" });
    expect(dup.length).toBeGreaterThanOrEqual(1);
    expect(dup[0].matchedOn).toBe("date_of_birth_and_name");
    expect(a.id).toBeTruthy();
  });

  it("EMP-02: explicit personId links a new employment to an existing person (rehire / second employment)", async () => {
    const base = await insertEmp("S4-8", "Farah", "Naz");
    const e2 = await employees.create(hr, { firstName: "Farah", lastName: "Naz", personId: base.person_id });
    const [row] = await sql<{ person_id: string }>("SELECT person_id FROM employees WHERE id = $1", [e2.id]);
    expect(row.person_id).toBe(base.person_id);
    await expect(employees.create(hr, { firstName: "X", lastName: "Y", personId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("EMP-05: versions are effective-dated and the as-of function answers for any date", async () => {
    const e = await insertEmp("S4-9", "Usman", "Tariq", { joined: addDays(today, -30) });
    await db.withClaims(FIXTURE, async (c) => {
      await c.query("SELECT set_config('app.effective_date', $1, true)", [addDays(today, -10)]);
      await c.query("UPDATE employees SET department = 'Finance', designation = 'Analyst' WHERE id = $1", [e.id]);
    });
    await db.withClaims(FIXTURE, async (c) => {
      await c.query("SELECT set_config('app.effective_date', $1, true)", [addDays(today, -3)]);
      await c.query("UPDATE employees SET department = 'Audit' WHERE id = $1", [e.id]);
    });
    expect((await directory.employeeAsOf(hr, e.id, addDays(today, -20))).department).toBeNull();
    expect((await directory.employeeAsOf(hr, e.id, addDays(today, -10))).department).toBe("Finance");
    expect((await directory.employeeAsOf(hr, e.id, addDays(today, -5))).designation).toBe("Analyst");
    expect((await directory.employeeAsOf(hr, e.id, addDays(today, 0))).department).toBe("Audit");
    await expect(directory.employeeAsOf(hr, e.id, addDays(today, -40))).rejects.toThrow(/No record/);
    await expect(directory.employeeAsOf(hr, e.id, "yesterday")).rejects.toBeInstanceOf(BadRequestException);
    // history never rewrote: three windows, no overlap, no gaps
    const v = await sql<{ valid_from: string; valid_to: string | null }>("SELECT valid_from::text, valid_to::text FROM employee_versions WHERE employee_id = $1 ORDER BY valid_from", [e.id]);
    expect(v.length).toBe(3);
    expect(v[0].valid_to).toBe(addDays(today, -11));
    expect(v[1].valid_to).toBe(addDays(today, -4));
    expect(v[2].valid_to).toBeNull();
  });

  it("EMP-05: workforce-as-of excludes people not yet hired and those already terminated", async () => {
    const w = await insertEmp("S4-10", "Hira", "Asif", { joined: addDays(today, -200) });
    await sql("UPDATE employees SET employment_status='terminated', termination_date=$2 WHERE id=$1", [w.id, addDays(today, -20)]);
    const before = await directory.workforceAsOf(hr, addDays(today, -30));
    const after = await directory.workforceAsOf(hr, addDays(today, -10));
    expect(before.employees.map((x) => x.employeeId)).toContain(w.id);
    expect(after.employees.map((x) => x.employeeId)).not.toContain(w.id);
    const asOf = await directory.employeeAsOf(hr, w.id, addDays(today, -10));
    expect(asOf.employmentStatus).toBe("terminated");
    expect(asOf.terminationDate).toBe(addDays(today, -20));
  });

  it("EMP-06: employment_status accepts system states and active catalog states only", async () => {
    const e = await insertEmp("S4-11", "Rida", "Zafar");
    await sql("UPDATE employees SET employment_status='on_leave' WHERE id=$1", [e.id]);
    await sql("UPDATE employees SET employment_status='suspended', employment_status_reason='disciplinary' WHERE id=$1", [e.id]);
    const [row] = await sql<{ employment_status_catalog_item_id: string | null }>("SELECT employment_status_catalog_item_id FROM employees WHERE id=$1", [e.id]);
    expect(row.employment_status_catalog_item_id).not.toBeNull();
    await expect(sql("UPDATE employees SET employment_status='teleporting' WHERE id=$1", [e.id])).rejects.toThrow(/employment_status/);
    await expect(sql("UPDATE employees SET employment_status='Not A Code' WHERE id=$1", [e.id])).rejects.toThrow();
    await sql("UPDATE hr_reference_catalog_items SET is_active=false WHERE company_id=$1 AND catalog_type='employment_status' AND code='suspended'", [companyId]);
    await expect(sql("UPDATE employees SET employment_status='active' WHERE id=$1", [e.id]).then(() => sql("UPDATE employees SET employment_status='suspended' WHERE id=$1", [e.id]))).rejects.toThrow(/catalog item/);
    await sql("UPDATE hr_reference_catalog_items SET is_active=true WHERE company_id=$1 AND catalog_type='employment_status' AND code='suspended'", [companyId]);
  });

  it("the new history tables are read-only for the application role", async () => {
    await expect(db.withClaims(hr, (c) => c.query("DELETE FROM employee_versions WHERE company_id = $1", [companyId]))).rejects.toThrow(/permission denied/);
    await expect(db.withClaims(hr, (c) => c.query("UPDATE person_versions SET title = 'x' WHERE company_id = $1", [companyId]))).rejects.toThrow(/permission denied/);
  });
});
