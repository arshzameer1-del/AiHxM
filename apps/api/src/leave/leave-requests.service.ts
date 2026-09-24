import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import type {
  LeaveBalanceView,
  LeaveRequestView,
  LeaveType,
  OverlapWarning,
  SubmitLeaveRequestRequest,
  SubmitLeaveRequestResponse,
} from "@aihxm/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;
const WORKFLOW_TEMPLATE_KEY = "leave_request";
const WORKFLOW_OBJECT_KEY = "leave_request";

// `unpaid` deliberately has no entry — see submit()'s own comment on why
// it draws against no policy/entitlement at all.
const LEAVE_TYPE_TO_POLICY_COLUMN: Record<Exclude<LeaveType, "unpaid">, string> = {
  annual: "annual_leave_days",
  casual: "casual_leave_days",
  sick: "sick_leave_days",
};

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  manager_id: string | null;
  manager_user_account_id: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBalance(row: any): LeaveBalanceView {
  const entitled = Number(row.entitled_days);
  const used = Number(row.used_days);
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveType: row.leave_type,
    year: row.year,
    entitledDays: entitled,
    usedDays: used,
    remainingDays: entitled - used,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLeaveRequest(row: any, employeeUserAccountId: string | null): LeaveRequestView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    leaveType: row.leave_type,
    startDate: toIsoDate(row.start_date),
    endDate: toIsoDate(row.end_date),
    daysRequested: Number(row.days_requested),
    reason: row.reason,
    status: row.status,
    submittedByUserAccountId: row.submitted_by_user_account_id,
    isOnBehalf: employeeUserAccountId !== null && row.submitted_by_user_account_id !== employeeUserAccountId,
    workflowInstanceId: row.workflow_instance_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  // Calendar days, inclusive of both ends.
  const start = Date.UTC(...(startDate.split("-").map(Number) as [number, number, number]));
  const end = Date.UTC(...(endDate.split("-").map(Number) as [number, number, number]));
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function addOneDayIso(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Holiday- AND weekly-pattern-aware day count. The holiday half shipped
 * first (mandatory company holidays only — see
 * `HolidaysService.countMandatoryHolidaysInRange`'s own doc comment for
 * why optional holidays deliberately aren't subtracted); the "NOT
 * business-day/weekend aware" half that comment used to name as a
 * separately-tracked gap (KNOWN_ISSUES.md, "no work-week/weekend concept
 * exists anywhere in this schema") is closed here, now that the Work
 * Schedule & Employee Schedule Assignment Architecture gives every
 * employee a real, configurable weekly pattern to check against.
 *
 * Deliberately walks day-by-day (rather than one aggregate query) and
 * asks `WorkScheduleResolutionService.isWorkingDay()` per day: that
 * method already returns `true` for every day when the employee has no
 * schedule configured at all (see its own doc comment), so a tenant that
 * hasn't set up Work Schedule/Shift Management yet gets EXACTLY today's
 * calendar-days-minus-mandatory-holidays behavior, unchanged — the
 * weekend/off-day exclusion only engages once a tenant has actually
 * configured a weekly pattern with a day marked off.
 */
async function countLeaveDays(
  client: PoolClient,
  workSchedule: WorkScheduleResolutionService,
  employeeId: string,
  startDate: string,
  endDate: string
): Promise<number> {
  let count = 0;
  for (let cursor = startDate; cursor <= endDate; cursor = addOneDayIso(cursor)) {
    if (await workSchedule.isWorkingDay(client, employeeId, cursor)) count++;
  }
  return count;
}

/**
 * Phase 9 (plan doc Section 7): "the real go/no-go checkpoint." The first
 * genuine end-to-end wiring of Phase 4's RBAC, Phase 5's entitlements,
 * Phase 6's workflow engine (including this phase's own
 * `manager_of_submitter` extension), Phase 7's Employee Core hierarchy,
 * and Phase 8's policy resolver — all four pillars serving one real
 * object for the first time.
 *
 * Deliberately calls `EmployeeGroupsService.resolvePolicyInternal()` (not
 * `resolvePolicy()`) — this service has already authorized its own caller
 * against `leave_request.create.self`/`leave_request.manage.all` before
 * ever asking for a policy resolution, so re-applying `leave_policy.manage`
 * on top would make it impossible for an ordinary self-service employee to
 * ever submit their own leave request. See EmployeeGroupsService's own
 * doc comments on both methods for the full reasoning.
 *
 * KNOWN NON-ATOMICITY (see KNOWN_ISSUES.md): `WorkflowService` calls and
 * this service's own `leave_requests`/`leave_balances` writes are
 * separate `DatabaseService.withClaims()` transactions — a crash between
 * them could leave a leave request without a workflow instance, or an
 * approved workflow instance without its balance decremented. A single
 * shared transaction would require `DatabaseService` to support nesting
 * across service boundaries, which it deliberately does not (see its own
 * doc comment) — a genuine, documented scope tradeoff, not an oversight.
 */
@Injectable()
export class LeaveRequestsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly employeeGroups: EmployeeGroupsService,
    private readonly workflow: WorkflowService,
    private readonly workSchedule: WorkScheduleResolutionService
  ) {}

  async submit(claims: RequestClaims, input: SubmitLeaveRequestRequest): Promise<SubmitLeaveRequestResponse> {
    await this.requireLeaveModule(claims);

    if (new Date(input.endDate) < new Date(input.startDate)) {
      throw new BadRequestException("endDate cannot be before startDate");
    }

    const employee = await this.db.withClaims(claims, async (client) => this.loadEmployee(client, input.employeeId));
    if (!employee) throw new NotFoundException("Employee not found");
    if (!employee.user_account_id) {
      // A leave request is routed through a workflow instance keyed on a
      // real user_account_id (both `subjectUserAccountId` and
      // `manager_of_submitter` resolution need one) — an employee record
      // with no login can never be the subject of one. Rather than
      // silently skipping approval routing for such employees, this is
      // surfaced as a clear, actionable error.
      throw new BadRequestException(
        "This employee has no user account and cannot have leave requests routed for approval — assign them a login first"
      );
    }

    const isOnBehalf = employee.user_account_id !== claims.sub;
    const [canSelf, canManageAll] = await Promise.all([
      !isOnBehalf
        ? this.rbac.can(claims, "leave_request.create.self", { ownerId: employee.user_account_id })
        : Promise.resolve(false),
      this.rbac.can(claims, "leave_request.manage.all"),
    ]);
    if (!canSelf && !canManageAll) {
      throw new ForbiddenException("Not permitted to submit a leave request for this employee");
    }

    // `unpaid` (Phase 12 addition — see Decision #14) is deliberately NOT
    // one of `LEAVE_TYPE_TO_POLICY_COLUMN`'s three entries: it has no
    // entitlement, no policy to resolve, and no balance to check or
    // decrement — an employee can always request it, in any amount,
    // precisely because it isn't a benefit being drawn down. It still
    // routes through the same approval workflow as any other leave type
    // (a manager still has to approve someone taking unpaid time off),
    // and PayrollService (Phase 12) is what actually turns an approved
    // `unpaid` request into a real deduction, by reading these rows
    // directly rather than this service tracking a running balance for
    // something that was never bounded in the first place.
    const isUnpaid = input.leaveType === "unpaid";

    const resolved = isUnpaid
      ? null
      : await this.employeeGroups.resolvePolicyInternal(claims, input.employeeId, "leave");
    if (!isUnpaid && !resolved?.policyId) {
      throw new BadRequestException(
        "No leave policy is configured for this employee — assign a tenant-wide default leave policy or an employee group policy first"
      );
    }

    // Balance year = the request's start date's year — a documented
    // simplification for a request that spans a year boundary (e.g.
    // Dec 30 - Jan 3): the whole request draws against the START year's
    // balance rather than being split proportionally across two years'
    // entitlements. See KNOWN_ISSUES.md.
    const year = new Date(input.startDate).getUTCFullYear();

    const result = await this.db.withClaims(claims, async (client) => {
      // Moved inside the transaction (rather than computed up front, as
      // it was before Holiday Management existed) because it now needs a
      // `client` to read the company's holiday calendar/weekly pattern —
      // see `countLeaveDays`'s own doc comment above.
      const daysRequested = await countLeaveDays(client, this.workSchedule, employee.id, input.startDate, input.endDate);
      if (daysRequested <= 0) {
        throw new BadRequestException(
          "A leave request must span at least one day that isn't a company holiday"
        );
      }

      if (!isUnpaid) {
        // Reads the CURRENT version's entitlement figures (effective_to IS
        // NULL) — see migration 0033's header comment: live decision paths
        // deliberately keep reading "current" only, not as-of any
        // historical date, even though the figures now live in a
        // versioned child table.
        const policyResult = await client.query<{
          annual_leave_days: number;
          casual_leave_days: number;
          sick_leave_days: number;
        }>(
          `SELECT annual_leave_days, casual_leave_days, sick_leave_days
           FROM leave_policy_versions WHERE policy_id = $1 AND effective_to IS NULL`,
          [resolved?.policyId]
        );
        if (policyResult.rowCount === 0) throw new NotFoundException("Resolved leave policy no longer exists");
        const entitledColumn = LEAVE_TYPE_TO_POLICY_COLUMN[input.leaveType as Exclude<typeof input.leaveType, "unpaid">];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entitledFromPolicy = Number((policyResult.rows[0] as any)[entitledColumn]);

        const balance = await this.getOrCreateBalance(client, employee.company_id, employee.id, input.leaveType, year, entitledFromPolicy);
        const remaining = Number(balance.entitled_days) - Number(balance.used_days);
        if (daysRequested > remaining) {
          throw new BadRequestException(
            `Insufficient ${input.leaveType} leave balance: requested ${daysRequested} day(s), ${remaining} remaining for ${year}`
          );
        }
      }

      const overlapWarnings = await this.findOverlapWarnings(client, employee, input.startDate, input.endDate);

      const insertResult = await client.query(
        `INSERT INTO leave_requests
           (company_id, employee_id, leave_type, start_date, end_date, days_requested, reason, status, submitted_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         RETURNING *`,
        [
          employee.company_id,
          employee.id,
          input.leaveType,
          input.startDate,
          input.endDate,
          daysRequested,
          input.reason ?? null,
          claims.sub,
        ]
      );
      const leaveRequestRow = insertResult.rows[0];

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "leave_request.submit",
        target: leaveRequestRow.id,
        metadata: { leaveType: input.leaveType, daysRequested, isOnBehalf },
      });

      return { leaveRequestRow, overlapWarnings, daysRequested };
    });

    // A separate transaction — see this class's own doc comment on the
    // deliberate non-atomicity this introduces.
    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: result.leaveRequestRow.id,
      record: { leaveType: input.leaveType, daysRequested: result.daysRequested, department: employee.department },
      subjectUserAccountId: employee.user_account_id,
    });

    const updatedRow = await this.db.withClaims(claims, async (client) => {
      const updateResult = await client.query(
        `UPDATE leave_requests SET workflow_instance_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [result.leaveRequestRow.id, instance.id]
      );
      return updateResult.rows[0];
    });

    return {
      request: rowToLeaveRequest(updatedRow, employee.user_account_id),
      overlapWarnings: result.overlapWarnings,
    };
  }

  async decide(claims: RequestClaims, leaveRequestId: string, dto: { decision: "approved" | "rejected"; comment?: string }): Promise<LeaveRequestView> {
    await this.requireLeaveModule(claims);

    const { leaveRequestRow, employee } = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveRequestId]);
      if (result.rowCount === 0) throw new NotFoundException("Leave request not found");
      const row = result.rows[0];
      const emp = await this.loadEmployee(client, row.employee_id);
      return { leaveRequestRow: row, employee: emp };
    });
    if (!employee) throw new NotFoundException("Employee not found");
    if (leaveRequestRow.status !== "pending") {
      throw new BadRequestException(`Leave request is already ${leaveRequestRow.status}`);
    }
    if (!leaveRequestRow.workflow_instance_id) {
      throw new BadRequestException("Leave request has no workflow instance to decide on");
    }

    // Who may actually decide this specific approval is entirely governed
    // by the tenant's configured workflow routing (role / specific_user /
    // manager_of_submitter) — WorkflowService.decide() itself throws
    // ForbiddenException for a caller who isn't a resolved approver on the
    // current step. There is no separate leave-specific "may approve"
    // permission to check here on top of that; the workflow IS the
    // authorization mechanism for this action, same as any other WRICEF
    // object routed through it.
    const instance = await this.workflow.getInstance(claims, leaveRequestRow.workflow_instance_id);
    const pendingStep = instance.steps.find((s) => s.status === "pending");
    if (!pendingStep) {
      throw new BadRequestException("No pending approval step found on this leave request");
    }
    const decidedInstance = await this.workflow.decide(claims, pendingStep.id, dto);

    const updatedRow = await this.db.withClaims(claims, async (client) => {
      if (decidedInstance.status === "approved") {
        await client.query(`UPDATE leave_requests SET status = 'approved', updated_at = now() WHERE id = $1`, [
          leaveRequestId,
        ]);
        const year = new Date(leaveRequestRow.start_date).getUTCFullYear();
        // For `leave_type = 'unpaid'` this WHERE simply matches no row —
        // there never was a `leave_balances` row to decrement in the
        // first place (see submit()'s own comment) — so no special-case
        // branch is needed here, just this note explaining why.
        await client.query(
          `UPDATE leave_balances SET used_days = used_days + $4, updated_at = now()
           WHERE employee_id = $1 AND leave_type = $2 AND year = $3`,
          [leaveRequestRow.employee_id, leaveRequestRow.leave_type, year, leaveRequestRow.days_requested]
        );
      } else if (decidedInstance.status === "rejected") {
        await client.query(`UPDATE leave_requests SET status = 'rejected', updated_at = now() WHERE id = $1`, [
          leaveRequestId,
        ]);
      }
      // else: still in_progress (a later step remains) — leave_requests
      // stays 'pending', nothing to write here yet.
      const result = await client.query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveRequestId]);

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "leave_request.decide",
        target: leaveRequestId,
        metadata: { decision: dto.decision, workflowStatus: decidedInstance.status },
      });

      return result.rows[0];
    });

    return rowToLeaveRequest(updatedRow, employee.user_account_id);
  }

  async cancel(claims: RequestClaims, leaveRequestId: string): Promise<void> {
    await this.requireLeaveModule(claims);
    // Cancellation is deliberately manage.all-only for now — matches the
    // permission's own seeded description ("...and cancel any leave
    // request"). A self-cancel-your-own-still-pending-request path is a
    // real, reasonable future addition but isn't asked for by this
    // phase's exit criterion, and adding it means adding a new permission
    // that doesn't exist in 0016_leave_attendance_seed.sql yet — not done
    // here to avoid over-building ahead of actual demand (Section 10).
    if (!(await this.rbac.can(claims, "leave_request.manage.all"))) {
      throw new ForbiddenException("Not permitted to cancel leave requests");
    }
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT status FROM leave_requests WHERE id = $1`, [leaveRequestId]);
      if (result.rowCount === 0) throw new NotFoundException("Leave request not found");
      if (result.rows[0].status !== "pending") {
        throw new BadRequestException(`Cannot cancel a leave request that is already ${result.rows[0].status}`);
      }
      await client.query(`UPDATE leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`, [
        leaveRequestId,
      ]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "leave_request.cancel",
        target: leaveRequestId,
      });
    });
  }

  async getRequest(claims: RequestClaims, id: string): Promise<LeaveRequestView> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT lr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         WHERE lr.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Leave request not found");
      const row = result.rows[0];
      const visible = await this.isVisible(claims, row.employee_user_account_id, row.manager_user_account_id);
      if (!visible) throw new NotFoundException("Leave request not found");
      return rowToLeaveRequest(row, row.employee_user_account_id);
    });
  }

  async listRequests(claims: RequestClaims, filter?: { employeeId?: string }): Promise<LeaveRequestView[]> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const scope = await this.rbac.resolveViewScope(claims, "leave_request.view");
      const result = await client.query(
        `SELECT lr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         WHERE ($1::uuid IS NULL OR lr.employee_id = $1)
         ORDER BY lr.created_at DESC`,
        [filter?.employeeId ?? null]
      );
      return result.rows
        .filter((row) =>
          scope.hasAll ||
          (scope.hasSelf && row.employee_user_account_id === claims.sub) ||
          (scope.hasTeam && row.manager_user_account_id === claims.sub)
        )
        .map((row) => rowToLeaveRequest(row, row.employee_user_account_id));
    });
  }

  async getBalances(claims: RequestClaims, employeeId: string): Promise<LeaveBalanceView[]> {
    await this.requireLeaveModule(claims);
    const employee = await this.db.withClaims(claims, async (client) => this.loadEmployee(client, employeeId));
    if (!employee) throw new NotFoundException("Employee not found");
    const visible = await this.isVisible(claims, employee.user_account_id, employee.manager_user_account_id);
    if (!visible) throw new NotFoundException("Employee not found");

    const year = new Date().getUTCFullYear();
    // `unpaid` has no balance concept at all (see submit()'s own comment)
    // so it's deliberately excluded from the set getBalances() reports on.
    const leaveTypes: Exclude<LeaveType, "unpaid">[] = ["annual", "casual", "sick"];
    const resolved = await this.employeeGroups.resolvePolicyInternal(claims, employeeId, "leave");

    return this.db.withClaims(claims, async (client) => {
      let entitlements: { annual_leave_days: number; casual_leave_days: number; sick_leave_days: number } | null = null;
      if (resolved.policyId) {
        // Same "current version only" read as submit() above.
        const policyResult = await client.query(
          `SELECT annual_leave_days, casual_leave_days, sick_leave_days
           FROM leave_policy_versions WHERE policy_id = $1 AND effective_to IS NULL`,
          [resolved.policyId]
        );
        entitlements = policyResult.rows[0] ?? null;
      }

      const balances: LeaveBalanceView[] = [];
      for (const leaveType of leaveTypes) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entitledFromPolicy = entitlements ? Number((entitlements as any)[LEAVE_TYPE_TO_POLICY_COLUMN[leaveType]]) : 0;
        const row = await this.getOrCreateBalance(client, employee.company_id, employeeId, leaveType, year, entitledFromPolicy);
        balances.push(rowToBalance(row));
      }
      return balances;
    });
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async requireLeaveModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async isVisible(claims: RequestClaims, ownerId: string | null, teamOwnerId: string | null): Promise<boolean> {
    const scope = await this.rbac.resolveViewScope(claims, "leave_request.view");
    return (
      scope.hasAll ||
      (scope.hasSelf && Boolean(ownerId) && ownerId === claims.sub) ||
      (scope.hasTeam && Boolean(teamOwnerId) && teamOwnerId === claims.sub)
    );
  }

  private async loadEmployee(
    client: PoolClient,
    employeeId: string
  ): Promise<(EmployeeRow & { manager_user_account_id: string | null }) | null> {
    const result = await client.query(
      `SELECT e.*, mgr.user_account_id AS manager_user_account_id
       FROM employees e
       LEFT JOIN employees mgr ON mgr.id = e.manager_id
       WHERE e.id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0];
  }

  /**
   * Lazily creates a `leave_balances` row the first time an employee's
   * balance for a given type/year is ever needed (0015_leave_attendance.sql's
   * header comment) — seeded from `entitledFromPolicy` at creation time
   * only; an already-existing row is returned as-is (its entitlement may
   * have been manually adjusted since, and re-seeding it here would
   * silently overwrite that).
   */
  private async getOrCreateBalance(
    client: PoolClient,
    companyId: string,
    employeeId: string,
    leaveType: LeaveType,
    year: number,
    entitledFromPolicy: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // A single INSERT ... ON CONFLICT ... RETURNING handles both cases
    // atomically (no separate SELECT-then-INSERT race): a fresh row is
    // seeded from `entitledFromPolicy`; an existing row's ON CONFLICT
    // branch is a deliberate no-op (it never touches entitled_days) and
    // RETURNING still hands back that existing row unchanged.
    const result = await client.query(
      `INSERT INTO leave_balances (company_id, employee_id, leave_type, year, entitled_days, used_days)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (employee_id, leave_type, year) DO UPDATE SET updated_at = leave_balances.updated_at
       RETURNING *`,
      [companyId, employeeId, leaveType, year, entitledFromPolicy]
    );
    return result.rows[0];
  }

  /**
   * Non-blocking "someone on the same team is already off that week" —
   * plan doc Section 7 calls these overlap NOTICES, not rejections.
   * "Same team" means same direct manager as the requesting employee;
   * only pending/approved requests count (a rejected or cancelled one
   * isn't actually going to happen).
   */
  private async findOverlapWarnings(
    client: PoolClient,
    employee: EmployeeRow,
    startDate: string,
    endDate: string
  ): Promise<OverlapWarning[]> {
    if (!employee.manager_id) return [];
    const result = await client.query(
      `SELECT lr.id AS leave_request_id, lr.start_date, lr.end_date, e.id AS employee_id, e.first_name, e.last_name
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE e.manager_id = $1
         AND e.id != $2
         AND lr.status IN ('pending', 'approved')
         AND lr.start_date <= $3 AND lr.end_date >= $4`,
      [employee.manager_id, employee.id, endDate, startDate]
    );
    return result.rows.map((row) => ({
      employeeId: row.employee_id,
      employeeFullName: `${row.first_name} ${row.last_name}`,
      leaveRequestId: row.leave_request_id,
      startDate: toIsoDate(row.start_date),
      endDate: toIsoDate(row.end_date),
    }));
  }
}
