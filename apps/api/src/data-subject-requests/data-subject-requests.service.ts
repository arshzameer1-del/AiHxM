import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import type {
  DataSubjectRequestView,
  DecideDataSubjectRequestRequest,
  FulfillDataSubjectRequestRequest,
  SubmitDataSubjectRequestRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const WORKFLOW_TEMPLATE_KEY = "data_subject_request";
const WORKFLOW_OBJECT_KEY = "data_subject_request";

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any, employeeUserAccountId: string | null): DataSubjectRequestView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    employeeName: `${row.first_name} ${row.last_name}`,
    requestType: row.request_type,
    description: row.description,
    status: row.status,
    submittedByUserAccountId: row.submitted_by_user_account_id,
    // Same "derive it, don't store it twice" idiom leave_requests and
    // attendance_correction_requests already use for isOnBehalf.
    isOnBehalf: employeeUserAccountId !== null && row.submitted_by_user_account_id !== employeeUserAccountId,
    workflowInstanceId: row.workflow_instance_id,
    decisionComment: row.decision_comment,
    fulfilledByUserAccountId: row.fulfilled_by_user_account_id,
    fulfilledAt: toIso(row.fulfilled_at),
    fulfillmentNote: row.fulfillment_note,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * Phase 2 gap-fill item #5 — data subject request queue (privacy
 * access/correction/deletion requests). Mirrors LeaveRequestsService's
 * exact integration shape with the generic WorkflowService (own domain
 * table + `workflow_instance_id` FK, `submitForApproval()` in a separate
 * transaction, `decide()` reacting to the returned instance status) —
 * see this feature's own migration header comment for why a DSR
 * deliberately uses the multi-step engine rather than the plain
 * self/team/all decision AttendanceCorrectionRequestView/OnDutyRequestView
 * use.
 *
 * `fulfill()` is deliberately its own explicit, HR-only step and does
 * NOT itself export data, edit a record, or erase anything: honoring a
 * granted request is a real action a human completes (see the migration's
 * own comment) — this only records that it happened and how, the same
 * "request + manual/scheduled action, not automation" shape TM-038 uses.
 *
 * Same documented non-atomicity as LeaveRequestsService between the
 * `data_subject_requests` write and the `WorkflowService` call — see
 * KNOWN_ISSUES.md and LeaveRequestsService's own class doc comment.
 */
@Injectable()
export class DataSubjectRequestsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService
  ) {}

  async submit(claims: RequestClaims, input: SubmitDataSubjectRequestRequest): Promise<DataSubjectRequestView> {
    await this.requireModule(claims);

    const employee = await this.db.withClaims(claims, async (client) => this.loadEmployee(client, input.employeeId));
    if (!employee.user_account_id) {
      // Same reasoning as LeaveRequestsService.submit(): a workflow
      // instance needs a real subject user_account_id to route
      // manager_of_submitter approvers against.
      throw new BadRequestException(
        "This employee has no user account and cannot have data subject requests routed for approval — assign them a login first"
      );
    }

    const isSelf = employee.user_account_id === claims.sub;
    const [canSelf, canOnBehalf] = await Promise.all([
      isSelf
        ? this.rbac.can(claims, "data_subject_request.request.self", { ownerId: employee.user_account_id })
        : Promise.resolve(false),
      // On-behalf submission (HR filing on a request an employee raised
      // verbally, or for an employee who can't self-serve) reuses the
      // existing "can manage any employee's data" authority rather than
      // adding a redundant new permission — see this migration's own
      // header comment.
      !isSelf ? this.rbac.can(claims, "employee.manage.all") : Promise.resolve(false),
    ]);
    if (!canSelf && !canOnBehalf) {
      throw new ForbiddenException("Not permitted to submit a data subject request for this employee");
    }

    const insertedRow = await this.db.withClaims(claims, async (client) => {
      const insertResult = await client.query(
        `INSERT INTO data_subject_requests
           (company_id, employee_id, request_type, description, status, submitted_by_user_account_id)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING *`,
        [employee.company_id, employee.id, input.requestType, input.description, claims.sub]
      );
      const row = insertResult.rows[0];

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "data_subject_request.submit",
        target: row.id,
        metadata: { requestType: input.requestType, isOnBehalf: !isSelf },
      });

      return row;
    });

    // A separate transaction — see this class's own doc comment on the
    // deliberate non-atomicity this introduces (same tradeoff
    // LeaveRequestsService.submit() already accepts).
    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: insertedRow.id,
      record: { requestType: input.requestType },
      subjectUserAccountId: employee.user_account_id,
    });

    const updatedRow = await this.db.withClaims(claims, async (client) => {
      const updateResult = await client.query(
        `UPDATE data_subject_requests SET workflow_instance_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [insertedRow.id, instance.id]
      );
      return updateResult.rows[0];
    });

    return rowToView(
      { ...updatedRow, employee_number: employee.employee_number, first_name: employee.first_name, last_name: employee.last_name },
      employee.user_account_id
    );
  }

  /**
   * The HR/compliance queue — every request in the tenant, gated on the
   * same reused `employee.manage.all` authority as decide()/fulfill()
   * below. Optional `status` filter for narrowing to the actionable
   * ('pending') subset.
   */
  async listQueue(claims: RequestClaims, filter?: { status?: string }): Promise<DataSubjectRequestView[]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "employee.manage.all"))) {
      throw new ForbiddenException("Not permitted to view the data subject request queue");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT dsr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id
         FROM data_subject_requests dsr
         JOIN employees e ON e.id = dsr.employee_id
         WHERE dsr.company_id = $1 AND ($2::text IS NULL OR dsr.status = $2)
         ORDER BY dsr.created_at DESC`,
        [claims.company_id, filter?.status ?? null]
      );
      return result.rows.map((row) => rowToView(row, row.employee_user_account_id));
    });
  }

  /** Self-service: the caller's own submitted requests, across every employee record tied to their login. */
  async listMine(claims: RequestClaims): Promise<DataSubjectRequestView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT dsr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id
         FROM data_subject_requests dsr
         JOIN employees e ON e.id = dsr.employee_id
         WHERE e.user_account_id = $1
         ORDER BY dsr.created_at DESC`,
        [claims.sub]
      );
      return result.rows.map((row) => rowToView(row, row.employee_user_account_id));
    });
  }

  async getRequest(claims: RequestClaims, id: string): Promise<DataSubjectRequestView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.loadRequestRow(client, id);
      const visible =
        row.employee_user_account_id === claims.sub || (await this.rbac.can(claims, "employee.manage.all"));
      if (!visible) throw new NotFoundException("Data subject request not found");
      return rowToView(row, row.employee_user_account_id);
    });
  }

  async decide(
    claims: RequestClaims,
    id: string,
    input: DecideDataSubjectRequestRequest
  ): Promise<DataSubjectRequestView> {
    await this.requireModule(claims);

    const row = await this.db.withClaims(claims, async (client) => this.loadRequestRow(client, id));
    if (row.status !== "pending") {
      throw new ConflictException(`This request is already ${row.status}`);
    }
    if (!row.workflow_instance_id) {
      throw new BadRequestException("Data subject request has no workflow instance to decide on");
    }

    // Same "the workflow IS the authorization mechanism" idiom as
    // LeaveRequestsService.decide() — WorkflowService.decide() itself
    // throws ForbiddenException for a caller who isn't a resolved
    // approver on the current step.
    const instance = await this.workflow.getInstance(claims, row.workflow_instance_id);
    const pendingStep = instance.steps.find((s) => s.status === "pending");
    if (!pendingStep) {
      throw new BadRequestException("No pending approval step found on this data subject request");
    }
    const decidedInstance = await this.workflow.decide(claims, pendingStep.id, input);

    const finalRow = await this.db.withClaims(claims, async (client) => {
      if (decidedInstance.status === "approved") {
        await client.query(
          `UPDATE data_subject_requests SET status = 'approved', decision_comment = $2, updated_at = now() WHERE id = $1`,
          [id, input.comment ?? null]
        );
      } else if (decidedInstance.status === "rejected") {
        await client.query(
          `UPDATE data_subject_requests SET status = 'rejected', decision_comment = $2, updated_at = now() WHERE id = $1`,
          [id, input.comment ?? null]
        );
      }
      // else: still in_progress (a later step remains) — status stays
      // 'pending', nothing to write here yet.

      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: "data_subject_request.decide",
        target: id,
        metadata: { decision: input.decision, workflowStatus: decidedInstance.status },
      });

      return this.loadRequestRow(client, id);
    });

    return rowToView(finalRow, finalRow.employee_user_account_id);
  }

  /**
   * HR/DPO records that an approved request was actually carried out.
   * Deliberately requires status === 'approved' first — you can't
   * "fulfill" a request nobody has reviewed, and a rejected request has
   * nothing to fulfill.
   */
  async fulfill(
    claims: RequestClaims,
    id: string,
    input: FulfillDataSubjectRequestRequest
  ): Promise<DataSubjectRequestView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "employee.manage.all"))) {
      throw new ForbiddenException("Not permitted to fulfill data subject requests");
    }

    const row = await this.db.withClaims(claims, async (client) => this.loadRequestRow(client, id));
    if (row.status !== "approved") {
      throw new ConflictException(`Only an approved request can be fulfilled (this one is ${row.status})`);
    }

    const finalRow = await this.db.withClaims(claims, async (client) => {
      await client.query(
        `UPDATE data_subject_requests
         SET status = 'fulfilled', fulfilled_by_user_account_id = $2, fulfilled_at = now(),
             fulfillment_note = $3, updated_at = now()
         WHERE id = $1`,
        [id, claims.sub, input.fulfillmentNote]
      );

      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: "data_subject_request.fulfill",
        target: id,
        metadata: { requestType: row.request_type },
      });

      return this.loadRequestRow(client, id);
    });

    return rowToView(finalRow, finalRow.employee_user_account_id);
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async loadEmployee(client: PoolClient, employeeId: string): Promise<EmployeeRow> {
    const result = await client.query<EmployeeRow>(
      `SELECT id, company_id, user_account_id, employee_number, first_name, last_name FROM employees WHERE id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
    return result.rows[0];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadRequestRow(client: PoolClient, id: string): Promise<any> {
    const result = await client.query(
      `SELECT dsr.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id
       FROM data_subject_requests dsr
       JOIN employees e ON e.id = dsr.employee_id
       WHERE dsr.id = $1`,
      [id]
    );
    if (result.rowCount === 0) throw new NotFoundException("Data subject request not found");
    return result.rows[0];
  }
}
