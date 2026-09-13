import type { Pool, PoolClient } from "pg";

/**
 * The claims shape every request-scoped query runs under.
 *
 * `is_service` is the odd one out: it is never present in a real user's
 * session JWT, and no guard in this codebase ever derives it from a
 * client-supplied token (see PlatformAdminGuard — it whitelists fields
 * explicitly rather than spreading a decoded payload). It exists only for
 * auth.service.ts's own pre-authentication database access (looking up
 * user_accounts by email before anyone has a session yet) and the seed
 * script bootstrapping the first platform admin. See migration
 * 0002_auth_identity.sql's header comment for the full reasoning.
 */
export type RequestClaims = {
  is_platform_admin: boolean;
  company_id?: string | null;
  sub: string;
  is_service?: boolean;
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
