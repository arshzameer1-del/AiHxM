import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { LeaveTypesService } from "./leave-types.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { resolveEntitlement } from "./leave-entitlements.repo";
import type {
  AccrualMethod,
  DecideLeaveCancellationRequest,
  LeaveApprovalLineView,
  LeaveBalanceView,
  LeaveColleagueView,
  LeaveApproverPreviewView,
  LeaveRequestView,
  LeaveType,
  LeaveTypeView,
  OverlapWarning,
  SubmitLeaveRequestRequest,
  SubmitLeaveRequestResponse,
  TeamLeaveEntryView,
  UpdateLeaveRequestRequest,
} from "@aihxm/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;
const WORKFLOW_TEMPLATE_KEY = "leave_request";
const WORKFLOW_OBJECT_KEY = "leave_request";

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  org_unit_id?: string | null;
  gender?: string | null;
  date_of_joining?: string | Date | null;
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
    openingDays: Number(row.opening_days ?? 0),
    accruedDays: Number(row.accrued_days ?? 0),
    carriedForwardDays: Number(row.carried_forward_days ?? 0),
    adjustedDays: Number(row.adjusted_days ?? 0),
    encashedDays: Number(row.encashed_days ?? 0),
    expiredDays: Number(row.expired_days ?? 0),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLeaveRequest(row: any, employeeUserAccountId: string | null, approvals?: LeaveApprovalLineView[]): LeaveRequestView {
  const startDate = toIsoDate(row.start_date);
  const endDate = toIsoDate(row.end_date);
  const delegateName = row.delegate_first_name ? `${row.delegate_first_name} ${row.delegate_last_name ?? ""}`.trim() : null;
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    leaveType: row.leave_type,
    startDate,
    endDate,
    daysRequested: Number(row.days_requested),
    reason: row.reason,
    status: row.status,
    submittedByUserAccountId: row.submitted_by_user_account_id,
    isOnBehalf: employeeUserAccountId !== null && row.submitted_by_user_account_id !== employeeUserAccountId,
    workflowInstanceId: row.workflow_instance_id,
    dayPart: row.day_part ?? "full",
    attachmentDocumentId: row.attachment_document_id ?? null,
    rejectionReason: row.rejection_reason ?? null,
    returnDate: row.return_date ? toIsoDate(row.return_date) : null,
    delegateEmployeeId: row.delegate_employee_id ?? null,
    cancellationStatus: row.cancellation_status ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    cancellationRequestedAt: row.cancellation_requested_at ? toIso(row.cancellation_requested_at) : null,
    payrollImpact: row.payroll_impact ?? false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    // LV-UP display fields. They come from joins the list/get queries add, so a view built from a bare
    // `leave_requests` row (submit, decide, cancel) simply leaves them out.
    ...(row.first_name !== undefined ? { employeeName: `${row.first_name} ${row.last_name ?? ""}`.trim(), employeeNumber: row.employee_number } : {}),
    ...(row.first_name !== undefined ? { delegateEmployeeName: delegateName } : {}),
    ...(row.leave_type_name ? { leaveTypeName: row.leave_type_name } : {}),
    absenceDays: inclusiveDayCount(startDate, endDate),
    ...(approvals ? { approvals } : {}),
  };
}

/**
 * Calendar days, inclusive of both ends. Exported (2026-10-01, integration
 * gap audit item 6) as the ONE copy of this arithmetic: PayrollService
 * used to carry its own hand-copied duplicate (it wasn't exported), and
 * now imports this one instead — a day Leave counts is, by construction,
 * the same day Payroll counts.
 *
 * `Date.UTC(year, monthIndex, day)` takes a 0-indexed month, so the
 * 1-indexed ISO calendar month is adjusted before being passed in. This
 * copy previously passed the raw month (Payroll's duplicate had already
 * fixed it for itself, see its git history), which silently corrupted any
 * span crossing a month boundary; that was latent here only because
 * nothing in this file called the helper any more once countLeaveDays()
 * replaced it. Fixed as part of making it the shared copy.
 */
export function inclusiveDayCount(startDate: string, endDate: string): number {
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

/** One approved unpaid-leave request's overlap with a queried date range
 * (already clipped to that range), as Payroll consumes it — see
 * `LeaveRequestsService.getApprovedUnpaidLeaveDaysInRange()`. */
export type UnpaidLeaveSegment = { startDate: string; endDate: string; days: number; leaveRequestId?: string };

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
    private readonly workSchedule: WorkScheduleResolutionService,
    private readonly leaveTypes: LeaveTypesService = new LeaveTypesService(db, rbac, entitlements, audit),
    private readonly ledger: LeaveLedgerService = new LeaveLedgerService(db, rbac, entitlements, audit)
  ) {
    this.workflow?.adapters?.register({
      objectKey: WORKFLOW_OBJECT_KEY,
      label: "Leave request",
      legacyDecide: (c, id, dto) => this.decide(c, id, dto),
    });
  }

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

    // TLM-01: the leave type is a tenant-configured catalogue row. A type that
    // does not track a balance (unpaid) has no entitlement, no policy to resolve
    // and nothing to decrement - an employee can always request it (a manager
    // still approves it, and PayrollService turns an approved request into a
    // deduction by reading these rows). Every other type draws on the policy.
    const leaveType = await this.db.withClaims(claims, (client) => this.leaveTypes.getByCode(client, employee.company_id, input.leaveType));
    if (!leaveType || !leaveType.isActive) {
      throw new BadRequestException(`Leave type "${input.leaveType}" is not available - ask HR to enable it`);
    }
    this.assertTypeEligibility(leaveType, employee, input.startDate);
    const dayPart = input.dayPart ?? "full";
    if (dayPart !== "full") {
      if (!leaveType.halfDayAllowed) throw new BadRequestException(`${leaveType.name} cannot be taken as a half day`);
      if (input.startDate !== input.endDate) throw new BadRequestException("A half-day leave request must start and end on the same date");
    }

    const resolved = leaveType.tracksBalance
      ? await this.employeeGroups.resolvePolicyInternal(claims, input.employeeId, "leave")
      : null;
    if (leaveType.tracksBalance && !resolved?.policyId) {
      throw new BadRequestException(
        "No leave policy is configured for this employee — assign a tenant-wide default leave policy or an employee group policy first"
      );
    }

    // Balance year = the request's start date's year - a documented
    // simplification for a request that spans a year boundary (e.g.
    // Dec 30 - Jan 3): the whole request draws against the START year's
    // balance rather than being split proportionally across two years'
    // entitlements. See KNOWN_ISSUES.md.
    const year = new Date(input.startDate).getUTCFullYear();

    const result = await this.db.withClaims(claims, async (client) => {
      const { daysRequested, returnDate, overlapWarnings } = await this.priceAndValidate(client, employee, leaveType, resolved?.policyId ?? null, year, {
        startDate: input.startDate,
        endDate: input.endDate,
        dayPart,
        attachmentDocumentId: input.attachmentDocumentId ?? null,
        delegateEmployeeId: input.delegateEmployeeId ?? null,
      });

      let insertResult;
      try {
        insertResult = await client.query(
          `INSERT INTO leave_requests
             (company_id, employee_id, leave_type, start_date, end_date, days_requested, reason, status, submitted_by_user_account_id,
              day_part, attachment_document_id, delegate_employee_id, return_date, payroll_impact)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            employee.company_id,
            employee.id,
            leaveType.code,
            input.startDate,
            input.endDate,
            daysRequested,
            input.reason ?? null,
            claims.sub,
            dayPart,
            input.attachmentDocumentId ?? null,
            input.delegateEmployeeId ?? null,
            returnDate,
            !leaveType.isPaid,
          ]
        );
      } catch (err) {
        // 23P01 = the overlap exclusion constraint (a concurrent request won the race).
        if ((err as { code?: string }).code === "23P01") {
          throw new ConflictException("This employee already has pending or approved leave overlapping these dates");
        }
        throw err;
      }
      const leaveRequestRow = insertResult.rows[0];

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "leave_request.submit",
        target: leaveRequestRow.id,
        metadata: { leaveType: leaveType.code, daysRequested, isOnBehalf, dayPart },
      });

      return { leaveRequestRow, overlapWarnings, daysRequested };
    });

    // A separate transaction — see this class's own doc comment on the
    // deliberate non-atomicity this introduces.
    let instance;
    try {
      instance = await this.workflow.submitForApproval(claims, {
        templateKey: WORKFLOW_TEMPLATE_KEY,
        objectKey: WORKFLOW_OBJECT_KEY,
        recordId: result.leaveRequestRow.id,
        // ORG-05: `orgUnitId` is the canonical dimension; `department` text stays for existing start conditions.
        record: { leaveType: input.leaveType, daysRequested: result.daysRequested, department: employee.department, orgUnitId: employee.org_unit_id ?? null },
        subjectUserAccountId: employee.user_account_id,
      });
    } catch (err) {
      // No approval route (or nobody to route to): the request was never really submitted, so it must not
      // stay behind as a "pending" row nobody can approve and that still counts against the balance.
      await this.db.withClaims(claims, (client) =>
        client.query("DELETE FROM leave_requests WHERE id = $1 AND workflow_instance_id IS NULL", [result.leaveRequestRow.id])
      );
      throw err;
    }

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
        // TLM-02: the deduction is a ledger entry (idempotent per request); the
        // balance row is derived from it. A type that keeps no balance (unpaid) is skipped.
        const type = await this.leaveTypes.getByCode(client, leaveRequestRow.company_id, leaveRequestRow.leave_type);
        if (type?.tracksBalance) {
          await this.ledger.deduct(client, {
            companyId: leaveRequestRow.company_id,
            employeeId: leaveRequestRow.employee_id,
            leaveType: leaveRequestRow.leave_type,
            year,
            days: Number(leaveRequestRow.days_requested),
            leaveRequestId,
            createdBy: claims.sub,
          });
        }
      } else if (decidedInstance.status === "rejected") {
        await client.query(`UPDATE leave_requests SET status = 'rejected', rejection_reason = $2, updated_at = now() WHERE id = $1`, [
          leaveRequestId,
          dto.comment ?? null,
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

  /**
   * HR-side cancellation (`leave_request.manage.all`). A pending request is simply
   * cancelled; an APPROVED one is cancelled and its balance deduction reversed in the
   * ledger (TLM-02). Employees ask for the latter through `requestCancellation`.
   */
  async cancel(claims: RequestClaims, leaveRequestId: string): Promise<void> {
    await this.requireLeaveModule(claims);
    if (!(await this.rbac.can(claims, "leave_request.manage.all"))) {
      throw new ForbiddenException("Not permitted to cancel leave requests");
    }
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveRequestId]);
      if (result.rowCount === 0) throw new NotFoundException("Leave request not found");
      const row = result.rows[0];
      if (row.status !== "pending" && row.status !== "approved") {
        throw new BadRequestException(`Cannot cancel a leave request that is already ${row.status}`);
      }
      await client.query(
        `UPDATE leave_requests SET status = 'cancelled',
                cancellation_status = CASE WHEN status = 'approved' THEN 'approved' ELSE cancellation_status END,
                updated_at = now() WHERE id = $1`,
        [leaveRequestId]
      );
      if (row.status === "approved") {
        await this.ledger.reverseSource(client, row.company_id, "leave_request", leaveRequestId, "Approved leave cancelled", claims.sub);
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "leave_request.cancel",
        target: leaveRequestId,
        metadata: { previousStatus: row.status },
      });
    });
  }

  /** TLM-03: an employee (or HR on their behalf) asks to cancel an APPROVED leave that has not ended yet. */
  async requestCancellation(claims: RequestClaims, leaveRequestId: string, reason: string): Promise<LeaveRequestView> {
    await this.requireLeaveModule(claims);
    if (!reason?.trim()) throw new BadRequestException("A cancellation request needs a reason");
    return this.db.withClaims(claims, async (client) => {
      const found = await client.query(
        `SELECT lr.*, e.user_account_id AS employee_user_account_id FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.id = $1`,
        [leaveRequestId]
      );
      if (found.rowCount === 0) throw new NotFoundException("Leave request not found");
      const row = found.rows[0];
      const isOwner = row.employee_user_account_id === claims.sub && (await this.rbac.can(claims, "leave_request.create.self", { ownerId: row.employee_user_account_id }));
      if (!isOwner && !(await this.rbac.can(claims, "leave_request.manage.all"))) {
        throw new NotFoundException("Leave request not found");
      }
      if (row.status !== "approved") throw new BadRequestException("Only an approved leave request can have a cancellation requested");
      if (row.cancellation_status === "requested") throw new ConflictException("A cancellation has already been requested for this leave");
      const ended = await client.query("SELECT $1::date < CURRENT_DATE AS ended", [toIsoDate(row.end_date)]);
      if (ended.rows[0].ended) throw new BadRequestException("This leave has already ended and can no longer be cancelled");
      const updated = await client.query(
        `UPDATE leave_requests SET cancellation_status = 'requested', cancellation_reason = $2,
                cancellation_requested_at = now(), cancellation_requested_by = $3, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [leaveRequestId, reason.trim(), claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: "leave_request.cancellation_requested",
        target: leaveRequestId,
        reason: reason.trim(),
      });
      return rowToLeaveRequest(updated.rows[0], row.employee_user_account_id);
    });
  }

  /** Decided by HR (`leave_request.manage.all`) or the employee's direct manager. */
  async decideCancellation(claims: RequestClaims, leaveRequestId: string, dto: DecideLeaveCancellationRequest): Promise<LeaveRequestView> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const found = await client.query(
        `SELECT lr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
           FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id LEFT JOIN employees mgr ON mgr.id = e.manager_id
          WHERE lr.id = $1`,
        [leaveRequestId]
      );
      if (found.rowCount === 0) throw new NotFoundException("Leave request not found");
      const row = found.rows[0];
      const isManager = Boolean(row.manager_user_account_id) && row.manager_user_account_id === claims.sub;
      if (!isManager && !(await this.rbac.can(claims, "leave_request.manage.all"))) {
        throw new NotFoundException("Leave request not found");
      }
      if (row.employee_user_account_id === claims.sub && !(await this.rbac.can(claims, "leave_request.manage.all"))) {
        throw new ForbiddenException("You cannot decide your own cancellation request");
      }
      if (row.status !== "approved" || row.cancellation_status !== "requested") {
        throw new BadRequestException("There is no pending cancellation request on this leave");
      }
      let updated;
      if (dto.decision === "approved") {
        updated = await client.query(
          `UPDATE leave_requests SET status = 'cancelled', cancellation_status = 'approved', updated_at = now() WHERE id = $1 RETURNING *`,
          [leaveRequestId]
        );
        await this.ledger.reverseSource(client, row.company_id, "leave_request", leaveRequestId, "Approved leave cancelled", claims.sub);
      } else {
        updated = await client.query(`UPDATE leave_requests SET cancellation_status = 'declined', updated_at = now() WHERE id = $1 RETURNING *`, [leaveRequestId]);
      }
      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: "leave_request.cancellation_decided",
        target: leaveRequestId,
        metadata: { decision: dto.decision, comment: dto.comment ?? null },
      });
      return rowToLeaveRequest(updated.rows[0], row.employee_user_account_id);
    });
  }

  async getRequest(claims: RequestClaims, id: string): Promise<LeaveRequestView> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT lr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id,
                e.first_name, e.last_name, e.employee_number, d.first_name AS delegate_first_name, d.last_name AS delegate_last_name,
                lt.name AS leave_type_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         LEFT JOIN employees d ON d.id = lr.delegate_employee_id
         LEFT JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
         WHERE lr.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Leave request not found");
      const row = result.rows[0];
      const visible = await this.isVisible(claims, row.employee_user_account_id, row.manager_user_account_id);
      if (!visible) throw new NotFoundException("Leave request not found");
      const approvals = await this.loadApprovals(client, row.workflow_instance_id ? [row.workflow_instance_id] : []);
      return rowToLeaveRequest(row, row.employee_user_account_id, approvals.get(row.workflow_instance_id) ?? []);
    });
  }

  async listRequests(claims: RequestClaims, filter?: { employeeId?: string }): Promise<LeaveRequestView[]> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const scope = await this.rbac.resolveViewScope(claims, "leave_request.view");
      const result = await client.query(
        `SELECT lr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id,
                e.first_name, e.last_name, e.employee_number, d.first_name AS delegate_first_name, d.last_name AS delegate_last_name,
                lt.name AS leave_type_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         LEFT JOIN employees d ON d.id = lr.delegate_employee_id
         LEFT JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
         WHERE ($1::uuid IS NULL OR lr.employee_id = $1)
         ORDER BY lr.created_at DESC`,
        [filter?.employeeId ?? null]
      );
      const visibleRows = result.rows.filter(
        (row) =>
          scope.hasAll ||
          (scope.hasSelf && row.employee_user_account_id === claims.sub) ||
          (scope.hasTeam && row.manager_user_account_id === claims.sub)
      );
      const approvals = await this.loadApprovals(client, [...new Set(visibleRows.map((r) => r.workflow_instance_id).filter(Boolean))] as string[]);
      return visibleRows.map((row) => rowToLeaveRequest(row, row.employee_user_account_id, approvals.get(row.workflow_instance_id) ?? []));
    });
  }

  async getBalances(claims: RequestClaims, employeeId: string): Promise<LeaveBalanceView[]> {
    await this.requireLeaveModule(claims);
    const employee = await this.db.withClaims(claims, async (client) => this.loadEmployee(client, employeeId));
    if (!employee) throw new NotFoundException("Employee not found");
    const visible = await this.isVisible(claims, employee.user_account_id, employee.manager_user_account_id);
    if (!visible) throw new NotFoundException("Employee not found");

    const year = new Date().getUTCFullYear();
    const resolved = await this.employeeGroups.resolvePolicyInternal(claims, employeeId, "leave");

    return this.db.withClaims(claims, async (client) => {
      // TLM-01/02: every active type that keeps a balance. The three built-ins are always
      // listed (as before); other types appear once they grant days or already have a balance.
      const types = (await this.leaveTypes.listActive(client, employee.company_id)).filter((t) => t.tracksBalance);
      const gender = (employee.gender ?? "").toLowerCase();
      const balances: LeaveBalanceView[] = [];
      for (const type of types) {
        const entitlement = resolved.policyId ? await resolveEntitlement(client, resolved.policyId, type.code) : null;
        const existing = await client.query("SELECT 1 FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3", [employeeId, type.code, year]);
        const builtIn = ["annual", "casual", "sick"].includes(type.code);
        const hasRow = (existing.rowCount ?? 0) > 0;
        if (!builtIn && !hasRow && !((entitlement?.days ?? 0) > 0)) continue;
        if (!hasRow && type.genderRestriction !== "any" && gender !== type.genderRestriction) continue;
        const row = await this.ledger.ensureBalance(client, employee.company_id, employeeId, type.code, year, {
          days: entitlement?.days ?? 0,
          method: entitlement?.accrualMethod ?? type.accrualMethod,
        });
        balances.push({ ...rowToBalance(row), leaveTypeName: type.name });
      }
      return balances;
    });
  }

  /**
   * Cross-module entry point for Payroll (integration gap audit item 6,
   * 2026-10-01): every APPROVED `unpaid` leave request overlapping
   * [rangeStart, rangeEnd] (both inclusive), each clipped to that range
   * and counted in CALENDAR days via this file's own `inclusiveDayCount`.
   * Replaces the raw `SELECT ... FROM leave_requests` PayrollService used
   * to run itself — Payroll now asks the module that owns leave_requests
   * rather than re-deriving its data by hand.
   *
   * Calendar days, deliberately — NOT `countLeaveDays()`'s
   * schedule/holiday-aware count stored in `days_requested`: this method
   * preserves Payroll's long-standing (Decision #14) unpaid-leave
   * deduction semantics exactly, which prorate against calendar days in
   * the period. The per-segment start/end dates are returned too so a
   * caller prorating against a WORKING-day denominator instead (Payroll's
   * schedule-aware path, for an employee with an explicit work schedule
   * assignment) can count working days inside each segment itself
   * against the same schedule resolution it already performed.
   *
   * Takes the caller's already-open, already-RLS-scoped `client` and does
   * no authorization of its own — the same cross-service shape
   * `WorkScheduleResolutionService.resolve()` uses; Payroll authorizes
   * its own caller (`payroll.calculate.all`) before reaching this.
   */
  async getApprovedUnpaidLeaveDaysInRange(
    client: PoolClient,
    employeeId: string,
    rangeStart: string,
    rangeEnd: string
  ): Promise<{ totalDays: number; segments: UnpaidLeaveSegment[] }> {
    // TLM-01: "unpaid" is now "a leave type with is_paid = false" (the built-in unpaid
    // type plus any tenant-defined unpaid type).
    const result = await client.query(
      `SELECT lr.id, lr.start_date, lr.end_date, lr.day_part
         FROM leave_requests lr
         JOIN leave_types t ON t.company_id = lr.company_id AND t.code = lr.leave_type
        WHERE lr.employee_id = $1 AND t.is_paid = false AND lr.status = 'approved'
          AND lr.start_date <= $3 AND lr.end_date >= $2
        ORDER BY lr.start_date ASC`,
      [employeeId, rangeStart, rangeEnd]
    );
    const segments: UnpaidLeaveSegment[] = [];
    for (const leave of result.rows) {
      const leaveStart = toIsoDate(leave.start_date);
      const leaveEnd = toIsoDate(leave.end_date);
      const startDate = leaveStart > rangeStart ? leaveStart : rangeStart;
      const endDate = leaveEnd < rangeEnd ? leaveEnd : rangeEnd;
      if (endDate < startDate) continue;
      segments.push({ leaveRequestId: leave.id, startDate, endDate, days: leave.day_part && leave.day_part !== "full" ? 0.5 : inclusiveDayCount(startDate, endDate) });
    }
    return { totalDays: segments.reduce((sum, s) => sum + s.days, 0), segments };
  }

  /**
   * LV-UP: edit a request that is still pending (SAP's pencil icon). Everything `submit` checks is checked again
   * against the new values, the days are recounted, and the request keeps its workflow instance. Refused once any
   * approver has already acted, because that decision was made on the old dates.
   */
  async update(claims: RequestClaims, leaveRequestId: string, dto: UpdateLeaveRequestRequest): Promise<SubmitLeaveRequestResponse> {
    await this.requireLeaveModule(claims);

    const loaded = await this.db.withClaims(claims, async (client) => {
      const found = await client.query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveRequestId]);
      if (found.rowCount === 0) return null;
      const row = found.rows[0];
      return { row, employee: await this.loadEmployee(client, row.employee_id) };
    });
    if (!loaded || !loaded.employee) throw new NotFoundException("Leave request not found");
    const { row, employee } = loaded;

    if (!(await this.isVisible(claims, employee.user_account_id, employee.manager_user_account_id))) {
      throw new NotFoundException("Leave request not found");
    }
    const isOwner = Boolean(employee.user_account_id) && employee.user_account_id === claims.sub;
    const canEdit = isOwner
      ? await this.rbac.can(claims, "leave_request.create.self", { ownerId: employee.user_account_id })
      : await this.rbac.can(claims, "leave_request.manage.all");
    if (!canEdit && !(await this.rbac.can(claims, "leave_request.manage.all"))) {
      throw new ForbiddenException("Not permitted to edit this leave request");
    }
    if (row.status !== "pending") throw new BadRequestException(`Only a pending leave request can be edited; this one is ${row.status}`);

    if (row.workflow_instance_id) {
      const acted = await this.db.withClaims(claims, (client) =>
        client.query(
          `SELECT 1 FROM workflow_step_approvals a JOIN workflow_step_instances s ON s.id = a.step_instance_id
            WHERE s.workflow_instance_id = $1 AND a.status IN ('approved', 'rejected') LIMIT 1`,
          [row.workflow_instance_id]
        )
      );
      if ((acted.rowCount ?? 0) > 0) throw new ConflictException("An approver has already acted on this request, so it can no longer be edited - cancel it and submit a new one");
    }

    const startDate = dto.startDate ?? toIsoDate(row.start_date);
    const endDate = dto.endDate ?? toIsoDate(row.end_date);
    if (new Date(endDate) < new Date(startDate)) throw new BadRequestException("endDate cannot be before startDate");
    const dayPart = dto.dayPart ?? row.day_part ?? "full";
    const typeCode = dto.leaveType ?? row.leave_type;
    const delegateEmployeeId = dto.delegateEmployeeId === undefined ? (row.delegate_employee_id ?? null) : dto.delegateEmployeeId;

    const leaveType = await this.db.withClaims(claims, (client) => this.leaveTypes.getByCode(client, employee.company_id, typeCode));
    if (!leaveType || !leaveType.isActive) throw new BadRequestException(`Leave type "${typeCode}" is not available - ask HR to enable it`);
    this.assertTypeEligibility(leaveType, employee, startDate);
    if (dayPart !== "full") {
      if (!leaveType.halfDayAllowed) throw new BadRequestException(`${leaveType.name} cannot be taken as a half day`);
      if (startDate !== endDate) throw new BadRequestException("A half-day leave request must start and end on the same date");
    }
    const resolved = leaveType.tracksBalance ? await this.employeeGroups.resolvePolicyInternal(claims, employee.id, "leave") : null;
    if (leaveType.tracksBalance && !resolved?.policyId) {
      throw new BadRequestException("No leave policy is configured for this employee — assign a tenant-wide default leave policy or an employee group policy first");
    }
    const year = new Date(startDate).getUTCFullYear();

    const result = await this.db.withClaims(claims, async (client) => {
      const { daysRequested, returnDate, overlapWarnings } = await this.priceAndValidate(
        client,
        employee,
        leaveType,
        resolved?.policyId ?? null,
        year,
        { startDate, endDate, dayPart, attachmentDocumentId: row.attachment_document_id ?? null, delegateEmployeeId },
        leaveRequestId
      );
      let updated;
      try {
        updated = await client.query(
          `UPDATE leave_requests
              SET leave_type = $2, start_date = $3, end_date = $4, days_requested = $5, reason = $6, day_part = $7,
                  delegate_employee_id = $8, return_date = $9, payroll_impact = $10, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [
            leaveRequestId,
            leaveType.code,
            startDate,
            endDate,
            daysRequested,
            dto.reason === undefined ? row.reason : dto.reason,
            dayPart,
            delegateEmployeeId,
            returnDate,
            !leaveType.isPaid,
          ]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23P01") {
          throw new ConflictException("This employee already has pending or approved leave overlapping these dates");
        }
        throw err;
      }
      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "leave_request.update",
        target: leaveRequestId,
        metadata: {
          before: { leaveType: row.leave_type, startDate: toIsoDate(row.start_date), endDate: toIsoDate(row.end_date), dayPart: row.day_part, daysRequested: Number(row.days_requested) },
          after: { leaveType: leaveType.code, startDate, endDate, dayPart, daysRequested },
        },
      });
      return { updatedRow: updated.rows[0], overlapWarnings };
    });

    return { request: rowToLeaveRequest(result.updatedRow, employee.user_account_id), overlapWarnings: result.overlapWarnings };
  }

  /**
   * LV-UP: "Team" calendar on the request detail page. The colleagues are the employees who share the viewed
   * employee's direct manager (the same definition the overlap notices use); a person with no manager sees only
   * themselves. Only pending and approved leave is shown, and only dates plus status, never type or reason.
   * The caller must be allowed to see the viewed employee's own leave in the first place.
   */
  async teamCalendar(claims: RequestClaims, query: { from: string; to: string; employeeId?: string }): Promise<TeamLeaveEntryView[]> {
    await this.requireLeaveModule(claims);
    if (query.to < query.from) throw new BadRequestException("`to` cannot be before `from`");
    if (inclusiveDayCount(query.from, query.to) > 93) throw new BadRequestException("The team calendar shows at most about three months at a time");

    return this.db.withClaims(claims, async (client) => {
      const subject = await this.resolveTeamSubject(client, claims, query.employeeId);
      const result = await client.query(
        `SELECT lr.id, lr.start_date, lr.end_date, lr.day_part, lr.status, e.id AS employee_id, e.first_name, e.last_name, e.employee_number
           FROM leave_requests lr
           JOIN employees e ON e.id = lr.employee_id
          WHERE lr.status IN ('pending', 'approved')
            AND lr.start_date <= $3 AND lr.end_date >= $2
            AND ( e.id = $1 OR ($4::uuid IS NOT NULL AND e.manager_id = $4) )
          ORDER BY e.first_name, e.last_name, lr.start_date`,
        [subject.id, query.from, query.to, subject.manager_id ?? null]
      );
      return result.rows.map((r) => ({
        leaveRequestId: r.id,
        employeeId: r.employee_id,
        employeeName: `${r.first_name} ${r.last_name}`.trim(),
        employeeNumber: r.employee_number,
        startDate: toIsoDate(r.start_date),
        endDate: toIsoDate(r.end_date),
        dayPart: r.day_part ?? "full",
        status: r.status,
      }));
    });
  }

  /**
   * LV-UP: the people who can be named as relief person for `employeeId` (default: the caller): the colleagues
   * under the same manager, excluding the employee. Needed because an ordinary employee cannot list other
   * employees, but must still be able to pick a relief person from their own team.
   */
  async listColleagues(claims: RequestClaims, employeeId?: string): Promise<LeaveColleagueView[]> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const subject = await this.resolveTeamSubject(client, claims, employeeId);
      if (!subject.manager_id) return [];
      const result = await client.query(
        `SELECT id, first_name, last_name, employee_number FROM employees
          WHERE manager_id = $1 AND id <> $2
          ORDER BY first_name, last_name`,
        [subject.manager_id, subject.id]
      );
      return result.rows.map((r) => ({ employeeId: r.id, employeeName: `${r.first_name} ${r.last_name}`.trim(), employeeNumber: r.employee_number }));
    });
  }

  /**
   * LV-UP: the approvers a new request for `employeeId` (default: the caller) is expected to go to, read from the
   * company's active leave workflow template, so the create form can show "1st Level Approver" before submitting.
   * Display only: the real routing is decided when the request is submitted.
   */
  async approverPreview(claims: RequestClaims, employeeId?: string): Promise<LeaveApproverPreviewView[]> {
    await this.requireLeaveModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const subject = await this.resolveTeamSubject(client, claims, employeeId);
      const template = await client.query(
        `SELECT id FROM workflow_templates WHERE company_id = $1 AND object_key = 'leave_request' AND is_active ORDER BY created_at LIMIT 1`,
        [claims.company_id]
      );
      if (template.rowCount === 0) return [];
      const rows = await client.query(
        `SELECT s.step_order, s.name AS step_name, a.approver_type, a.user_account_id, r.name AS role_name
           FROM workflow_template_steps s
           JOIN workflow_template_step_approvers a ON a.step_id = s.id
           LEFT JOIN roles r ON r.id = a.role_id
          WHERE s.template_id = $1
          ORDER BY s.step_order, a.created_at`,
        [template.rows[0].id]
      );
      const names = async (userAccountId: string | null): Promise<string | null> => {
        if (!userAccountId) return null;
        const e = await client.query(`SELECT first_name, last_name FROM employees WHERE user_account_id = $1`, [userAccountId]);
        return e.rows[0] ? `${e.rows[0].first_name} ${e.rows[0].last_name}`.trim() : null;
      };
      const byStep = new Map<number, { stepName: string; names: string[] }>();
      for (const row of rows.rows) {
        let name: string | null = null;
        if (row.approver_type === "manager_of_submitter") name = await names(subject.manager_user_account_id ?? null);
        else if (row.approver_type === "specific_user") name = await names(row.user_account_id);
        else name = row.role_name ?? null;
        const entry: { stepName: string; names: string[] } = byStep.get(row.step_order) ?? { stepName: row.step_name as string, names: [] };
        if (name) entry.names.push(name);
        byStep.set(row.step_order, entry);
      }
      return [...byStep.entries()].map(([stepOrder, v]) => ({ stepOrder, stepName: v.stepName, approverName: v.names.length > 0 ? v.names.join(", ") : null }));
    });
  }

  /** The employee whose team is being shown, after checking the caller may see that employee at all (404 otherwise). */
  private async resolveTeamSubject(client: PoolClient, claims: RequestClaims, employeeId?: string) {
    const base = `SELECT e.*, mgr.user_account_id AS manager_user_account_id FROM employees e LEFT JOIN employees mgr ON mgr.id = e.manager_id`;
    const found = employeeId
      ? await client.query(`${base} WHERE e.id = $1`, [employeeId])
      : await client.query(`${base} WHERE e.user_account_id = $1`, [claims.sub]);
    const subject = found.rows[0];
    if (!subject) throw new NotFoundException("Employee not found");
    if (!(await this.isVisible(claims, subject.user_account_id, subject.manager_user_account_id))) {
      throw new NotFoundException("Employee not found");
    }
    return subject;
  }

  /** LV-UP: the approval chain for a set of workflow instances, one entry per approver line. */
  private async loadApprovals(client: PoolClient, instanceIds: string[]): Promise<Map<string, LeaveApprovalLineView[]>> {
    const byInstance = new Map<string, LeaveApprovalLineView[]>();
    if (instanceIds.length === 0) return byInstance;
    const result = await client.query(
      `SELECT s.workflow_instance_id, s.step_order, s.name AS step_name, a.status, a.decided_at, a.comment,
              s.require_comment_on_approve, s.require_comment_on_reject,
              COALESCE(NULLIF(trim(concat_ws(' ', ee.first_name, ee.last_name)), ''), r.name) AS approver_name,
              NULLIF(trim(concat_ws(' ', de.first_name, de.last_name)), '') AS decided_by_name
         FROM workflow_step_instances s
         JOIN workflow_step_approvals a ON a.step_instance_id = s.id
         LEFT JOIN employees ee ON ee.user_account_id = COALESCE(a.delegated_to_user_account_id, a.user_account_id)
         LEFT JOIN employees de ON de.user_account_id = a.decided_by_user_account_id
         LEFT JOIN roles r ON r.id = a.role_id
        WHERE s.workflow_instance_id = ANY($1::uuid[])
        ORDER BY s.workflow_instance_id, s.step_order, a.created_at`,
      [instanceIds]
    );
    for (const r of result.rows) {
      const list = byInstance.get(r.workflow_instance_id) ?? [];
      list.push({
        stepOrder: r.step_order,
        stepName: r.step_name,
        approverName: r.approver_name ?? null,
        status: r.status,
        decidedAt: r.decided_at ? toIso(r.decided_at) : null,
        decidedByName: r.decided_by_name ?? null,
        comment: r.comment ?? null,
        requireCommentOnApprove: Boolean(r.require_comment_on_approve),
        requireCommentOnReject: Boolean(r.require_comment_on_reject),
      });
      byInstance.set(r.workflow_instance_id, list);
    }
    return byInstance;
  }

  /**
   * The checks and arithmetic every new or edited request goes through: working days, the per-type limits,
   * supporting document, relief person, balance, overlap, return date. `excludeRequestId` lets an edit ignore
   * its own row when looking for overlapping leave.
   */
  private async priceAndValidate(
    client: PoolClient,
    employee: EmployeeRow,
    leaveType: LeaveTypeView,
    policyId: string | null,
    year: number,
    input: { startDate: string; endDate: string; dayPart: string; attachmentDocumentId: string | null; delegateEmployeeId: string | null },
    excludeRequestId?: string
  ): Promise<{ daysRequested: number; returnDate: string; overlapWarnings: OverlapWarning[] }> {
    // Needs a `client` to read the company's holiday calendar / weekly pattern.
    const daysRequested =
      input.dayPart === "full"
        ? await countLeaveDays(client, this.workSchedule, employee.id, input.startDate, input.endDate)
        : (await this.workSchedule.isWorkingDay(client, employee.id, input.startDate))
          ? 0.5
          : 0;
    if (daysRequested <= 0) {
      throw new BadRequestException("A leave request must span at least one day that isn't a company holiday");
    }
    if (leaveType.maxConsecutiveDays !== null && daysRequested > leaveType.maxConsecutiveDays) {
      throw new BadRequestException(`${leaveType.name} is limited to ${leaveType.maxConsecutiveDays} consecutive day(s) per request`);
    }

    // TLM-03: supporting document, delegate.
    if (leaveType.documentRequired && daysRequested > leaveType.documentRequiredAfterDays && !input.attachmentDocumentId) {
      throw new BadRequestException(`${leaveType.name} of ${daysRequested} day(s) needs a supporting document`);
    }
    if (input.attachmentDocumentId) {
      const doc = await client.query("SELECT 1 FROM employee_documents WHERE id = $1 AND employee_id = $2", [input.attachmentDocumentId, employee.id]);
      if (doc.rowCount === 0) throw new BadRequestException("The attached document does not belong to this employee");
    }
    if (input.delegateEmployeeId) {
      if (input.delegateEmployeeId === employee.id) throw new BadRequestException("An employee cannot delegate to themselves");
      const delegate = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [input.delegateEmployeeId, employee.company_id]);
      if (delegate.rowCount === 0) throw new BadRequestException("Delegate employee not found");
    }

    if (leaveType.tracksBalance) {
      // Reads the CURRENT version's entitlement (effective_to IS NULL) - live
      // decision paths deliberately keep reading "current" only.
      const entitlement = await resolveEntitlement(client, policyId!, leaveType.code);
      if (!entitlement) throw new NotFoundException("Resolved leave policy no longer exists");
      const method: AccrualMethod = entitlement.accrualMethod ?? leaveType.accrualMethod;
      const balance = await this.ledger.ensureBalance(client, employee.company_id, employee.id, leaveType.code, year, { days: entitlement.days, method });
      const remaining = Number(balance.entitled_days) - Number(balance.used_days);
      if (daysRequested > remaining) {
        throw new BadRequestException(
          `Insufficient ${leaveType.code} leave balance: requested ${daysRequested} day(s), ${remaining} remaining for ${year}`
        );
      }
    }

    await this.assertNoOverlap(client, employee.id, input.startDate, input.endDate, input.dayPart, excludeRequestId);
    const overlapWarnings = await this.findOverlapWarnings(client, employee, input.startDate, input.endDate);
    const returnDate = await this.computeReturnDate(client, employee.id, input.endDate, input.dayPart, input.startDate);
    return { daysRequested, returnDate, overlapWarnings };
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

  private assertTypeEligibility(type: LeaveTypeView, employee: EmployeeRow, startDate: string): void {
    if (type.genderRestriction !== "any") {
      const gender = (employee.gender ?? "").toLowerCase();
      if (gender !== type.genderRestriction) {
        throw new BadRequestException(`${type.name} is only available to ${type.genderRestriction} employees`);
      }
    }
    if (type.minServiceMonths > 0) {
      const joined = employee.date_of_joining ? toIsoDate(employee.date_of_joining) : null;
      if (!joined) throw new BadRequestException(`${type.name} needs ${type.minServiceMonths} month(s) of service, but this employee has no joining date`);
      const [jy, jm, jd] = joined.split("-").map(Number);
      const [sy, sm, sd] = startDate.split("-").map(Number);
      const months = (sy - jy) * 12 + (sm - jm) - (sd < jd ? 1 : 0);
      if (months < type.minServiceMonths) {
        throw new BadRequestException(`${type.name} needs ${type.minServiceMonths} month(s) of service`);
      }
    }
  }

  /** TLM-03 overlap protection: opposite halves of one day may coexist; everything else may not. */
  private async assertNoOverlap(client: PoolClient, employeeId: string, startDate: string, endDate: string, dayPart: string, excludeRequestId?: string): Promise<void> {
    const clash = await client.query(
      `SELECT id FROM leave_requests
        WHERE employee_id = $1 AND status IN ('pending', 'approved')
          AND start_date <= $3 AND end_date >= $2
          AND (day_part = 'full' OR $4 = 'full' OR day_part = $4)
          AND ($5::uuid IS NULL OR id <> $5)
        LIMIT 1`,
      [employeeId, startDate, endDate, dayPart, excludeRequestId ?? null]
    );
    if ((clash.rowCount ?? 0) > 0) {
      throw new ConflictException("This employee already has pending or approved leave overlapping these dates");
    }
  }

  /** First day the employee is expected back: the next working day after the leave (a first-half leave returns the same day). */
  private async computeReturnDate(client: PoolClient, employeeId: string, endDate: string, dayPart: string, startDate: string): Promise<string> {
    if (dayPart === "first_half") return startDate;
    let cursor = addOneDayIso(endDate);
    for (let i = 0; i < 31; i++, cursor = addOneDayIso(cursor)) {
      if (await this.workSchedule.isWorkingDay(client, employeeId, cursor)) return cursor;
    }
    return addOneDayIso(endDate);
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
