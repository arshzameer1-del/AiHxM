import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeLifecycleService } from "../employees/employee-lifecycle.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { requireItemCompletionAccess, requireScopedEmployeeAccess } from "./checklist-access.util";
import type {
  CreateOffboardingItemTemplateRequest,
  EmployeeOffboardingView,
  InitiateOffboardingRequest,
  OffboardingChecklistItemView,
  OffboardingItemTemplateView,
  UpdateChecklistItemRequest,
  UpdateOffboardingExitRequest,
  UpdateOffboardingItemTemplateRequest,
} from "@aihxm/shared-types";

// Gated on the existing `exit` module_catalog entry ("Exit &
// Offboarding") — see 0035_onboarding_offboarding.sql's header comment
// for why this reuses that placeholder rather than a new sellable
// module. `exit` was, until this increment, a pure licensing row with
// zero backend behind it (Part 1 Section 3 of the roadmap audit).
const MODULE_KEY = "exit" as const;
const MANAGE_PERMISSION = "offboarding.manage.all";
const VIEW_TEAM_PERMISSION = "offboarding.view.team";
const VIEW_SELF_PERMISSION = "offboarding.view.self";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTemplate(row: any): OffboardingItemTemplateView {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    responsibleRole: row.responsible_role,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToItem(row: any): OffboardingChecklistItemView {
  return {
    id: row.id,
    templateItemId: row.template_item_id,
    title: row.title,
    category: row.category,
    responsibleRole: row.responsible_role,
    sortOrder: row.sort_order,
    status: row.status,
    notes: row.notes,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function toIsoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/**
 * Offboarding checklists — the mirror of OnboardingService, plus the one
 * genuinely consequential action onboarding never needed: `complete()`
 * finalizes the exit by flipping the employee's `employment_status` to
 * `terminated`. That flip is deliberately delegated to
 * `EmployeesService.update()` rather than duplicated here — it's the
 * one and only place in this codebase that mutates an employee's
 * termination fields, it already validates `terminationDate`, and it
 * already auto-records `employee_job_history` on every status
 * transition (see `EmployeesService.autoRecordJobHistory()`). Routing
 * through it means this increment gets that behavior for free and
 * correctly, rather than a second, parallel (and easy-to-drift) copy of
 * "what does terminating an employee actually update."
 */
@Injectable()
export class OffboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    // Step 4 (LIF-05) - optional, appended last so positional spec
    // constructions keep working. Without the lifecycle service completion
    // falls back to the pre-Step-4 EmployeesService.update() path.
    private readonly lifecycle?: EmployeeLifecycleService,
    private readonly businessPolicy?: HrBusinessPolicyService
  ) {}

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage offboarding");
    }
  }

  // ------------------------------------------------------------------
  // Item templates
  // ------------------------------------------------------------------

  async createItemTemplate(
    claims: RequestClaims,
    input: CreateOffboardingItemTemplateRequest
  ): Promise<OffboardingItemTemplateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO offboarding_item_templates (company_id, title, category, responsible_role, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [claims.company_id, input.title, input.category, input.responsibleRole, input.sortOrder ?? 0]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.item_template.create",
        target: result.rows[0].id,
        metadata: { title: input.title },
      });
      return rowToTemplate(result.rows[0]);
    });
  }

  async listItemTemplates(claims: RequestClaims): Promise<OffboardingItemTemplateView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM offboarding_item_templates WHERE company_id = $1 ORDER BY sort_order, created_at",
        [claims.company_id]
      );
      return result.rows.map(rowToTemplate);
    });
  }

  async updateItemTemplate(
    claims: RequestClaims,
    id: string,
    input: UpdateOffboardingItemTemplateRequest
  ): Promise<OffboardingItemTemplateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM offboarding_item_templates WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Checklist item template not found");
      const row = current.rows[0];

      const result = await client.query(
        `UPDATE offboarding_item_templates
         SET title = $2, category = $3, responsible_role = $4, sort_order = $5, is_active = $6, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          input.title ?? row.title,
          input.category ?? row.category,
          input.responsibleRole ?? row.responsible_role,
          input.sortOrder ?? row.sort_order,
          input.isActive ?? row.is_active,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.item_template.update",
        target: id,
      });
      return rowToTemplate(result.rows[0]);
    });
  }

  async deactivateItemTemplate(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "UPDATE offboarding_item_templates SET is_active = false, updated_at = now() WHERE id = $1",
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Checklist item template not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.item_template.deactivate",
        target: id,
      });
    });
  }

  // ------------------------------------------------------------------
  // Instance lifecycle
  // ------------------------------------------------------------------

  async initiateOffboarding(
    claims: RequestClaims,
    employeeId: string,
    input: InitiateOffboardingRequest
  ): Promise<EmployeeOffboardingView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await client.query<{ id: string; employment_status: string }>(
        "SELECT id, employment_status FROM employees WHERE id = $1",
        [employeeId]
      );
      if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
      if (employee.rows[0].employment_status === "terminated") {
        throw new BadRequestException("This employee is already terminated");
      }

      const existing = await client.query(
        "SELECT 1 FROM employee_offboarding WHERE employee_id = $1 AND status = 'in_progress'",
        [employeeId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This employee already has an offboarding in progress");
      }

      // LIF-05: the notice period defaults from the Termination / Exit policy.
      let noticeDays: number | null = input.noticePeriodDays ?? null;
      if (noticeDays === null && this.businessPolicy) {
        const rules = await this.businessPolicy.resolveEffectivePolicy(client, claims.company_id!, "termination_exit", { employeeId });
        if (typeof rules?.noticeDays === "number") noticeDays = rules.noticeDays;
      }
      const offboarding = await client.query(
        `INSERT INTO employee_offboarding
           (company_id, employee_id, reason, last_working_day, notes, initiated_by_user_account_id,
            reason_code, notice_period_days, notice_start_date, exit_interview_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          claims.company_id, employeeId, input.reason, input.lastWorkingDay, input.notes ?? null, claims.sub,
          input.reasonCode ?? null, noticeDays, input.noticeStartDate ?? null,
          input.exitInterviewRequired ? "pending" : "not_required",
        ]
      );
      const offboardingId = offboarding.rows[0].id;

      const templates = await client.query(
        "SELECT * FROM offboarding_item_templates WHERE company_id = $1 AND is_active ORDER BY sort_order, created_at",
        [claims.company_id]
      );
      for (const t of templates.rows) {
        await client.query(
          `INSERT INTO employee_offboarding_items
             (offboarding_id, company_id, template_item_id, title, category, responsible_role, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [offboardingId, claims.company_id, t.id, t.title, t.category, t.responsible_role, t.sort_order]
        );
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.initiate",
        target: offboardingId,
        metadata: { employeeId, reason: input.reason, lastWorkingDay: input.lastWorkingDay, itemCount: templates.rowCount ?? 0 },
      });

      return this.loadView(client, offboardingId);
    });
  }

  async getForEmployee(claims: RequestClaims, employeeId: string): Promise<EmployeeOffboardingView | null> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      await requireScopedEmployeeAccess(
        this.rbac,
        claims,
        client,
        employeeId,
        MANAGE_PERMISSION,
        VIEW_SELF_PERMISSION,
        VIEW_TEAM_PERMISSION,
        "Not permitted to view this employee's offboarding"
      );
      const row = await client.query(
        "SELECT id FROM employee_offboarding WHERE employee_id = $1 ORDER BY started_at DESC LIMIT 1",
        [employeeId]
      );
      if (row.rowCount === 0) return null;
      return this.loadView(client, row.rows[0].id);
    });
  }

  /** HR-only dashboard read: every offboarding currently in progress. */
  async listInProgress(claims: RequestClaims): Promise<EmployeeOffboardingView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const rows = await client.query(
        "SELECT id FROM employee_offboarding WHERE company_id = $1 AND status = 'in_progress' ORDER BY last_working_day",
        [claims.company_id]
      );
      const views: EmployeeOffboardingView[] = [];
      for (const row of rows.rows) {
        views.push(await this.loadView(client, row.id));
      }
      return views;
    });
  }

  async updateItem(
    claims: RequestClaims,
    itemId: string,
    input: UpdateChecklistItemRequest
  ): Promise<OffboardingChecklistItemView> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const item = await client.query(
        `SELECT oi.*, o.employee_id AS offboarding_employee_id
         FROM employee_offboarding_items oi
         JOIN employee_offboarding o ON o.id = oi.offboarding_id
         WHERE oi.id = $1`,
        [itemId]
      );
      if (item.rowCount === 0) throw new NotFoundException("Checklist item not found");
      const row = item.rows[0];

      await requireItemCompletionAccess(
        this.rbac,
        claims,
        client,
        row.offboarding_employee_id,
        row.responsible_role,
        MANAGE_PERMISSION,
        VIEW_SELF_PERMISSION,
        VIEW_TEAM_PERMISSION,
        "Not permitted to update this checklist item"
      );

      const result = await client.query(
        `UPDATE employee_offboarding_items
         SET status = $2, notes = $3,
             completed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
             completed_by_user_account_id = CASE WHEN $2 = 'pending' THEN NULL ELSE $4::uuid END
         WHERE id = $1 RETURNING *`,
        [itemId, input.status, input.notes ?? row.notes, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.item.update",
        target: itemId,
        metadata: { status: input.status },
      });

      return rowToItem(result.rows[0]);
    });
  }

  /**
   * Finalizes the offboarding: requires every checklist item to be out
   * of `pending` first (a real, deliberate gate — unlike onboarding,
   * this action has a genuine, hard-to-reverse consequence), then
   * delegates to `EmployeesService.update()` to actually terminate the
   * employee, reusing its existing validation and job-history side
   * effect rather than duplicating either. HR-only, matching the
   * `MANAGE_PERMISSION` gate `EmployeesService.update()` itself also
   * requires (`employee.manage.all`) — every real hr_admin already
   * holds both.
   */
  async completeOffboarding(claims: RequestClaims, employeeId: string): Promise<EmployeeOffboardingView> {
    await this.requireManage(claims);
    const offboardingId = await this.db.withClaims(claims, async (client) => {
      const offboarding = await client.query(
        "SELECT * FROM employee_offboarding WHERE employee_id = $1 AND status = 'in_progress'",
        [employeeId]
      );
      if (offboarding.rowCount === 0) throw new NotFoundException("This employee has no offboarding in progress");
      const row = offboarding.rows[0];

      const pending = await client.query<{ count: string }>(
        "SELECT COUNT(*) FROM employee_offboarding_items WHERE offboarding_id = $1 AND status = 'pending'",
        [row.id]
      );
      if (Number(pending.rows[0].count) > 0) {
        throw new BadRequestException(
          `${pending.rows[0].count} checklist item(s) are still pending — complete or skip them before finalizing`
        );
      }
      if (row.exit_interview_status === "pending") {
        throw new BadRequestException("The exit interview is still pending - record it as completed or declined (or not required) before finalizing");
      }
      return row.id as string;
    });

    // Deliberately a second transaction: EmployeesService.update() opens
    // and manages its own `db.withClaims` call, and this codebase's
    // DatabaseService doesn't support nested/cross-service transactions
    // — the same documented, accepted tradeoff LeaveRequestsService's
    // own Workflow Engine integration already lives with.
    const offboarding = await this.db.withClaims(claims, (client) =>
      client.query("SELECT * FROM employee_offboarding WHERE id = $1", [offboardingId])
    );
    const row = offboarding.rows[0];

    // LIF-05: terminate through the lifecycle service so the exit produces a
    // real termination event (applied now, or SCHEDULED when the last working
    // day is still ahead - the employee stays employed until then), revokes
    // access on the day it takes effect and links back to this offboarding.
    let terminationEventId: string | null = null;
    if (this.lifecycle) {
      const result = await this.lifecycle.terminate(
        claims,
        employeeId,
        {
          terminationDate: toIsoDate(row.last_working_day),
          terminationReason: row.reason,
          reasonCode: row.reason_code ?? undefined,
          notes: row.notes ?? undefined,
        },
        { sourceChannel: "offboarding" }
      );
      terminationEventId = result.event.id;
    } else {
      await this.employees.update(claims, employeeId, {
        employmentStatus: "terminated",
        terminationDate: toIsoDate(row.last_working_day),
        terminationReason: row.reason,
      });
    }

    return this.db.withClaims(claims, async (client) => {
      await client.query(
        "UPDATE employee_offboarding SET status = 'completed', completed_at = now(), termination_event_id = $2 WHERE id = $1",
        [offboardingId, terminationEventId]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.complete",
        target: offboardingId,
        metadata: { employeeId, terminationEventId },
      });
      return this.loadView(client, offboardingId);
    });
  }

  /** LIF-05 / LIF-06: notice period, rehire eligibility and exit interview, recorded while (or after) the exit is handled. */
  async updateExitDetails(claims: RequestClaims, employeeId: string, input: UpdateOffboardingExitRequest): Promise<EmployeeOffboardingView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query(
        "SELECT * FROM employee_offboarding WHERE employee_id = $1 ORDER BY started_at DESC LIMIT 1",
        [employeeId]
      );
      if (current.rowCount === 0) throw new NotFoundException("This employee has no offboarding record");
      const row = current.rows[0];
      const has = (k: keyof UpdateOffboardingExitRequest) => Object.prototype.hasOwnProperty.call(input, k);
      const interview = input.exitInterviewStatus ?? row.exit_interview_status;
      const result = await client.query(
        `UPDATE employee_offboarding SET
            rehire_eligibility = $2, rehire_eligibility_note = $3, exit_interview_status = $4,
            exit_interview_notes = $5,
            exit_interview_completed_at = CASE WHEN $4 IN ('completed', 'declined') AND exit_interview_completed_at IS NULL THEN now()
                                               WHEN $4 NOT IN ('completed', 'declined') THEN NULL ELSE exit_interview_completed_at END,
            notice_period_days = $6, notice_start_date = $7::date
          WHERE id = $1 RETURNING *`,
        [
          row.id,
          has("rehireEligibility") ? input.rehireEligibility : row.rehire_eligibility,
          has("rehireEligibilityNote") ? input.rehireEligibilityNote : row.rehire_eligibility_note,
          interview,
          has("exitInterviewNotes") ? input.exitInterviewNotes : row.exit_interview_notes,
          has("noticePeriodDays") ? input.noticePeriodDays : row.notice_period_days,
          has("noticeStartDate") ? input.noticeStartDate : row.notice_start_date ? toIsoDate(row.notice_start_date) : null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "offboarding.exit_details.update",
        target: row.id,
        metadata: { employeeId, rehireEligibility: result.rows[0].rehire_eligibility, exitInterviewStatus: interview },
      });
      return this.loadView(client, row.id);
    });
  }

  private async loadView(client: PoolClient, offboardingId: string): Promise<EmployeeOffboardingView> {
    const offboarding = await client.query(
      `SELECT eo.*, e.employee_number, e.first_name, e.last_name
       FROM employee_offboarding eo
       JOIN employees e ON e.id = eo.employee_id
       WHERE eo.id = $1`,
      [offboardingId]
    );
    const items = await client.query(
      "SELECT * FROM employee_offboarding_items WHERE offboarding_id = $1 ORDER BY sort_order, title",
      [offboardingId]
    );
    const row = offboarding.rows[0];
    return {
      id: row.id,
      employeeId: row.employee_id,
      employeeNumber: row.employee_number,
      employeeName: `${row.first_name} ${row.last_name}`,
      reason: row.reason,
      lastWorkingDay: toIsoDate(row.last_working_day),
      notes: row.notes,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      items: items.rows.map(rowToItem),
      reasonCode: row.reason_code ?? null,
      noticePeriodDays: row.notice_period_days ?? null,
      noticeStartDate: row.notice_start_date ? toIsoDate(row.notice_start_date) : null,
      rehireEligibility: row.rehire_eligibility ?? null,
      rehireEligibilityNote: row.rehire_eligibility_note ?? null,
      exitInterviewStatus: row.exit_interview_status ?? "not_required",
      exitInterviewCompletedAt: row.exit_interview_completed_at ? new Date(row.exit_interview_completed_at).toISOString() : null,
      exitInterviewNotes: row.exit_interview_notes ?? null,
      terminationEventId: row.termination_event_id ?? null,
    };
  }
}
