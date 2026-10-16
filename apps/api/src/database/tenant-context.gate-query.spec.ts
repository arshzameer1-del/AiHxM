import { Pool } from "pg";
import { DatabaseService } from "./database.service";
import type { RequestClaims } from "./tenant-context";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "gate-query-spec" };

/** queryWithClaims: the one-round-trip read used by the per-request gates. Same isolation as withClaims, safe with hostile text, never leaves a connection broken. */
describe("queryWithClaims (one round trip gate read)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL, max: 1 });
    db = new DatabaseService(pool);
    companyId = await db.withClaims(FIXTURE, async (c) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return (await c.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Gate Co ${stamp}`, `gate-${stamp}`])).rows[0].id as string;
    });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("returns the rows and applies the caller's claims (RLS sees the company)", async () => {
    const claims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: "someone" };
    const res = await db.queryWithClaims<{ id: string }>(claims, "SELECT id FROM companies WHERE id = $1", [companyId]);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].id).toBe(companyId);
    const other = await db.queryWithClaims({ is_platform_admin: false, company_id: "00000000-0000-4000-8000-000000000009", sub: "someone" }, "SELECT id FROM companies WHERE id = $1", [companyId]);
    expect(other.rowCount).toBe(0);
  });

  it("claims do not outlive the call, and the connection is reusable (pool of one)", async () => {
    await db.queryWithClaims({ is_platform_admin: false, company_id: companyId, sub: "leaky?" }, "SELECT 1 AS one");
    const leaked = await pool.query("SELECT current_setting('request.jwt.claims', true) AS c");
    expect(leaked.rows[0].c ?? "").toBe("");
  });

  it("text that looks like SQL is only ever a value", async () => {
    const hostile = "x'; DROP TABLE companies; --";
    const res = await db.queryWithClaims(FIXTURE, "SELECT id FROM companies WHERE name = $1 OR slug = $2", [hostile, "it's \\ quoted"]);
    expect(res.rowCount).toBe(0);
    expect((await db.queryWithClaims(FIXTURE, "SELECT 1 FROM companies WHERE id = $1", [companyId])).rowCount).toBe(1);
  });

  it("a failing query throws and leaves the connection usable", async () => {
    await expect(db.queryWithClaims(FIXTURE, "SELECT * FROM no_such_table_anywhere")).rejects.toThrow();
    await expect(db.queryWithClaims(FIXTURE, "SELECT 1 AS one WHERE $1 = 1", [1])).resolves.toMatchObject({ rowCount: 1 });
    await expect(db.queryWithClaims(FIXTURE, "SELECT $2", ["only one value"])).rejects.toThrow(/no value for \$2/);
    expect((await db.queryWithClaims(FIXTURE, "SELECT 1")).rowCount).toBe(1);
  });
});
