import type { Pool, PoolClient } from "pg";
import { fieldCrypto } from "../crypto/field-crypto";

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
  /**
   * Phase 2 gap-fill item #7 — Platform Admin delegation. Set by
   * PlatformAdminGuard from PLATFORM_ADMINS.access_level, never present on
   * a tenant-side session. Optional and additive: every RLS policy written
   * before this feature existed ignores unknown JSON keys, so carrying
   * these through `request.jwt.claims` changes nothing for them.
   */
  platformAdminAccessLevel?: "full" | "read_only" | "scoped";
  /** Only meaningful (and only ever non-empty) when accessLevel === "scoped". */
  platformAdminScopedCompanyIds?: string[];
  /**
   * Phase 2 gap-fill item #2 — step-up re-authentication. The session's own
   * `user_sessions.id` (the JWT's `jti`), set by SessionGuard/PlatformAdminGuard
   * from the verified token — never client-supplied on its own. Absent for a
   * token minted before sessions existed (no `jti` at all); StepUpGuard
   * treats that as "cannot be step-up verified" rather than guessing.
   * Not sent to Postgres via `request.jwt.claims` for any RLS purpose (no
   * policy reads it) — it exists purely for StepUpGuard/StepUpService to
   * key SessionSecurityService's step-up cache by.
   */
  sessionId?: string;
};

/**
 * Runs `fn` against a pooled connection with `request.jwt.claims` set for
 * the lifetime of one transaction (`set_config(..., true)` is the SQL
 * equivalent of `SET LOCAL` — it never leaks to whichever request the
 * pooled connection serves next). This is the one and only place claims
 * get attached to a query, so it's also the one place to check when
 * asking "could this leak across tenants."
 */
/**
 * SEC-02: make the tenant's field-encryption keys available (in-process
 * cache) so services can encrypt/decrypt synchronously. A SAVEPOINT keeps a
 * failure here (e.g. key table not migrated yet, master key unset) from
 * poisoning the request's transaction -- requests that never touch an
 * encrypted field keep working, and the ones that do fail loudly with
 * FIELD_KEYS_NOT_LOADED instead of silently writing plaintext.
 */
async function warmFieldKeys(client: PoolClient, claims: RequestClaims): Promise<void> {
  if (!claims.company_id) return;
  // Keys already loaded: nothing to query, so no savepoint round trips either.
  if (fieldCrypto.isWarm(claims.company_id)) return;
  await client.query("SAVEPOINT warm_field_keys");
  try {
    await fieldCrypto.warm(client, claims.company_id);
    await client.query("RELEASE SAVEPOINT warm_field_keys");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT warm_field_keys");
    await client.query("RELEASE SAVEPOINT warm_field_keys");
    // eslint-disable-next-line no-console
    console.warn(`[field-crypto] could not load tenant keys: ${(err as Error).message}`);
  }
}

const afterCommitQueues = new WeakMap<PoolClient, Array<() => Promise<void> | void>>();

/**
 * Runs `fn` once the transaction that owns `client` has COMMITTED (and never if it rolls back). For side effects that must not
 * happen for work that was rolled back - notifications, e-mails. A client that is not inside runInTenantContext (a hand-made
 * connection in a spec) runs it straight away. A failing `fn` is logged, never thrown: the work it follows is already saved.
 */
export function afterCommit(client: PoolClient, fn: () => Promise<void> | void): void {
  const queue = afterCommitQueues.get(client);
  if (queue) queue.push(fn);
  else void Promise.resolve().then(fn).catch(() => undefined);
}

export async function runInTenantContext<T>(
  pool: Pool,
  claims: RequestClaims,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  afterCommitQueues.set(client, []);
  try {
    // One round trip, not two: BEGIN and the claims go to the server together (simple-query protocol runs both).
    // The database is often a continent away from the API, so every round trip saved is felt on every request.
    await client.query(`BEGIN; SELECT set_config('request.jwt.claims', ${client.escapeLiteral(JSON.stringify(claims))}, true)`);
    await warmFieldKeys(client, claims);
    const result = await fn(client);
    await client.query("COMMIT");
    const queued = afterCommitQueues.get(client) ?? [];
    afterCommitQueues.delete(client);
    for (const job of queued) {
      try {
        await job();
      } catch {
        /* the work is committed; a failing side effect must not turn it into an error */
      }
    }
    return result;
  } catch (err) {
    afterCommitQueues.delete(client);
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    afterCommitQueues.delete(client);
    client.release();
  }
}

/**
 * A single read-only query under the caller's claims in ONE round trip: BEGIN, the claims, the query and COMMIT are sent as one
 * batch. For the small gate lookups that run on nearly every request (is the module on, does this user hold the permission),
 * where the five-step transaction wrapper cost far more than the query. Same isolation as runInTenantContext (the claims are
 * transaction-local and RLS applies); nothing is cached, so an authorization change is seen on the very next request.
 *
 * Only for queries whose parameters are plain strings, numbers, booleans or null: they are written into the statement as
 * escaped literals (the simple-query protocol has no bound parameters). It does not load tenant field keys, so it must not
 * touch an encrypted column.
 */
export async function queryInTenantContext<R extends Record<string, unknown> = Record<string, unknown>>(
  pool: Pool,
  claims: RequestClaims,
  text: string,
  values: ReadonlyArray<string | number | boolean | null> = []
): Promise<{ rows: R[]; rowCount: number }> {
  const client = await pool.connect();
  try {
    const literal = (v: string | number | boolean | null): string => {
      if (v === null) return "NULL";
      if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new Error("queryInTenantContext: non-finite number parameter");
        return String(v);
      }
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      return client.escapeLiteral(v);
    };
    const statement = text.replace(/\$(\d+)/g, (_m, n: string) => {
      const i = Number(n) - 1;
      if (i < 0 || i >= values.length) throw new Error(`queryInTenantContext: no value for $${n}`);
      return literal(values[i]);
    });
    const results = (await client.query(
      `BEGIN; SELECT set_config('request.jwt.claims', ${client.escapeLiteral(JSON.stringify(claims))}, true); ${statement}; COMMIT`
    )) as unknown as Array<{ rows: R[]; rowCount: number | null }>;
    const r = results[2];
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
