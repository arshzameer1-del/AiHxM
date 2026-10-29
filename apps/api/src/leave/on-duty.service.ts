import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { decideInEngine, statusForOutcome, submitToEngineIfConfigured } from "../workflow/engine-routing";
import type { DecideOnDutyRequestRequest, OnDutyRequestView, SubmitOnDutyRequestRequest } from "@aihxm/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;
const WORKFLOW_OBJECT_KEY = "on_duty_request";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dutyLabel(dutyType: string | null | undefined): string {
  return dutyType === "work_from_home" ? "Work from home" : "On-duty";
}

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
    dutyType: row.duty_type === "work_from_home" ? "work_from_home" : "on_duty",
    location: row.location,
    locationId: row.location_id ?? null,
    // a configured location keeps its name in `location` (snapshot at submission)
    locationName: row.location_id ? row.location : null,
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
    private readonly audit: AuditService,
    // WFL-01 (Step 6): optional + appended so positional spec constructions keep working.
    private readonly workflow?: WorkflowService
  ) {
    this.workflow?.adapters?.register({
      objectKey: WORKFLOW_OBJECT_KEY,
      label: "On-duty request",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT odr.start_date, odr.end_date, odr.location, odr.duty_type, e.first_name, e.last_name
             FROM on_duty_requests odr JOIN employees e ON e.id = odr.employee_id WHERE odr.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const x = r.rows[0];
        return { title: `${dutyLabel(x.duty_type)}: ${x.first_name} ${x.last_name}`, summary: `${toIsoDate(x.start_date)} to ${toIsoDate(x.end_date)}${x.location ? ` at ${x.location}` : ""}`, deepLink: "/attendance/work-away" };
      },
      onOutcome: async (ctx) => {
        const status = statusForOutcome(ctx.event);
        const decided = status === "approved" || status === "rejected";
        const r = await ctx.client.query(
          `UPDATE on_duty_requests
              SET status = $2, updated_at = now(),
                  decided_by_user_account_id = CASE WHEN $3 THEN $4::uuid ELSE decided_by_user_account_id END,
                  decision_comment = CASE WHEN $3 THEN $5 ELSE decision_comment END,
                  decided_at = CASE WHEN $3 THEN now() ELSE decided_at END
            WHERE id = $1 RETURNING employee_id`,
          [ctx.recordId, status, decided, ctx.claims.sub, ctx.comment]
        );
        if (!r.rowCount) return;
        await this.audit.record(ctx.client, ctx.claims, {
          companyId: ctx.claims.company_id ?? null,
          action: `on_duty.${ctx.event}`,
          target: ctx.recordId,
          metadata: { employeeId: r.rows[0].employee_id, viaWorkflow: ctx.instanceId },
        });
      },
    });
  }

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
         WHERE employee_id = $1 AND status IN ('pending', 'approved', 'returned')
           AND start_date <= $2 AND end_date >= $3`,
        [employee.id, input.endDate, input.startDate]
      );
      if ((overlap.rowCount ?? 0) > 0) {
        throw new ConflictException("This employee already has a pending or approved on-duty / work-from-home request overlapping these dates");
      }

      // TLM-11: a configured location, when given, must exist and be active in this company; its
      // name is kept on the row as the display text (the free-text `location` stays the note otherwise).
      let locationText = input.location ?? null;
      if (input.locationId) {
        const loc = await client.query("SELECT name FROM locations WHERE id = $1 AND company_id = $2 AND status = 'active'", [input.locationId, employee.company_id]);
        if (loc.rowCount === 0) throw new NotFoundException("Location not found");
        locationText = loc.rows[0].name;
      }
      let result = await client.query(
        `INSERT INTO on_duty_requests
           (company_id, employee_id, start_date, end_date, location, location_id, reason, submitted_by_user_account_id, duty_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [employee.company_id, employee.id, input.startDate, input.endDate, locationText, input.locationId ?? null, input.reason ?? null, claims.sub, input.dutyType ?? "on_duty"]
      );
      // WFL-01: when the tenant has an active template the request is approved through the engine.
      const instanceId = await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: WORKFLOW_OBJECT_KEY,
        table: "on_duty_requests",
        recordId: result.rows[0].id,
        record: { employeeId: employee.id, startDate: input.startDate, endDate: input.endDate, location: locationText, locationId: input.locationId ?? null },
        subjectUserAccountId: employee.user_account_id,
        title: `${dutyLabel(input.dutyType)}: ${employee.first_name} ${employee.last_name}`,
      });
      if (instanceId) result = await client.query("SELECT * FROM on_duty_requests WHERE id = $1", [result.rows[0].id]);

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "on_duty.submit",
        target: result.rows[0].id,
        metadata: { employeeId: employee.id, startDate: input.startDate, endDate: input.endDate, dutyType: input.dutyType ?? "on_duty" },
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
         WHERE odr.company_id = $1 AND odr.status = 'pending' AND odr.workflow_instance_id IS NULL
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

      if (row.workflow_instance_id && this.workflow) {
        // routed through the workflow engine: the configured approvers decide; onOutcome applies the status
        await decideInEngine(this.workflow, client, claims, row.workflow_instance_id, { decision: input.decision, comment: input.comment });
        const fresh = await client.query("SELECT * FROM on_duty_requests WHERE id = $1", [id]);
        return rowToView(
          { ...fresh.rows[0], employee_number: row.employee_number, first_name: row.first_name, last_name: row.last_name },
          row.employee_user_account_id
        );
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
