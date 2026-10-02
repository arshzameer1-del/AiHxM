/**
 * Read-only diagnostic (not a migration). Live testing on aihxm.com
 * confirmed kumail's real login (ahsan@exdnow.com, Qatar Solutions) has
 * roleKeys ["system_admin", "hr_admin"] -- the literal SEEDED role keys,
 * not a look-alike custom role as earlier hypothesized. That rules out a
 * role-identity mismatch. Yet:
 *   - GET /api/configuration-center returns [] (every domain's card
 *     omitted) even though the SAME underlying service methods
 *     (EmployeeGroupsService.listGroups/listLeavePolicies,
 *     ShiftsService.listShifts, HolidaysService.listHolidays, etc.) all
 *     return 200 with real data when called directly via their own
 *     /api/employee-groups, /api/leave-policies, /api/shifts, /api/holidays
 *     endpoints in the SAME browser session.
 *   - GET /api/hr-administration/business-policies/types returns 403.
 * This script checks, permission by permission, which of the specific
 * keys ConfigurationCenterService.countFor() and HrBusinessPolicyService
 * require are actually present in `permissions` and actually granted to
 * the real `hr_admin`/`system_admin` roles -- to find exactly which grant
 * is missing (if any), rather than guessing further from the UI. Writes
 * nothing. Uses the same DATABASE_URL/.env loading as migrate.ts.
 */
import { join } from "path";
import { Client } from "pg";
import { loadEnvFile } from "../load-env";
import { resolveSslConfig } from "./db-connection.util";

// Every permission key referenced by ConfigurationCenterService.countFor()
// plus the two hr_business_policy permissions from migration 0107.
const PERMISSION_KEYS = [
  "employee_group.manage",
  "leave_policy.manage",
  "shift.manage.all",
  "shift.view.team",
  "holiday.manage.all",
  "holiday.view.all",
  "workflow_template.manage.all",
  "custom_field.manage.all",
  "org_unit.view.all",
  "org_unit.manage.all",
  "job.view.all",
  "job.manage.all",
  "location.view.all",
  "location.manage.all",
  "cost_center.view.all",
  "cost_center.manage.all",
  "profit_center.view.all",
  "profit_center.manage.all",
  "employee.manage.all",
  "onboarding.manage.all",
  "offboarding.manage.all",
  "payroll.manage.all",
  "hr_business_policy.manage.all",
  "hr_business_policy.view.all",
];

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (checked env and apps/api/.env)");

  const client = new Client({ connectionString: databaseUrl, ssl: resolveSslConfig(databaseUrl) });
  await client.connect();
  try {
    console.log("=== Ahsan Ghauri's account + role assignments at Qatar Solutions ===");
    const account = await client.query(
      `SELECT ua.id AS user_account_id, ua.email, c.id AS company_id, c.name AS company_name
       FROM user_accounts ua
       JOIN companies c ON c.slug = 'qatar-solutions'
       WHERE ua.email = 'ahsan@exdnow.com'`
    );
    console.log(account.rows);
    const userAccountId = account.rows[0]?.user_account_id;
    const companyId = account.rows[0]?.company_id;
    if (!userAccountId || !companyId) {
      console.log("Could not find ahsan@exdnow.com at qatar-solutions -- stopping here.");
      return;
    }

    const roleAssignments = await client.query(
      `SELECT ura.id AS assignment_id, ura.company_id, r.id AS role_id, r.key AS role_key, r.name AS role_name
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.user_account_id = $1`,
      [userAccountId]
    );
    console.log(roleAssignments.rows);

    console.log(
      "\n=== For each role assignment above, does its company_id match Qatar Solutions' company_id? ==="
    );
    console.log({ qatarSolutionsCompanyId: companyId });

    console.log("\n=== permission-by-permission: does it exist, and is it granted to hr_admin / system_admin? ===");
    for (const key of PERMISSION_KEYS) {
      const perm = await client.query("SELECT id FROM permissions WHERE key = $1", [key]);
      const exists = perm.rows.length > 0;
      let grantedTo: string[] = [];
      if (exists) {
        const grants = await client.query(
          `SELECT r.key AS role_key
           FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE p.key = $1 AND r.key IN ('hr_admin', 'system_admin')`,
          [key]
        );
        grantedTo = grants.rows.map((r) => r.role_key);
      }
      console.log({ key, existsInPermissionsTable: exists, grantedToHrAdminOrSystemAdmin: grantedTo });
    }

    console.log("\n=== Sanity check: a permission we KNOW works for this account (employee_group.manage) ===");
    const sanity = await client.query(
      `SELECT r.key AS role_key, p.key AS permission_key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.key = 'employee_group.manage'`
    );
    console.log(sanity.rows);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
