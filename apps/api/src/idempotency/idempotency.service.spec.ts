import { Pool } from "pg";
import { ConflictException } from "@nestjs/common";
import { IdempotencyService, hashRequest } from "./idempotency.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const SVC: RequestClaims = { is_platform_admin: true, company_id: null, sub: "idempotency-fixtures" };

describe("IdempotencyService (SEC-10)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: IdempotencyService;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    svc = new IdempotencyService();
    const stamp = Date.now();
    const mk = (n: string) =>
      db.withClaims(SVC, async (c) => {
        const r = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Idem ${n} ${stamp}`, `idem-${n}-${stamp}`]);
        return r.rows[0].id as string;
      });
    companyA = await mk("a");
    companyB = await mk("b");
  });

  afterAll(async () => {
    await db.withClaims(SVC, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyA, companyB]]));
    await pool.end();
  });

  const claimsFor = (companyId: string): RequestClaims => ({ is_platform_admin: false, company_id: companyId, sub: "user-1" });

  it("hashes requests independent of key order", () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it("runs the work once and replays the stored result on a retry", async () => {
    let runs = 0;
    const input = { companyId: companyA, scope: "payroll.finalize", key: `key-${Date.now()}-aaaa`, request: { runId: "r1" } };
    const work = async () => ({ finalized: true, n: ++runs });

    const first = await db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, work));
    const second = await db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, work));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ finalized: true, n: 1 });
    expect(runs).toBe(1);
  });

  it("rejects the same key reused for a different request", async () => {
    const key = `key-${Date.now()}-bbbb`;
    const base = { companyId: companyA, scope: "payment.release", key };
    await db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), { ...base, request: { amount: 100 } }, async () => "ok"));
    await expect(
      db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), { ...base, request: { amount: 999 } }, async () => "ok"))
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not record the key when the work fails (the retry can run it for real)", async () => {
    const input = { companyId: companyA, scope: "import.commit", key: `key-${Date.now()}-cccc`, request: { f: 1 } };
    await expect(
      db.withClaims(claimsFor(companyA), (c) =>
        svc.execute(c, claimsFor(companyA), input, async () => {
          throw new Error("boom");
        })
      )
    ).rejects.toThrow("boom");
    const retry = await db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, async () => "done"));
    expect(retry).toEqual({ result: "done", replayed: false });
  });

  it("serializes two concurrent requests with the same key: the work runs once", async () => {
    let runs = 0;
    const input = { companyId: companyA, scope: "hire.complete", key: `key-${Date.now()}-dddd`, request: { h: 1 } };
    const slow = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 300));
      return { id: "emp-1" };
    };
    const [x, y] = await Promise.all([
      db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, slow)),
      db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, slow)),
    ]);
    expect(runs).toBe(1);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(x.result).toEqual(y.result);
  });

  it("is scoped per company: the same key in another tenant is independent, and tenants cannot read each other's rows", async () => {
    const key = `key-${Date.now()}-eeee`;
    const a = await db.withClaims(claimsFor(companyA), (c) =>
      svc.execute(c, claimsFor(companyA), { companyId: companyA, scope: "s", key, request: 1 }, async () => "A")
    );
    const b = await db.withClaims(claimsFor(companyB), (c) =>
      svc.execute(c, claimsFor(companyB), { companyId: companyB, scope: "s", key, request: 1 }, async () => "B")
    );
    expect(a.result).toBe("A");
    expect(b).toEqual({ result: "B", replayed: false });
    const visibleToB = await db.withClaims(claimsFor(companyB), (c) => c.query("SELECT company_id FROM idempotency_keys WHERE key = $1", [key]));
    expect(visibleToB.rows.every((r) => r.company_id === companyB)).toBe(true);
  });

  it("purges expired keys and lets an expired key be reused", async () => {
    const key = `key-${Date.now()}-ffff`;
    const input = { companyId: companyA, scope: "s2", key, request: 1 };
    await db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, async () => 1));
    await db.withClaims(SVC, (c) => c.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE key = $1", [key]));
    const again = await db.withClaims(claimsFor(companyA), (c) => svc.execute(c, claimsFor(companyA), input, async () => 2));
    expect(again).toEqual({ result: 2, replayed: false });
    await db.withClaims(SVC, (c) => c.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE key = $1", [key]));
    const removed = await db.withClaims(SVC, (c) => svc.purgeExpired(c));
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});
