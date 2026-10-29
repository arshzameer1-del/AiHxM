import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { AttendanceAutoCloseService, AUTO_CLOSED_STATUS } from "./attendance-auto-close.service";
import { localParts } from "./attendance-evaluation.service";
import { AttendancePolicyService } from "./attendance-policy.service";
import type { AttendanceRecordView, ClockInRequest, ClockOutRequest, ResolvedWorkScheduleView } from "@aihxm/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;
const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Karachi";
/** An open clock-in older than this is a forgotten clock-out (LIVE-13); the web warning uses the same number. */
export const STALE_OPEN_CLOCK_IN_HOURS = 16;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value;
}

/**
 * Resolves the employee's EFFECTIVE WORKING DAY as of this punch's own
 * date — Work Schedule & Employee Schedule Assignment Architecture,
 * Section 21 ("Do not duplicate schedule logic inside Attendance") —
 * via `WorkScheduleResolutionService.resolveAttendanceStatus()`, which is
 * now the one place on-time/late/early-departure/rest-day/holiday is
 * decided. Before 2026-09-18 this compared every punch against the
 * SHIFT's flat start/end time regardless of day-of-week, which would
 * have mis-flagged a punch on a day the weekly pattern marks off (e.g.
 * Friday) as "late" against a different day's hours — see that service's
 * own doc comment. Status is never persisted onto `attendance_records` —
 * see 0026_shift_management.sql's header comment for why this stays a
 * read-time computation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rowToRecord(
  client: PoolClient,
  workSchedule: WorkScheduleResolutionService,
  row: any,
  /** A list passes one shared cache so each calendar day is resolved once instead of once per punch. */
  resolvedByDay?: Map<string, ResolvedWorkScheduleView>
): Promise<AttendanceRecordView> {
  const clockInAt: Date = row.clock_in_at;
  const clockOutAt: Date | null = row.clock_out_at;
  // The calendar day of the punch where the shift lives (not the UTC day: a 7 AM Karachi punch is still "yesterday" in UTC).
  const dateIso = localParts(clockInAt, DEFAULT_SCHEDULE_TIMEZONE).date;
  let resolved = resolvedByDay?.get(dateIso);
  if (!resolved) {
    resolved = await workSchedule.resolve(client, row.employee_id, dateIso);
    resolvedByDay?.set(dateIso, resolved);
  }
  const { status, shiftName } = workSchedule.statusFromResolved(resolved, clockInAt, clockOutAt);

  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    source: row.source,
    clockInAt: toIso(row.clock_in_at) as string,
    clockOutAt: toIso(row.clock_out_at),
    gpsLat: row.gps_lat === null ? null : Number(row.gps_lat),
    gpsLng: row.gps_lng === null ? null : Number(row.gps_lng),
    status,
    shiftName,
    autoClosed: row.derived_status === AUTO_CLOSED_STATUS,
    geofenceResult: row.geofence_result ?? "not_applicable",
    locationFlags: row.location_flags ?? [],
    hasSelfie: Boolean(row.selfie_path),
  };
}

/**
 * Phase 9's other half: biometric/GPS/manual clock-in, keyed off
 * `employee_number` per plan doc Section 5's rule that an external
 * interface (a kiosk, a biometric device, a phone GPS check-in) speaks
 * the number it scanned, never the internal UUID —
 * 0015_leave_attendance.sql's header comment has the full reasoning.
 * Lives under the same `leave` module license as leave requests — it's
 * the same module_catalog description ("...biometric/GPS clock-in") from
 * Phase 5/6's seed, not a new licensable unit.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly workSchedule: WorkScheduleResolutionService,
    private readonly autoClose: AttendanceAutoCloseService,
    // Location checks (attendance depth): optional so positional spec constructions keep working.
    private readonly policy?: AttendancePolicyService
  ) {}

  async clockIn(claims: RequestClaims, input: ClockInRequest): Promise<AttendanceRecordView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employeeResult = await client.query<{ id: string; company_id: string; user_account_id: string | null }>(
        `SELECT id, company_id, user_account_id FROM employees WHERE employee_number = $1`,
        [input.employeeNumber]
      );
      if (employeeResult.rowCount === 0) throw new NotFoundException("No employee found with that employee number");
      const employee = employeeResult.rows[0];

      const canSelf =
        employee.user_account_id === claims.sub &&
        (await this.rbac.can(claims, "attendance.record.self", { ownerId: employee.user_account_id }));
      const canAll = await this.rbac.can(claims, "attendance.record.all");
      if (!canSelf && !canAll) {
        throw new ForbiddenException("Not permitted to record attendance for this employee");
      }

      // A clock-in with no clock-out from an earlier day is closed at that day's shift end time first.
      await this.autoClose.closeForgottenForEmployee(client, claims, employee.id);

      // One clock-in and one clock-out per day: once today has a record (open or finished), no second one is started.
      const todayDate = localParts(new Date(), DEFAULT_SCHEDULE_TIMEZONE).date;
      const sameDay = await client.query<{ open: boolean }>(
        `SELECT (clock_out_at IS NULL) AS open FROM attendance_records
          WHERE employee_id = $1 AND COALESCE(work_date, (clock_in_at AT TIME ZONE 'Asia/Karachi')::date) = $2::date
          ORDER BY clock_in_at DESC LIMIT 1`,
        [employee.id, todayDate]
      );
      if ((sameDay.rowCount ?? 0) > 0) {
        throw new ConflictException(
          sameDay.rows[0].open
            ? "This employee is already clocked in — clock out first"
            : "Already clocked in and out for today. Only one clock-in and one clock-out is allowed per day; if a time is wrong, ask for an attendance correction."
        );
      }

      // LIVE-13: a clock-in left open for a day or more is a forgotten clock-out, not a live shift. It must not
      // stop the person starting today's work; it stays open (hours are never invented) and is fixed with an
      // attendance correction, which can set its clock-out.
      const open = await client.query(
        `SELECT id FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL
            AND clock_in_at > now() - make_interval(hours => $2::int)`,
        [employee.id, STALE_OPEN_CLOCK_IN_HOURS]
      );
      if ((open.rowCount ?? 0) > 0) {
        throw new ConflictException("This employee is already clocked in — clock out first");
      }

      // TLM-04: stamp the work date (in the schedule's own time zone) and the shift in force.
      const now = new Date();
      const schedule = await this.workSchedule.resolve(client, employee.id, localParts(now, DEFAULT_SCHEDULE_TIMEZONE).date);
      const workDate = localParts(now, schedule.timezone ?? DEFAULT_SCHEDULE_TIMEZONE).date;
      // Location checks (each is off until the company turns it on). A blocked clock-in throws here, before anything is written.
      const where = this.policy ? await this.policy.assess(client, employee.company_id, employee.id, input, now) : null;
      const result = await client.query(
        `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, gps_lat, gps_lng, shift_id, work_date, gps_accuracy_m, geofence_result, geofence_id, location_flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          employee.company_id, employee.id, input.employeeNumber, input.source, input.gpsLat ?? null, input.gpsLng ?? null, schedule.scheduleId, workDate,
          input.gpsAccuracyM ?? null, where?.geofenceResult ?? "not_applicable", where?.geofenceId ?? null, where?.flags ?? [],
        ]
      );
      if (where?.selfie && this.policy) {
        const path = await this.policy.storeSelfie(employee.company_id, employee.id, where.selfie);
        result.rows[0] = (await client.query("UPDATE attendance_records SET selfie_path = $2, selfie_mime = 'image/jpeg' WHERE id = $1 RETURNING *", [result.rows[0].id, path])).rows[0];
      }

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "attendance.clock_in",
        target: result.rows[0].id,
        metadata: { source: input.source, geofence: where?.geofenceResult ?? "not_applicable", flags: where?.flags ?? [] },
      });

      return rowToRecord(client, this.workSchedule, result.rows[0]);
    });
  }

  async clockOut(claims: RequestClaims, input: ClockOutRequest): Promise<AttendanceRecordView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employeeResult = await client.query<{ id: string; company_id: string; user_account_id: string | null }>(
        `SELECT id, company_id, user_account_id FROM employees WHERE employee_number = $1`,
        [input.employeeNumber]
      );
      if (employeeResult.rowCount === 0) throw new NotFoundException("No employee found with that employee number");
      const employee = employeeResult.rows[0];

      const canSelf =
        employee.user_account_id === claims.sub &&
        (await this.rbac.can(claims, "attendance.record.self", { ownerId: employee.user_account_id }));
      const canAll = await this.rbac.can(claims, "attendance.record.all");
      if (!canSelf && !canAll) {
        throw new ForbiddenException("Not permitted to record attendance for this employee");
      }

      await this.autoClose.closeForgottenForEmployee(client, claims, employee.id);

      const open = await client.query(
        `SELECT id FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL
            AND clock_in_at > now() - make_interval(hours => $2::int)
          ORDER BY clock_in_at DESC LIMIT 1`,
        [employee.id, STALE_OPEN_CLOCK_IN_HOURS]
      );
      if (open.rowCount === 0) {
        const forgotten = await client.query(`SELECT 1 FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL LIMIT 1`, [employee.id]);
        if ((forgotten.rowCount ?? 0) > 0) {
          throw new BadRequestException(
            "The last clock-in is more than a day old, so clocking out now would count the whole time as work. Ask for an attendance correction to set the real clock-out time, then clock in again."
          );
        }
        throw new BadRequestException("This employee is not currently clocked in");
      }

      const result = await client.query(
        `UPDATE attendance_records SET clock_out_at = now() WHERE id = $1 RETURNING *`,
        [open.rows[0].id]
      );

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "attendance.clock_out",
        target: result.rows[0].id,
      });

      const view = await rowToRecord(client, this.workSchedule, result.rows[0]);
      await client.query("UPDATE attendance_records SET derived_status = $2 WHERE id = $1", [result.rows[0].id, view.status]);
      return view;
    });
  }

  async listForEmployee(claims: RequestClaims, employeeId: string, limit = 200): Promise<AttendanceRecordView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employeeResult = await client.query<{ user_account_id: string | null }>(
        `SELECT user_account_id FROM employees WHERE id = $1`,
        [employeeId]
      );
      if (employeeResult.rowCount === 0) throw new NotFoundException("Employee not found");
      const employee = employeeResult.rows[0];

      const canSelf =
        employee.user_account_id === claims.sub &&
        (await this.rbac.can(claims, "attendance.record.self", { ownerId: employee.user_account_id }));
      const canAll = await this.rbac.can(claims, "attendance.record.all");
      if (!canSelf && !canAll) {
        throw new ForbiddenException("Not permitted to view attendance for this employee");
      }

      // Best effort: the viewer may not be allowed to write; the hourly sweep then does it.
      await this.autoClose.closeForgottenForEmployee(client, claims, employeeId).catch(() => 0);

      const result = await client.query(
        `SELECT * FROM attendance_records WHERE employee_id = $1 ORDER BY clock_in_at DESC LIMIT $2`,
        [employeeId, Math.max(1, Math.min(limit, 1000))]
      );
      // One at a time: they share one transaction connection (and the day cache).
      const resolvedByDay = new Map<string, ResolvedWorkScheduleView>();
      const views: AttendanceRecordView[] = [];
      for (const row of result.rows) views.push(await rowToRecord(client, this.workSchedule, row, resolvedByDay));
      return views;
    });
  }
}
