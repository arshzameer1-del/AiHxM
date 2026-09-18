import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CreateHolidayRequest, HolidayView, UpdateHolidayRequest } from "@boostfactor/shared-types";

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
      const existing = await client.query(
        "SELECT 1 FROM holidays WHERE company_id = $1 AND holiday_date = $2 AND name = $3",
        [claims.company_id, input.holidayDate, input.name]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`A holiday named "${input.name}" on ${input.holidayDate} already exists`);
      }
      const result = await client.query(
        `INSERT INTO holidays (company_id, name, holiday_date, is_optional)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [claims.company_id, input.name, input.holidayDate, input.isOptional ?? false]
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

      const result = await client.query(
        `UPDATE holidays SET name = $2, holiday_date = $3, is_optional = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, input.name ?? row.name, input.holidayDate ?? row.holiday_date, input.isOptional ?? row.is_optional]
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
  async listHolidays(claims: RequestClaims, year?: string): Promise<HolidayView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = year
        ? await client.query(
            "SELECT * FROM holidays WHERE company_id = $1 AND EXTRACT(YEAR FROM holiday_date) = $2 ORDER BY holiday_date",
            [claims.company_id, year]
          )
        : await client.query("SELECT * FROM holidays WHERE company_id = $1 ORDER BY holiday_date", [
            claims.company_id,
          ]);
      return result.rows.map(rowToHoliday);
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
  async getHolidayOnDate(client: PoolClient, companyId: string, dateIso: string): Promise<{ name: string; isOptional: boolean } | null> {
    const result = await client.query<{ name: string; is_optional: boolean }>(
      `SELECT name, is_optional FROM holidays WHERE company_id = $1 AND holiday_date = $2`,
      [companyId, dateIso]
    );
    if (result.rowCount === 0) return null;
    return { name: result.rows[0].name, isOptional: result.rows[0].is_optional };
  }
}
