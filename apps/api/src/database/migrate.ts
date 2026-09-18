/**
 * Minimal, dependency-free migration runner (Decision #2: raw SQL instead
 * of Prisma). Applies every `.sql` file in ../../migrations, in filename
 * order, that isn't already recorded in `_migrations`. Each file runs
 * inside its own transaction — a failing migration rolls back cleanly
 * rather than leaving the schema half-applied.
 *
 * Connects as the migration/owner role (DATABASE_URL) — the same role
 * that owns the tables — never as `app_role`, since this needs to create
 * roles, schemas, and RLS policies that `app_role` itself is deliberately
 * not allowed to touch.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Client } from "pg";
import { loadEnvFile } from "../load-env";
import { resolveSslConfig } from "./db-connection.util";

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set (checked env and apps/api/.env)");
  }

  const migrationsDir = join(__dirname, "..", "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString: databaseUrl, ssl: resolveSslConfig(databaseUrl) });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows: appliedRows } = await client.query<{ filename: string }>(
      "SELECT filename FROM _migrations"
    );
    const applied = new Set(appliedRows.map((r) => r.filename));

    let ranAny = false;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      console.log(`apply ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        ranAny = true;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log(ranAny ? "Migrations applied." : "Already up to date.");

    // Migration 0001 creates `app_role` with a hardcoded dev password
    // (`app_role_dev_password`) — fine for a throwaway local Postgres
    // instance, a real credential leak if the exact same value ever ran
    // against a real, internet-reachable database (Supabase or otherwise).
    // Rather than editing an already-applied migration file (this codebase's
    // own discipline: migrations are never edited after they ship, only
    // added to), this rotates the password here, idempotently, whenever a
    // real value is provided — a no-op for every existing local dev
    // environment that doesn't set it, so nothing about local dev changes.
    const appRolePassword = process.env.APP_ROLE_PASSWORD;
    if (appRolePassword) {
      // `ALTER ROLE ... PASSWORD` does not accept a bind parameter directly
      // (Postgres's grammar wants a literal there, confirmed against a real
      // server — `$1` in that position is a syntax error, not just an
      // untested assumption); building the statement via the server's own
      // `format('...%L', $1)` gets safe quoting/escaping for free (verified
      // against a password containing quotes, semicolons, and `--`) without
      // hand-rolling string-escaping logic here.
      const { rows } = await client.query<{ stmt: string }>(
        "SELECT format('ALTER ROLE app_role WITH PASSWORD %L', $1::text) AS stmt",
        [appRolePassword]
      );
      await client.query(rows[0].stmt);
      console.log("app_role password set from APP_ROLE_PASSWORD.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
