import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { DecideOnDutyRequestRequest, OnDutyRequestView, SubmitOnDutyRequestRequest } from "@aihxm/shared-types";

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
function rowToView(row: any, employeeUserAccountId: string | null): OnDutyRequestView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    employeeName: `${row.first_name} ${row.last_name}`,
    startDate: toIsoDate(row.start_date),
    endDate: toIsoDate(row.end_date),
    location: row.location,
    reason: row.reason,
    status: row.status,
    // Same "derive it, don't store it twice" comparison
    // AttendanceCorrectionRequestView/OvertimeRecordView already use.
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
 * Overtime & On-Duty's second half — see 0040_on_duty.sql's header
 * comment for why this is a distinct record shape from an overtime claim
 * (authorized ahead of time, over a date range, with no schedule
 * comparison at all) rather than a variant of OvertimeService, and why
 * it's a plain RBAC self/team/all decision rather than a Workflow Engine
 * instance, mirroring AttendanceCorrectionsService/OvertimeService.
 */
@Injectable()
export class OnDutyService {
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

  async submit(claims: RequestClaims, input: SubmitOnDutyRequestRequest): Promise<OnDutyRequestView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException("endDate cannot be before startDate");
    }

    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);

      const isSelf = employee.user_account_id === claims.sub;
      const canSelf = isSelf && (await this.rbac.can(claims, "on_duty.request.self", { ownerId: employee.user_account_id }));
      // On-behalf submission reuses the existing "can touch any employee's
      // attendance" authority rather than a new permission — the exact
      // same reuse Attendance Corrections and Overtime both already use.
      const canOnBehalf = !isSelf && (await this.rbac.can(claims, "attendance.record.all"));
      if (!canSelf && !canOnBehalf) {
        throw new ForbiddenException("Not permitted to request on-duty for this employee");
      }

      // A same-employee, overlapping-date-range pending/approved request
      // is a real conflict (unlike LeaveRequestsService's own overlap
      // check, which is a non-blocking cross-employee NOTICE) — reusing
      // that exact "start <= end AND end >= start" range-overlap query
      // shape, scoped to one employee and blocking rather than warning.
      const overlap = await client.query(
        `SELECT id FROM on_duty_requests
         WHERE employee_id = $1 AND status IN ('pending', 'approved')
           AND start_date <= $2 AND end_date >= $3`,
        [employee.id, input.endDate, input.startDate]
      );
      if ((overlap.rowCount ?? 0) > 0) {
        throw new ConflictException("This employee already has a pending or approved on-duty request overlapping these dates");
      }

      const result = await client.query(
        `INSERT INTO on_duty_requests
           (company_id, employee_id, start_date, end_date, location, reason, submitted_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [employee.company_id, employee.id, input.startDate, input.endDate, input.location ?? null, input.reason ?? null, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "on_duty.submit",
        target: result.rows[0].id,
        metadata: { employeeId: employee.id, startDate: input.startDate, endDate: input.endDate },
      });

      return rowToView(
        { ...result.rows[0], employee_number: employee.employee_number, first_name: employee.first_name, last_name: employee.last_name },
        employee.user_account_id
      );
    });
  }

  async listForEmployee(claims: RequestClaims, employeeId: string): Promise<OnDutyRequestView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      const teamOwnerId = await this.managerUserAccountId(client, employee.manager_id);

      const canSelf =
        employee.user_account_id === claims.sub &&
        (await this.rbac.can(claims, "on_duty.request.self", { ownerId: employee.user_account_id }));
      const canAll = await this.rbac.can(claims, "on_duty.decide.all");
      const canTeam = await this.rbac.can(claims, "on_duty.decide.team", { teamOwnerId });
      if (!canSelf && !canAll && !canTeam) {
        throw new ForbiddenException("Not permitted to view this employee's on-duty requests");
      }

      const result = await client.query(
        `SELECT odr.*, e.employee_number, e.first_name, e.last_name
         FROM on_duty_requests odr
         JOIN employees e ON e.id = odr.employee_id
         WHERE odr.employee_id = $1
         ORDER BY odr.created_at DESC`,
        [employeeId]
      );
      return result.rows.map((row) => rowToView(row, employee.user_account_id));
    });
  }

  /**
   * Same "degrade to an empty list rather than 403" convention
   * AttendanceCorrectionsService/OvertimeService both already use for a
   * caller with neither decide permission.
   */
  async listPendingForDecider(claims: RequestClaims): Promise<OnDutyRequestView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    const scope = await this.rbac.resolveViewScope(claims, "on_duty.decide");
    if (!scope.hasAll && !scope.hasTeam) return [];

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT odr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id,
                m.user_account_id AS manager_user_account_id
         FROM on_duty_requests odr
         JOIN employees e ON e.id = odr.employee_id
         LEFT JOIN employees m ON m.id = e.manager_id
         WHERE odr.company_id = $1 AND odr.status = 'pending'
         ORDER BY odr.created_at ASC`,
        [claims.company_id]
      );

      const visible = scope.hasAll ? result.rows : result.rows.filter((row) => row.manager_user_account_id === claims.sub);

      return visible.map((row) => rowToView(row, row.employee_user_account_id));
    });
  }

  async decide(claims: RequestClaims, id: string, input: DecideOnDutyRequestRequest): Promise<OnDutyRequestView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        `SELECT odr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id,
                e.manager_id, e.company_id AS employee_company_id
         FROM on_duty_requests odr
         JOIN employees e ON e.id = odr.employee_id
         WHERE odr.id = $1`,
        [id]
      );
      if (existing.rowCount === 0) throw new NotFoundException("On-duty request not found");
      const row = existing.rows[0];
      if (row.status !== "pending") {
        throw new ConflictException("This on-duty request has already been decided");
      }

      const canAll = await this.rbac.can(claims, "on_duty.decide.all");
      const teamOwnerId = await this.managerUserAccountId(client, row.manager_id);
      const canTeam = await this.rbac.can(claims, "on_duty.decide.team", { teamOwnerId });
      if (!canAll && !canTeam) {
        throw new ForbiddenException("Not permitted to decide this on-duty request");
      }

      const updated = await client.query(
        `UPDATE on_duty_requests
         SET status = $2, decided_by_user_account_id = $3, decision_comment = $4, decided_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, input.decision, claims.sub, input.comment ?? null]
      );

      await this.audit.record(client, claims, {
        companyId: row.employee_company_id,
        action: `on_duty.${input.decision}`,
        target: id,
        metadata: { employeeId: row.employee_id },
      });

      return rowToView(
        { ...updated.rows[0], employee_number: row.employee_number, first_name: row.first_name, last_name: row.last_name },
        row.employee_user_account_id
      );
    });
  }
}
