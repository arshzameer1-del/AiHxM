/**
 * Read-only diagnostic (not a migration) — Configuration Center and
 * Business Policies are both showing empty/403 for Qatar Solutions'
 * "HR Admin"-labeled login, even though every permission grant those
 * screens need is supposed to belong to the seeded `hr_admin` role key.
 * This checks whether that login's actual assigned role is really the
 * seeded `hr_admin` role, or a separately-created role that happens to
 * share the same display name. Writes nothing. Uses the same
 * DATABASE_URL/.env loading as migrate.ts.
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
    console.log("=== Qatar Solutions company row ===");
    const company = await client.query("SELECT id, name, slug, package_tier FROM companies WHERE slug = 'qatar-solutions'");
    console.log(company.rows);
    const companyId = company.rows[0]?.id;
    if (!companyId) {
      console.log("No company with slug 'qatar-solutions' found — stopping here.");
      return;
    }

    console.log("\n=== Every role assigned to every user at Qatar Solutions, with permission counts ===");
    const assignments = await client.query(
      `SELECT ua.email,
              r.id AS role_id, r.key AS role_key, r.name AS role_name,
              (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
       FROM user_role_assignments ura
       JOIN user_accounts ua ON ua.id = ura.user_account_id
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.company_id = $1
       ORDER BY ua.email, r.key`,
      [companyId]
    );
    console.log(assignments.rows);

    console.log("\n=== The SEEDED 'hr_admin' role (by key) — does it exist, and how many permissions does it really have? ===");
    const seeded = await client.query(
      `SELECT r.id, r.key, r.name, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
       FROM roles r WHERE r.key = 'hr_admin'`
    );
    console.log(seeded.rows);

    console.log("\n=== Every role whose KEY or NAME contains 'hr' or 'admin' (case-insensitive) — to spot a look-alike custom role ===");
    const lookalikes = await client.query(
      `SELECT r.id, r.key, r.name, (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
       FROM roles r WHERE r.key ILIKE '%hr%' OR r.key ILIKE '%admin%' OR r.name ILIKE '%hr%' OR r.name ILIKE '%admin%'
       ORDER BY r.key`
    );
    console.log(lookalikes.rows);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
