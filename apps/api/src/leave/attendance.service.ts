import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { AttendanceRecordView, ClockInRequest, ClockOutRequest } from "@boostfactor/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecord(row: any): AttendanceRecordView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    source: row.source,
    clockInAt: toIso(row.clock_in_at) as string,
    clockOutAt: toIso(row.clock_out_at),
    gpsLat: row.gps_lat === null ? null : Number(row.gps_lat),
    gpsLng: row.gps_lng === null ? null : Number(row.gps_lng),
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
    private readonly audit: AuditService
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

      return rowToRecord(result.rows[0]);
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

      return rowToRecord(result.rows[0]);
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
      return result.rows.map(rowToRecord);
    });
  }
}
