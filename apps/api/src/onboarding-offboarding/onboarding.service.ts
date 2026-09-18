import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { requireItemCompletionAccess, requireScopedEmployeeAccess } from "./checklist-access.util";
import type {
  CreateOnboardingItemTemplateRequest,
  EmployeeOnboardingView,
  OnboardingChecklistItemView,
  OnboardingItemTemplateView,
  UpdateChecklistItemRequest,
  UpdateOnboardingItemTemplateRequest,
} from "@boostfactor/shared-types";

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
  };
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
  };
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
    private readonly audit: AuditService
  ) {}

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
        `INSERT INTO onboarding_item_templates (company_id, title, category, responsible_role, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [claims.company_id, input.title, input.category, input.responsibleRole, input.sortOrder ?? 0]
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
      const employee = await client.query<{ id: string; employment_status: string }>(
        "SELECT id, employment_status FROM employees WHERE id = $1",
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
      for (const t of templates.rows) {
        await client.query(
          `INSERT INTO employee_onboarding_items
             (onboarding_id, company_id, template_item_id, title, category, responsible_role, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [onboardingId, claims.company_id, t.id, t.title, t.category, t.responsible_role, t.sort_order]
        );
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "onboarding.initiate",
        target: onboardingId,
        metadata: { employeeId, itemCount: templates.rowCount ?? 0 },
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
