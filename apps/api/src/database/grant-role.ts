/**
 * One-off fix for a real gap this session uncovered: `CompaniesService`'s
 * Platform-Admin-driven "create a company admin, then create their login"
 * path (companies.service.ts's `addAdmin` + `createAdminLogin`) never
 * grants the resulting account an RBAC role — unlike the public
 * self-signup path (`signup.service.ts`), which deliberately grants
 * `hr_admin` in the same request because there's no Platform Admin left to
 * do it by hand afterward. A company admin created via the Platform Admin
 * console has always needed that same grant done separately — this script
 * is the (previously-missing) way to do it, since there is no frontend
 * screen yet for Platform Admin's `POST /platform/role-assignments` and a
 * tenant's own "Roles & Access" screen only manages `employees`, not
 * `company_admins` (RolesAccessPanel.tsx), so a Platform-Admin-created
 * admin has no self-service path to fix this themselves.
 *
 * `companies.service.ts`'s `createAdminLogin` now grants `hr_admin`
 * automatically for every NEW login created this way, mirroring signup —
 * this script exists only to fix accounts created before that fix shipped.
 *
 * Usage (from apps/api, with your production .env in place — same as
 * `npm run migrate` / `npm run seed`):
 *   GRANT_ROLE_EMAIL="admin@example.com" npm run grant-role
 * Optionally set GRANT_ROLE_KEY (defaults to "hr_admin"; other valid keys:
 * line_manager, employee_self_service, system_admin).
 *
 * Idempotent: does nothing if the account already holds that role.
 *
 * Connects via APP_DATABASE_URL (app_role, RLS in effect) — the same
 * connection the running API itself uses — under the same `is_service`
 * claim seed.ts and signup.service.ts use for pre-authenticated,
 * server-side-only writes.
 */
import { join } from "path";
import { Pool } from "pg";
import { loadEnvFile } from "../load-env";
import { runInTenantContext, type RequestClaims } from "./tenant-context";
import { normalizeEmail } from "../auth/email.util";
import { resolveSslConfig } from "./db-connection.util";

const GRANT_ROLE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "grant-role-script" };

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));

  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (checked env and apps/api/.env)");
  }

  const roleKey = process.env.GRANT_ROLE_KEY || "hr_admin";

  if (!process.env.GRANT_ROLE_EMAIL) {
    throw new Error(
      'GRANT_ROLE_EMAIL must be set — e.g. GRANT_ROLE_EMAIL="admin@example.com" npm run grant-role'
    );
  }
  // normalizeEmail() means this no longer needs the "case-sensitive" caveat
  // this script's lookup error used to carry — every write path now stores
  // emails lowercased (see email.util.ts), so this comparison stays valid
  // regardless of how the email is typed here.
  const email = normalizeEmail(process.env.GRANT_ROLE_EMAIL);

  const pool = new Pool({ connectionString, ssl: resolveSslConfig(connectionString) });

  try {
    await runInTenantContext(pool, GRANT_ROLE_CLAIMS, async (client) => {
      const account = await client.query("SELECT id FROM user_accounts WHERE email = $1", [email]);
      if (account.rowCount === 0) {
        throw new Error(`No user_accounts row for ${email} — check the email is exactly right.`);
      }
      const userAccountId = account.rows[0].id as string;

      // A company admin created through the Platform Admin console lands
      // in company_admins; someone created through Employee Core lands in
      // employees. Check both — whichever has this login owns the company.
      const companyLookup = await client.query(
        `SELECT company_id FROM company_admins WHERE user_account_id = $1
         UNION
         SELECT company_id FROM employees WHERE user_account_id = $1
         LIMIT 1`,
        [userAccountId]
      );
      if (companyLookup.rowCount === 0) {
        throw new Error(
          `${email} has a login but isn't linked to any company (not in company_admins or employees) — nothing to grant a tenant role against.`
        );
      }
      const companyId = companyLookup.rows[0].company_id as string;

      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      if (role.rowCount === 0) {
        throw new Error(`No role with key "${roleKey}" — expected one of hr_admin, line_manager, employee_self_service, system_admin.`);
      }
      const roleId = role.rows[0].id as string;

      const existing = await client.query(
        "SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3",
        [userAccountId, companyId, roleId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        console.log(`${email} already holds "${roleKey}" in company ${companyId} — nothing to do.`);
        return;
      }

      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, roleId]
      );

      console.log(`Granted "${roleKey}" to ${email} in company ${companyId}.`);
      console.log("Log out and back in (or just refresh after re-logging in) — the new role takes effect on next login.");
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
