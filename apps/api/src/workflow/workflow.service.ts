import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import type {
  ApproverType,
  EscalationApproverType,
  WorkflowApprovalStatus,
  WorkflowInstanceView,
  WorkflowStepApprovalView,
  WorkflowStepInstanceView,
  WorkflowStepStatus,
  WorkflowTemplate,
} from "@aihxm/shared-types";

const MANAGE_PERMISSION = "workflow_template.manage.all";

type FieldCondition = { field: string; equals: unknown };

type TemplateStepRow = {
  id: string;
  step_order: number;
  name: string;
  condition: FieldCondition | null;
  sla_hours: number | null;
};

type TemplateApproverRow = {
  id: string;
  step_id: string;
  approver_type: ApproverType;
  role_id: string | null;
  user_account_id: string | null;
  escalation_approver_type: EscalationApproverType | null;
  escalation_role_id: string | null;
  escalation_user_account_id: string | null;
};

function conditionMatches(condition: FieldCondition | null, record: Record<string, unknown>): boolean {
  if (!condition) return true;
  return record[condition.field] === condition.equals;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

/**
 * The generic, tenant-configurable approval-routing engine — plan doc
 * Section 6's "Workflows" WRICEF pillar. Deliberately decoupled from any
 * specific object's schema: callers pass `objectKey`/`recordId` plus a
 * point-in-time `record` snapshot for conditional-step evaluation
 * (0007_wricef_workflow.sql's header comment has the full reasoning), and
 * this service never queries an arbitrary object's own table itself.
 *
 * Whether the CALLER may submit or view a given record at all is
 * explicitly NOT this service's job — the module that owns the object
 * (DummyService today; any real module later) is responsible for
 * checking its own RBAC rules before ever calling in here, the same way
 * it already does before returning the record to begin with. This
 * service only owns what happens once a record enters a workflow.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService
  ) {}

  // -----------------------------------------------------------------
  // Templates
  // -----------------------------------------------------------------

  async createTemplate(
    claims: RequestClaims,
    dto: {
      key: string;
      name: string;
      objectKey: string;
      steps: Array<{
        stepOrder: number;
        name: string;
        condition?: FieldCondition | null;
        slaHours?: number;
        approvers: Array<{
          approverType: ApproverType;
          roleId?: string;
          userAccountId?: string;
          escalationApproverType?: EscalationApproverType;
          escalationRoleId?: string;
          escalationUserAccountId?: string;
        }>;
      }>;
    }
  ): Promise<WorkflowTemplate> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage workflow templates");
    }
    const stepOrders = dto.steps.map((s) => s.stepOrder);
    if (new Set(stepOrders).size !== stepOrders.length) {
      throw new BadRequestException("stepOrder values must be unique within a template");
    }

    return this.db.withClaims(claims, async (client) => {
      const templateResult = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO workflow_templates (company_id, key, name, object_key)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [claims.company_id, dto.key, dto.name, dto.objectKey]
      );
      const templateId = templateResult.rows[0].id;

      for (const step of dto.steps) {
        const stepResult = await client.query<{ id: string }>(
          `INSERT INTO workflow_template_steps (template_id, step_order, name, condition, sla_hours)
           VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
          [templateId, step.stepOrder, step.name, step.condition ? JSON.stringify(step.condition) : null, step.slaHours ?? null]
        );
        const stepId = stepResult.rows[0].id;

        for (const approver of step.approvers) {
          await client.query(
            `INSERT INTO workflow_template_step_approvers
               (step_id, approver_type, role_id, user_account_id,
                escalation_approver_type, escalation_role_id, escalation_user_account_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              stepId,
              approver.approverType,
              approver.roleId ?? null,
              approver.userAccountId ?? null,
              approver.escalationApproverType ?? null,
              approver.escalationRoleId ?? null,
              approver.escalationUserAccountId ?? null,
            ]
          );
        }
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "workflow_template.create",
        target: templateId,
        metadata: { key: dto.key, objectKey: dto.objectKey, stepCount: dto.steps.length },
      });

      const template = await this.loadTemplate(client, templateId);
      if (!template) throw new Error("Template vanished immediately after insert");
      return template;
    });
  }

  async getTemplateByKey(claims: RequestClaims, key: string): Promise<WorkflowTemplate | null> {
    if (!claims.company_id) return null;
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM workflow_templates WHERE company_id = $1 AND key = $2`,
        [claims.company_id, key]
      );
      if (result.rowCount === 0) return null;
      return this.loadTemplate(client, result.rows[0].id);
    });
  }

  async listTemplates(claims: RequestClaims): Promise<WorkflowTemplate[]> {
    if (!claims.company_id) return [];
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to view workflow templates");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM workflow_templates WHERE company_id = $1 ORDER BY created_at ASC`,
        [claims.company_id]
      );
      const templates: WorkflowTemplate[] = [];
      for (const row of result.rows) {
        const t = await this.loadTemplate(client, row.id);
        if (t) templates.push(t);
      }
      return templates;
    });
  }

  private async loadTemplate(client: PoolClient, templateId: string): Promise<WorkflowTemplate | null> {
    const templateResult = await client.query(
      `SELECT * FROM workflow_templates WHERE id = $1`,
      [templateId]
    );
    if (templateResult.rowCount === 0) return null;
    const t = templateResult.rows[0];

    const stepsResult = await client.query<TemplateStepRow>(
      `SELECT id, step_order, name, condition, sla_hours FROM workflow_template_steps
       WHERE template_id = $1 ORDER BY step_order ASC`,
      [templateId]
    );
    const approversResult = await client.query<TemplateApproverRow>(
      `SELECT a.* FROM workflow_template_step_approvers a
       JOIN workflow_template_steps s ON s.id = a.step_id
       WHERE s.template_id = $1`,
      [templateId]
    );

    return {
      id: t.id,
      companyId: t.company_id,
      key: t.key,
      name: t.name,
      objectKey: t.object_key,
      isActive: t.is_active,
      createdAt: toIso(t.created_at),
      steps: stepsResult.rows.map((s) => ({
        stepOrder: s.step_order,
        name: s.name,
        condition: s.condition ?? undefined,
        slaHours: s.sla_hours ?? undefined,
        approvers: approversResult.rows
          .filter((a) => a.step_id === s.id)
          .map((a) => ({
            approverType: a.approver_type,
            roleId: a.role_id ?? undefined,
            userAccountId: a.user_account_id ?? undefined,
            escalationApproverType: a.escalation_approver_type ?? undefined,
            escalationRoleId: a.escalation_role_id ?? undefined,
            escalationUserAccountId: a.escalation_user_account_id ?? undefined,
          })),
      })),
    };
  }

  // -----------------------------------------------------------------
  // Instances
  // -----------------------------------------------------------------

  async submitForApproval(
    claims: RequestClaims,
    dto: {
      templateKey: string;
      objectKey: string;
      recordId: string;
      record: Record<string, unknown>;
      /**
       * Who a `manager_of_submitter` approver should actually resolve
       * against — see 0014_workflow_manager_of_submitter.sql's header
       * comment. Omit for the ordinary case (the caller is submitting
       * their own record); an On-Behalf submission (Phase 9's leave
       * requests) passes the EMPLOYEE's own `user_account_id` here, not
       * the HR Admin's who is actually calling this method.
       */
      subjectUserAccountId?: string;
    }
  ): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();

    return this.db.withClaims(claims, async (client) => {
      const templateResult = await client.query<{ id: string; is_active: boolean; object_key: string }>(
        `SELECT id, is_active, object_key FROM workflow_templates WHERE company_id = $1 AND key = $2`,
        [claims.company_id, dto.templateKey]
      );
      if (templateResult.rowCount === 0 || !templateResult.rows[0].is_active) {
        throw new NotFoundException("No active workflow template with that key");
      }
      const template = templateResult.rows[0];
      if (template.object_key !== dto.objectKey) {
        throw new BadRequestException("Template is not configured for this object type");
      }

      const steps = await this.loadTemplateStepsWithApprovers(client, template.id);
      if (steps.length === 0) {
        throw new BadRequestException("Template has no steps configured");
      }

      const subjectUserAccountId = dto.subjectUserAccountId ?? claims.sub;
      const instanceResult = await client.query<{ id: string; created_at: Date; updated_at: Date }>(
        `INSERT INTO workflow_instances
           (company_id, template_id, object_key, record_id, submitted_by_user_account_id, subject_user_account_id, record_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id, created_at, updated_at`,
        [claims.company_id, template.id, dto.objectKey, dto.recordId, claims.sub, subjectUserAccountId, JSON.stringify(dto.record)]
      );
      const instanceId = instanceResult.rows[0].id;

      await this.activateFromStep(client, instanceId, steps, 0, dto.record, subjectUserAccountId);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "workflow_instance.submit",
        target: instanceId,
        metadata: { templateKey: dto.templateKey, objectKey: dto.objectKey, recordId: dto.recordId },
      });

      const view = await this.loadInstance(client, instanceId);
      if (!view) throw new Error("Instance vanished immediately after insert");
      return view;
    });
  }

  async getInstance(claims: RequestClaims, id: string): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const view = await this.loadInstance(client, id);
      if (!view) throw new NotFoundException("Workflow instance not found");
      return view;
    });
  }

  async listInstancesForRecord(
    claims: RequestClaims,
    objectKey: string,
    recordId: string
  ): Promise<WorkflowInstanceView[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM workflow_instances WHERE company_id = $1 AND object_key = $2 AND record_id = $3
         ORDER BY created_at DESC`,
        [claims.company_id, objectKey, recordId]
      );
      const views: WorkflowInstanceView[] = [];
      for (const row of result.rows) {
        const v = await this.loadInstance(client, row.id);
        if (v) views.push(v);
      }
      return views;
    });
  }

  /**
   * An approver acts on one step_instance. `claims.sub` must resolve
   * against at least one of that step's still-actionable approval lines
   * (role membership, the specific named user, or — once escalated — the
   * escalation target) or this throws. Recording every line's decision
   * this way, rather than a single "the step is approved" flag, is what
   * makes a multi-line ("parallel") step actually require every line.
   */
  async decide(
    claims: RequestClaims,
    stepInstanceId: string,
    dto: { decision: "approved" | "rejected"; comment?: string }
  ): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();

    return this.db.withClaims(claims, async (client) => {
      const stepResult = await client.query<{
        id: string;
        workflow_instance_id: string;
        step_order: number;
        status: WorkflowStepStatus;
      }>(`SELECT id, workflow_instance_id, step_order, status FROM workflow_step_instances WHERE id = $1`, [
        stepInstanceId,
      ]);
      if (stepResult.rowCount === 0) throw new NotFoundException("Workflow step not found");
      const stepInstance = stepResult.rows[0];
      if (stepInstance.status !== "pending") {
        throw new BadRequestException(`Step is already ${stepInstance.status}, no decision can be recorded`);
      }

      const instanceResult = await client.query<{
        id: string;
        status: string;
        company_id: string;
        template_id: string;
        subject_user_account_id: string;
      }>(
        `SELECT id, status, company_id, template_id, subject_user_account_id FROM workflow_instances WHERE id = $1`,
        [stepInstance.workflow_instance_id]
      );
      if (instanceResult.rowCount === 0) throw new NotFoundException("Workflow instance not found");
      const instance = instanceResult.rows[0];
      if (instance.status !== "in_progress") {
        throw new BadRequestException(`Workflow is already ${instance.status}`);
      }

      const approvalsResult = await client.query<{
        id: string;
        approver_type: ApproverType;
        role_id: string | null;
        user_account_id: string | null;
        status: WorkflowApprovalStatus;
        escalated_to_user_account_id: string | null;
      }>(
        `SELECT id, approver_type, role_id, user_account_id, status, escalated_to_user_account_id
         FROM workflow_step_approvals WHERE step_instance_id = $1`,
        [stepInstanceId]
      );

      let actedApprovalId: string | null = null;
      for (const approval of approvalsResult.rows) {
        if (approval.status !== "pending" && approval.status !== "escalated") continue;
        const isOriginalApprover =
          ((approval.approver_type === "specific_user" || approval.approver_type === "manager_of_submitter") &&
            approval.user_account_id === claims.sub) ||
          (approval.approver_type === "role" && (await this.userHoldsRole(client, claims.sub, instance.company_id, approval.role_id)));
        const isEscalationTarget = approval.status === "escalated" && approval.escalated_to_user_account_id === claims.sub;
        if (isOriginalApprover || isEscalationTarget) {
          actedApprovalId = approval.id;
          break;
        }
      }
      if (!actedApprovalId) {
        throw new ForbiddenException("You are not an approver on this step");
      }

      await client.query(
        `UPDATE workflow_step_approvals
         SET status = $1, decision = $1, decided_by_user_account_id = $2, comment = $3, decided_at = now()
         WHERE id = $4`,
        [dto.decision, claims.sub, dto.comment ?? null, actedApprovalId]
      );

      await this.audit.record(client, claims, {
        companyId: instance.company_id,
        action: "workflow_step.decide",
        target: stepInstanceId,
        metadata: { decision: dto.decision },
      });

      if (dto.decision === "rejected") {
        await client.query(`UPDATE workflow_step_instances SET status = 'rejected', updated_at = now() WHERE id = $1`, [
          stepInstanceId,
        ]);
        await client.query(`UPDATE workflow_instances SET status = 'rejected', updated_at = now() WHERE id = $1`, [
          instance.id,
        ]);
      } else {
        const remaining = await client.query<{ count: string }>(
          `SELECT count(*)::text FROM workflow_step_approvals
           WHERE step_instance_id = $1 AND status NOT IN ('approved')`,
          [stepInstanceId]
        );
        if (Number(remaining.rows[0].count) === 0) {
          await client.query(`UPDATE workflow_step_instances SET status = 'approved', updated_at = now() WHERE id = $1`, [
            stepInstanceId,
          ]);
          const steps = await this.loadTemplateStepsWithApprovers(client, instance.template_id);
          const nextIndex = steps.findIndex((s) => s.stepOrder === stepInstance.step_order) + 1;
          const record = await this.getRecordSnapshot(client, instance.id);
          await this.activateFromStep(client, instance.id, steps, nextIndex, record, instance.subject_user_account_id);
        }
      }

      const view = await this.loadInstance(client, instance.id);
      if (!view) throw new Error("Instance vanished during decision recording");
      return view;
    });
  }

  /**
   * The forced-timeout escalation sweep — this phase's own exit
   * criterion. Runs with service claims (no tenant scoping) so it can
   * see every company's overdue approvals in one pass; RLS still applies
   * (see 0007_wricef_workflow.sql), it just resolves true for
   * `app.is_service()` rather than a specific company. Wired to
   * @nestjs/schedule's cron (workflow.module.ts) for real operation, and
   * exposed as a plain method here so tests can invoke it directly rather
   * than waiting on a real clock — Redis/BullMQ (the plan doc's original
   * Section 8 stack pick for this) is deliberately not introduced for
   * something this simple; see KNOWN_ISSUES.md.
   */
  async escalateOverdue(): Promise<number> {
    const serviceClaims: RequestClaims = { is_platform_admin: false, company_id: null, sub: "system", is_service: true };
    return this.db.withClaims(serviceClaims, async (client) => {
      const overdue = await client.query<{
        id: string;
        role_id: string | null;
        user_account_id: string | null;
        template_approver_id: string | null;
      }>(
        `SELECT id, role_id, user_account_id, template_approver_id
         FROM workflow_step_approvals
         WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < now()`
      );

      let escalatedCount = 0;
      for (const approval of overdue.rows) {
        let escalationTarget: string | null = null;
        if (approval.template_approver_id) {
          const templateApprover = await client.query<{
            escalation_approver_type: EscalationApproverType | null;
            escalation_role_id: string | null;
            escalation_user_account_id: string | null;
          }>(
            `SELECT escalation_approver_type, escalation_role_id, escalation_user_account_id
             FROM workflow_template_step_approvers WHERE id = $1`,
            [approval.template_approver_id]
          );
          if (templateApprover.rowCount && templateApprover.rowCount > 0) {
            const t = templateApprover.rows[0];
            if (t.escalation_approver_type === "specific_user") {
              escalationTarget = t.escalation_user_account_id;
            } else if (t.escalation_approver_type === "role" && t.escalation_role_id) {
              const holder = await client.query<{ user_account_id: string }>(
                `SELECT user_account_id FROM user_role_assignments WHERE role_id = $1 LIMIT 1`,
                [t.escalation_role_id]
              );
              escalationTarget = holder.rows[0]?.user_account_id ?? null;
            }
          }
        }

        await client.query(
          `UPDATE workflow_step_approvals
           SET status = 'escalated', escalated_at = now(), escalated_to_user_account_id = $1
           WHERE id = $2`,
          [escalationTarget, approval.id]
        );
        escalatedCount++;
      }
      return escalatedCount;
    });
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async userHoldsRole(
    client: PoolClient,
    userAccountId: string,
    companyId: string,
    roleId: string | null
  ): Promise<boolean> {
    if (!roleId) return false;
    const result = await client.query(
      `SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3 LIMIT 1`,
      [userAccountId, companyId, roleId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async loadTemplateStepsWithApprovers(
    client: PoolClient,
    templateId: string
  ): Promise<
    Array<{
      stepOrder: number;
      name: string;
      condition: FieldCondition | null;
      slaHours: number | null;
      approvers: TemplateApproverRow[];
    }>
  > {
    const stepsResult = await client.query<TemplateStepRow>(
      `SELECT id, step_order, name, condition, sla_hours FROM workflow_template_steps
       WHERE template_id = $1 ORDER BY step_order ASC`,
      [templateId]
    );
    const approversResult = await client.query<TemplateApproverRow>(
      `SELECT a.* FROM workflow_template_step_approvers a
       JOIN workflow_template_steps s ON s.id = a.step_id
       WHERE s.template_id = $1`,
      [templateId]
    );
    return stepsResult.rows.map((s) => ({
      stepOrder: s.step_order,
      name: s.name,
      condition: s.condition,
      slaHours: s.sla_hours,
      approvers: approversResult.rows.filter((a) => a.step_id === s.id),
    }));
  }

  private async getRecordSnapshot(client: PoolClient, instanceId: string): Promise<Record<string, unknown>> {
    const result = await client.query<{ record_snapshot: Record<string, unknown> }>(
      `SELECT record_snapshot FROM workflow_instances WHERE id = $1`,
      [instanceId]
    );
    return result.rows[0]?.record_snapshot ?? {};
  }

  /**
   * Activates the first step at or after `startIndex` whose condition
   * matches `record`, skipping any that don't; steps with no remaining
   * candidate complete the whole instance as 'approved'. Recursive rather
   * than looped only because "skip a step, then immediately check the
   * next" reads more clearly that way — there are never more than a
   * handful of steps in practice (plan doc Section 10's own guardrail
   * against over-building this engine).
   */
  private async activateFromStep(
    client: PoolClient,
    instanceId: string,
    steps: Array<{
      stepOrder: number;
      name: string;
      condition: FieldCondition | null;
      slaHours: number | null;
      approvers: TemplateApproverRow[];
    }>,
    index: number,
    record: Record<string, unknown>,
    subjectUserAccountId: string
  ): Promise<void> {
    if (index >= steps.length) {
      await client.query(`UPDATE workflow_instances SET status = 'approved', updated_at = now() WHERE id = $1`, [
        instanceId,
      ]);
      return;
    }

    const step = steps[index];
    if (!conditionMatches(step.condition, record)) {
      await client.query(
        `INSERT INTO workflow_step_instances (workflow_instance_id, step_order, name, status)
         VALUES ($1, $2, $3, 'skipped')`,
        [instanceId, step.stepOrder, step.name]
      );
      return this.activateFromStep(client, instanceId, steps, index + 1, record, subjectUserAccountId);
    }

    const dueAt = step.slaHours ? new Date(Date.now() + step.slaHours * 60 * 60 * 1000) : null;
    const stepInstanceResult = await client.query<{ id: string }>(
      `INSERT INTO workflow_step_instances (workflow_instance_id, step_order, name, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [instanceId, step.stepOrder, step.name]
    );
    const stepInstanceId = stepInstanceResult.rows[0].id;

    for (const approver of step.approvers) {
      let userAccountId = approver.user_account_id;
      if (approver.approver_type === "manager_of_submitter") {
        userAccountId = await this.resolveManagerOfSubmitter(client, subjectUserAccountId);
        if (!userAccountId) {
          // Safe-deny, not a silent stall: a manager_of_submitter step
          // with nobody to route to is a real configuration/data problem
          // (the subject has no Employee record, or no manager on file,
          // or their manager has no login) — surface it immediately as a
          // clear error rather than creating an approval line nobody can
          // ever act on. See KNOWN_ISSUES.md for the one honestly-scoped
          // limitation this still leaves: if this happens on a step
          // AFTER the first (activated later, from decide()), the error
          // surfaces on the PRECEDING approver's decide() call rather
          // than at submission time.
          throw new BadRequestException(
            "Cannot route to manager_of_submitter: the subject has no employee record, no manager on file, or their manager has no login"
          );
        }
      }
      await client.query(
        `INSERT INTO workflow_step_approvals
           (step_instance_id, template_approver_id, approver_type, role_id, user_account_id, due_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [stepInstanceId, approver.id, approver.approver_type, approver.role_id, userAccountId, dueAt]
      );
    }
  }

  /**
   * Resolves "the manager of `subjectUserAccountId`" via the Employee
   * Core hierarchy Phase 7 introduced — a deliberate, narrow exception to
   * this engine's usual "never queries an arbitrary object's own table"
   * rule (this class's own doc comment), in the same spirit it already
   * queries `user_role_assignments`/`roles` directly for the `role`
   * approver type: `employees` is a well-known platform table now, not
   * an arbitrary caller-owned one. Returns null if the subject has no
   * Employee record, has no manager (top of the org chart), or their
   * manager has no login (`user_account_id IS NULL`) — any of which means
   * there is genuinely nobody to route to.
   */
  private async resolveManagerOfSubmitter(client: PoolClient, subjectUserAccountId: string): Promise<string | null> {
    const result = await client.query<{ manager_user_account_id: string | null }>(
      `SELECT mgr.user_account_id AS manager_user_account_id
       FROM employees e
       JOIN employees mgr ON mgr.id = e.manager_id
       WHERE e.user_account_id = $1`,
      [subjectUserAccountId]
    );
    return result.rows[0]?.manager_user_account_id ?? null;
  }

  private async loadInstance(client: PoolClient, instanceId: string): Promise<WorkflowInstanceView | null> {
    const instanceResult = await client.query(
      `SELECT wi.*, t.key AS template_key FROM workflow_instances wi
       JOIN workflow_templates t ON t.id = wi.template_id
       WHERE wi.id = $1`,
      [instanceId]
    );
    if (instanceResult.rowCount === 0) return null;
    const inst = instanceResult.rows[0];

    const stepsResult = await client.query(
      `SELECT * FROM workflow_step_instances WHERE workflow_instance_id = $1 ORDER BY step_order ASC`,
      [instanceId]
    );
    const stepIds = stepsResult.rows.map((s) => s.id);
    const approvalsResult =
      stepIds.length > 0
        ? await client.query(
            `SELECT * FROM workflow_step_approvals WHERE step_instance_id = ANY($1::uuid[])`,
            [stepIds]
          )
        : { rows: [] as Array<Record<string, unknown>> };

    const steps: WorkflowStepInstanceView[] = stepsResult.rows.map((s) => {
      const approvals: WorkflowStepApprovalView[] = approvalsResult.rows
        .filter((a) => a.step_instance_id === s.id)
        .map((a) => ({
          id: a.id,
          approverType: a.approver_type,
          roleId: a.role_id,
          userAccountId: a.user_account_id,
          status: a.status,
          dueAt: a.due_at ? toIso(a.due_at) : null,
          escalatedAt: a.escalated_at ? toIso(a.escalated_at) : null,
          escalatedToUserAccountId: a.escalated_to_user_account_id,
          decidedByUserAccountId: a.decided_by_user_account_id,
          decision: a.decision,
          comment: a.comment,
        }));
      return {
        id: s.id,
        stepOrder: s.step_order,
        name: s.name,
        status: s.status,
        approvals,
      };
    });

    return {
      id: inst.id,
      companyId: inst.company_id,
      templateId: inst.template_id,
      templateKey: inst.template_key,
      objectKey: inst.object_key,
      recordId: inst.record_id,
      submittedByUserAccountId: inst.submitted_by_user_account_id,
      subjectUserAccountId: inst.subject_user_account_id,
      status: inst.status,
      steps,
      createdAt: toIso(inst.created_at),
      updatedAt: toIso(inst.updated_at),
    };
  }
}
