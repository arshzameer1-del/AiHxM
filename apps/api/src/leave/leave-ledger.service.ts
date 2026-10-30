import { localToday } from "../common/local-date";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { AccrualMethod, AdjustLeaveBalanceRequest, LeaveLedgerEntryType, LeaveLedgerEntryView } from "@aihxm/shared-types";

const MODULE_KEY = "leave" as const;

export type LedgerPost = {
  companyId: string;
  employeeId: string;
  leaveType: string;
  year: number;
  entryType: LeaveLedgerEntryType;
  /** Signed days (see the sign rules in migration 0139). */
  days: number;
  effectiveDate?: string;
  expiresOn?: string | null;
  sourceType: string;
  sourceId?: string | null;
  /** Idempotency token: a second post with the same (employee, type, year, entry, source type, key) is ignored. */
  sourceKey?: string | null;
  reversesEntryId?: string | null;
  reason?: string | null;
  createdBy?: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDate(value: any): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): LeaveLedgerEntryView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveType: row.leave_type,
    year: row.year,
    entryType: row.entry_type,
    days: Number(row.days),
    effectiveDate: toDate(row.effective_date),
    expiresOn: row.expires_on ? toDate(row.expires_on) : null,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversesEntryId: row.reverses_entry_id,
    reason: row.reason,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Gap Register TLM-02 - the leave ledger.
 *
 * Every change to a leave balance is an append-only `leave_ledger` row with its source (a
 * leave request, the accrual job, an HR adjustment, the legacy backfill). `leave_balances`
 * is a DERIVED summary re-computed from the ledger by `refreshBalance()` after each post, so
 * a balance can always be explained, audited and reversed (a reversal is a new row pointing
 * at the entry it reverses; a deduction can be reversed once).
 *
 *   entitled_days = opening + accrual + carry_forward + adjustment + encashment(-) + expiry(-)
 *   used_days     = -(deduction + reversal)
 */
@Injectable()
export class LeaveLedgerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  /** Appends one entry (idempotent when `sourceKey` is given) and re-derives the balance. */
  async post(client: PoolClient, e: LedgerPost): Promise<{ id: string | null; inserted: boolean }> {
    const r = await client.query(
      `INSERT INTO leave_ledger
         (company_id, employee_id, leave_type, year, entry_type, days, effective_date, expires_on,
          source_type, source_id, source_key, reverses_entry_id, reason, created_by_user_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE),$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        e.companyId,
        e.employeeId,
        e.leaveType,
        e.year,
        e.entryType,
        e.days,
        e.effectiveDate ?? null,
        e.expiresOn ?? null,
        e.sourceType,
        e.sourceId ?? null,
        e.sourceKey ?? null,
        e.reversesEntryId ?? null,
        e.reason ?? null,
        e.createdBy ?? null,
      ]
    );
    await this.refreshBalance(client, e.companyId, e.employeeId, e.leaveType, e.year);
    return { id: r.rows[0]?.id ?? null, inserted: (r.rowCount ?? 0) > 0 };
  }

  /** Re-derives the leave_balances summary row from the ledger (creating it when absent). */
  async refreshBalance(client: PoolClient, companyId: string, employeeId: string, leaveType: string, year: number): Promise<void> {
    await client.query(
      `INSERT INTO leave_balances
         (company_id, employee_id, leave_type, year, entitled_days, used_days,
          opening_days, accrued_days, carried_forward_days, adjusted_days, encashed_days, expired_days)
       SELECT $1, $2, $3, $4,
         COALESCE(SUM(days) FILTER (WHERE entry_type IN ('opening','accrual','carry_forward','adjustment','encashment','expiry')), 0),
         -COALESCE(SUM(days) FILTER (WHERE entry_type IN ('deduction','reversal')), 0),
         COALESCE(SUM(days) FILTER (WHERE entry_type = 'opening'), 0),
         COALESCE(SUM(days) FILTER (WHERE entry_type = 'accrual'), 0),
         COALESCE(SUM(days) FILTER (WHERE entry_type = 'carry_forward'), 0),
         COALESCE(SUM(days) FILTER (WHERE entry_type = 'adjustment'), 0),
         -COALESCE(SUM(days) FILTER (WHERE entry_type = 'encashment'), 0),
         -COALESCE(SUM(days) FILTER (WHERE entry_type = 'expiry'), 0)
       FROM leave_ledger WHERE employee_id = $2 AND leave_type = $3 AND year = $4
       ON CONFLICT (employee_id, leave_type, year) DO UPDATE SET
         entitled_days = EXCLUDED.entitled_days, used_days = EXCLUDED.used_days,
         opening_days = EXCLUDED.opening_days, accrued_days = EXCLUDED.accrued_days,
         carried_forward_days = EXCLUDED.carried_forward_days, adjusted_days = EXCLUDED.adjusted_days,
         encashed_days = EXCLUDED.encashed_days, expired_days = EXCLUDED.expired_days, updated_at = now()`,
      [companyId, employeeId, leaveType, year]
    );
  }

  /**
   * The balance row for (employee, type, year), created from the policy entitlement the
   * first time it is needed: `upfront` posts the whole year as an opening entry, `monthly`
   * posts the months elapsed so far (the accrual job posts the rest), `none` starts at 0
   * (e.g. compensatory off, earned through ledger entries). An existing row is returned
   * untouched, except a zero-entitlement row for a type the policy now grants days for, which
   * is topped up (LIVE-18).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ensureBalance(
    client: PoolClient,
    companyId: string,
    employeeId: string,
    leaveType: string,
    year: number,
    entitlement: { days: number; method: AccrualMethod },
    asOf: string = localToday()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const existing = await client.query("SELECT * FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3", [employeeId, leaveType, year]);
    // LIVE-18: a row that was created at 0 before a policy gave this person an entitlement is topped up from the
    // policy now. Posting is idempotent per source key, so a balance that already has its entitlement is untouched.
    // The row can also exist because a year-end carry-forward was posted into it before the first request of the year, so
    // "needs its entitlement" means: no opening / accrual entry has been posted for it yet (a carry-forward alone does not count).
    let needsEntitlement = false;
    if ((existing.rowCount ?? 0) > 0 && entitlement.days > 0 && entitlement.method !== "none") {
      if (Number(existing.rows[0].entitled_days) === 0) needsEntitlement = true;
      else {
        const granted = await client.query(
          "SELECT 1 FROM leave_ledger WHERE employee_id = $1 AND leave_type = $2 AND year = $3 AND entry_type IN ('opening','accrual') LIMIT 1",
          [employeeId, leaveType, year]
        );
        needsEntitlement = (granted.rowCount ?? 0) === 0 && Number(existing.rows[0].carried_forward_days ?? 0) > 0;
      }
    }
    if ((existing.rowCount ?? 0) > 0 && !needsEntitlement) return existing.rows[0];
    if (entitlement.days > 0) {
      if (entitlement.method === "upfront") {
        await this.post(client, {
          companyId, employeeId, leaveType, year, entryType: "opening", days: entitlement.days,
          effectiveDate: `${year}-01-01`, sourceType: "policy", sourceKey: `policy:${year}`,
          reason: "Annual entitlement from the leave policy",
        });
      } else if (entitlement.method === "monthly") {
        const through = Number(asOf.slice(0, 4)) === year ? Number(asOf.slice(5, 7)) : Number(asOf.slice(0, 4)) > year ? 12 : 0;
        for (let m = 1; m <= through; m++) {
          await this.accrueMonth(client, companyId, employeeId, leaveType, year, m, entitlement.days);
        }
      }
    }
    await this.refreshBalance(client, companyId, employeeId, leaveType, year);
    const created = await client.query("SELECT * FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3", [employeeId, leaveType, year]);
    return created.rows[0];
  }

  /** One month's accrual of a yearly entitlement; idempotent per (employee, type, year, month). */
  async accrueMonth(client: PoolClient, companyId: string, employeeId: string, leaveType: string, year: number, month: number, yearlyDays: number): Promise<boolean> {
    const monthly = round2(yearlyDays / 12);
    // The last month absorbs the rounding remainder so the year adds up to the entitlement exactly.
    const days = month === 12 ? round2(yearlyDays - monthly * 11) : monthly;
    if (days <= 0) return false;
    const mm = String(month).padStart(2, "0");
    const r = await this.post(client, {
      companyId, employeeId, leaveType, year, entryType: "accrual", days,
      effectiveDate: `${year}-${mm}-01`, sourceType: "accrual_job", sourceKey: `${year}-${mm}`,
      reason: `Monthly accrual ${year}-${mm}`,
    });
    return r.inserted;
  }

  /** Records approved leave against the balance (idempotent per request). */
  async deduct(client: PoolClient, p: { companyId: string; employeeId: string; leaveType: string; year: number; days: number; leaveRequestId: string; createdBy?: string | null }): Promise<void> {
    await this.post(client, {
      companyId: p.companyId, employeeId: p.employeeId, leaveType: p.leaveType, year: p.year, entryType: "deduction",
      days: -p.days, sourceType: "leave_request", sourceId: p.leaveRequestId, sourceKey: `approved:${p.leaveRequestId}`,
      reason: "Approved leave", createdBy: p.createdBy,
    });
  }

  /** Reverses every not-yet-reversed deduction of a source (e.g. a cancelled approved leave request). */
  async reverseSource(client: PoolClient, companyId: string, sourceType: string, sourceId: string, reason: string, createdBy?: string | null): Promise<number> {
    const open = await client.query(
      `SELECT d.* FROM leave_ledger d
        WHERE d.company_id = $1 AND d.source_type = $2 AND d.source_id = $3 AND d.entry_type = 'deduction'
          AND NOT EXISTS (SELECT 1 FROM leave_ledger r WHERE r.reverses_entry_id = d.id)`,
      [companyId, sourceType, sourceId]
    );
    for (const d of open.rows) {
      await this.post(client, {
        companyId, employeeId: d.employee_id, leaveType: d.leave_type, year: d.year, entryType: "reversal",
        days: -Number(d.days), sourceType, sourceId, reversesEntryId: d.id, reason, createdBy,
      });
    }
    return open.rowCount ?? 0;
  }

  // --- HR-facing -------------------------------------------------------------

  async adjust(claims: RequestClaims, input: AdjustLeaveBalanceRequest): Promise<{ entitledDays: number; usedDays: number; remainingDays: number }> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "leave_request.manage.all"))) {
      throw new ForbiddenException("Not permitted to adjust leave balances");
    }
    if (!input.reason?.trim()) throw new BadRequestException("An adjustment needs a reason");
    if (!Number.isFinite(input.days) || input.days === 0) throw new BadRequestException("An adjustment needs a non-zero number of days");
    const year = input.year ?? Number(localToday().slice(0, 4));
    return this.db.withClaims(claims, async (client) => {
      const emp = await client.query("SELECT company_id FROM employees WHERE id = $1", [input.employeeId]);
      if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
      const type = await client.query("SELECT tracks_balance FROM leave_types WHERE company_id = $1 AND code = $2", [emp.rows[0].company_id, input.leaveType]);
      if (type.rowCount === 0) throw new BadRequestException(`Unknown leave type "${input.leaveType}"`);
      if (!type.rows[0].tracks_balance) throw new BadRequestException("This leave type does not keep a balance");
      await this.refreshBalance(client, emp.rows[0].company_id, input.employeeId, input.leaveType, year);
      const bal = await client.query("SELECT entitled_days, used_days FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3", [input.employeeId, input.leaveType, year]);
      const nextEntitled = Number(bal.rows[0].entitled_days) + input.days;
      if (nextEntitled < Number(bal.rows[0].used_days)) {
        throw new BadRequestException("The adjustment would leave the balance below the days already used");
      }
      await this.post(client, {
        companyId: emp.rows[0].company_id, employeeId: input.employeeId, leaveType: input.leaveType, year,
        entryType: "adjustment", days: round2(input.days), sourceType: "manual_adjustment", reason: input.reason.trim(), createdBy: claims.sub,
      });
      await this.audit.record(client, claims, {
        companyId: emp.rows[0].company_id,
        action: "leave_balance.adjust",
        target: input.employeeId,
        reason: input.reason.trim(),
        metadata: { leaveType: input.leaveType, year, days: input.days },
      });
      const after = await client.query("SELECT entitled_days, used_days FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3", [input.employeeId, input.leaveType, year]);
      const entitledDays = Number(after.rows[0].entitled_days);
      const usedDays = Number(after.rows[0].used_days);
      return { entitledDays, usedDays, remainingDays: entitledDays - usedDays };
    });
  }

  /** The audit trail of one employee's leave balance, newest first. */
  async history(claims: RequestClaims, employeeId: string, filter?: { leaveType?: string; year?: number }): Promise<LeaveLedgerEntryView[]> {
    await this.requireModule(claims);
    const canAll = await this.rbac.can(claims, "leave_request.manage.all");
    return this.db.withClaims(claims, async (client) => {
      const emp = await client.query(
        `SELECT e.user_account_id, mgr.user_account_id AS manager_user_account_id
           FROM employees e LEFT JOIN employees mgr ON mgr.id = e.manager_id WHERE e.id = $1`,
        [employeeId]
      );
      if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
      const scope = await this.rbac.resolveViewScope(claims, "leave_request.view");
      const visible =
        canAll || scope.hasAll ||
        (scope.hasSelf && emp.rows[0].user_account_id === claims.sub) ||
        (scope.hasTeam && emp.rows[0].manager_user_account_id === claims.sub);
      if (!visible) throw new NotFoundException("Employee not found");
      const r = await client.query(
        `SELECT * FROM leave_ledger WHERE employee_id = $1 AND ($2::text IS NULL OR leave_type = $2) AND ($3::int IS NULL OR year = $3)
          ORDER BY created_at DESC, id DESC LIMIT 500`,
        [employeeId, filter?.leaveType ?? null, filter?.year ?? null]
      );
      return r.rows.map(rowToEntry);
    });
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }
}
