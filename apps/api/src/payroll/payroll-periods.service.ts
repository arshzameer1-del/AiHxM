import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  CreatePayrollCalendarRequest,
  GeneratePayrollPeriodsRequest,
  GeneratePayrollPeriodsResponse,
  PayrollCalendarView,
  PayrollFrequency,
  PayrollPeriodStatus,
  PayrollPeriodView,
  UpdatePayrollCalendarRequest,
} from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { currentCorrelationId } from "../common/request-context";

const MODULE_KEY = "payroll" as const;
const MANAGE = "payroll_calendar.manage.all";
const VIEW_PERMISSIONS = [MANAGE, "payroll.calculate.all", "payroll.calculate.scoped", "payroll.finalize.all", "payroll.finalize.scoped", "payroll.approve.all", "payroll.disburse.all"];
const FREQUENCIES: PayrollFrequency[] = ["monthly", "semi_monthly", "bi_weekly", "weekly"];
/** Run states in which a run is still being prepared or settled; a period cannot close over them. */
const OPEN_RUN_STATUSES = ["draft", "pre_validated", "calculating", "calculated", "validated", "pending_approval", "approved", "finalized", "accounting", "payment_released", "reconciled", "reopened"];

const MS_DAY = 86_400_000;
const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fmt(new Date(parse(iso).getTime() + n * MS_DAY));
const lastOfMonth = (y: number, m0: number) => fmt(new Date(Date.UTC(y, m0 + 1, 0)));
const iso = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : fmt(v as Date));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ts = (v: any): string | null => (v ? (v.toISOString ? v.toISOString() : v) : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCalendar(row: any): PayrollCalendarView {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    name: row.name,
    frequency: row.frequency,
    currencyCode: row.currency_code,
    payDayOffset: row.pay_day_offset,
    cutoffDaysBeforeEnd: row.cutoff_days_before_end,
    isActive: row.is_active,
    periodCount: Number(row.period_count ?? 0),
    createdAt: ts(row.created_at)!,
    updatedAt: ts(row.updated_at)!,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPeriod(row: any): PayrollPeriodView {
  return {
    id: row.id,
    companyId: row.company_id,
    calendarId: row.calendar_id,
    calendarCode: row.calendar_code,
    label: row.label,
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    payDate: iso(row.pay_date),
    cutoffDate: iso(row.cutoff_date),
    status: row.status,
    lockedAt: ts(row.locked_at),
    closedAt: ts(row.closed_at),
    runCount: Number(row.run_count ?? 0),
  };
}

export type PeriodForRun = { id: string; calendarId: string; periodStart: string; periodEnd: string; status: PayrollPeriodStatus };

/**
 * PAY-03 - may a NEW run be created from this period?
 *  open   - any run
 *  locked - off-cycle runs only (the regular cycle has been cut off)
 *  closed - nothing
 * A corrective run opened by a reversal never goes through here: it takes over the reversed run's slot.
 */
export function assertPeriodAcceptsRun(period: { status: PayrollPeriodStatus; label?: string }, runType: "regular" | "off_cycle"): void {
  if (period.status === "closed") {
    throw new BadRequestException(`Payroll period ${period.label ?? ""} is closed; reopen it before creating another run`.replace("  ", " "));
  }
  if (period.status === "locked" && runType === "regular") {
    throw new BadRequestException(`Payroll period ${period.label ?? ""} is locked; only off-cycle runs can be created, or unlock the period`.replace("  ", " "));
  }
}

/** Loads a period for a run being created and validates it against the area and the dates the caller supplied. */
export async function resolvePeriodForRun(
  client: PoolClient,
  companyId: string,
  periodId: string,
  opts: { runType: "regular" | "off_cycle"; payrollAreaId: string | null; periodStart?: string; periodEnd?: string }
): Promise<PeriodForRun> {
  const r = await client.query(
    `SELECT id, calendar_id, label, period_start, period_end, status FROM payroll_periods WHERE id = $1 AND company_id = $2`,
    [periodId, companyId]
  );
  if (r.rowCount === 0) throw new NotFoundException("Payroll period not found");
  const period = { id: r.rows[0].id as string, calendarId: r.rows[0].calendar_id as string, label: r.rows[0].label as string, periodStart: iso(r.rows[0].period_start), periodEnd: iso(r.rows[0].period_end), status: r.rows[0].status as PayrollPeriodStatus };
  assertPeriodAcceptsRun(period, opts.runType);
  if ((opts.periodStart && opts.periodStart !== period.periodStart) || (opts.periodEnd && opts.periodEnd !== period.periodEnd)) {
    throw new BadRequestException(`periodStart/periodEnd must equal the payroll period's own dates (${period.periodStart} to ${period.periodEnd}), or be left out`);
  }
  if (opts.payrollAreaId) {
    const area = await client.query<{ calendar_id: string | null }>("SELECT calendar_id FROM payroll_areas WHERE id = $1", [opts.payrollAreaId]);
    const areaCalendar = area.rows[0]?.calendar_id ?? null;
    if (areaCalendar && areaCalendar !== period.calendarId) {
      throw new BadRequestException("This payroll period belongs to a different calendar than the payroll area uses");
    }
  }
  return period;
}

/**
 * PAY-03 - payroll calendars and the periods generated from them. A period is the unit a regular run is created
 * for; periods of one calendar can never overlap (database exclusion constraint), and a period moves
 * open -> locked -> closed. No statutory value lives here.
 */
@Injectable()
export class PayrollPeriodsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------------ calendars

  async listCalendars(claims: RequestClaims, opts: { includeInactive?: boolean } = {}): Promise<PayrollCalendarView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT c.*, (SELECT COUNT(*) FROM payroll_periods p WHERE p.calendar_id = c.id) AS period_count
           FROM payroll_calendars c WHERE c.company_id = $1 ${opts.includeInactive ? "" : "AND c.is_active"} ORDER BY c.code`,
        [claims.company_id]
      );
      return r.rows.map(rowToCalendar);
    });
  }

  async createCalendar(claims: RequestClaims, input: CreatePayrollCalendarRequest): Promise<PayrollCalendarView> {
    await this.requireManage(claims);
    const code = input.code?.trim();
    const name = input.name?.trim();
    if (!code) throw new BadRequestException("code is required");
    if (!name) throw new BadRequestException("name is required");
    const frequency = input.frequency ?? "monthly";
    if (!FREQUENCIES.includes(frequency)) throw new BadRequestException(`frequency must be one of ${FREQUENCIES.join(", ")}`);
    const currency = input.currencyCode ?? "PKR";
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException("currencyCode must be a three-letter ISO code");
    return this.db.withClaims(claims, async (client) => {
      const dup = await client.query("SELECT 1 FROM payroll_calendars WHERE company_id = $1 AND code = $2", [claims.company_id, code]);
      if (dup.rowCount) throw new ConflictException(`A payroll calendar with code "${code}" already exists`);
      const r = await client.query(
        `INSERT INTO payroll_calendars (company_id, code, name, frequency, currency_code, pay_day_offset, cutoff_days_before_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [claims.company_id, code, name, frequency, currency, input.payDayOffset ?? 0, input.cutoffDaysBeforeEnd ?? 0]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_calendar.create", target: r.rows[0].id, metadata: { code, frequency } });
      return rowToCalendar(r.rows[0]);
    });
  }

  async updateCalendar(claims: RequestClaims, id: string, patch: UpdatePayrollCalendarRequest): Promise<PayrollCalendarView> {
    await this.requireManage(claims);
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestException("name cannot be blank");
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT id FROM payroll_calendars WHERE id = $1 AND company_id = $2", [id, claims.company_id]);
      if (cur.rowCount === 0) throw new NotFoundException("Payroll calendar not found");
      const r = await client.query(
        `UPDATE payroll_calendars SET name = COALESCE($2, name), pay_day_offset = COALESCE($3, pay_day_offset),
                cutoff_days_before_end = COALESCE($4, cutoff_days_before_end), is_active = COALESCE($5, is_active), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, patch.name?.trim() ?? null, patch.payDayOffset ?? null, patch.cutoffDaysBeforeEnd ?? null, patch.isActive ?? null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_calendar.update", target: id, metadata: { ...patch } });
      return rowToCalendar(r.rows[0]);
    });
  }

  // ------------------------------------------------------------------ periods

  async listPeriods(claims: RequestClaims, filter: { calendarId?: string; status?: PayrollPeriodStatus; year?: number } = {}): Promise<PayrollPeriodView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const where = ["p.company_id = $1"];
      const values: unknown[] = [claims.company_id];
      if (filter.calendarId) { values.push(filter.calendarId); where.push(`p.calendar_id = $${values.length}`); }
      if (filter.status) { values.push(filter.status); where.push(`p.status = $${values.length}`); }
      if (filter.year) { values.push(filter.year); where.push(`EXTRACT(YEAR FROM p.period_start) = $${values.length}`); }
      const r = await client.query(
        `SELECT p.*, c.code AS calendar_code,
                (SELECT COUNT(*) FROM payroll_runs pr WHERE pr.payroll_period_id = p.id AND pr.status <> 'cancelled' AND pr.is_simulation = false) AS run_count
           FROM payroll_periods p JOIN payroll_calendars c ON c.id = p.calendar_id
          WHERE ${where.join(" AND ")} ORDER BY p.period_start DESC, c.code LIMIT 500`,
        values
      );
      return r.rows.map(rowToPeriod);
    });
  }

  /**
   * Generates consecutive periods from `fromDate`. monthly and semi_monthly must start on the 1st
   * (semi_monthly also on the 16th); weekly and bi_weekly may start on any day. Re-running is safe:
   * a period that already exists, or overlaps one, is reported as skipped rather than duplicated.
   */
  async generatePeriods(claims: RequestClaims, calendarId: string, input: GeneratePayrollPeriodsRequest): Promise<GeneratePayrollPeriodsResponse> {
    await this.requireManage(claims);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate)) throw new BadRequestException("fromDate must be an ISO date (YYYY-MM-DD)");
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 60) throw new BadRequestException("count must be a whole number from 1 to 60");
    return this.db.withClaims(claims, async (client) => {
      const cal = await client.query("SELECT * FROM payroll_calendars WHERE id = $1 AND company_id = $2", [calendarId, claims.company_id]);
      if (cal.rowCount === 0) throw new NotFoundException("Payroll calendar not found");
      const calendar = cal.rows[0];
      if (!calendar.is_active) throw new BadRequestException("This payroll calendar is inactive");
      const start0 = parse(input.fromDate);
      if (Number.isNaN(start0.getTime())) throw new BadRequestException("fromDate is not a real date");
      const day = start0.getUTCDate();
      if (calendar.frequency === "monthly" && day !== 1) throw new BadRequestException("A monthly calendar's first period must start on the 1st");
      if (calendar.frequency === "semi_monthly" && day !== 1 && day !== 16) throw new BadRequestException("A semi-monthly calendar's first period must start on the 1st or the 16th");

      const created: PayrollPeriodView[] = [];
      const skipped: GeneratePayrollPeriodsResponse["skipped"] = [];
      let start = input.fromDate;
      for (let i = 0; i < input.count; i += 1) {
        const [end, label, next] = this.nextPeriod(calendar.frequency as PayrollFrequency, start);
        const payDate = addDays(end, calendar.pay_day_offset);
        const cutoff = addDays(end, -calendar.cutoff_days_before_end);
        const clash = await client.query<{ period_start: unknown; period_end: unknown }>(
          `SELECT period_start, period_end FROM payroll_periods WHERE calendar_id = $1 AND daterange(period_start, period_end, '[]') && daterange($2::date, $3::date, '[]') LIMIT 1`,
          [calendarId, start, end]
        );
        if (clash.rowCount) {
          const same = iso(clash.rows[0].period_start) === start && iso(clash.rows[0].period_end) === end;
          skipped.push({ periodStart: start, periodEnd: end, reason: same ? "already exists" : `overlaps the existing period ${iso(clash.rows[0].period_start)} to ${iso(clash.rows[0].period_end)}` });
        } else {
          const r = await client.query(
            `INSERT INTO payroll_periods (company_id, calendar_id, label, period_start, period_end, pay_date, cutoff_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, $8::text AS calendar_code, 0 AS run_count`,
            [claims.company_id, calendarId, label, start, end, payDate, cutoff, calendar.code]
          );
          created.push(rowToPeriod(r.rows[0]));
        }
        start = next;
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_period.generate",
        target: calendarId,
        metadata: { fromDate: input.fromDate, count: input.count, created: created.length, skipped: skipped.length },
      });
      return { created, skipped };
    });
  }

  private nextPeriod(freq: PayrollFrequency, start: string): [end: string, label: string, next: string] {
    const d = parse(start);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const ym = start.slice(0, 7);
    switch (freq) {
      case "monthly": {
        const end = lastOfMonth(y, m);
        return [end, ym, addDays(end, 1)];
      }
      case "semi_monthly": {
        if (d.getUTCDate() === 1) return [`${ym}-15`, `${ym} (1st half)`, `${ym}-16`];
        const end = lastOfMonth(y, m);
        return [end, `${ym} (2nd half)`, addDays(end, 1)];
      }
      case "bi_weekly":
        return [addDays(start, 13), `Fortnight of ${start}`, addDays(start, 14)];
      case "weekly":
      default:
        return [addDays(start, 6), `Week of ${start}`, addDays(start, 7)];
    }
  }

  async lockPeriod(claims: RequestClaims, id: string): Promise<PayrollPeriodView> {
    return this.moveStatus(claims, id, "lock", ["open"], "locked");
  }

  async unlockPeriod(claims: RequestClaims, id: string): Promise<PayrollPeriodView> {
    return this.moveStatus(claims, id, "unlock", ["locked"], "open");
  }

  /** Closing needs every real run of the period to have finished (closed, cancelled or reversed). */
  async closePeriod(claims: RequestClaims, id: string): Promise<PayrollPeriodView> {
    return this.moveStatus(claims, id, "close", ["open", "locked"], "closed");
  }

  /** The highly restricted way back: needs payroll.reopen.all and a reason. */
  async reopenPeriod(claims: RequestClaims, id: string, reason: string): Promise<PayrollPeriodView> {
    await this.requireManage(claims);
    if (!(await this.rbac.can(claims, "payroll.reopen.all"))) throw new ForbiddenException("Reopening a closed payroll period needs payroll.reopen.all");
    if (!reason || reason.trim().length < 5) throw new BadRequestException("A reason of at least 5 characters is required to reopen a period");
    return this.moveStatus(claims, id, "reopen", ["closed"], "locked", reason.trim());
  }

  private async moveStatus(claims: RequestClaims, id: string, action: string, from: PayrollPeriodStatus[], to: PayrollPeriodStatus, reason?: string): Promise<PayrollPeriodView> {
    if (action !== "reopen") await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM payroll_periods WHERE id = $1 AND company_id = $2 FOR UPDATE", [id, claims.company_id]);
      if (cur.rowCount === 0) throw new NotFoundException("Payroll period not found");
      const status = cur.rows[0].status as PayrollPeriodStatus;
      if (!from.includes(status)) throw new BadRequestException(`Cannot ${action} a payroll period that is ${status}`);
      if (to === "closed") {
        const busy = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM payroll_runs WHERE payroll_period_id = $1 AND is_simulation = false AND status = ANY($2::text[])`,
          [id, OPEN_RUN_STATUSES.filter((s) => s !== "closed")]
        );
        if (Number(busy.rows[0].n) > 0) {
          throw new BadRequestException(`${busy.rows[0].n} run(s) in this period have not been closed yet; close or cancel them first`);
        }
      }
      await client.query(
        `UPDATE payroll_periods SET status = $2,
                locked_at = CASE WHEN $2 = 'locked' THEN now() WHEN $2 = 'open' THEN NULL ELSE locked_at END,
                locked_by = CASE WHEN $2 = 'locked' THEN $3::uuid WHEN $2 = 'open' THEN NULL ELSE locked_by END,
                closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
                closed_by = CASE WHEN $2 = 'closed' THEN $3::uuid ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [id, to, claims.sub ?? null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: `payroll_period.${action}`,
        target: id,
        metadata: { from: status, to, reason: reason ?? undefined, correlationId: currentCorrelationId() ?? undefined },
      });
      const out = await client.query(
        `SELECT p.*, c.code AS calendar_code, (SELECT COUNT(*) FROM payroll_runs pr WHERE pr.payroll_period_id = p.id AND pr.status <> 'cancelled' AND pr.is_simulation = false) AS run_count
           FROM payroll_periods p JOIN payroll_calendars c ON c.id = p.calendar_id WHERE p.id = $1`,
        [id]
      );
      return rowToPeriod(out.rows[0]);
    });
  }

  // ------------------------------------------------------------------ access

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to manage payroll calendars and periods");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    for (const key of VIEW_PERMISSIONS) if (await this.rbac.can(claims, key)) return;
    throw new ForbiddenException("Not permitted to view payroll calendars and periods");
  }
}
