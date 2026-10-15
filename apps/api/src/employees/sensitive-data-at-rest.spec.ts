import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { isEncrypted } from "../crypto/field-crypto";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "at-rest-fixtures" };
const CNIC = "35202-1234567-1";
const BANK = "0123456789012345";
const IBAN = "PK36SCBL0000001123456702";

/**
 * Gap Register SEC-02 — proves the values are really encrypted IN THE
 * DATABASE (raw SQL), still round-trip through the API, are deduplicated via
 * the blind index, and never leak into the append-only audit log.
 */
describe("sensitive data at rest (SEC-02)", () => {
  let pool: Pool;
  let owner: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let accounts: EmployeePaymentAccountsService;
  let companyId: string;
  let claims: RequestClaims;

  const raw = async (sql: string, params: unknown[]) => (await owner.query(sql, params)).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
    db = new DatabaseService(pool);
    const audit = new AuditService();
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    accounts = new EmployeePaymentAccountsService(db, rbac, ent, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`AtRest ${stamp}`, `atrest-${stamp}`]);
      const id = co.rows[0].id as string;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [id]);
      return id;
    });
    const userId = await db.withClaims(FIXTURE, async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`atrest-${stamp}@example.com`]);
      const role = await c.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)", [u.rows[0].id, companyId, role.rows[0].id]);
      return u.rows[0].id as string;
    });
    claims = { is_platform_admin: false, company_id: companyId, sub: userId };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await owner.end();
  });

  it("stores CNIC, bank account and DOB encrypted, yet the API returns them in the clear", async () => {
    const created = await employees.create(claims, {
      firstName: "Ayesha",
      lastName: "Khan",
      cnic: CNIC,
      dateOfBirth: "1991-04-12",
      bankAccountNumber: BANK,
    });
    expect(created).toMatchObject({ cnic: CNIC, dateOfBirth: "1991-04-12", bankAccountNumber: BANK });

    const [row] = await raw("SELECT cnic, bank_account_number, date_of_birth, date_of_birth_enc, cnic_bidx FROM employees WHERE id = $1", [created.id]);
    expect(isEncrypted(row.cnic)).toBe(true);
    expect(isEncrypted(row.bank_account_number)).toBe(true);
    expect(isEncrypted(row.date_of_birth_enc)).toBe(true);
    expect(row.date_of_birth).toBeNull();
    expect(row.cnic_bidx).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("35202");
    expect(JSON.stringify(row)).not.toContain(BANK);
    expect(JSON.stringify(row)).not.toContain("1991");

    const fetched = await employees.get(claims, created.id);
    expect(fetched).toMatchObject({ cnic: CNIC, dateOfBirth: "1991-04-12", bankAccountNumber: BANK });
  });

  it("the shadow person record is encrypted too, and the same CNIC (any formatting) resolves to the same person", async () => {
    const a = await employees.create(claims, { firstName: "Bilal", lastName: "Ahmed", cnic: "42101-7654321-9", dateOfBirth: "1988-01-01" });
    const b = await employees.create(claims, { firstName: "Bilal", lastName: "Ahmed", cnic: "4210176543219" });
    expect(b.personId).toBe(a.personId);
    const [p] = await raw("SELECT cnic, date_of_birth, date_of_birth_enc, cnic_bidx FROM persons WHERE id = $1", [a.personId]);
    expect(isEncrypted(p.cnic)).toBe(true);
    expect(p.date_of_birth).toBeNull();
    expect(isEncrypted(p.date_of_birth_enc)).toBe(true);
  });

  it("an update re-encrypts and keeps decrypting; clearing nothing leaks plaintext", async () => {
    const e = await employees.create(claims, { firstName: "Carla", lastName: "D", cnic: "35201-1111111-1", bankAccountNumber: "111" });
    const upd = await employees.update(claims, e.id, { designation: "Analyst", cnic: "35201-2222222-2" });
    expect(upd.cnic).toBe("35201-2222222-2");
    expect(upd.bankAccountNumber).toBe("111"); // untouched field survives the round trip
    const [row] = await raw("SELECT cnic, bank_account_number FROM employees WHERE id = $1", [e.id]);
    expect(isEncrypted(row.cnic)).toBe(true);
    expect(isEncrypted(row.bank_account_number)).toBe(true);
  });

  it("legacy plaintext rows still read correctly and are encrypted on their next write", async () => {
    const e = await employees.create(claims, { firstName: "Legacy", lastName: "Row" });
    await raw("UPDATE employees SET cnic = '35202-9999999-9', bank_account_number = 'LEGACY123', date_of_birth = '1980-02-02' WHERE id = $1", [e.id]);
    const read = await employees.get(claims, e.id);
    expect(read).toMatchObject({ cnic: "35202-9999999-9", bankAccountNumber: "LEGACY123", dateOfBirth: "1980-02-02" });
    await employees.update(claims, e.id, { designation: "Touched" });
    const [row] = await raw("SELECT cnic, bank_account_number, date_of_birth FROM employees WHERE id = $1", [e.id]);
    expect(isEncrypted(row.cnic)).toBe(true);
    expect(isEncrypted(row.bank_account_number)).toBe(true);
    expect(row.date_of_birth).toBeNull();
  });

  it("payment accounts: account number and IBAN encrypted at rest, audit log holds no plaintext", async () => {
    const e = await employees.create(claims, { firstName: "Dana", lastName: "P" });
    const acct = await accounts.create(claims, {
      employeeId: e.id,
      paymentMethod: "bank_transfer",
      bankName: "Test Bank",
      accountNumber: BANK,
      iban: IBAN,
      isPrimary: true,
    });
    expect(acct).toMatchObject({ accountNumber: BANK, iban: IBAN });
    await accounts.update(claims, acct.id, { accountTitle: "Dana P" }); // writes before/after into audit metadata

    const [row] = await raw("SELECT account_number, iban, account_number_bidx, iban_bidx FROM employee_payment_accounts WHERE id = $1", [acct.id]);
    expect(isEncrypted(row.account_number)).toBe(true);
    expect(isEncrypted(row.iban)).toBe(true);
    expect(row.account_number_bidx).toMatch(/^[0-9a-f]{64}$/);
    expect(row.iban_bidx).toMatch(/^[0-9a-f]{64}$/);

    const audit = await raw("SELECT metadata::text AS m FROM audit_log WHERE company_id = $1 AND action LIKE 'employee_payment_account.%'", [companyId]);
    expect(audit.length).toBeGreaterThanOrEqual(2);
    for (const a of audit) {
      expect(a.m).not.toContain(BANK);
      expect(a.m).not.toContain(IBAN);
    }
  });

  it("no plaintext identifier appears anywhere in this tenant's audit log", async () => {
    const all = await raw("SELECT metadata::text AS m, coalesce(before_data::text,'') AS b, coalesce(after_data::text,'') AS a FROM audit_log WHERE company_id = $1", [companyId]);
    const blob = JSON.stringify(all);
    for (const secret of ["35202-1234567-1", "42101-7654321-9", "35201-2222222-2", BANK, IBAN]) expect(blob).not.toContain(secret);
  });

  it("another tenant cannot decrypt (or even see) these rows", async () => {
    const stamp = Date.now();
    const other = await db.withClaims(FIXTURE, async (c) => (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Other ${stamp}`, `other-${stamp}`])).rows[0].id as string);
    const seen = await db.withClaims({ is_platform_admin: false, company_id: other, sub: "x" }, (c) => c.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1", [companyId]));
    expect(seen.rows[0].n).toBe(0);
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [other]));
  });
});
