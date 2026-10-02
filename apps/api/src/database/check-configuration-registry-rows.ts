/**
 * Read-only diagnostic (not a migration). Business Policies is now fixed
 * (migration 0107 applied), but GET /api/configuration-center still
 * returns [] even though every permission its domains need is confirmed
 * already granted to hr_admin. The one thing not yet checked directly:
 * the LIVE API never connects with DATABASE_URL (that's the
 * migration/owner role, used only by migrate.ts and these diagnostic
 * scripts) -- it always connects as `app_role` via a DIFFERENT env var,
 * APP_DATABASE_URL (see database.module.ts's own header comment). Every
 * earlier diagnostic this session ran as the owner role, which bypasses
 * RLS entirely -- so "the data and grants look fine" doesn't actually
 * prove app_role can see them. This script queries
 * `configuration_registry` BOTH ways to compare. Writes nothing.
 */
import { join } from "path";
import { Client } from "pg";
import { loadEnvFile } from "../load-env";
import { resolveSslConfig } from "./db-connection.util";

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));

  const ownerUrl = process.env.DATABASE_URL;
  const appUrl = process.env.APP_DATABASE_URL;
  console.log({ hasDatabaseUrl: !!ownerUrl, hasAppDatabaseUrl: !!appUrl });

  if (ownerUrl) {
    const owner = new Client({ connectionString: ownerUrl, ssl: resolveSslConfig(ownerUrl) });
    await owner.connect();
    try {
      console.log("\n=== As OWNER role (DATABASE_URL, bypasses RLS) ===");
      const rows = await owner.query(
        "SELECT domain_key, label, sort_order FROM configuration_registry ORDER BY sort_order ASC"
      );
      console.log(`row count: ${rows.rows.length}`);
      console.log(rows.rows);

      console.log("\n=== app_role's actual grants on configuration_registry ===");
      const grants = await owner.query(
        `SELECT grantee, privilege_type FROM information_schema.role_table_grants
         WHERE table_name = 'configuration_registry'`
      );
      console.log(grants.rows);

      console.log("\n=== RLS flags on configuration_registry (should both be false) ===");
      const rls = await owner.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'configuration_registry'`
      );
      console.log(rls.rows);

      console.log("\n=== Current Postgres role name/user that owns this connection ===");
      const whoOwner = await owner.query("SELECT current_user, session_user");
      console.log(whoOwner.rows);
    } finally {
      await owner.end();
    }
  }

  if (appUrl) {
    const app = new Client({ connectionString: appUrl, ssl: resolveSslConfig(appUrl) });
    await app.connect();
    try {
      console.log("\n=== As APP_ROLE (APP_DATABASE_URL -- the exact connection the live API uses) ===");
      const whoApp = await app.query("SELECT current_user, session_user");
      console.log(whoApp.rows);

      const rows = await app.query(
        "SELECT domain_key, label, sort_order FROM configuration_registry ORDER BY sort_order ASC"
      );
      console.log(`row count: ${rows.rows.length}`);
      console.log(rows.rows);
    } catch (err) {
      console.log("app_role query FAILED with:", err);
    } finally {
      await app.end();
    }
  } else {
    console.log("\nAPP_DATABASE_URL is not set in this shell's .env -- cannot test the app_role connection directly.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
