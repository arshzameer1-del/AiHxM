import { Pool } from "pg";
import { BackgroundJobsService, jobBackoffSeconds } from "./background-jobs.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const SVC: RequestClaims = { is_platform_admin: false, is_service: true, company_id: null, sub: "jobs-worker" };

describe("BackgroundJobsService (PLT-03)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let jobs: BackgroundJobsService;
  let companyId: string;
  let otherCompanyId: string;
  const type = `spec.${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    jobs = new BackgroundJobsService();
    const stamp = Date.now();
    const mk = (n: string) =>
      db.withClaims(SVC, async (c) => {
        const r = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Jobs ${n} ${stamp}`, `jobs-${n}-${stamp}`]);
        return r.rows[0].id as string;
      });
    companyId = await mk("a");
    otherCompanyId = await mk("b");
  });

  afterAll(async () => {
    await db.withClaims(SVC, (c) => c.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });

  it("backs off exponentially, capped at an hour", () => {
    expect([1, 2, 3, 4].map(jobBackoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(jobBackoffSeconds(50)).toBe(3600);
  });

  it("enqueues idempotently: the same key returns the same job", async () => {
    const a = await db.withClaims(SVC, (c) => jobs.enqueue(c, SVC, { companyId, jobType: type, idempotencyKey: "k1", payload: { n: 1 } }));
    const b = await db.withClaims(SVC, (c) => jobs.enqueue(c, SVC, { companyId, jobType: type, idempotencyKey: "k1", payload: { n: 2 } }));
    expect(b.id).toBe(a.id);
    expect(b.payload).toEqual({ n: 1 });
  });

  it("claims, reports progress and completes", async () => {
    const jt = `${type}.happy`;
    const queued = await db.withClaims(SVC, (c) => jobs.enqueue(c, SVC, { companyId, jobType: jt }));
    const claimed = await db.withClaims(SVC, (c) => jobs.claimNext(c, "w1", { jobTypes: [jt] }));
    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    await db.withClaims(SVC, (c) => jobs.reportProgress(c, queued.id, 60, "halfway-ish"));
    const done = await db.withClaims(SVC, (c) => jobs.complete(c, queued.id, { rows: 10 }));
    expect(done).toMatchObject({ status: "completed", progressPercent: 100, result: { rows: 10 } });
    expect(await db.withClaims(SVC, (c) => jobs.claimNext(c, "w1", { jobTypes: [jt] }))).toBeNull();
  });

  it("two concurrent workers never claim the same job", async () => {
    const jt = `${type}.race`;
    await db.withClaims(SVC, async (c) => {
      for (let i = 0; i < 6; i++) await jobs.enqueue(c, SVC, { companyId, jobType: jt, idempotencyKey: `r${i}` });
    });
    const claimLoop = async (w: string) => {
      const got: string[] = [];
      for (;;) {
        const j = await db.withClaims(SVC, (c) => jobs.claimNext(c, w, { jobTypes: [jt] }));
        if (!j) return got;
        got.push(j.id);
      }
    };
    const [a, b] = await Promise.all([claimLoop("wa"), claimLoop("wb")]);
    expect(a.length + b.length).toBe(6);
    expect(new Set([...a, ...b]).size).toBe(6);
  });

  it("retries with backoff, then dead-letters when attempts run out; retry() revives it", async () => {
    const jt = `${type}.fail`;
    const j = await db.withClaims(SVC, (c) => jobs.enqueue(c, SVC, { companyId, jobType: jt, maxAttempts: 2 }));
    await db.withClaims(SVC, (c) => jobs.claimNext(c, "w", { jobTypes: [jt] }));
    const first = await db.withClaims(SVC, (c) => jobs.fail(c, j.id, "network down"));
    expect(first).toMatchObject({ status: "queued", deadLettered: false, attempts: 1 });
    expect(new Date(first.runAfter).getTime()).toBeGreaterThan(Date.now());
    // not claimable until backoff elapses
    expect(await db.withClaims(SVC, (c) => jobs.claimNext(c, "w", { jobTypes: [jt] }))).toBeNull();

    await db.withClaims(SVC, (c) => c.query("UPDATE background_jobs SET run_after = now() WHERE id = $1", [j.id]));
    await db.withClaims(SVC, (c) => jobs.claimNext(c, "w", { jobTypes: [jt] }));
    const dead = await db.withClaims(SVC, (c) => jobs.fail(c, j.id, "still down"));
    expect(dead).toMatchObject({ status: "failed", deadLettered: true, lastError: "still down" });

    const revived = await db.withClaims(SVC, (c) => jobs.retry(c, j.id));
    expect(revived).toMatchObject({ status: "queued", deadLettered: false, attempts: 0 });
  });

  it("re-leases a job whose worker crashed (expired lease)", async () => {
    const jt = `${type}.lease`;
    const j = await db.withClaims(SVC, (c) => jobs.enqueue(c, SVC, { companyId, jobType: jt }));
    await db.withClaims(SVC, (c) => jobs.claimNext(c, "crashy", { jobTypes: [jt], leaseSeconds: 60 }));
    expect(await db.withClaims(SVC, (c) => jobs.claimNext(c, "other", { jobTypes: [jt] }))).toBeNull();
    await db.withClaims(SVC, (c) => c.query("UPDATE background_jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [j.id]));
    const taken = await db.withClaims(SVC, (c) => jobs.claimNext(c, "other", { jobTypes: [jt] }));
    expect(taken).toMatchObject({ id: j.id, attempts: 2 });
  });

  it("cancels only queued jobs", async () => {
    const jt = `${type}.cancel`;
    const j = await db.withClaims(SVC, (c) => jobs.enqueue(c, SVC, { companyId, jobType: jt }));
    expect((await db.withClaims(SVC, (c) => jobs.cancel(c, j.id))).status).toBe("cancelled");
    await expect(db.withClaims(SVC, (c) => jobs.cancel(c, j.id))).rejects.toThrow(/queued/);
  });

  it("tenant isolation: a tenant session sees only its own jobs", async () => {
    const jt = `${type}.iso`;
    await db.withClaims(SVC, async (c) => {
      await jobs.enqueue(c, SVC, { companyId, jobType: jt });
      await jobs.enqueue(c, SVC, { companyId: otherCompanyId, jobType: jt });
    });
    const asB: RequestClaims = { is_platform_admin: false, company_id: otherCompanyId, sub: "u" };
    const seen = await db.withClaims(asB, (c) => jobs.list(c, { jobType: jt }));
    expect(seen).toHaveLength(1);
    expect(seen[0].companyId).toBe(otherCompanyId);
  });
});
