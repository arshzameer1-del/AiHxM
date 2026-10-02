/**
 * Read-only diagnostic (not a migration) — checks whether the
 * `hr_business_policy.manage.all`/`.view.all` permissions exist and are
 * actually granted to the `hr_admin` role, to debug a live 403 on
 * `GET /hr-administration/business-policies/types`. Safe to run any
 * number of times; writes nothing. Uses the exact same DATABASE_URL/.env
 * loading as migrate.ts, so the real connection string never needs to be
 * typed or pasted anywhere.
 */
import { join } from "path";
import { Client } from "pg";
import { loadEnvFile } from "../load-env";
import { resolveSslConfig } from "./db-connection.util";

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (checked env and apps/api/.env)");

  const client = new Client({ connectionString: databaseUrl, ssl: resolveSslConfig(databaseUrl) });
  await client.connect();
  try {
    console.log("=== permissions rows ===");
    const perms = await client.query(
      "SELECT key FROM permissions WHERE key LIKE 'hr_business_policy%' ORDER BY key"
    );
    console.log(perms.rows);

    console.log("\n=== role_permissions grants ===");
    const grants = await client.query(
      `SELECT r.key AS role_key, p.key AS permission_key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.key LIKE 'hr_business_policy%'
       ORDER BY r.key, p.key`
    );
    console.log(grants.rows);

    console.log("\n=== is migration 0107 recorded as applied? ===");
    const migrations = await client.query(
      "SELECT filename, applied_at FROM _migrations WHERE filename LIKE '0107%'"
    );
    console.log(migrations.rows);

    console.log("\n=== roles table — does 'hr_admin' key exist? ===");
    const roles = await client.query("SELECT key, name FROM roles WHERE key = 'hr_admin'");
    console.log(roles.rows);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
