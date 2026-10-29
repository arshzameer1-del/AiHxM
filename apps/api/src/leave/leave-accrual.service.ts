import { ExclusiveCron } from "../common/cron-lock";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { resolveEntitlement } from "./leave-entitlements.repo";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "leave-accrual-job" };

/**
 * Gap Register TLM-02 - the accrual job.
 *
 * For every active employee and every balance-keeping leave type whose effective accrual
 * method is `monthly` (the policy entitlement's own method, else the leave type's), posts
 * the months of the current year not yet accrued as `accrual` ledger entries. Idempotent
 * through the ledger's source key (`YYYY-MM`), so it can run daily, be re-run for a past
 * date, and catch up after downtime. Employees who joined mid-year accrue from their
 * joining month. `upfront` types are posted when the balance is first needed and `none`
 * types (e.g. compensatory off) are only changed by explicit ledger entries.
 *
 * NOT built here (TLM-13, planned after this step): year-end carry-forward / expiry jobs,
 * leave encashment and compensatory-off earning.
 */
@Injectable()
export class LeaveAccrualService {
  private readonly logger = new Logger(LeaveAccrualService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly employeeGroups: EmployeeGroupsService,
    private readonly ledger: LeaveLedgerService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  @ExclusiveCron("LeaveAccrualService.sweep")
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.run();
      if (r.accruals > 0) this.logger.log(`Leave accrual: ${r.accruals} entries across ${r.companies} tenant(s)`);
    } catch (err) {
      this.logger.warn(`Leave accrual sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run(asOf: string = new Date().toISOString().slice(0, 10), companyId?: string): Promise<{ companies: number; accruals: number }> {
    const companies = await this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT DISTINCT t.company_id AS id
           FROM leave_types t
           JOIN tenant_module_entitlement m ON m.company_id = t.company_id AND m.module_key = 'leave' AND m.enabled
          WHERE t.is_active AND t.tracks_balance AND ($1::uuid IS NULL OR t.company_id = $1)`,
        [companyId ?? null]
      );
      return r.rows.map((x) => x.id);
    });
    let accruals = 0;
    for (const id of companies) accruals += await this.runCompany(id, asOf);
    return { companies: companies.length, accruals };
  }

  async runCompany(companyId: string, asOf: string): Promise<number> {
    const claims: RequestClaims = { ...SERVICE, company_id: companyId };
    const year = Number(asOf.slice(0, 4));
    const month = Number(asOf.slice(5, 7));
    const { types, employees } = await this.db.withClaims(claims, async (client) => {
      const t = await client.query("SELECT code, accrual_method FROM leave_types WHERE company_id = $1 AND is_active AND tracks_balance", [companyId]);
      const e = await client.query(
        `SELECT id, date_of_joining FROM employees
          WHERE company_id = $1 AND (termination_date IS NULL OR termination_date >= $2::date)
            AND (date_of_joining IS NULL OR date_of_joining <= $2::date)`,
        [companyId, asOf]
      );
      return { types: t.rows as Array<{ code: string; accrual_method: string }>, employees: e.rows as Array<{ id: string; date_of_joining: Date | string | null }> };
    });

    let posted = 0;
    for (const emp of employees) {
      const resolved = await this.employeeGroups.resolvePolicyInternal(claims, emp.id, "leave").catch(() => null);
      if (!resolved?.policyId) continue;
      const joined = emp.date_of_joining ? (typeof emp.date_of_joining === "string" ? emp.date_of_joining : emp.date_of_joining.toISOString()).slice(0, 10) : null;
      const firstMonth = joined && Number(joined.slice(0, 4)) === year ? Number(joined.slice(5, 7)) : 1;
      if (joined && Number(joined.slice(0, 4)) > year) continue;
      await this.db.withClaims(claims, async (client) => {
        for (const type of types) {
          const ent = await resolveEntitlement(client, resolved.policyId!, type.code);
          if (!ent || ent.days <= 0) continue;
          if ((ent.accrualMethod ?? type.accrual_method) !== "monthly") continue;
          // Creating the row (catch-up for the elapsed months) is itself part of the job.
          const existing = await client.query("SELECT 1 FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3", [emp.id, type.code, year]);
          if ((existing.rowCount ?? 0) === 0) {
            await this.ledger.ensureBalance(client, companyId, emp.id, type.code, year, { days: ent.days, method: "monthly" }, asOf);
            posted += Math.max(0, month - firstMonth + 1);
            continue;
          }
          for (let m = firstMonth; m <= month; m++) {
            if (await this.ledger.accrueMonth(client, companyId, emp.id, type.code, year, m, ent.days)) posted++;
          }
        }
      });
    }
    return posted;
  }
}
