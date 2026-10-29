import { localToday } from "../common/local-date";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ExclusiveCron } from "../common/cron-lock";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { resolveEntitlement } from "./leave-entitlements.repo";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "leave-year-end-job" };
const round2 = (n: number) => Math.round(n * 100) / 100;

function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

type TypeRow = {
  code: string;
  accrual_method: string;
  carry_forward_allowed: boolean;
  carry_forward_cap_days: string | null;
  carry_forward_expiry_months: number | null;
  encashable: boolean;
};

/**
 * R2 - applies the carry-forward and expiry settings of leave types and policy entitlements, which until now were stored
 * but never acted on.
 *
 * Year end (run for the year that has just ended):
 *  - unused balance (entitled - used) of a balance-keeping type is carried into the new year, up to the cap
 *    (policy entitlement cap, else the leave type's cap; no cap set = carry everything), as a `carry_forward` entry that
 *    expires after the configured months (policy entitlement months, else the type's);
 *  - the carried days leave the closing year (an `adjustment`), and what is not carried is forfeited with an `expiry` entry
 *    in the closing year, so the closed year reads zero remaining.
 *    Types marked encashable are never forfeited (they stay for encashment / final settlement);
 *  - the new year's own entitlement is posted straight away (upfront types), so the new balance is complete.
 *
 * Expiry: carried days that are still unused on their expiry date are removed with an `expiry` entry. Leave taken in the
 * new year draws on carried days first.
 *
 * Every entry carries a source key, so the job can run daily, be repeated for a past date and catch up after downtime
 * without posting twice.
 */
@Injectable()
export class LeaveYearEndService {
  private readonly logger = new Logger(LeaveYearEndService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly employeeGroups: EmployeeGroupsService,
    private readonly ledger: LeaveLedgerService
  ) {}

  @Cron("0 30 2 * * *")
  @ExclusiveCron("LeaveYearEndService.sweep")
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.run();
      if (r.carried + r.forfeited + r.expired > 0) {
        this.logger.log(`Leave year end: ${r.carried} carried, ${r.forfeited} forfeited, ${r.expired} expired across ${r.companies} tenant(s)`);
      }
    } catch (err) {
      this.logger.warn(`Leave year-end sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run(asOf: string = localToday(), companyId?: string) {
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
    const total = { companies: companies.length, carried: 0, forfeited: 0, expired: 0 };
    for (const id of companies) {
      const r = await this.runCompany(id, asOf);
      total.carried += r.carried;
      total.forfeited += r.forfeited;
      total.expired += r.expired;
    }
    return total;
  }

  async runCompany(companyId: string, asOf: string): Promise<{ carried: number; forfeited: number; expired: number }> {
    const claims: RequestClaims = { ...SERVICE, company_id: companyId };
    const newYear = Number(asOf.slice(0, 4));
    const closingYear = newYear - 1;
    const types = await this.db.withClaims(claims, async (client) => {
      const t = await client.query<TypeRow>(
        `SELECT code, accrual_method, carry_forward_allowed, carry_forward_cap_days, carry_forward_expiry_months, encashable
           FROM leave_types WHERE company_id = $1 AND is_active AND tracks_balance`,
        [companyId]
      );
      return t.rows;
    });
    const out = { carried: 0, forfeited: 0, expired: 0 };
    if (types.length === 0) return out;

    // Everyone who held a balance in the closing year (including people who have since left: their closing year is still closed).
    const balances = await this.db.withClaims(claims, async (client) => {
      const r = await client.query<{ employee_id: string; leave_type: string; remaining: string; terminated: boolean }>(
        `SELECT b.employee_id, b.leave_type, (b.entitled_days - b.used_days) AS remaining,
                (e.termination_date IS NOT NULL AND e.termination_date < $3::date) AS terminated
           FROM leave_balances b JOIN employees e ON e.id = b.employee_id
          WHERE b.company_id = $1 AND b.year = $2`,
        [companyId, closingYear, `${newYear}-01-01`]
      );
      return r.rows;
    });
    const typeByCode = new Map(types.map((t) => [t.code, t]));

    for (const b of balances) {
      const type = typeByCode.get(b.leave_type);
      if (!type) continue;
      const remaining = round2(Number(b.remaining));
      if (remaining <= 0) continue;
      await this.db.withClaims(claims, async (client) => {
        const policy = await this.employeeGroups.resolvePolicyInternal(claims, b.employee_id, "leave").catch(() => null);
        const ent = policy?.policyId ? await resolveEntitlement(client, policy.policyId, type.code) : null;

        const allowed = type.carry_forward_allowed && !b.terminated;
        const typeCap = type.carry_forward_cap_days === null ? null : Number(type.carry_forward_cap_days);
        const cap = ent?.carryForwardCapDays ?? typeCap; // null = no cap
        const carry = allowed ? round2(cap === null ? remaining : Math.min(remaining, cap)) : 0;
        const months = ent?.expiresAfterMonths ?? type.carry_forward_expiry_months;

        if (carry > 0) {
          const effective = `${newYear}-01-01`;
          const r = await this.ledger.post(client, {
            companyId, employeeId: b.employee_id, leaveType: type.code, year: newYear, entryType: "carry_forward", days: carry,
            effectiveDate: effective, expiresOn: months ? addMonths(effective, months) : null,
            sourceType: "year_end_job", sourceKey: `cf:${closingYear}`,
            reason: `Unused ${closingYear} leave carried forward${cap !== null && remaining > cap ? ` (capped at ${cap})` : ""}`,
          });
          if (r.inserted) out.carried++;
          // The carried days leave the closing year, so the closed year reads zero (the new year holds them).
          await this.ledger.post(client, {
            companyId, employeeId: b.employee_id, leaveType: type.code, year: closingYear, entryType: "adjustment", days: -carry,
            effectiveDate: `${closingYear}-12-31`, sourceType: "year_end_job", sourceKey: `cfout:${closingYear}`,
            reason: `Carried forward into ${newYear}`,
          });
        }
        const forfeit = round2(remaining - carry);
        if (forfeit > 0 && !type.encashable) {
          const r = await this.ledger.post(client, {
            companyId, employeeId: b.employee_id, leaveType: type.code, year: closingYear, entryType: "expiry", days: -forfeit,
            effectiveDate: `${closingYear}-12-31`, sourceType: "year_end_job", sourceKey: `yearend:${closingYear}`,
            reason: `Unused ${closingYear} leave not carried forward`,
          });
          if (r.inserted) out.forfeited++;
        }
        // Complete the new year's balance now, so the carried days sit beside the year's own entitlement.
        if (carry > 0 && ent && ent.days > 0) {
          const method = (ent.accrualMethod ?? type.accrual_method) as "upfront" | "monthly" | "none";
          if (method === "upfront") await this.ledger.ensureBalance(client, companyId, b.employee_id, type.code, newYear, { days: ent.days, method }, asOf);
        }
      });
    }

    out.expired = await this.expireCarried(claims, companyId, asOf);
    return out;
  }

  /** Removes carried-forward days that are still unused on their expiry date. */
  private async expireCarried(claims: RequestClaims, companyId: string, asOf: string): Promise<number> {
    const due = await this.db.withClaims(claims, async (client) => {
      const r = await client.query<{ id: string; employee_id: string; leave_type: string; year: number; days: string; expires_on: Date | string }>(
        `SELECT l.id, l.employee_id, l.leave_type, l.year, l.days, l.expires_on
           FROM leave_ledger l
          WHERE l.company_id = $1 AND l.entry_type = 'carry_forward' AND l.expires_on IS NOT NULL AND l.expires_on <= $2::date
            AND NOT EXISTS (SELECT 1 FROM leave_ledger x WHERE x.employee_id = l.employee_id AND x.leave_type = l.leave_type
                              AND x.year = l.year AND x.entry_type = 'expiry' AND x.source_type = 'carry_expiry_job' AND x.source_key = 'exp:' || l.id::text)`,
        [companyId, asOf]
      );
      return r.rows;
    });
    let n = 0;
    for (const c of due) {
      const expiresOn = (typeof c.expires_on === "string" ? c.expires_on : c.expires_on.toISOString()).slice(0, 10);
      await this.db.withClaims(claims, async (client) => {
        const used = await client.query<{ used: string }>(
          `SELECT -COALESCE(SUM(days), 0) AS used FROM leave_ledger
            WHERE employee_id = $1 AND leave_type = $2 AND year = $3 AND entry_type IN ('deduction','reversal') AND effective_date <= $4::date`,
          [c.employee_id, c.leave_type, c.year, expiresOn]
        );
        const bal = await client.query<{ remaining: string }>(
          "SELECT (entitled_days - used_days) AS remaining FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3",
          [c.employee_id, c.leave_type, c.year]
        );
        // Leave taken first uses the carried days, so what is left of them is what the carry exceeds usage by.
        const unconsumed = Math.max(0, round2(Number(c.days) - Number(used.rows[0]?.used ?? 0)));
        const expire = round2(Math.min(unconsumed, Math.max(0, Number(bal.rows[0]?.remaining ?? 0))));
        if (expire > 0) {
          const r = await this.ledger.post(client, {
            companyId, employeeId: c.employee_id, leaveType: c.leave_type, year: c.year, entryType: "expiry", days: -expire,
            effectiveDate: expiresOn, sourceType: "carry_expiry_job", sourceKey: `exp:${c.id}`,
            reason: "Carried-forward leave expired",
          });
          if (r.inserted) n++;
        } else {
          // Nothing left to expire: record a zero-day marker (the sign rule allows 0) so this entry is not checked again.
          await this.ledger.post(client, {
            companyId, employeeId: c.employee_id, leaveType: c.leave_type, year: c.year, entryType: "expiry", days: 0,
            effectiveDate: expiresOn, sourceType: "carry_expiry_job", sourceKey: `exp:${c.id}`,
            reason: "Carried-forward leave fully used before it expired",
          });
        }
      });
    }
    return n;
  }
}
