import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import type { AttendanceRecordView, ClockInRequest, ClockOutRequest } from "@aihxm/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;

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
async function rowToRecord(client: PoolClient, workSchedule: WorkScheduleResolutionService, row: any): Promise<AttendanceRecordView> {
  const clockInAt: Date = row.clock_in_at;
  const clockOutAt: Date | null = row.clock_out_at;
  const dateIso = clockInAt.toISOString().slice(0, 10);
  const { status, shiftName } = await workSchedule.resolveAttendanceStatus(client, row.employee_id, dateIso, clockInAt, clockOutAt);

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
    private readonly workSchedule: WorkScheduleResolutionService
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

      const open = await client.query(
        `SELECT id FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL`,
        [employee.id]
      );
      if ((open.rowCount ?? 0) > 0) {
        throw new ConflictException("This employee is already clocked in — clock out first");
      }

      const result = await client.query(
        `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, gps_lat, gps_lng)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [employee.company_id, employee.id, input.employeeNumber, input.source, input.gpsLat ?? null, input.gpsLng ?? null]
      );

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "attendance.clock_in",
        target: result.rows[0].id,
        metadata: { source: input.source },
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

      const open = await client.query(
        `SELECT id FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL ORDER BY clock_in_at DESC LIMIT 1`,
        [employee.id]
      );
      if (open.rowCount === 0) {
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

      return rowToRecord(client, this.workSchedule, result.rows[0]);
    });
  }

  async listForEmployee(claims: RequestClaims, employeeId: string): Promise<AttendanceRecordView[]> {
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

      const result = await client.query(
        `SELECT * FROM attendance_records WHERE employee_id = $1 ORDER BY clock_in_at DESC`,
        [employeeId]
      );
      return Promise.all(result.rows.map((row) => rowToRecord(client, this.workSchedule, row)));
    });
  }
}
