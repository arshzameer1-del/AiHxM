import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type {
  AttendanceCorrectionRequestView,
  DecideAttendanceCorrectionRequest,
  SubmitAttendanceCorrectionRequest,
} from "@aihxm/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoDate(value: any): string {
  return value?.toISOString ? value.toISOString().slice(0, 10) : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any, employeeUserAccountId: string | null): AttendanceCorrectionRequestView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    employeeName: `${row.first_name} ${row.last_name}`,
    attendanceRecordId: row.attendance_record_id,
    requestedDate: toIsoDate(row.requested_date),
    requestedClockIn: toIso(row.requested_clock_in),
    requestedClockOut: toIso(row.requested_clock_out),
    reason: row.reason,
    status: row.status,
    // Same "derive it, don't store it twice" comparison leave_requests
    // already uses for isOnBehalf.
    isOnBehalf: employeeUserAccountId !== null && row.submitted_by_user_account_id !== employeeUserAccountId,
    decisionComment: row.decision_comment,
    decidedAt: toIso(row.decided_at),
    createdAt: toIso(row.created_at) as string,
  };
}

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  manager_id: string | null;
};

/**
 * Attendance Policies increment 1 — see 0028_attendance_corrections.sql's
 * header comment for why this is a plain RBAC self/team/all decision
 * rather than a Workflow Engine instance, and why absence reporting is
 * deliberately not part of this increment.
 */
@Injectable()
export class AttendanceCorrectionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  private async loadEmployee(client: PoolClient, employeeId: string): Promise<EmployeeRow> {
    const result = await client.query<EmployeeRow>(
      `SELECT id, company_id, user_account_id, employee_number, first_name, last_name, manager_id
       FROM employees WHERE id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
    return result.rows[0];
  }

  private async managerUserAccountId(client: PoolClient, managerId: string | null): Promise<string | null> {
    if (!managerId) return null;
    const manager = await client.query<{ user_account_id: string | null }>(
      "SELECT user_account_id FROM employees WHERE id = $1",
      [managerId]
    );
    return manager.rows[0]?.user_account_id ?? null;
  }

  async submit(
    claims: RequestClaims,
    input: SubmitAttendanceCorrectionRequest
  ): Promise<AttendanceCorrectionRequestView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!input.requestedClockIn && !input.requestedClockOut) {
      throw new BadRequestException("Provide a corrected clock-in and/or clock-out time");
    }
    if (!input.attendanceRecordId && !input.requestedClockIn) {
      // No existing record to correct means this creates a brand-new one
      // on approval, and a punch can't start with only a clock-out.
      throw new BadRequestException("A new attendance record needs at least a corrected clock-in time");
    }

    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);

      const isSelf = employee.user_account_id === claims.sub;
      const canSelf =
        isSelf && (await this.rbac.can(claims, "attendance_correction.request.self", { ownerId: employee.user_account_id }));
      // On-behalf submission reuses the existing "can touch any employee's
      // attendance" authority rather than a new permission — see this
      // migration's seed file header comment.
      const canOnBehalf = !isSelf && (await this.rbac.can(claims, "attendance.record.all"));
      if (!canSelf && !canOnBehalf) {
        throw new ForbiddenException("Not permitted to request an attendance correction for this employee");
      }

      if (input.attendanceRecordId) {
        const existing = await client.query("SELECT id FROM attendance_records WHERE id = $1 AND employee_id = $2", [
          input.attendanceRecordId,
          employee.id,
        ]);
        if (existing.rowCount === 0) {
          throw new NotFoundException("Attendance record not found for this employee");
        }
      }

      const result = await client.query(
        `INSERT INTO attendance_correction_requests
           (company_id, employee_id, attendance_record_id, requested_date, requested_clock_in,
            requested_clock_out, reason, submitted_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          employee.company_id,
          employee.id,
          input.attendanceRecordId ?? null,
          input.requestedDate,
          input.requestedClockIn ?? null,
          input.requestedClockOut ?? null,
          input.reason,
          claims.sub,
        ]
      );

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "attendance_correction.submit",
        target: result.rows[0].id,
        metadata: { employeeId: employee.id, requestedDate: input.requestedDate },
      });

      return rowToView(
        { ...result.rows[0], employee_number: employee.employee_number, first_name: employee.first_name, last_name: employee.last_name },
        employee.user_account_id
      );
    });
  }

  async listForEmployee(claims: RequestClaims, employeeId: string): Promise<AttendanceCorrectionRequestView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      const teamOwnerId = await this.managerUserAccountId(client, employee.manager_id);

      // Same self/self-request-permission vs. decide.team/decide.all shape
      // as decide() below, just for read access to the list rather than
      // the ability to act on it.
      const canSelf =
        employee.user_account_id === claims.sub &&
        (await this.rbac.can(claims, "attendance_correction.request.self", { ownerId: employee.user_account_id }));
      const canAll = await this.rbac.can(claims, "attendance_correction.decide.all");
      const canTeam = await this.rbac.can(claims, "attendance_correction.decide.team", { teamOwnerId });
      if (!canSelf && !canAll && !canTeam) {
        throw new ForbiddenException("Not permitted to view this employee's attendance corrections");
      }

      const result = await client.query(
        `SELECT acr.*, e.employee_number, e.first_name, e.last_name
         FROM attendance_correction_requests acr
         JOIN employees e ON e.id = acr.employee_id
         WHERE acr.employee_id = $1
         ORDER BY acr.created_at DESC`,
        [employeeId]
      );
      return result.rows.map((row) => rowToView(row, employee.user_account_id));
    });
  }

  /**
   * Pending requests a decider (line_manager/hr_admin) can actually act
   * on — hr_admin sees the whole company's pending queue, line_manager
   * sees only their own direct reports'. Uses `resolveViewScope`
   * (LeaveRequestsService.listRequests's own idiom for exactly this
   * "which scope(s) does this caller hold" question) rather than probing
   * `rbac.can` with a manufactured target, since there's no single record
   * to check against yet at this point in the query.
   */
  async listPendingForDecider(claims: RequestClaims): Promise<AttendanceCorrectionRequestView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    const scope = await this.rbac.resolveViewScope(claims, "attendance_correction.decide");
    if (!scope.hasAll && !scope.hasTeam) return [];

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT acr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id,
                m.user_account_id AS manager_user_account_id
         FROM attendance_correction_requests acr
         JOIN employees e ON e.id = acr.employee_id
         LEFT JOIN employees m ON m.id = e.manager_id
         WHERE acr.company_id = $1 AND acr.status = 'pending'
         ORDER BY acr.created_at ASC`,
        [claims.company_id]
      );

      const visible = scope.hasAll
        ? result.rows
        : result.rows.filter((row) => row.manager_user_account_id === claims.sub);

      return visible.map((row) => rowToView(row, row.employee_user_account_id));
    });
  }

  async decide(
    claims: RequestClaims,
    id: string,
    input: DecideAttendanceCorrectionRequest
  ): Promise<AttendanceCorrectionRequestView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        `SELECT acr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id,
                e.manager_id, e.company_id AS employee_company_id
         FROM attendance_correction_requests acr
         JOIN employees e ON e.id = acr.employee_id
         WHERE acr.id = $1`,
        [id]
      );
      if (existing.rowCount === 0) throw new NotFoundException("Correction request not found");
      const row = existing.rows[0];
      if (row.status !== "pending") {
        throw new ConflictException("This request has already been decided");
      }

      const canAll = await this.rbac.can(claims, "attendance_correction.decide.all");
      const teamOwnerId = await this.managerUserAccountId(client, row.manager_id);
      const canTeam = await this.rbac.can(claims, "attendance_correction.decide.team", { teamOwnerId });
      if (!canAll && !canTeam) {
        throw new ForbiddenException("Not permitted to decide this attendance correction request");
      }

      const updated = await client.query(
        `UPDATE attendance_correction_requests
         SET status = $2, decided_by_user_account_id = $3, decision_comment = $4, decided_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, input.decision, claims.sub, input.comment ?? null]
      );
      let finalRow = updated.rows[0];

      if (input.decision === "approved") {
        if (row.attendance_record_id) {
          // attendance_records has its own CHECK (clock_out_at IS NULL OR
          // clock_out_at >= clock_in_at). A correction that only touches
          // ONE side (e.g. "the clock-in was wrong, clock-out was fine")
          // can still violate it once combined with the side that's NOT
          // being corrected — e.g. correcting clock-in to later than the
          // existing, unchanged clock-out. Resolve and validate the final
          // pair here so that case surfaces as a clear 409, not a raw
          // unhandled DB constraint error (caught via live HTTP
          // verification, not by this service's own tests — every
          // existing test happened to pick values that never crossed the
          // boundary).
          const existing = await client.query<{ clock_in_at: Date; clock_out_at: Date | null }>(
            "SELECT clock_in_at, clock_out_at FROM attendance_records WHERE id = $1",
            [row.attendance_record_id]
          );
          if (existing.rowCount === 0) {
            throw new NotFoundException("The attendance record this correction referenced no longer exists");
          }
          const resolvedClockIn = row.requested_clock_in ?? existing.rows[0].clock_in_at;
          const resolvedClockOut = row.requested_clock_out ?? existing.rows[0].clock_out_at;
          if (resolvedClockOut && new Date(resolvedClockOut) < new Date(resolvedClockIn)) {
            throw new ConflictException(
              "Approving this would leave the clock-out time before the clock-in time — correct both times together"
            );
          }

          await client.query(`UPDATE attendance_records SET clock_in_at = $2, clock_out_at = $3 WHERE id = $1`, [
            row.attendance_record_id,
            resolvedClockIn,
            resolvedClockOut,
          ]);
        } else {
          const created = await client.query(
            `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
             VALUES ($1, $2, $3, 'manual', $4, $5)
             RETURNING id`,
            [row.employee_company_id, row.employee_id, row.employee_number, row.requested_clock_in, row.requested_clock_out]
          );
          const linked = await client.query(
            `UPDATE attendance_correction_requests SET attendance_record_id = $2 WHERE id = $1 RETURNING *`,
            [id, created.rows[0].id]
          );
          finalRow = linked.rows[0];
        }
      }

      await this.audit.record(client, claims, {
        companyId: row.employee_company_id,
        action: `attendance_correction.${input.decision}`,
        target: id,
        metadata: { employeeId: row.employee_id },
      });

      return rowToView(
        { ...finalRow, employee_number: row.employee_number, first_name: row.first_name, last_name: row.last_name },
        row.employee_user_account_id
      );
    });
  }
}
