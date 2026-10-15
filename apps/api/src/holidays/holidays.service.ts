import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CreateHolidayRequest, HolidayView, RollHolidaysForwardRequest, UpdateHolidayRequest } from "@aihxm/shared-types";

// Reuses the `leave` module's entitlement, same reasoning as Shift
// Management (0026) and Attendance Corrections (0028) — see
// 0030_holiday_management.sql's own header comment.
const MODULE_KEY = "leave" as const;
const MANAGE_PERMISSION = "holiday.manage.all";
const VIEW_PERMISSION = "holiday.view.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToHoliday(row: any): HolidayView {
  return {
    id: row.id,
    name: row.name,
    holidayDate: row.holiday_date instanceof Date ? row.holiday_date.toISOString().slice(0, 10) : row.holiday_date,
    isOptional: row.is_optional,
    calendarId: row.calendar_id ?? null,
    isGazetted: row.is_gazetted ?? false,
    dateBasis: row.date_basis ?? "fixed",
    isTentative: row.is_tentative ?? false,
  };
}

/**
 * The Holiday Management calendar — see 0030_holiday_management.sql for
 * the full design reasoning. Deliberately a standalone module (unlike
 * Attendance Corrections, colocated inside `leave/`): a holiday is a
 * company-wide calendar fact Leave, Attendance, and eventually Payroll
 * will all need to read, not a sub-feature of any single one of them.
 *
 * Unlike Shift Management's split view permissions (view.self/view.team),
 * there is exactly one view permission here (`holiday.view.all`) because
 * every employee already needs to see the same calendar — see the seed
 * migration's own comment on why this is granted broadly rather than
 * scoped per-role.
 */
function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

@Injectable()
export class HolidaysService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  private async requireManage(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage the holiday calendar");
    }
  }

  private async requireView(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    // Management implies view — no separate grant needed for hr_admin,
    // same "manage implies view" shape ShiftsService.requireViewAccess
    // uses via its own canAll check.
    const canManage = await this.rbac.can(claims, MANAGE_PERMISSION);
    if (canManage) return;
    if (!(await this.rbac.can(claims, VIEW_PERMISSION))) {
      throw new ForbiddenException("Not permitted to view the holiday calendar");
    }
  }

  async createHoliday(claims: RequestClaims, input: CreateHolidayRequest): Promise<HolidayView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const calendarId = input.calendarId ?? null;
      await this.assertCalendar(client, claims.company_id!, calendarId);
      const existing = await client.query(
        "SELECT 1 FROM holidays WHERE company_id = $1 AND holiday_date = $2 AND name = $3 AND calendar_id IS NOT DISTINCT FROM $4",
        [claims.company_id, input.holidayDate, input.name, calendarId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`A holiday named "${input.name}" on ${input.holidayDate} already exists${calendarId ? " in this calendar" : ""}`);
      }
      const result = await client.query(
        `INSERT INTO holidays (company_id, name, holiday_date, is_optional, calendar_id, is_gazetted, date_basis, is_tentative)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, input.name, input.holidayDate, input.isOptional ?? false, calendarId, input.isGazetted ?? false, input.dateBasis ?? "fixed", input.isTentative ?? false]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "holiday.create",
        target: result.rows[0].id,
        metadata: { name: input.name, holidayDate: input.holidayDate },
      });
      return rowToHoliday(result.rows[0]);
    });
  }

  async updateHoliday(claims: RequestClaims, id: string, input: UpdateHolidayRequest): Promise<HolidayView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM holidays WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Holiday not found");
      const row = current.rows[0];

      const calendarId = input.calendarId !== undefined ? input.calendarId : row.calendar_id;
      if (input.calendarId !== undefined) await this.assertCalendar(client, claims.company_id!, calendarId);
      const name = input.name ?? row.name;
      const holidayDate = input.holidayDate ?? row.holiday_date;
      const clash = await client.query(
        "SELECT 1 FROM holidays WHERE company_id = $1 AND holiday_date = $2 AND name = $3 AND calendar_id IS NOT DISTINCT FROM $4 AND id <> $5",
        [claims.company_id, holidayDate, name, calendarId, id]
      );
      if ((clash.rowCount ?? 0) > 0) throw new ConflictException(`A holiday named "${name}" on that date already exists${calendarId ? " in this calendar" : ""}`);
      const result = await client.query(
        `UPDATE holidays SET name = $2, holiday_date = $3, is_optional = $4, calendar_id = $5,
                is_gazetted = $6, date_basis = $7, is_tentative = $8, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, name, holidayDate, input.isOptional ?? row.is_optional, calendarId,
         input.isGazetted ?? row.is_gazetted, input.dateBasis ?? row.date_basis,
         // confirming or moving the date of a moon-dependent holiday clears "tentative" unless said otherwise
         input.isTentative ?? (input.holidayDate !== undefined ? false : row.is_tentative)]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "holiday.update",
        target: id,
      });
      return rowToHoliday(result.rows[0]);
    });
  }

  async deleteHoliday(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      // No FK dependents from any other table reference holidays yet
      // (see the migration's header comment) — a hard delete is safe
      // and is a real, legitimate need for correcting a wrongly-entered
      // date, unlike e.g. a leave request, which is never hard-deleted.
      const result = await client.query("DELETE FROM holidays WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Holiday not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "holiday.delete",
        target: id,
      });
    });
  }

  /** `year` (e.g. "2026") optionally narrows the calendar to one year. */
  async listHolidays(claims: RequestClaims, year?: string, calendarId?: string): Promise<HolidayView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const params: unknown[] = [claims.company_id];
      let where = "company_id = $1";
      if (year) {
        params.push(year);
        where += ` AND EXTRACT(YEAR FROM holiday_date) = $${params.length}`;
      }
      // "company" = the company-wide holidays only; a uuid = that calendar's; omitted = everything
      if (calendarId === "company") where += " AND calendar_id IS NULL";
      else if (calendarId) {
        params.push(calendarId);
        where += ` AND calendar_id = $${params.length}`;
      }
      const result = await client.query(`SELECT * FROM holidays WHERE ${where} ORDER BY holiday_date, name`, params);
      return result.rows.map(rowToHoliday);
    });
  }

  private async assertCalendar(client: PoolClient, companyId: string, calendarId: string | null): Promise<void> {
    if (!calendarId) return;
    const r = await client.query("SELECT status FROM holiday_calendars WHERE id = $1 AND company_id = $2", [calendarId, companyId]);
    if (r.rowCount === 0) throw new NotFoundException("Holiday calendar not found");
    if (r.rows[0].status !== "active") throw new ConflictException("That holiday calendar is archived");
  }

  /**
   * Copies one year's holidays into another so the new year starts populated. Fixed-date
   * holidays keep their month and day; lunar ones (Eid, Muharram...) are copied at the same
   * Gregorian date but flagged tentative - HR moves each to the announced date, which clears the
   * flag. A holiday that already exists in the target year is left alone, so this is safe to run twice.
   */
  async rollForward(claims: RequestClaims, input: RollHolidaysForwardRequest): Promise<{ created: number; skipped: number; tentative: number }> {
    await this.requireManage(claims);
    if (input.toYear === input.fromYear) throw new ConflictException("Choose two different years");
    return this.db.withClaims(claims, async (client) => {
      const calendarId = input.calendarId ?? null;
      if (calendarId) await this.assertCalendar(client, claims.company_id!, calendarId);
      const source = await client.query(
        `SELECT * FROM holidays WHERE company_id = $1 AND EXTRACT(YEAR FROM holiday_date) = $2 AND calendar_id IS NOT DISTINCT FROM $3 ORDER BY holiday_date`,
        [claims.company_id, input.fromYear, calendarId]
      );
      let created = 0;
      let skipped = 0;
      let tentative = 0;
      for (const h of source.rows) {
        const src = (h.holiday_date instanceof Date ? h.holiday_date.toISOString() : String(h.holiday_date)).slice(5, 10);
        // 29 Feb has no equivalent in a non-leap target year; it lands on 28 Feb
        const target = src === "02-29" && !isLeapYear(input.toYear) ? "02-28" : src;
        const date = `${input.toYear}-${target}`;
        const isLunar = h.date_basis === "lunar";
        const r = await client.query(
          `INSERT INTO holidays (company_id, name, holiday_date, is_optional, calendar_id, is_gazetted, date_basis, is_tentative)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (company_id, COALESCE(calendar_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date, name) DO NOTHING`,
          [claims.company_id, h.name, date, h.is_optional, calendarId, h.is_gazetted, h.date_basis, isLunar]
        );
        if ((r.rowCount ?? 0) > 0) {
          created++;
          if (isLunar) tentative++;
        } else skipped++;
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "holiday.roll_forward",
        metadata: { fromYear: input.fromYear, toYear: input.toYear, calendarId, created, skipped, tentative },
      });
      return { created, skipped, tentative };
    });
  }

  /**
   * The cross-module entry point this module's own header comment
   * anticipated ("exported for future integration work — leave day-count
   * calculation, attendance absence detection") — LeaveRequestsService
   * calls this directly, the same "take an already-scoped `client` from
   * the caller's own transaction rather than opening a second one" shape
   * ShiftsService.resolveForEmployeeOnDate() already established for the
   * identical kind of cross-module read.
   *
   * Deliberately counts only NON-optional (mandatory) holidays: an
   * optional holiday is the employee's own choice to take or not, so a
   * leave request that happens to span one shouldn't silently shrink in
   * length — this codebase has no way to know whether that specific
   * employee would have worked that day or not, and guessing either way
   * would be a real policy decision this increment isn't making. `start`/
   * `end` are inclusive, same convention `inclusiveDayCount` already uses
   * in leave-requests.service.ts.
   */
  async countMandatoryHolidaysInRange(client: PoolClient, companyId: string, start: string, end: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM holidays
       WHERE company_id = $1 AND holiday_date BETWEEN $2 AND $3 AND NOT is_optional`,
      [companyId, start, end]
    );
    return Number(result.rows[0].count);
  }

  /**
   * Single-date lookup — the `isHoliday()` piece Section 20 of the Work
   * Schedule architecture names as a WorkScheduleResolutionService
   * responsibility. Deliberately a thin, separate query rather than
   * reusing `countMandatoryHolidaysInRange` (which also deliberately
   * excludes optional holidays and returns a count, not identity) —
   * the resolution service needs to know WHICH holiday and whether it's
   * optional, not just whether one exists.
   */
  async getHolidayOnDate(client: PoolClient, companyId: string, dateIso: string, employeeId?: string): Promise<{ name: string; isOptional: boolean } | null> {
    // TLM-10: company-wide holidays (no calendar) apply to everyone. A calendar's holidays apply to
    // the employees it is scoped to - its locations (and their sub-locations) or org units; a calendar
    // with no scope applies to everyone. Without an employee only the company-wide ones are considered
    // plus unscoped calendars. A mandatory holiday outranks an optional one on the same date.
    const result = await client.query<{ name: string; is_optional: boolean }>(
      `WITH RECURSIVE loc AS (
         SELECT location_id AS id FROM employees WHERE id = $3::uuid AND location_id IS NOT NULL
         UNION
         SELECT l.parent_id FROM locations l JOIN loc ON l.id = loc.id WHERE l.parent_id IS NOT NULL
       )
       SELECT h.name, h.is_optional FROM holidays h
         LEFT JOIN holiday_calendars c ON c.id = h.calendar_id
        WHERE h.company_id = $1 AND h.holiday_date = $2
          AND (h.calendar_id IS NULL OR (c.status = 'active' AND (
                NOT EXISTS (SELECT 1 FROM holiday_calendar_applicability a WHERE a.calendar_id = c.id)
                OR ($3::uuid IS NOT NULL AND EXISTS (
                     SELECT 1 FROM holiday_calendar_applicability a
                      LEFT JOIN employees e ON e.id = $3::uuid
                      WHERE a.calendar_id = c.id
                        AND ((a.org_unit_id IS NOT NULL AND a.org_unit_id = e.org_unit_id)
                          OR (a.location_id IS NOT NULL AND a.location_id IN (SELECT id FROM loc))))))))
        ORDER BY h.is_optional ASC, h.calendar_id NULLS FIRST
        LIMIT 1`,
      [companyId, dateIso, employeeId ?? null]
    );
    if (result.rowCount === 0) return null;
    return { name: result.rows[0].name, isOptional: result.rows[0].is_optional };
  }
}
