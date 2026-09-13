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

  const client = new Client({ connectionString: databaseUrl });
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
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
