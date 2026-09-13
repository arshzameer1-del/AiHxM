import type { Pool, PoolClient } from "pg";

/**
 * The claims shape every request-scoped query runs under. Phase 2 only
 * ever produces `{ is_platform_admin: true, sub: "platform-admin-dev" }`
 * (see src/auth) since there is no tenant-side login yet — `company_id`
 * is here now because the RLS policies in migration 0001 already support
 * a scoped, non-platform-admin caller, ready for Phase 3 to start issuing
 * real ones from Supabase Auth without another migration.
 */
export type RequestClaims = {
  is_platform_admin: boolean;
  company_id?: string | null;
  sub: string;
};

/**
 * Runs `fn` against a pooled connection with `request.jwt.claims` set for
 * the lifetime of one transaction (`set_config(..., true)` is the SQL
 * equivalent of `SET LOCAL` — it never leaks to whichever request the
 * pooled connection serves next). This is the one and only place claims
 * get attached to a query, so it's also the one place to check when
 * asking "could this leak across tenants."
 */
export async function runInTenantContext<T>(
  pool: Pool,
  claims: RequestClaims,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
