/**
 * Reset one company's BUSINESS DATA (people, org structure, payroll runs, recruitment, expenses, learning) so a fresh,
 * consistent data set can be loaded with seed-tenant-demo.ts. Everything that makes the company itself work is kept:
 * the company row, its login accounts, roles and role assignments, sessions, modules and subscription, catalogs, policies,
 * workflow templates, leave types and policies, payroll configuration (settings, calendars, tax tables, formulas, schemes),
 * shifts, holidays, numbering policy. The append-only audit trail stays (audit_log and domain events are never deleted).
 *
 * SAFE BY DEFAULT: without --execute it only counts what it would delete (dry run, nothing is changed).
 * To delete: take a backup first (your usual data backup (backup-data.js or a Supabase backup)), then
 *   npm run reset-tenant -- --slug qatar-solutions --execute --backup-done --confirm "RESET qatar-solutions"
 * Everything runs in ONE transaction: any error rolls back and nothing is deleted. Employees have no way back afterwards.
 *
 * It connects with DATABASE_URL (the owner connection used by migrations), because the app's own login may not delete these tables.
 *
 * It deletes the "roots" of each data family and relies on the database's own ON DELETE CASCADE for the children, with the
 * same guards the application uses (immutable payslips and the ledgers only allow deletion as part of a cascade).
 */

import { join } from "path";
import { Pool, type PoolClient } from "pg";
import { loadEnvFile } from "../load-env";
import { runInTenantContext, type RequestClaims } from "./tenant-context";
import { resolveSslConfig } from "./db-connection.util";

const RESET_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "reset-tenant-data" };

/**
 * Tables whose rows are deleted, in this order. A table is listed before the tables it is referenced by with a
 * RESTRICT/NO ACTION foreign key. Children that cascade are not listed.
 */
export const RESET_ORDER: string[] = [
  // payroll runs (employees point at them with a restrict key) and everything produced by a run
  "payroll_payment_batches",
  "payroll_journals",
  "payroll_final_settlements",
  "payroll_runs",
  // recruitment (offers and requisitions point at employees with a restrict key)
  "offers",
  "applications",
  "interviews",
  "pre_employment_checks",
  "candidates",
  "recruitment_events",
  "job_requisitions",
  // hiring drafts
  "hire_processes",
  "import_batches",
  // people and identity
  "employees",
  "persons",
  // org structure (positions before units, units before jobs/locations/centers)
  "org_changes",
  "org_reconciliation_runs",
  "org_relationships",
  "position_relationships",
  "positions",
  "org_units",
  "jobs",
  "locations",
  "cost_centers",
  "profit_centers",
  // other business data
  "expense_claims",
  "courses",
  "competencies",
  "workflow_instances",
  "notification_log",
  "background_jobs",
  "idempotency_keys",
  "tenant_daily_usage_counter",
];

/** Employee numbering starts again (issued-number ledger and counters), so the new people begin at EMP-0001. */
export const RESET_COUNTERS: string[] = ["employee_numbers", "employee_number_series", "employee_number_sequences"];

type Plan = { table: string; rows: number; skipped?: string };

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const r = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
  return r.rows[0].ok as boolean;
}

async function hasCompanyColumn(client: PoolClient, table: string): Promise<boolean> {
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'company_id'",
    [table]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function planReset(client: PoolClient, companyId: string): Promise<Plan[]> {
  const plan: Plan[] = [];
  for (const table of [...RESET_ORDER, ...RESET_COUNTERS]) {
    if (!(await tableExists(client, table))) {
      plan.push({ table, rows: 0, skipped: "table does not exist" });
      continue;
    }
    if (!(await hasCompanyColumn(client, table))) {
      plan.push({ table, rows: 0, skipped: "no company_id column" });
      continue;
    }
    const r = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId]);
    plan.push({ table, rows: r.rows[0].n });
  }
  return plan;
}

export async function executeReset(client: PoolClient, companyId: string): Promise<Plan[]> {
  const done: Plan[] = [];
  for (const table of RESET_ORDER) {
    if (!(await tableExists(client, table)) || !(await hasCompanyColumn(client, table))) continue;
    // one savepoint per table, so the error names the table that blocked the reset
    await client.query("SAVEPOINT reset_step");
    try {
      const r = await client.query(`DELETE FROM ${table} WHERE company_id = $1`, [companyId]);
      await client.query("RELEASE SAVEPOINT reset_step");
      done.push({ table, rows: r.rowCount ?? 0 });
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT reset_step").catch(() => undefined);
      throw new Error(`Could not delete ${table}: ${(err as Error).message}`);
    }
  }
  for (const table of RESET_COUNTERS) {
    if (!(await tableExists(client, table))) continue;
    const r = await client.query(`DELETE FROM ${table} WHERE company_id = $1`, [companyId]);
    done.push({ table, rows: r.rowCount ?? 0 });
  }
  return done;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  process.env.TZ = "UTC"; // same as the live server (see seed-tenant-demo.ts)
  loadEnvFile(join(__dirname, "../../.env"));
  const slug = arg("slug");
  if (!slug) throw new Error("Give the company with --slug <company-slug> (for example --slug qatar-solutions)");
  // The owner connection (the one migrations use), not the app's limited login: that login is deliberately not allowed to
  // delete org units, positions, jobs, locations, cost centers or people records, which are archived in normal use.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL (the owner / migration connection) is not set");
  const execute = flag("execute");
  if (execute) {
    if (!flag("backup-done")) throw new Error("Refusing to delete: take a backup first (your usual data backup (backup-data.js or a Supabase backup)) and add --backup-done");
    if (arg("confirm") !== `RESET ${slug}`) throw new Error(`Refusing to delete: add --confirm "RESET ${slug}"`);
  }

  const pool = new Pool({ connectionString, ssl: resolveSslConfig(connectionString) });
  try {
    await runInTenantContext(pool, RESET_CLAIMS, async (client) => {
      const company = await client.query("SELECT id, name FROM companies WHERE slug = $1", [slug]);
      if (company.rowCount === 0) throw new Error(`No company with slug "${slug}"`);
      const { id, name } = company.rows[0] as { id: string; name: string };
      console.log(`Company: ${name} (${slug})`);
      const plan = await planReset(client, id);
      console.log(execute ? "Rows before the reset:" : "DRY RUN - nothing is deleted. Rows that --execute would delete (children cascade on top of this):");
      for (const p of plan) console.log(`  ${p.table.padEnd(34)} ${p.skipped ? `(${p.skipped})` : p.rows}`);
      if (!execute) {
        // roll back: a dry run must change nothing
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        return;
      }
      const done = await executeReset(client, id);
      console.log("Deleted:");
      for (const d of done) console.log(`  ${d.table.padEnd(34)} ${d.rows}`);
      const left = await client.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1", [id]);
      console.log(`Employees left: ${left.rows[0].n}`);
    });
    console.log(execute ? "RESET DONE. Now run: npm run seed-demo -- --slug " + slug : "Dry run finished.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("STOPPED:", err.message);
    process.exit(1);
  });
}
