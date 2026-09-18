/**
 * Bootstraps the very first Platform Admin account.
 *
 * Phase 3 deleted Phase 2's shared dev-only login controller outright —
 * after that, the login path is real (password + user_accounts row), which
 * means without this script there would be no way to authenticate into a
 * fresh database at all: `AuthController.login` needs a user_accounts row
 * linked to a platform_admins row, and the only thing that can create one
 * pre-authentication is server-side code carrying the `is_service` claim
 * (see tenant-context.ts and migration 0002's header comment) — exactly
 * what this script, run directly against the database, is.
 *
 * Idempotent: safe to run again. If PLATFORM_ADMIN_BOOTSTRAP_EMAIL already
 * has a platform_admins row, this exits without changing anything, so it
 * can live in a deploy/setup step without special-casing "first run."
 *
 * Connects via APP_DATABASE_URL (app_role, RLS in effect) — not the
 * migration/owner role — so this exercises the exact same RLS policies
 * (user_accounts_insert / platform_admins_write, both gated on
 * `app.is_service()`) that the running API relies on, rather than
 * bypassing them via a superuser connection.
 */
import { join } from "path";
import { Pool } from "pg";
import { loadEnvFile } from "../load-env";
import { runInTenantContext, type RequestClaims } from "./tenant-context";
import { hashPassword } from "../auth/password";
import { resolveSslConfig } from "./db-connection.util";

const SEED_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "seed-script" };

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));

  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (checked env and apps/api/.env)");
  }

  const email = process.env.PLATFORM_ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.PLATFORM_ADMIN_BOOTSTRAP_PASSWORD;
  const fullName = process.env.PLATFORM_ADMIN_BOOTSTRAP_NAME || "Platform Admin";

  if (!email || !password) {
    throw new Error(
      "PLATFORM_ADMIN_BOOTSTRAP_EMAIL and PLATFORM_ADMIN_BOOTSTRAP_PASSWORD must both be set " +
        "(env or apps/api/.env) to bootstrap the first Platform Admin."
    );
  }
  if (password.length < 10) {
    throw new Error("PLATFORM_ADMIN_BOOTSTRAP_PASSWORD must be at least 10 characters");
  }

  const pool = new Pool({ connectionString, ssl: resolveSslConfig(connectionString) });

  try {
    await runInTenantContext(pool, SEED_CLAIMS, async (client) => {
      const existing = await client.query("SELECT id FROM platform_admins WHERE email = $1", [
        email,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        console.log(`Platform Admin ${email} already exists — nothing to do.`);
        return;
      }

      const passwordHash = await hashPassword(password);
      const account = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      await client.query(
        "INSERT INTO platform_admins (full_name, email, user_account_id) VALUES ($1, $2, $3)",
        [fullName, email, account.rows[0].id]
      );

      console.log(`Created Platform Admin ${email}.`);
      console.log(
        "Sign in with this email/password — the first login will walk through mandatory MFA enrollment (TOTP QR code)."
      );
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
