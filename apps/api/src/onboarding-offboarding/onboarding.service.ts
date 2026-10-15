import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { WorkflowService } from "../workflow/workflow.service";
import { AuditService } from "../audit/audit.service";
import { requireItemCompletionAccess, requireScopedEmployeeAccess } from "./checklist-access.util";
import type {
  AssignOnboardingItemRequest,
  CreateOnboardingItemTemplateRequest,
  EmployeeOnboardingView,
  MyOnboardingItemView,
  OnboardingAssigneeRule,
  OnboardingChecklistItemView,
  OnboardingItemApplicability,
  OnboardingItemTemplateView,
  UpdateChecklistItemRequest,
  UpdateOnboardingItemTemplateRequest,
} from "@aihxm/shared-types";

// Gated on the existing `recruitment` module_catalog entry — see
// 0035_onboarding_offboarding.sql's header comment for why this reuses
// that placeholder rather than a new sellable module.
const MODULE_KEY = "recruitment" as const;
const MANAGE_PERMISSION = "onboarding.manage.all";
const VIEW_TEAM_PERMISSION = "onboarding.view.team";
const VIEW_SELF_PERMISSION = "onboarding.view.self";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTemplate(row: any): OnboardingItemTemplateView {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    responsibleRole: row.responsible_role,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    applicability: normalizeApplicability(row.applicability),
    assigneeRule: (row.assignee_rule ?? "none") as OnboardingAssigneeRule,
    dueOffsetDays: row.due_offset_days ?? null,
  };
}

/** Keep only non-empty, de-duplicated lists; an empty object means "applies to everyone". */
export function normalizeApplicability(input: unknown): OnboardingItemApplicability {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: OnboardingItemApplicability = {};
  for (const key of ["employmentTypes", "orgUnitIds", "locationIds"] as const) {
    const raw = src[key];
    if (!Array.isArray(raw)) continue;
    const list = [...new Set(raw.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
    if (list.length > 0) out[key] = list;
  }
  return out;
}

export type ApplicabilityEmployee = { employment_type: string | null; org_unit_id: string | null; location_id: string | null };

/**
 * An item applies when, for every dimension the template restricts, the
 * employee's value is in the list. A restricted dimension the employee has no
 * value for does not match (an item meant for "Karachi office" is not given to
 * someone with no location). No restrictions = everyone.
 */
export function matchesApplicability(app: OnboardingItemApplicability, emp: ApplicabilityEmployee): boolean {
  if (app.employmentTypes?.length && !(emp.employment_type && app.employmentTypes.includes(emp.employment_type))) return false;
  if (app.orgUnitIds?.length && !(emp.org_unit_id && app.orgUnitIds.includes(emp.org_unit_id))) return false;
  if (app.locationIds?.length && !(emp.location_id && app.locationIds.includes(emp.location_id))) return false;
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToItem(row: any): OnboardingChecklistItemView {
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
    assignedToUserAccountId: row.assigned_to_user_account_id ?? null,
    assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : null,
    dueDate: toDateOnly(row.due_date),
    isOverdue: row.status === "pending" && !!row.due_date && toDateOnly(row.due_date)! < todayIso(),
    workflowTaskId: row.workflow_task_id ?? null,
  };
}

function toDateOnly(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    // pg returns DATE as a local-midnight Date; format with local parts
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function todayIso(): string {
  return toDateOnly(new Date())!;
}

/**
 * Onboarding checklists — see 0035_onboarding_offboarding.sql for the
 * full design writeup. A company configures a list of checklist item
 * templates once (`*ItemTemplate*` methods below, HR-only); each new
 * hire's onboarding clones the currently-active templates into their own
 * item rows at `initiate()` time, so a later template edit never rewrites
 * an in-flight employee's checklist history.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    // WFL-01 (Step 6): My Inbox lists a person's open onboarding items next to their approvals.
    // Optional + appended so positional spec constructions keep working.
    private readonly workflow?: WorkflowService
  ) {
    this.workflow?.adapters?.register({
      objectKey: "onboarding_item",
      label: "Onboarding task",
      listTasks: async (client, claims) => {
        const rows = await client.query(
          `SELECT oi.id, oi.title, oi.due_date, oi.assigned_at, oi.onboarding_id,
                  e.first_name, e.last_name
             FROM employee_onboarding_items oi
             JOIN employee_onboarding o ON o.id = oi.onboarding_id
             JOIN employees e ON e.id = o.employee_id
            WHERE oi.assigned_to_user_account_id = $1 AND oi.status = 'pending' AND o.status = 'in_progress'
            ORDER BY oi.due_date NULLS LAST, oi.sort_order`,
          [claims.sub]
        );
        return rows.rows.map((r) => ({
          instanceId: r.id,
          stepInstanceId: null,
          objectKey: "onboarding_item",
          objectLabel: "Onboarding task",
          recordId: r.id,
          title: r.title,
          status: "in_progress" as const,
          priority: "normal" as const,
          stepName: null,
          submittedByUserAccountId: claims.sub,
          submittedAt: new Date(r.assigned_at ?? Date.now()).toISOString(),
          dueAt: r.due_date ? new Date(r.due_date).toISOString() : null,
          slaState: "none" as const,
          actingFor: null,
          reason: "task" as const,
          canSendBack: false,
          summary: `Onboarding for ${r.first_name} ${r.last_name}`,
          deepLink: `/onboarding/${r.onboarding_id}`,
        }));
      },
    });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage onboarding");
    }
  }

  // ------------------------------------------------------------------
  // Item templates — company-configured checklist definition
  // ------------------------------------------------------------------

  async createItemTemplate(
    claims: RequestClaims,
    input: CreateOnboardingItemTemplateRequest
  ): Promise<OnboardingItemTemplateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO onboarding_item_templates
           (company_id, title, category, responsible_role, sort_order, applicability, assignee_rule, due_offset_days)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [
          claims.company_id,
          input.title,
          input.category,
          input.responsibleRole,
          input.sortOrder ?? 0,
          JSON.stringify(normalizeApplicability(input.applicability)),
          input.assigneeRule ?? "none",
          input.dueOffsetDays ?? null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.item_template.create",
        target: result.rows[0].id,
        metadata: { title: input.title },
      });
      return rowToTemplate(result.rows[0]);
    });
  }

  async listItemTemplates(claims: RequestClaims): Promise<OnboardingItemTemplateView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM onboarding_item_templates WHERE company_id = $1 ORDER BY sort_order, created_at",
        [claims.company_id]
      );
      return result.rows.map(rowToTemplate);
    });
  }

  async updateItemTemplate(
    claims: RequestClaims,
    id: string,
    input: UpdateOnboardingItemTemplateRequest
  ): Promise<OnboardingItemTemplateView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM onboarding_item_templates WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Checklist item template not found");
      const row = current.rows[0];

      const result = await client.query(
        `UPDATE onboarding_item_templates
         SET title = $2, category = $3, responsible_role = $4, sort_order = $5, is_active = $6,
             applicability = $7::jsonb, assignee_rule = $8, due_offset_days = $9, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          input.title ?? row.title,
          input.category ?? row.category,
          input.responsibleRole ?? row.responsible_role,
          input.sortOrder ?? row.sort_order,
          input.isActive ?? row.is_active,
          JSON.stringify(input.applicability !== undefined ? normalizeApplicability(input.applicability) : normalizeApplicability(row.applicability)),
          input.assigneeRule ?? row.assignee_rule,
          input.dueOffsetDays !== undefined ? input.dueOffsetDays : row.due_offset_days,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.item_template.update",
        target: id,
      });
      return rowToTemplate(result.rows[0]);
    });
  }

  /**
   * Soft delete only (`is_active = false`), never a hard delete — unlike
   * Holiday Management's calendar entries, cloned checklist items keep a
   * (nullable, SET NULL) FK back to their template, so a hard delete
   * here isn't even destructive to history; deactivating is still the
   * right primitive because the whole point is "stop cloning this onto
   * NEW checklists," not "erase that this template ever existed."
   */
  async deactivateItemTemplate(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "UPDATE onboarding_item_templates SET is_active = false, updated_at = now() WHERE id = $1",
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Checklist item template not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.item_template.deactivate",
        target: id,
      });
    });
  }

  // ------------------------------------------------------------------
  // Instance lifecycle
  // ------------------------------------------------------------------

  async initiateOnboarding(claims: RequestClaims, employeeId: string): Promise<EmployeeOnboardingView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await client.query<{
        id: string;
        employment_status: string;
        employment_type: string | null;
        org_unit_id: string | null;
        location_id: string | null;
        user_account_id: string | null;
        manager_id: string | null;
        date_of_joining: Date | string | null;
      }>(
        `SELECT id, employment_status, employment_type, org_unit_id, location_id, user_account_id, manager_id, date_of_joining
           FROM employees WHERE id = $1`,
        [employeeId]
      );
      if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
      if (employee.rows[0].employment_status === "terminated") {
        throw new BadRequestException("Cannot start onboarding for a terminated employee");
      }

      const existing = await client.query(
        "SELECT 1 FROM employee_onboarding WHERE employee_id = $1 AND status = 'in_progress'",
        [employeeId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException("This employee already has an onboarding in progress");
      }

      const onboarding = await client.query(
        `INSERT INTO employee_onboarding (company_id, employee_id, initiated_by_user_account_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [claims.company_id, employeeId, claims.sub]
      );
      const onboardingId = onboarding.rows[0].id;

      const templates = await client.query(
        "SELECT * FROM onboarding_item_templates WHERE company_id = $1 AND is_active ORDER BY sort_order, created_at",
        [claims.company_id]
      );
      const emp = employee.rows[0];
      // due dates count from the later of today and the joining date, so a past joining date does not make every item overdue on day one
      const startDate = await client.query<{ d: string }>(
        "SELECT GREATEST(CURRENT_DATE, COALESCE($1::date, CURRENT_DATE))::text AS d",
        [emp.date_of_joining ? toDateOnly(emp.date_of_joining) : null]
      );
      let managerUserId: string | null = null;
      if (emp.manager_id) {
        const mgr = await client.query<{ user_account_id: string | null }>(
          "SELECT user_account_id FROM employees WHERE id = $1",
          [emp.manager_id]
        );
        managerUserId = mgr.rows[0]?.user_account_id ?? null;
      }
      let created = 0;
      let skipped = 0;
      for (const t of templates.rows) {
        if (!matchesApplicability(normalizeApplicability(t.applicability), emp)) {
          skipped += 1;
          continue;
        }
        const assignee =
          t.assignee_rule === "employee" ? emp.user_account_id : t.assignee_rule === "manager" ? managerUserId : null;
        await client.query(
          `INSERT INTO employee_onboarding_items
             (onboarding_id, company_id, template_item_id, title, category, responsible_role, sort_order,
              assigned_to_user_account_id, assigned_at, due_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid,
                   CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END,
                   CASE WHEN $9::int IS NULL THEN NULL ELSE ($10::date + $9::int) END)`,
          [
            onboardingId,
            claims.company_id,
            t.id,
            t.title,
            t.category,
            t.responsible_role,
            t.sort_order,
            assignee,
            t.due_offset_days,
            startDate.rows[0].d,
          ]
        );
        created += 1;
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.initiate",
        target: onboardingId,
        metadata: { employeeId, itemCount: created, skippedNotApplicable: skipped },
      });

      return this.loadView(client, onboardingId);
    });
  }

  async getForEmployee(claims: RequestClaims, employeeId: string): Promise<EmployeeOnboardingView | null> {
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
        "Not permitted to view this employee's onboarding"
      );
      const row = await client.query(
        "SELECT id FROM employee_onboarding WHERE employee_id = $1 ORDER BY started_at DESC LIMIT 1",
        [employeeId]
      );
      if (row.rowCount === 0) return null;
      return this.loadView(client, row.rows[0].id);
    });
  }

  /** HR-only dashboard read: every onboarding currently in progress. */
  async listInProgress(claims: RequestClaims): Promise<EmployeeOnboardingView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const rows = await client.query(
        "SELECT id FROM employee_onboarding WHERE company_id = $1 AND status = 'in_progress' ORDER BY started_at",
        [claims.company_id]
      );
      const views: EmployeeOnboardingView[] = [];
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
  ): Promise<OnboardingChecklistItemView> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const item = await client.query(
        `SELECT oi.*, o.employee_id AS onboarding_employee_id
         FROM employee_onboarding_items oi
         JOIN employee_onboarding o ON o.id = oi.onboarding_id
         WHERE oi.id = $1`,
        [itemId]
      );
      if (item.rowCount === 0) throw new NotFoundException("Checklist item not found");
      const row = item.rows[0];

      await requireItemCompletionAccess(
        this.rbac,
        claims,
        client,
        row.onboarding_employee_id,
        row.responsible_role,
        MANAGE_PERMISSION,
        VIEW_SELF_PERMISSION,
        VIEW_TEAM_PERMISSION,
        "Not permitted to update this checklist item"
      );

      const result = await client.query(
        `UPDATE employee_onboarding_items
         SET status = $2, notes = $3,
             completed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
             completed_by_user_account_id = CASE WHEN $2 = 'pending' THEN NULL ELSE $4::uuid END
         WHERE id = $1 RETURNING *`,
        [itemId, input.status, input.notes ?? row.notes, claims.sub]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.item.update",
        target: itemId,
        metadata: { status: input.status },
      });

      await this.maybeCompleteOnboarding(client, row.onboarding_id);

      return rowToItem(result.rows[0]);
    });
  }

  // ------------------------------------------------------------------
  // LIF-09: assignment, due dates, my items, overdue
  // ------------------------------------------------------------------

  /** (Re)assign an onboarding item to a user of this company, or clear the assignee; optionally set the due date. */
  async assignItem(
    claims: RequestClaims,
    itemId: string,
    input: AssignOnboardingItemRequest
  ): Promise<OnboardingChecklistItemView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const item = await client.query("SELECT * FROM employee_onboarding_items WHERE id = $1", [itemId]);
      if (item.rowCount === 0) throw new NotFoundException("Checklist item not found");
      const row = item.rows[0];
      if (row.status !== "pending") throw new ConflictException("Only a pending checklist item can be reassigned");

      if (input.assignedToUserAccountId) {
        const member = await client.query(
          `SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2
           UNION SELECT 1 FROM employees WHERE user_account_id = $1 AND company_id = $2 LIMIT 1`,
          [input.assignedToUserAccountId, claims.company_id]
        );
        if (member.rowCount === 0) throw new BadRequestException("The assignee is not a user of this company");
      }
      const dueDate = input.dueDate === undefined ? toDateOnly(row.due_date) : input.dueDate ? input.dueDate.slice(0, 10) : null;

      const result = await client.query(
        `UPDATE employee_onboarding_items
            SET assigned_to_user_account_id = $2::uuid,
                assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,
                due_date = $3::date
          WHERE id = $1 RETURNING *`,
        [itemId, input.assignedToUserAccountId, dueDate]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.item.assign",
        target: itemId,
        metadata: {
          from: row.assigned_to_user_account_id ?? null,
          to: input.assignedToUserAccountId,
          dueDate,
        },
      });
      return rowToItem(result.rows[0]);
    });
  }

  /** The caller's own pending items, soonest due first (undated last). */
  async listMyItems(claims: RequestClaims): Promise<MyOnboardingItemView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const rows = await client.query(
        `SELECT oi.*, o.employee_id, e.employee_number, e.first_name, e.last_name
           FROM employee_onboarding_items oi
           JOIN employee_onboarding o ON o.id = oi.onboarding_id
           JOIN employees e ON e.id = o.employee_id
          WHERE oi.assigned_to_user_account_id = $1 AND oi.status = 'pending' AND o.status = 'in_progress'
          ORDER BY oi.due_date NULLS LAST, oi.sort_order`,
        [claims.sub]
      );
      return rows.rows.map((r) => ({
        ...rowToItem(r),
        onboardingId: r.onboarding_id,
        employeeId: r.employee_id,
        employeeName: `${r.first_name} ${r.last_name}`,
        employeeNumber: r.employee_number,
      }));
    });
  }

  /** HR view: every pending item past its due date, oldest first. */
  async listOverdue(claims: RequestClaims): Promise<MyOnboardingItemView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const rows = await client.query(
        `SELECT oi.*, o.employee_id, e.employee_number, e.first_name, e.last_name
           FROM employee_onboarding_items oi
           JOIN employee_onboarding o ON o.id = oi.onboarding_id
           JOIN employees e ON e.id = o.employee_id
          WHERE oi.company_id = $1 AND oi.status = 'pending' AND o.status = 'in_progress'
            AND oi.due_date IS NOT NULL AND oi.due_date < CURRENT_DATE
          ORDER BY oi.due_date, oi.sort_order`,
        [claims.company_id]
      );
      return rows.rows.map((r) => ({
        ...rowToItem(r),
        onboardingId: r.onboarding_id,
        employeeId: r.employee_id,
        employeeName: `${r.first_name} ${r.last_name}`,
        employeeNumber: r.employee_number,
      }));
    });
  }

  /**
   * Once every item on an onboarding is out of `pending` (completed OR
   * deliberately skipped), the whole onboarding auto-completes — there's
   * no separate "finalize" action for onboarding the way Offboarding
   * needs one (Offboarding's finalize does the real, consequential work
   * of flipping `employment_status`; onboarding completing has no such
   * side effect to gate behind an explicit HR action).
   */
  private async maybeCompleteOnboarding(client: PoolClient, onboardingId: string): Promise<void> {
    const remaining = await client.query<{ count: string }>(
      "SELECT COUNT(*) FROM employee_onboarding_items WHERE onboarding_id = $1 AND status = 'pending'",
      [onboardingId]
    );
    if (Number(remaining.rows[0].count) === 0) {
      await client.query(
        "UPDATE employee_onboarding SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'in_progress'",
        [onboardingId]
      );
    }
  }

  private async loadView(client: PoolClient, onboardingId: string): Promise<EmployeeOnboardingView> {
    const onboarding = await client.query(
      `SELECT eo.*, e.employee_number, e.first_name, e.last_name
       FROM employee_onboarding eo
       JOIN employees e ON e.id = eo.employee_id
       WHERE eo.id = $1`,
      [onboardingId]
    );
    const items = await client.query(
      "SELECT * FROM employee_onboarding_items WHERE onboarding_id = $1 ORDER BY sort_order, title",
      [onboardingId]
    );
    const row = onboarding.rows[0];
    return {
      id: row.id,
      employeeId: row.employee_id,
      employeeNumber: row.employee_number,
      employeeName: `${row.first_name} ${row.last_name}`,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      items: items.rows.map(rowToItem),
    };
  }
}
