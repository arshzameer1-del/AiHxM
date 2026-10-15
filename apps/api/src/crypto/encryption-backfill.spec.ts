import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EncryptionBackfillService } from "./encryption-backfill.service";
import { fieldCrypto, isEncrypted } from "./field-crypto";

const SVC: RequestClaims = { is_platform_admin: true, company_id: null, sub: "backfill-fixtures" };

describe("EncryptionBackfillService (SEC-02)", () => {
  let pool: Pool;
  let owner: Pool;
  let db: DatabaseService;
  let svc: EncryptionBackfillService;
  let companyId: string;
  let claims: RequestClaims;
  const empIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new EncryptionBackfillService();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    companyId = (await owner.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Backfill ${stamp}`, `backfill-${stamp}`])).rows[0].id;
    claims = { ...SVC, company_id: companyId };
    // legacy PLAINTEXT rows, written straight to the table (as they existed before SEC-02)
    for (let i = 1; i <= 5; i++) {
      const r = await owner.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, cnic, bank_account_number, date_of_birth)
         VALUES ($1, $2, 'L', $3, $4, $5, '1990-05-0${i}') RETURNING id`,
        [companyId, `BF-${i}`, `Row${i}`, `35202-000000${i}-1`, `ACC${i}`]
      );
      empIds.push(r.rows[0].id);
    }
    // one already-clean row, one with nothing sensitive at all
    await owner.query("INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1,'BF-EMPTY','N','S')", [companyId]);
    const pa = await owner.query(
      "INSERT INTO employee_payment_accounts (company_id, employee_id, payment_method, account_number, iban) VALUES ($1,$2,'bank_transfer','PLAINACC','PK00PLAIN') RETURNING id",
      [companyId, empIds[0]]
    );
    void pa;
    await owner.query(
      `INSERT INTO tenant_integrations (company_id, provider_key, enabled, config, previous_secret_value, updated_by)
       VALUES ($1,'webhook',true,'{"url":"https://example.test/hook","signingSecret":"plain-signing-secret"}'::jsonb,'old-plain-secret','fixture')`,
      [companyId]
    );
  });

  afterAll(async () => {
    await owner.query("DELETE FROM companies WHERE id = $1", [companyId]);
    await pool.end();
    await owner.end();
  });

  it("reports the plaintext rows that are pending", async () => {
    const pending = await db.withClaims(claims, async (c) => {
      await fieldCrypto.warm(c, companyId);
      return svc.pendingCounts(c, companyId);
    });
    expect(pending.employees).toBe(5);
    expect(pending.employee_payment_accounts).toBe(1);
    expect(pending.tenant_integrations).toBe(1);
  });

  it("converts in small batches (resumable) until nothing remains, losing no value", async () => {
    const first = await db.withClaims(claims, (c) => svc.runBatch(c, companyId, 2));
    expect(first.employees).toBe(2);
    const mid = await db.withClaims(claims, (c) => svc.pendingCounts(c, companyId));
    expect(mid.employees).toBe(3); // resumable: a later run continues where this stopped

    const { remaining } = await db.withClaims(claims, (c) => svc.runToCompletion(c, companyId, 2));
    expect(Object.values(remaining).every((n) => n === 0)).toBe(true);

    const rows = (await owner.query("SELECT cnic, bank_account_number, date_of_birth, date_of_birth_enc, cnic_bidx FROM employees WHERE id = ANY($1::uuid[]) ORDER BY employee_number", [empIds])).rows;
    rows.forEach((r) => {
      expect(isEncrypted(r.cnic)).toBe(true);
      expect(isEncrypted(r.bank_account_number)).toBe(true);
      expect(isEncrypted(r.date_of_birth_enc)).toBe(true);
      expect(r.date_of_birth).toBeNull();
      expect(r.cnic_bidx).toMatch(/^[0-9a-f]{64}$/);
    });

    // and every value decrypts back to exactly what was there before
    await db.withClaims(claims, (c) => fieldCrypto.warm(c, companyId));
    rows.forEach((r, i) => {
      expect(fieldCrypto.decrypt(companyId, r.cnic)).toBe(`35202-000000${i + 1}-1`);
      expect(fieldCrypto.decrypt(companyId, r.bank_account_number)).toBe(`ACC${i + 1}`);
      expect(fieldCrypto.decrypt(companyId, r.date_of_birth_enc)).toBe(`1990-05-0${i + 1}`);
    });
    const ti = (await owner.query("SELECT config, previous_secret_value FROM tenant_integrations WHERE company_id = $1", [companyId])).rows[0];
    expect(isEncrypted(ti.config.signingSecret)).toBe(true);
    expect(ti.config.url).toBe("https://example.test/hook"); // non-secret fields untouched
    expect(fieldCrypto.decrypt(companyId, ti.config.signingSecret)).toBe("plain-signing-secret");
    expect(fieldCrypto.decrypt(companyId, ti.previous_secret_value)).toBe("old-plain-secret");
    const pa = (await owner.query("SELECT account_number, iban FROM employee_payment_accounts WHERE company_id = $1", [companyId])).rows[0];
    expect(fieldCrypto.decrypt(companyId, pa.account_number)).toBe("PLAINACC");
    expect(fieldCrypto.decrypt(companyId, pa.iban)).toBe("PK00PLAIN");
  });

  it("is idempotent: a second full run changes nothing", async () => {
    const before = (await owner.query("SELECT cnic FROM employees WHERE id = $1", [empIds[0]])).rows[0].cnic;
    const res = await db.withClaims(claims, (c) => svc.runToCompletion(c, companyId));
    expect(Object.values(res.converted).reduce((a, b) => a + b, 0)).toBe(0);
    const after = (await owner.query("SELECT cnic FROM employees WHERE id = $1", [empIds[0]])).rows[0].cnic;
    expect(after).toBe(before); // ciphertext untouched, not re-encrypted
  });
});
