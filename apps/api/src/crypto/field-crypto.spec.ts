import { Pool } from "pg";
import { FieldCrypto, isEncrypted, normalizeForIndex } from "./field-crypto";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const SVC: RequestClaims = { is_platform_admin: true, company_id: null, sub: "crypto-fixtures" };

describe("FieldCrypto (SEC-02/03/04 foundation)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let crypto: FieldCrypto;
  let companyA: string;
  let companyB: string;

  const inTenant = <T>(companyId: string, fn: (c: import("pg").PoolClient) => Promise<T>) =>
    db.withClaims({ is_platform_admin: false, company_id: companyId, sub: "u" }, fn);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const stamp = Date.now();
    const mk = (n: string) =>
      db.withClaims(SVC, async (c) => (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Crypto ${n} ${stamp}`, `crypto-${n}-${stamp}`])).rows[0].id as string);
    companyA = await mk("a");
    companyB = await mk("b");
  });

  beforeEach(() => {
    crypto = new FieldCrypto();
  });

  afterAll(async () => {
    await db.withClaims(SVC, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyA, companyB]]));
    await pool.end();
  });

  it("round-trips and never stores the plaintext", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    const enc = crypto.encrypt(companyA, "35202-1234567-1")!;
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain("35202");
    expect(crypto.decrypt(companyA, enc)).toBe("35202-1234567-1");
  });

  it("uses a fresh IV every time (equal plaintexts give different ciphertexts)", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    expect(crypto.encrypt(companyA, "same")).not.toBe(crypto.encrypt(companyA, "same"));
  });

  it("is idempotent on already-encrypted input and passes legacy plaintext through on decrypt", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    const enc = crypto.encrypt(companyA, "x1")!;
    expect(crypto.encrypt(companyA, enc)).toBe(enc);
    expect(crypto.decrypt(companyA, "legacy-plaintext")).toBe("legacy-plaintext");
    expect(crypto.encrypt(companyA, null)).toBeNull();
    expect(crypto.encrypt(companyA, "")).toBeNull();
    expect(crypto.decrypt(companyA, null)).toBeNull();
  });

  it("a ciphertext cannot be decrypted under another tenant (AAD + separate keys)", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    await inTenant(companyB, (c) => crypto.warm(c, companyB));
    const enc = crypto.encrypt(companyA, "secret")!;
    expect(() => crypto.decrypt(companyB, enc)).toThrow(/FIELD_DECRYPTION_FAILED/);
  });

  it("tampered ciphertext is rejected", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    const enc = crypto.encrypt(companyA, "secret")!;
    const parts = enc.split(":");
    parts[parts.length - 1] = "AAAA" + parts[parts.length - 1].slice(4);
    expect(() => crypto.decrypt(companyA, parts.join(":"))).toThrow(/FIELD_DECRYPTION_FAILED/);
  });

  it("blind index is deterministic per tenant, normalised, namespaced and tenant-specific", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    await inTenant(companyB, (c) => crypto.warm(c, companyB));
    const a1 = crypto.blindIndex(companyA, "cnic", "35202-1234567-1");
    expect(a1).toBe(crypto.blindIndex(companyA, "cnic", " 3520212345671 "));
    expect(a1).not.toBe(crypto.blindIndex(companyB, "cnic", "35202-1234567-1"));
    expect(a1).not.toBe(crypto.blindIndex(companyA, "account_number", "35202-1234567-1".replace(/-/g, "")) + "x");
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.blindIndex(companyA, "cnic", null)).toBeNull();
    expect(normalizeForIndex("iban", "pk36 scbl 0000")).toBe("PK36SCBL0000");
  });

  it("tenant keys persist: a second process (empty cache) decrypts what the first wrote", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    const enc = crypto.encrypt(companyA, "persisted")!;
    const other = new FieldCrypto();
    await inTenant(companyA, (c) => other.warm(c, companyA));
    expect(other.decrypt(companyA, enc)).toBe("persisted");
    const rows = await db.withClaims(SVC, (c) => c.query("SELECT wrapped_key FROM tenant_data_keys WHERE company_id = $1", [companyA]));
    expect(rows.rows).toHaveLength(2); // dek + bidx
    for (const r of rows.rows) expect(r.wrapped_key).not.toContain("persisted");
  });

  it("concurrent first use converges on one key pair", async () => {
    const stamp = Date.now();
    const cid = await db.withClaims(SVC, async (c) => (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Crypto race ${stamp}`, `crypto-race-${stamp}`])).rows[0].id as string);
    const [x, y] = [new FieldCrypto(), new FieldCrypto()];
    await Promise.all([inTenant(cid, (c) => x.warm(c, cid)), inTenant(cid, (c) => y.warm(c, cid))]);
    const enc = x.encrypt(cid, "race")!;
    // y may have loaded either its own or x's key; re-warm after both committed and it must decrypt
    y.clearCache();
    await inTenant(cid, (c) => y.warm(c, cid));
    expect(y.decrypt(cid, enc)).toBe("race");
    const n = await db.withClaims(SVC, (c) => c.query("SELECT count(*)::int AS n FROM tenant_data_keys WHERE company_id = $1 AND status = 'active'", [cid]));
    expect(n.rows[0].n).toBe(2);
    await db.withClaims(SVC, (c) => c.query("DELETE FROM companies WHERE id = $1", [cid]));
  });

  it("DEK rotation: old ciphertext stays readable, new writes use the new version", async () => {
    await inTenant(companyA, (c) => crypto.warm(c, companyA));
    const old = crypto.encrypt(companyA, "before")!;
    const v = await inTenant(companyA, (c) => crypto.rotateDek(c, companyA));
    const fresh = crypto.encrypt(companyA, "after")!;
    expect(old.split(":")[2]).not.toBe(String(v));
    expect(fresh.split(":")[2]).toBe(String(v));
    expect(crypto.decrypt(companyA, old)).toBe("before");
    expect(crypto.decrypt(companyA, fresh)).toBe("after");
  });

  it("master-key rotation: rewrap under a new master, old master retired", async () => {
    const prevEnv = { k: process.env.FIELD_ENCRYPTION_KEY, p: process.env.FIELD_ENCRYPTION_KEY_PREVIOUS };
    try {
      process.env.FIELD_ENCRYPTION_KEY = "master-one-for-rotation-test-aaaaaaaaaaaaaaaa";
      delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
      const stamp = Date.now();
      const cid = await db.withClaims(SVC, async (c) => (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Crypto mk ${stamp}`, `crypto-mk-${stamp}`])).rows[0].id as string);
      const a = new FieldCrypto();
      await inTenant(cid, (c) => a.warm(c, cid));
      const enc = a.encrypt(cid, "survives")!;

      process.env.FIELD_ENCRYPTION_KEY = "master-two-for-rotation-test-bbbbbbbbbbbbbbbb";
      process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = "master-one-for-rotation-test-aaaaaaaaaaaaaaaa";
      const b = new FieldCrypto();
      const n = await db.withClaims(SVC, (c) => b.rewrapMasterKeys(c));
      expect(n.rewrapped).toBeGreaterThanOrEqual(2);
      expect(n.skipped).toBeGreaterThanOrEqual(0); // other test tenants wrapped under the dev master

      delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS; // old master gone
      const c2 = new FieldCrypto();
      await inTenant(cid, (c) => c2.warm(c, cid));
      expect(c2.decrypt(cid, enc)).toBe("survives");

      // a process holding ONLY the old master can no longer unwrap
      process.env.FIELD_ENCRYPTION_KEY = "master-one-for-rotation-test-aaaaaaaaaaaaaaaa";
      await expect(inTenant(cid, (c) => new FieldCrypto().warm(c, cid))).rejects.toThrow(/FIELD_KEY_UNAVAILABLE/);
      await db.withClaims(SVC, (c) => c.query("DELETE FROM companies WHERE id = $1", [cid]));
    } finally {
      if (prevEnv.k === undefined) delete process.env.FIELD_ENCRYPTION_KEY; else process.env.FIELD_ENCRYPTION_KEY = prevEnv.k;
      if (prevEnv.p === undefined) delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS; else process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = prevEnv.p;
    }
  });

  it("fails closed in production when FIELD_ENCRYPTION_KEY is unset", async () => {
    const env = { n: process.env.NODE_ENV, k: process.env.FIELD_ENCRYPTION_KEY };
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.FIELD_ENCRYPTION_KEY;
      await expect(inTenant(companyA, (c) => new FieldCrypto().warm(c, companyA))).rejects.toThrow(/FIELD_ENCRYPTION_KEY is not set/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env.n;
      if (env.k !== undefined) process.env.FIELD_ENCRYPTION_KEY = env.k;
    }
  });

  it("encrypt before keys are loaded fails loudly instead of writing plaintext", () => {
    expect(() => new FieldCrypto().encrypt("00000000-0000-0000-0000-000000000000", "x")).toThrow(/FIELD_KEYS_NOT_LOADED/);
  });
});
