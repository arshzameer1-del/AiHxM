/**
 * Shared connection-config helpers for every place in this codebase that
 * opens a raw `pg` `Pool`/`Client` (the running API's `DatabaseModule`,
 * `migrate.ts`, `seed.ts`, `seed-pilot-company.ts`). Extracted the moment
 * a second real environment (Supabase-hosted Postgres, for a real go-live
 * deployment) needed the identical "does this connection need TLS"
 * decision the local-dev-only code never had to make, rather than
 * hand-copying the same `ssl: {...}` object into four call sites and
 * risking them drifting apart — the same "extract on the second real
 * consumer" discipline this codebase's other shared engines follow.
 *
 * Local Postgres (the docker-compose/native-cluster dev default) speaks
 * plain TCP with no certificate to verify, so this must stay a no-op for
 * every existing local connection string — nothing here changes local
 * dev behavior unless the connection string itself says otherwise.
 */
export function resolveSslConfig(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  // Explicit opt-in/opt-out always wins over the hostname sniff below, for
  // any host this heuristic doesn't recognize (a client's own self-hosted
  // Supabase, a different managed Postgres provider, etc.).
  const explicit = process.env.DATABASE_SSL;
  if (explicit === "true") return { rejectUnauthorized: false };
  if (explicit === "false") return undefined;

  // Supabase's pooled and direct connection hosts both require TLS, and
  // (like most managed Postgres providers reachable over the public
  // internet) present a certificate chain `pg`'s default strict
  // verification doesn't have the intermediate CA for — the same
  // "verify encryption, not the full chain" tradeoff every other
  // Supabase-targeting Node client (including Supabase's own docs) makes,
  // not a weakening specific to this codebase.
  let hostname = "";
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    // Not a parseable URL (shouldn't happen for a real pg connection
    // string) — fall through to "no SSL", matching prior behavior.
  }
  if (hostname.endsWith(".supabase.co") || hostname.endsWith(".supabase.com")) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}
