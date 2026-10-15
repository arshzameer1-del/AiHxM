import { Pool } from "pg";

/**
 * Gap Register SEC-14 — permanent guard. Every public table must have
 * ROW LEVEL SECURITY enabled AND forced, with at least one policy, except the
 * two deliberately global tables below. Any new table that forgets RLS fails
 * this test instead of silently shipping cross-tenant readable.
 */
const GLOBAL_TABLES = new Set([
  "_migrations", // migration bookkeeping, owner-only
  "configuration_registry", // platform-wide catalogue of configurable objects, no tenant data
]);

describe("RLS coverage (SEC-14)", () => {
  let owner: Pool;
  beforeAll(() => {
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await owner.end();
  });

  it("every tenant table has RLS enabled, forced, and at least one policy", async () => {
    const r = await owner.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS has_policy
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`
    );
    const offenders = r.rows
      .filter((t) => !GLOBAL_TABLES.has(t.relname))
      .filter((t) => !t.relrowsecurity || !t.relforcerowsecurity || !t.has_policy)
      .map((t) => t.relname);
    expect(offenders).toEqual([]);
  });

  it("every table with a company_id column is covered (nullable company_id tables included)", async () => {
    const r = await owner.query(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN pg_class k ON k.relname = c.table_name AND k.relkind = 'r'
        WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND NOT k.relrowsecurity`
    );
    expect(r.rows).toEqual([]);
  });
});
