import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { WorkflowAdapterRegistry, type WorkflowOutcomeEvent } from "./workflow-adapter.registry";
import { conditionMatches, validateCondition } from "./workflow-conditions";
import type {
  ApproverType,
  EscalationApproverType,
  WorkflowApprovalMode,
  WorkflowCommentKind,
  WorkflowCommentView,
  WorkflowFieldCondition,
  WorkflowInstanceView,
  WorkflowPriority,
  WorkflowStepApprovalView,
  WorkflowStepInstanceView,
  WorkflowTemplate,
} from "@aihxm/shared-types";

const MANAGE_PERMISSION = "workflow_template.manage.all";
const PRIORITIES: WorkflowPriority[] = ["low", "normal", "high", "urgent"];

// ---------------------------------------------------------------------------
// Template definition (the shape stored in workflow_template_versions.definition)
// ---------------------------------------------------------------------------
export type ApproverDef = {
  id?: string | null;
  approverType: ApproverType;
  roleId?: string | null;
  userAccountId?: string | null;
  positionId?: string | null;
  employeeGroupId?: string | null;
  orgUnitId?: string | null;
  escalationApproverType?: EscalationApproverType | null;
  escalationRoleId?: string | null;
  escalationUserAccountId?: string | null;
};
export type StepDef = {
  stepOrder: number;
  name: string;
  condition: WorkflowFieldCondition | null;
  slaHours: number | null;
  approvalMode: WorkflowApprovalMode;
  quorumCount: number | null;
  parallelGroup: string | null;
  reminderHours: number | null;
  requireCommentOnReject: boolean;
  requireCommentOnApprove: boolean;
  approvers: ApproverDef[];
};
export type TemplateDefinition = {
  triggerEvent: string | null;
  startCondition: WorkflowFieldCondition | null;
  steps: StepDef[];
};

export type CreateTemplateInput = {
  key: string;
  name: string;
  objectKey: string;
  description?: string;
  triggerEvent?: string;
  startCondition?: WorkflowFieldCondition | null;
  steps: Array<{
    stepOrder: number;
    name: string;
    condition?: WorkflowFieldCondition | null;
    slaHours?: number;
    approvalMode?: WorkflowApprovalMode;
    quorumCount?: number;
    parallelGroup?: string | null;
    reminderHours?: number;
    requireCommentOnReject?: boolean;
    requireCommentOnApprove?: boolean;
    approvers: Array<{
      approverType: ApproverType;
      roleId?: string;
      userAccountId?: string;
      positionId?: string;
      employeeGroupId?: string;
      orgUnitId?: string;
      escalationApproverType?: EscalationApproverType;
      escalationRoleId?: string;
      escalationUserAccountId?: string;
    }>;
  }>;
};

export type SubmitInput = {
  templateKey: string;
  objectKey: string;
  recordId: string;
  record: Record<string, unknown>;
  subjectUserAccountId?: string;
  title?: string;
  priority?: WorkflowPriority;
  dueAt?: string;
};

export type DecideInput = { decision: "approved" | "rejected" | "send_back"; comment?: string };

type InstanceRow = {
  id: string;
  company_id: string;
  template_id: string;
  template_version_id: string | null;
  object_key: string;
  record_id: string;
  status: string;
  submitted_by_user_account_id: string;
  subject_user_account_id: string;
  record_snapshot: Record<string, unknown>;
};

type LineRow = {
  id: string;
  step_instance_id: string;
  approver_type: ApproverType;
  role_id: string | null;
  user_account_id: string | null;
  employee_group_id: string | null;
  status: string;
  escalated_to_user_account_id: string | null;
  delegated_to_user_account_id: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function contentHash(def: TemplateDefinition): string {
  return createHash("md5").update(JSON.stringify(def)).digest("hex");
}

/**
 * The generic, tenant-configurable approval engine. Callers pass `objectKey` /
 * `recordId` plus a point-in-time `record` snapshot for condition evaluation;
 * the engine never queries an arbitrary object's own table. Whether the caller
 * may submit or view a record is the owning module's job. The engine owns what
 * happens once a record enters a workflow.
 *
 * Step 6 (WFL-02..07, ACC-06): versioned templates (instances read the version
 * they were submitted under), send back / request information / delegate, approval
 * modes (all, any, quorum) and parallel groups, richer approver types, comments,
 * priority and due dates, standing delegations. The `...InTx` methods run on the
 * caller's transaction so a module's domain change and the workflow state commit
 * atomically; the public methods without the suffix open their own.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    readonly adapters: WorkflowAdapterRegistry = new WorkflowAdapterRegistry()
  ) {}

  // =========================================================================
  // Templates
  // =========================================================================

  private toDefinition(dto: CreateTemplateInput): TemplateDefinition {
    return {
      triggerEvent: dto.triggerEvent ?? null,
      startCondition: dto.startCondition ?? null,
      steps: dto.steps
        .slice()
        .sort((a, b) => a.stepOrder - b.stepOrder)
        .map((s) => ({
          stepOrder: s.stepOrder,
          name: s.name,
          condition: s.condition ?? null,
          slaHours: s.slaHours ?? null,
          approvalMode: s.approvalMode ?? "all",
          quorumCount: s.approvalMode === "quorum" ? (s.quorumCount ?? null) : null,
          parallelGroup: s.parallelGroup?.trim() || null,
          reminderHours: s.reminderHours ?? null,
          requireCommentOnReject: s.requireCommentOnReject ?? false,
          requireCommentOnApprove: s.requireCommentOnApprove ?? false,
          approvers: s.approvers.map((a) => ({
            approverType: a.approverType,
            roleId: a.roleId ?? null,
            userAccountId: a.userAccountId ?? null,
            positionId: a.positionId ?? null,
            employeeGroupId: a.employeeGroupId ?? null,
            orgUnitId: a.orgUnitId ?? null,
            escalationApproverType: a.escalationApproverType ?? null,
            escalationRoleId: a.escalationRoleId ?? null,
            escalationUserAccountId: a.escalationUserAccountId ?? null,
          })),
        })),
    };
  }

  /** Static + referential validation shared by create and update (WFL-09 groundwork: bad templates never reach publish). */
  private async validateTemplate(client: PoolClient, companyId: string, dto: CreateTemplateInput): Promise<void> {
    const stepOrders = dto.steps.map((s) => s.stepOrder);
    if (new Set(stepOrders).size !== stepOrders.length) {
      throw new BadRequestException("stepOrder values must be unique within a template");
    }
    validateCondition(dto.startCondition, "startCondition");
    const sorted = dto.steps.slice().sort((a, b) => a.stepOrder - b.stepOrder);
    const seenGroups = new Set<string>();
    let lastGroup: string | null = null;
    for (const s of sorted) {
      validateCondition(s.condition, `step ${s.stepOrder} condition`);
      const mode = s.approvalMode ?? "all";
      if (mode === "quorum") {
        if (!s.quorumCount || s.quorumCount < 1) throw new BadRequestException(`Step ${s.stepOrder}: quorum mode needs quorumCount`);
        if (s.quorumCount > s.approvers.length) throw new BadRequestException(`Step ${s.stepOrder}: quorumCount exceeds the number of approvers`);
      } else if (s.quorumCount != null) {
        throw new BadRequestException(`Step ${s.stepOrder}: quorumCount only applies to quorum mode`);
      }
      const g = s.parallelGroup?.trim() || null;
      if (g) {
        if (g !== lastGroup && seenGroups.has(g)) {
          throw new BadRequestException(`Parallel group "${g}" must be made of adjacent steps`);
        }
        seenGroups.add(g);
      }
      lastGroup = g;
      for (const a of s.approvers) {
        const t = a.approverType;
        if (t === "role" && !a.roleId) throw new BadRequestException(`Step ${s.stepOrder}: role approver needs roleId`);
        if (t === "specific_user" && !a.userAccountId) throw new BadRequestException(`Step ${s.stepOrder}: specific_user approver needs userAccountId`);
        if (t === "position" && !a.positionId) throw new BadRequestException(`Step ${s.stepOrder}: position approver needs positionId`);
        if (t === "group" && !a.employeeGroupId) throw new BadRequestException(`Step ${s.stepOrder}: group approver needs employeeGroupId`);
        if (a.positionId) {
          const r = await client.query("SELECT 1 FROM positions WHERE id = $1 AND company_id = $2", [a.positionId, companyId]);
          if (!r.rowCount) throw new BadRequestException(`Step ${s.stepOrder}: position not found in this company`);
        }
        if (a.employeeGroupId) {
          const r = await client.query("SELECT 1 FROM employee_groups WHERE id = $1 AND company_id = $2", [a.employeeGroupId, companyId]);
          if (!r.rowCount) throw new BadRequestException(`Step ${s.stepOrder}: employee group not found in this company`);
        }
        if (a.orgUnitId) {
          const r = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [a.orgUnitId, companyId]);
          if (!r.rowCount) throw new BadRequestException(`Step ${s.stepOrder}: org unit not found in this company`);
        }
      }
    }
  }

  private async writeTemplateChildren(client: PoolClient, templateId: string, def: TemplateDefinition): Promise<void> {
    for (const step of def.steps) {
      const stepResult = await client.query<{ id: string }>(
        `INSERT INTO workflow_template_steps
           (template_id, step_order, name, condition, sla_hours, approval_mode, quorum_count, parallel_group, reminder_hours, require_comment_on_reject, require_comment_on_approve)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          templateId,
          step.stepOrder,
          step.name,
          step.condition ? JSON.stringify(step.condition) : null,
          step.slaHours,
          step.approvalMode,
          step.quorumCount,
          step.parallelGroup,
          step.reminderHours,
          step.requireCommentOnReject,
          step.requireCommentOnApprove,
        ]
      );
      for (const a of step.approvers) {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO workflow_template_step_approvers
             (step_id, approver_type, role_id, user_account_id, position_id, employee_group_id, org_unit_id,
              escalation_approver_type, escalation_role_id, escalation_user_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            stepResult.rows[0].id,
            a.approverType,
            a.roleId,
            a.userAccountId,
            a.positionId,
            a.employeeGroupId,
            a.orgUnitId,
            a.escalationApproverType,
            a.escalationRoleId,
            a.escalationUserAccountId,
          ]
        );
        a.id = ins.rows[0].id;
      }
    }
  }

  private async publishVersion(client: PoolClient, claims: RequestClaims, templateId: string, versionNo: number, def: TemplateDefinition) {
    await client.query(
      `INSERT INTO workflow_template_versions (template_id, company_id, version_no, definition, content_hash, created_by_user_account_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [templateId, claims.company_id, versionNo, JSON.stringify(def), contentHash(def), claims.sub]
    );
  }

  async createTemplate(claims: RequestClaims, dto: CreateTemplateInput): Promise<WorkflowTemplate> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage workflow templates");
    }
    return this.db.withClaims(claims, async (client) => {
      await this.validateTemplate(client, claims.company_id!, dto);
      const def = this.toDefinition(dto);
      const templateResult = await client.query<{ id: string }>(
        `INSERT INTO workflow_templates (company_id, key, name, object_key, description, trigger_event, start_condition)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
        [claims.company_id, dto.key, dto.name, dto.objectKey, dto.description ?? null, def.triggerEvent, def.startCondition ? JSON.stringify(def.startCondition) : null]
      );
      const templateId = templateResult.rows[0].id;
      await this.writeTemplateChildren(client, templateId, def);
      await this.publishVersion(client, claims, templateId, 1, def);

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

  /**
   * Starter setup: creates each template that does not exist yet for the caller's company and leaves existing
   * ones (any version, active or not) exactly as they are. No RBAC check here on purpose - the caller (the
   * starter-pack service) has already checked its own permission, and a tenant's first approval routes must
   * not wait for a System Admin. Returns the keys it created and the keys it skipped.
   */
  async createMissingTemplatesInTx(
    client: PoolClient,
    claims: RequestClaims,
    templates: CreateTemplateInput[]
  ): Promise<{ created: string[]; skipped: string[] }> {
    if (!claims.company_id) throw new ForbiddenException();
    const created: string[] = [];
    const skipped: string[] = [];
    for (const dto of templates) {
      const existing = await client.query("SELECT 1 FROM workflow_templates WHERE company_id = $1 AND key = $2", [claims.company_id, dto.key]);
      if (existing.rowCount) {
        skipped.push(dto.key);
        continue;
      }
      await this.validateTemplate(client, claims.company_id, dto);
      const def = this.toDefinition(dto);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO workflow_templates (company_id, key, name, object_key, description, trigger_event, start_condition)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
        [claims.company_id, dto.key, dto.name, dto.objectKey, dto.description ?? null, def.triggerEvent, def.startCondition ? JSON.stringify(def.startCondition) : null]
      );
      const templateId = inserted.rows[0].id;
      await this.writeTemplateChildren(client, templateId, def);
      await this.publishVersion(client, claims, templateId, 1, def);
      await this.audit.record(client, claims, {
        companyId: claims.company_id,
        action: "workflow_template.create",
        target: templateId,
        metadata: { key: dto.key, objectKey: dto.objectKey, stepCount: dto.steps.length, source: "starter_setup" },
      });
      created.push(dto.key);
    }
    return { created, skipped };
  }

  /**
   * WFL-02: editing a template publishes a NEW immutable version. Approvals
   * already in flight keep the version they were submitted under.
   */
  async updateTemplate(claims: RequestClaims, key: string, dto: Omit<CreateTemplateInput, "key" | "objectKey"> & { isActive?: boolean }): Promise<WorkflowTemplate> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage workflow templates");
    }
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM workflow_templates WHERE company_id = $1 AND key = $2 FOR UPDATE", [claims.company_id, key]);
      if (!cur.rowCount) throw new NotFoundException("Workflow template not found");
      const t = cur.rows[0];
      const input: CreateTemplateInput = { ...dto, key, objectKey: t.object_key };
      await this.validateTemplate(client, claims.company_id!, input);
      const def = this.toDefinition(input);
      const nextVersion = t.current_version_no + 1;

      await client.query(
        `DELETE FROM workflow_template_step_approvers WHERE step_id IN (SELECT id FROM workflow_template_steps WHERE template_id = $1)`,
        [t.id]
      );
      await client.query("DELETE FROM workflow_template_steps WHERE template_id = $1", [t.id]);
      await this.writeTemplateChildren(client, t.id, def);
      await client.query(
        `UPDATE workflow_templates
            SET name = $2, description = $3, trigger_event = $4, start_condition = $5::jsonb,
                is_active = COALESCE($6, is_active), current_version_no = $7, updated_at = now()
          WHERE id = $1`,
        [t.id, dto.name, dto.description ?? null, def.triggerEvent, def.startCondition ? JSON.stringify(def.startCondition) : null, dto.isActive ?? null, nextVersion]
      );
      await this.publishVersion(client, claims, t.id, nextVersion, def);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "workflow_template.publish_version",
        target: t.id,
        metadata: { key, versionNo: nextVersion },
      });
      return (await this.loadTemplate(client, t.id))!;
    });
  }

  async setTemplateActive(claims: RequestClaims, key: string, isActive: boolean): Promise<WorkflowTemplate> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage workflow templates");
    }
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("UPDATE workflow_templates SET is_active = $3, updated_at = now() WHERE company_id = $1 AND key = $2 RETURNING id", [claims.company_id, key, isActive]);
      if (!r.rowCount) throw new NotFoundException("Workflow template not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: isActive ? "workflow_template.activate" : "workflow_template.deactivate",
        target: r.rows[0].id,
        metadata: { key },
      });
      return (await this.loadTemplate(client, r.rows[0].id))!;
    });
  }

  async listTemplateVersions(claims: RequestClaims, key: string): Promise<Array<{ versionNo: number; contentHash: string; createdAt: string; definition: TemplateDefinition }>> {
    if (!claims.company_id) return [];
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to view workflow templates");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT v.* FROM workflow_template_versions v JOIN workflow_templates t ON t.id = v.template_id
          WHERE t.company_id = $1 AND t.key = $2 ORDER BY v.version_no DESC`,
        [claims.company_id, key]
      );
      return r.rows.map((v) => ({ versionNo: v.version_no, contentHash: v.content_hash, createdAt: toIso(v.created_at), definition: v.definition }));
    });
  }

  async getTemplateByKey(claims: RequestClaims, key: string): Promise<WorkflowTemplate | null> {
    if (!claims.company_id) return null;
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string }>(`SELECT id FROM workflow_templates WHERE company_id = $1 AND key = $2`, [claims.company_id, key]);
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
      const result = await client.query<{ id: string }>(`SELECT id FROM workflow_templates WHERE company_id = $1 ORDER BY created_at ASC`, [claims.company_id]);
      const templates: WorkflowTemplate[] = [];
      for (const row of result.rows) {
        const t = await this.loadTemplate(client, row.id);
        if (t) templates.push(t);
      }
      return templates;
    });
  }

  /**
   * First active template for `objectKey` whose start condition matches the record
   * (preferring one declared for `triggerEvent`). Modules use this to decide
   * whether a record is routed through the engine; null means "no workflow
   * configured, keep the module's direct decision path".
   */
  async resolveTemplateKey(
    client: PoolClient,
    companyId: string,
    objectKey: string,
    record: Record<string, unknown>,
    triggerEvent?: string
  ): Promise<string | null> {
    const r = await client.query(
      `SELECT key, trigger_event, start_condition FROM workflow_templates
        WHERE company_id = $1 AND object_key = $2 AND is_active ORDER BY created_at`,
      [companyId, objectKey]
    );
    const matching = r.rows.filter((t) => conditionMatches(t.start_condition, record));
    const preferred = triggerEvent ? matching.find((t) => t.trigger_event === triggerEvent) : undefined;
    const fallback = matching.find((t) => !t.trigger_event || !triggerEvent);
    return (preferred ?? fallback)?.key ?? null;
  }

  private async loadTemplate(client: PoolClient, templateId: string): Promise<WorkflowTemplate | null> {
    const templateResult = await client.query(`SELECT * FROM workflow_templates WHERE id = $1`, [templateId]);
    if (templateResult.rowCount === 0) return null;
    const t = templateResult.rows[0];
    const stepsResult = await client.query(`SELECT * FROM workflow_template_steps WHERE template_id = $1 ORDER BY step_order ASC`, [templateId]);
    const approversResult = await client.query(
      `SELECT a.* FROM workflow_template_step_approvers a JOIN workflow_template_steps s ON s.id = a.step_id WHERE s.template_id = $1`,
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
      currentVersionNo: t.current_version_no,
      description: t.description,
      triggerEvent: t.trigger_event,
      startCondition: t.start_condition ?? null,
      steps: stepsResult.rows.map((s) => ({
        stepOrder: s.step_order,
        name: s.name,
        condition: s.condition ?? undefined,
        slaHours: s.sla_hours ?? undefined,
        approvalMode: s.approval_mode,
        quorumCount: s.quorum_count ?? undefined,
        parallelGroup: s.parallel_group ?? undefined,
        reminderHours: s.reminder_hours ?? undefined,
        requireCommentOnReject: s.require_comment_on_reject,
        requireCommentOnApprove: s.require_comment_on_approve ?? false,
        approvers: approversResult.rows
          .filter((a) => a.step_id === s.id)
          .map((a) => ({
            approverType: a.approver_type,
            roleId: a.role_id ?? undefined,
            userAccountId: a.user_account_id ?? undefined,
            positionId: a.position_id ?? undefined,
            employeeGroupId: a.employee_group_id ?? undefined,
            orgUnitId: a.org_unit_id ?? undefined,
            escalationApproverType: a.escalation_approver_type ?? undefined,
            escalationRoleId: a.escalation_role_id ?? undefined,
            escalationUserAccountId: a.escalation_user_account_id ?? undefined,
          })),
      })),
    };
  }

  // =========================================================================
  // Submission
  // =========================================================================

  async submitForApproval(claims: RequestClaims, dto: SubmitInput): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, (client) => this.submitForApprovalInTx(client, claims, dto));
  }

  async submitForApprovalInTx(client: PoolClient, claims: RequestClaims, dto: SubmitInput): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    const templateResult = await client.query<{ id: string; is_active: boolean; object_key: string; name: string; current_version_no: number; start_condition: WorkflowFieldCondition | null }>(
      `SELECT id, is_active, object_key, name, current_version_no, start_condition FROM workflow_templates WHERE company_id = $1 AND key = $2`,
      [claims.company_id, dto.templateKey]
    );
    if (templateResult.rowCount === 0 || !templateResult.rows[0].is_active) {
      throw new NotFoundException(`No active approval route (workflow template "${dto.templateKey}") is set up for this company. An HR Admin can add the starter routes from Configuration Center > Starter setup.`);
    }
    const template = templateResult.rows[0];
    if (template.object_key !== dto.objectKey) {
      throw new BadRequestException("Template is not configured for this object type");
    }
    if (!conditionMatches(template.start_condition, dto.record)) {
      throw new BadRequestException("This request does not meet the workflow's start condition");
    }
    if (dto.priority && !PRIORITIES.includes(dto.priority)) throw new BadRequestException("Unknown priority");

    const version = await client.query<{ id: string; definition: TemplateDefinition }>(
      `SELECT id, definition FROM workflow_template_versions WHERE template_id = $1 AND version_no = $2`,
      [template.id, template.current_version_no]
    );
    if (!version.rowCount) throw new BadRequestException("Template has no published version");
    const steps = version.rows[0].definition.steps;
    if (steps.length === 0) throw new BadRequestException("Template has no steps configured");

    const subjectUserAccountId = dto.subjectUserAccountId ?? claims.sub;
    const instanceResult = await client.query<{ id: string }>(
      `INSERT INTO workflow_instances
         (company_id, template_id, template_version_id, object_key, record_id, submitted_by_user_account_id,
          subject_user_account_id, record_snapshot, title, priority, due_at, due_at_explicit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12) RETURNING id`,
      [
        claims.company_id,
        template.id,
        version.rows[0].id,
        dto.objectKey,
        dto.recordId,
        claims.sub,
        subjectUserAccountId,
        JSON.stringify(dto.record),
        dto.title ?? template.name,
        dto.priority ?? "normal",
        dto.dueAt ?? null,
        !!dto.dueAt,
      ]
    );
    const instanceId = instanceResult.rows[0].id;

    await this.activateStage(client, instanceId, steps, 0, dto.record, subjectUserAccountId, claims);

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "workflow_instance.submit",
      target: instanceId,
      metadata: { templateKey: dto.templateKey, objectKey: dto.objectKey, recordId: dto.recordId, versionNo: template.current_version_no },
    });

    // The start may already have completed the instance (every step skipped).
    const done = await client.query<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [instanceId]);
    if (done.rows[0].status === "approved") {
      await this.fireOutcome(client, claims, instanceId, "approved", null);
    }
    const view = await this.loadInstance(client, instanceId);
    if (!view) throw new Error("Instance vanished immediately after insert");
    return view;
  }

  async getInstance(claims: RequestClaims, id: string): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const view = await this.loadInstance(client, id);
      if (!view) throw new NotFoundException("Workflow instance not found");
      return view;
    });
  }

  async listInstancesForRecord(claims: RequestClaims, objectKey: string, recordId: string): Promise<WorkflowInstanceView[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM workflow_instances WHERE company_id = $1 AND object_key = $2 AND record_id = $3 ORDER BY created_at DESC`,
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

  // =========================================================================
  // Who may act (role / person / group / escalation / delegate / standing delegation)
  // =========================================================================

  async userHoldsRole(client: PoolClient, userAccountId: string, companyId: string, roleId: string | null): Promise<boolean> {
    if (!roleId) return false;
    const result = await client.query(
      `SELECT 1 FROM user_role_assignments
        WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3
          AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
          AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) LIMIT 1`,
      [userAccountId, companyId, roleId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async userInGroup(client: PoolClient, userAccountId: string, groupId: string | null): Promise<boolean> {
    if (!groupId) return false;
    const r = await client.query(
      `SELECT 1 FROM employee_group_memberships m JOIN employees e ON e.id = m.employee_id
        WHERE m.group_id = $2 AND e.user_account_id = $1
          AND m.effective_from <= CURRENT_DATE AND (m.effective_to IS NULL OR m.effective_to >= CURRENT_DATE) LIMIT 1`,
      [userAccountId, groupId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Does `userId` satisfy this approval line on their own account (no delegation)? */
  async userMatchesLine(client: PoolClient, userId: string, companyId: string, line: LineRow): Promise<boolean> {
    if (line.status !== "pending" && line.status !== "escalated") return false;
    if (line.delegated_to_user_account_id) return line.delegated_to_user_account_id === userId;
    if (line.status === "escalated" && line.escalated_to_user_account_id === userId) return true;
    if (line.approver_type === "role") return this.userHoldsRole(client, userId, companyId, line.role_id);
    if (line.approver_type === "group") return this.userInGroup(client, userId, line.employee_group_id);
    return line.user_account_id === userId;
  }

  /** Active standing delegations that let `userId` act for others on this object. */
  async activeDelegators(client: PoolClient, userId: string, companyId: string, objectKey: string): Promise<Array<{ delegatorId: string; delegationId: string }>> {
    const r = await client.query(
      `SELECT id, delegator_user_account_id FROM delegations
        WHERE company_id = $1 AND delegate_user_account_id = $2 AND status = 'active'
          AND valid_from <= CURRENT_DATE AND valid_to >= CURRENT_DATE
          AND (scope_object_keys IS NULL OR $3 = ANY(scope_object_keys))`,
      [companyId, userId, objectKey]
    );
    return r.rows.map((x) => ({ delegatorId: x.delegator_user_account_id, delegationId: x.id }));
  }

  /** null = `userId` cannot act on the line; otherwise who they act as (null = themselves). */
  async resolveActor(
    client: PoolClient,
    userId: string,
    inst: Pick<InstanceRow, "company_id" | "object_key" | "subject_user_account_id">,
    line: LineRow
  ): Promise<{ actingFor: string | null; delegationId: string | null } | null> {
    if (await this.userMatchesLine(client, userId, inst.company_id, line)) return { actingFor: null, delegationId: null };
    for (const d of await this.activeDelegators(client, userId, inst.company_id, inst.object_key)) {
      // a delegate never approves a request that is about themselves
      if (inst.subject_user_account_id === userId) continue;
      if (await this.userMatchesLine(client, d.delegatorId, inst.company_id, line)) return { actingFor: d.delegatorId, delegationId: d.delegationId };
    }
    return null;
  }

  // =========================================================================
  // Decisions
  // =========================================================================

  async decide(claims: RequestClaims, stepInstanceId: string, dto: DecideInput): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, (client) => this.decideInTx(client, claims, stepInstanceId, dto));
  }

  async decideInTx(client: PoolClient, claims: RequestClaims, stepInstanceId: string, dto: DecideInput): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    const stepResult = await client.query(`SELECT * FROM workflow_step_instances WHERE id = $1`, [stepInstanceId]);
    if (stepResult.rowCount === 0) throw new NotFoundException("Workflow step not found");
    const step = stepResult.rows[0];
    const instance = await this.lockInstance(client, step.workflow_instance_id);
    if (step.status !== "pending") {
      throw new BadRequestException(`Step is already ${step.status}, no decision can be recorded`);
    }
    if (instance.status === "on_hold") throw new BadRequestException("This request is on hold waiting for information from the submitter");
    if (instance.status !== "in_progress") throw new BadRequestException(`Workflow is already ${instance.status}`);

    if (dto.decision === "rejected" && step.require_comment_on_reject && !dto.comment?.trim()) {
      throw new BadRequestException("A comment is required when rejecting at this step");
    }
    if (dto.decision === "approved" && step.require_comment_on_approve && !dto.comment?.trim()) {
      throw new BadRequestException("A comment is required when approving at this step");
    }
    if (dto.decision === "send_back" && !dto.comment?.trim()) {
      throw new BadRequestException("A comment explaining what to change is required when sending back");
    }

    const lines = await this.loadLines(client, stepInstanceId);
    let acted: { line: LineRow; actingFor: string | null; delegationId: string | null } | null = null;
    for (const line of lines) {
      const actor = await this.resolveActor(client, claims.sub, instance, line);
      if (actor) {
        acted = { line, ...actor };
        break;
      }
    }
    if (!acted) throw new ForbiddenException("You are not an approver on this step");

    // LIVE-03/14: segregation of duties. The tenant's "Approval Controls" policy can forbid approving one's own request.
    if (dto.decision === "approved" && (claims.sub === instance.submitted_by_user_account_id || claims.sub === instance.subject_user_account_id)) {
      if (await this.blocksSelfApproval(client, instance.company_id)) {
        throw new ForbiddenException(
          "You cannot approve your own request. Your company's approval controls require another approver; ask HR to route it to someone else."
        );
      }
    }

    const lineStatus = dto.decision === "send_back" ? "returned" : dto.decision;
    await client.query(
      `UPDATE workflow_step_approvals
          SET status = $1, decision = $7, decided_by_user_account_id = $2, comment = $3, decided_at = now(),
              delegated_from_user_account_id = COALESCE($5, delegated_from_user_account_id),
              delegation_id = COALESCE($6, delegation_id)
        WHERE id = $4`,
      [lineStatus, claims.sub, dto.comment ?? null, acted.line.id, acted.actingFor, acted.delegationId, dto.decision]
    );
    if (dto.comment?.trim()) {
      await this.addCommentInTx(client, claims, instance, dto.comment.trim(), dto.decision === "send_back" ? "send_back" : "decision", stepInstanceId, "participants");
    }
    await this.audit.record(client, claims, {
      companyId: instance.company_id,
      action: "workflow_step.decide",
      target: stepInstanceId,
      metadata: { decision: dto.decision, actingFor: acted.actingFor, delegationId: acted.delegationId },
    });

    const def = await this.loadDefinition(client, instance);
    const stageSteps = await this.stageStepInstances(client, instance.id, def.steps, step.step_order);

    if (dto.decision === "send_back") {
      for (const s of stageSteps.filter((x) => x.status === "pending")) {
        await client.query(`UPDATE workflow_step_approvals SET status = 'withdrawn' WHERE step_instance_id = $1 AND status IN ('pending','escalated')`, [s.id]);
        await client.query(`UPDATE workflow_step_instances SET status = 'returned', updated_at = now() WHERE id = $1`, [s.id]);
      }
      await client.query(`UPDATE workflow_instances SET status = 'returned', returned_at = now(), updated_at = now() WHERE id = $1`, [instance.id]);
      await this.fireOutcome(client, claims, instance.id, "returned", dto.comment ?? null);
      return (await this.loadInstance(client, instance.id))!;
    }

    // current state of this step's lines after the decision
    const after = await this.loadLines(client, stepInstanceId, true);
    const approved = after.filter((l) => l.status === "approved").length;
    const open = after.filter((l) => l.status === "pending" || l.status === "escalated").length;
    const mode: WorkflowApprovalMode = step.approval_mode;
    const quorum: number = step.quorum_count ?? 1;

    if (dto.decision === "rejected") {
      const rejects =
        mode === "all" ? true : mode === "any" ? open === 0 && approved === 0 : approved + open < quorum;
      if (rejects) {
        await this.terminateStage(client, stageSteps, step.id, "rejected");
        await client.query(`UPDATE workflow_instances SET status = 'rejected', completed_at = now(), updated_at = now() WHERE id = $1`, [instance.id]);
        await this.fireOutcome(client, claims, instance.id, "rejected", dto.comment ?? null);
      }
      return (await this.loadInstance(client, instance.id))!;
    }

    const complete = mode === "all" ? open === 0 : mode === "any" ? approved >= 1 : approved >= quorum;
    if (!complete) return (await this.loadInstance(client, instance.id))!;

    await client.query(`UPDATE workflow_step_approvals SET status = 'withdrawn' WHERE step_instance_id = $1 AND status IN ('pending','escalated')`, [step.id]);
    await client.query(`UPDATE workflow_step_instances SET status = 'approved', updated_at = now() WHERE id = $1`, [step.id]);

    const fresh = await this.stageStepInstances(client, instance.id, def.steps, step.step_order);
    if (fresh.some((s) => s.status === "pending")) {
      return (await this.loadInstance(client, instance.id))!; // parallel siblings still open
    }
    const lastIndexInStage = this.stageRange(def.steps, def.steps.findIndex((s) => s.stepOrder === step.step_order)).end;
    const record = instance.record_snapshot ?? {};
    await this.activateStage(client, instance.id, def.steps, lastIndexInStage + 1, record, instance.subject_user_account_id, claims);

    const done = await client.query<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [instance.id]);
    if (done.rows[0].status === "approved") await this.fireOutcome(client, claims, instance.id, "approved", dto.comment ?? null);
    return (await this.loadInstance(client, instance.id))!;
  }

  private async blocksSelfApproval(client: PoolClient, companyId: string): Promise<boolean> {
    const r = await client.query<{ rules: Record<string, unknown> | null }>(
      `SELECT rules FROM hr_business_policies
        WHERE company_id = $1 AND policy_type = 'approval_controls' AND is_default = true AND is_active = true
          AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
          AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
        LIMIT 1`,
      [companyId]
    );
    return r.rows[0]?.rules?.blockSelfApproval === true;
  }

  /** Marks the open steps of a stage terminated: the deciding step gets `finalStatus`, siblings are skipped. */
  private async terminateStage(client: PoolClient, stageSteps: Array<{ id: string; status: string }>, decidingStepId: string, finalStatus: "rejected") {
    for (const s of stageSteps) {
      if (s.status !== "pending" && s.id !== decidingStepId) continue;
      await client.query(`UPDATE workflow_step_approvals SET status = 'withdrawn' WHERE step_instance_id = $1 AND status IN ('pending','escalated')`, [s.id]);
      await client.query(`UPDATE workflow_step_instances SET status = $2, updated_at = now() WHERE id = $1`, [s.id, s.id === decidingStepId ? finalStatus : "skipped"]);
    }
  }

  // ---------------------------------------------------------------- request info / respond / resubmit / cancel / delegate

  /** An approver asks the submitter for information; the request is put on hold (and its SLA clock paused). */
  async requestInfo(claims: RequestClaims, instanceId: string, comment: string): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!comment?.trim()) throw new BadRequestException("Say what information is needed");
    return this.db.withClaims(claims, async (client) => {
      const instance = await this.lockInstance(client, instanceId);
      if (instance.status !== "in_progress") throw new ConflictException(`Cannot request information on a request that is ${instance.status}`);
      const found = await this.findActionableLine(client, claims.sub, instance);
      if (!found) throw new ForbiddenException("You are not an approver on this request");
      await client.query(
        `UPDATE workflow_instances SET status = 'on_hold', hold_reason = $2, hold_started_at = now(), updated_at = now() WHERE id = $1`,
        [instanceId, comment.trim()]
      );
      await this.addCommentInTx(client, claims, instance, comment.trim(), "info_request", found.line.step_instance_id, "participants");
      await this.audit.record(client, claims, { companyId: instance.company_id, action: "workflow_instance.request_info", target: instanceId, metadata: {} });
      return (await this.loadInstance(client, instanceId))!;
    });
  }

  /** The submitter (or the subject) answers; the clock restarts from where it stopped. */
  async respondToInfo(claims: RequestClaims, instanceId: string, body: string): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!body?.trim()) throw new BadRequestException("A response is required");
    return this.db.withClaims(claims, async (client) => {
      const instance = await this.lockInstance(client, instanceId);
      await this.requireSubmitterOrManager(claims, instance);
      if (instance.status !== "on_hold") throw new ConflictException("This request is not waiting for information");
      await client.query(
        `UPDATE workflow_step_approvals a
            SET due_at = a.due_at + (now() - COALESCE((SELECT hold_started_at FROM workflow_instances WHERE id = $1), now()))
          FROM workflow_step_instances si
         WHERE si.id = a.step_instance_id AND si.workflow_instance_id = $1 AND a.status IN ('pending','escalated') AND a.due_at IS NOT NULL`,
        [instanceId]
      );
      await client.query(`UPDATE workflow_instances SET status = 'in_progress', hold_reason = NULL, hold_started_at = NULL, updated_at = now() WHERE id = $1`, [instanceId]);
      await this.addCommentInTx(client, claims, instance, body.trim(), "info_response", null, "participants");
      await this.refreshDueAt(client, instanceId);
      return (await this.loadInstance(client, instanceId))!;
    });
  }

  /** After a send-back: the submitter fixes the record and resubmits; returned steps reopen with fresh approval lines. */
  async resubmit(claims: RequestClaims, instanceId: string, input: { record?: Record<string, unknown>; comment?: string } = {}): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      const instance = await this.lockInstance(client, instanceId);
      await this.requireSubmitterOrManager(claims, instance);
      if (instance.status !== "returned") throw new ConflictException("Only a request that was sent back can be resubmitted");

      const record = input.record ?? instance.record_snapshot ?? {};
      if (input.record) {
        await client.query("UPDATE workflow_instances SET record_snapshot = $2::jsonb WHERE id = $1", [instanceId, JSON.stringify(input.record)]);
      }
      const def = await this.loadDefinition(client, instance);
      await client.query(`UPDATE workflow_instances SET status = 'in_progress', returned_at = NULL, updated_at = now() WHERE id = $1`, [instanceId]);
      if (input.comment?.trim()) await this.addCommentInTx(client, claims, instance, input.comment.trim(), "resubmit", null, "participants");

      const returned = await client.query<{ step_order: number }>(
        `SELECT step_order FROM workflow_step_instances WHERE workflow_instance_id = $1 AND status = 'returned' ORDER BY step_order`,
        [instanceId]
      );
      if (!returned.rowCount) throw new ConflictException("Nothing to resubmit");
      const startIndex = def.steps.findIndex((s) => s.stepOrder === returned.rows[0].step_order);
      await this.activateStage(client, instanceId, def.steps, startIndex, record, instance.subject_user_account_id, claims);

      await this.audit.record(client, claims, { companyId: instance.company_id, action: "workflow_instance.resubmit", target: instanceId, metadata: {} });
      const state = await client.query<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [instanceId]);
      await this.fireOutcome(client, claims, instanceId, state.rows[0].status === "approved" ? "approved" : "resubmitted", input.comment ?? null);
      return (await this.loadInstance(client, instanceId))!;
    });
  }

  async cancel(claims: RequestClaims, instanceId: string, reason?: string): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => this.cancelInTx(client, claims, instanceId, reason));
  }

  async cancelInTx(client: PoolClient, claims: RequestClaims, instanceId: string, reason?: string): Promise<WorkflowInstanceView> {
    const instance = await this.lockInstance(client, instanceId);
    await this.requireSubmitterOrManager(claims, instance);
    if (!["in_progress", "on_hold", "returned"].includes(instance.status)) {
      throw new ConflictException(`A request that is ${instance.status} cannot be cancelled`);
    }
    await client.query(
      `UPDATE workflow_step_approvals SET status = 'withdrawn'
        WHERE status IN ('pending','escalated') AND step_instance_id IN (SELECT id FROM workflow_step_instances WHERE workflow_instance_id = $1)`,
      [instanceId]
    );
    await client.query(`UPDATE workflow_step_instances SET status = 'skipped', updated_at = now() WHERE workflow_instance_id = $1 AND status IN ('pending','returned')`, [instanceId]);
    await client.query(`UPDATE workflow_instances SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`, [instanceId]);
    if (reason?.trim()) await this.addCommentInTx(client, claims, instance, reason.trim(), "system", null, "participants");
    await this.audit.record(client, claims, { companyId: instance.company_id, action: "workflow_instance.cancel", target: instanceId, metadata: {} });
    await this.fireOutcome(client, claims, instanceId, "cancelled", reason ?? null);
    return (await this.loadInstance(client, instanceId))!;
  }

  /**
   * Close an open instance because its record was withdrawn by its owning module
   * (e.g. a hire cancelled while awaiting approval). No outcome event fires - the
   * module already holds the new state. Idempotent for instances that are already closed.
   */
  async withdrawInstanceInTx(client: PoolClient, claims: RequestClaims, instanceId: string, reason: string): Promise<void> {
    const instance = await this.lockInstance(client, instanceId);
    if (!["in_progress", "on_hold", "returned"].includes(instance.status)) return;
    await client.query(
      `UPDATE workflow_step_approvals SET status = 'withdrawn'
        WHERE status IN ('pending','escalated') AND step_instance_id IN (SELECT id FROM workflow_step_instances WHERE workflow_instance_id = $1)`,
      [instanceId]
    );
    await client.query(`UPDATE workflow_step_instances SET status = 'skipped', updated_at = now() WHERE workflow_instance_id = $1 AND status IN ('pending','returned')`, [instanceId]);
    await client.query(`UPDATE workflow_instances SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`, [instanceId]);
    await this.addCommentInTx(client, claims, instance, reason, "system", null, "participants");
    await this.audit.record(client, claims, { companyId: instance.company_id, action: "workflow_instance.withdrawn", target: instanceId, reason, metadata: {} });
  }

  /** Hand one approval line to someone else (the original approver steps out). */
  async delegateLine(claims: RequestClaims, instanceId: string, toUserAccountId: string, comment?: string): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      const instance = await this.lockInstance(client, instanceId);
      if (instance.status !== "in_progress") throw new ConflictException(`Cannot delegate on a request that is ${instance.status}`);
      if (toUserAccountId === claims.sub) throw new BadRequestException("You cannot delegate to yourself");
      if (toUserAccountId === instance.subject_user_account_id) throw new BadRequestException("A request cannot be delegated to the person it is about");
      const member = await client.query(
        `SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2
         UNION SELECT 1 FROM employees WHERE user_account_id = $1 AND company_id = $2 LIMIT 1`,
        [toUserAccountId, instance.company_id]
      );
      if (!member.rowCount) throw new BadRequestException("The delegate is not a user of this company");
      const found = await this.findActionableLine(client, claims.sub, instance);
      if (!found) throw new ForbiddenException("You are not an approver on this request");
      await client.query(
        `UPDATE workflow_step_approvals SET delegated_to_user_account_id = $2, delegated_at = now(), delegated_from_user_account_id = $3 WHERE id = $1`,
        [found.line.id, toUserAccountId, claims.sub]
      );
      await this.addCommentInTx(client, claims, instance, comment?.trim() || "Delegated this approval", "delegation", found.line.step_instance_id, "participants");
      await this.audit.record(client, claims, {
        companyId: instance.company_id,
        action: "workflow_step.delegate",
        target: found.line.id,
        metadata: { to: toUserAccountId },
      });
      return (await this.loadInstance(client, instanceId))!;
    });
  }

  /** The first pending line of a pending step that `userId` (or one of their delegators) may act on. */
  async findActionableLine(client: PoolClient, userId: string, instance: InstanceRow) {
    const steps = await client.query<{ id: string }>(`SELECT id FROM workflow_step_instances WHERE workflow_instance_id = $1 AND status = 'pending' ORDER BY step_order`, [instance.id]);
    for (const s of steps.rows) {
      for (const line of await this.loadLines(client, s.id)) {
        const actor = await this.resolveActor(client, userId, instance, line);
        if (actor) return { line, stepInstanceId: s.id, ...actor };
      }
    }
    return null;
  }

  private async requireSubmitterOrManager(claims: RequestClaims, instance: InstanceRow): Promise<void> {
    if (claims.sub === instance.submitted_by_user_account_id || claims.sub === instance.subject_user_account_id) return;
    if (await this.rbac.can(claims, MANAGE_PERMISSION)) return;
    throw new ForbiddenException("Only the submitter can do this");
  }

  // =========================================================================
  // Comments / attachments (WFL-06)
  // =========================================================================

  /** Participants: the submitter, the subject, anyone who is or was an approver, and workflow managers. */
  async isParticipant(client: PoolClient, claims: RequestClaims, instance: Pick<InstanceRow, "id" | "company_id" | "object_key" | "submitted_by_user_account_id" | "subject_user_account_id">): Promise<{ participant: boolean; approver: boolean }> {
    if (claims.sub === instance.submitted_by_user_account_id || claims.sub === instance.subject_user_account_id) return { participant: true, approver: false };
    const lines = await client.query(
      `SELECT a.id, a.step_instance_id, a.approver_type, a.role_id, a.user_account_id, a.employee_group_id, a.status,
              a.escalated_to_user_account_id, a.delegated_to_user_account_id, a.decided_by_user_account_id
         FROM workflow_step_approvals a JOIN workflow_step_instances s ON s.id = a.step_instance_id
        WHERE s.workflow_instance_id = $1`,
      [instance.id]
    );
    for (const l of lines.rows) {
      if (l.decided_by_user_account_id === claims.sub || l.delegated_to_user_account_id === claims.sub) return { participant: true, approver: true };
      const probe: LineRow = { ...l, status: "pending" };
      if (await this.userMatchesLine(client, claims.sub, instance.company_id, probe)) return { participant: true, approver: true };
    }
    if (await this.rbac.can(claims, MANAGE_PERMISSION)) return { participant: true, approver: true };
    return { participant: false, approver: false };
  }

  async addComment(claims: RequestClaims, instanceId: string, body: string, visibility: "participants" | "approvers" = "participants"): Promise<WorkflowCommentView> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!body?.trim()) throw new BadRequestException("A comment cannot be empty");
    return this.db.withClaims(claims, async (client) => {
      const instance = await this.lockInstance(client, instanceId);
      const who = await this.isParticipant(client, claims, instance);
      if (!who.participant) throw new ForbiddenException("You are not a participant in this request");
      if (visibility === "approvers" && !who.approver) throw new ForbiddenException("Only approvers can leave approver-only notes");
      return this.addCommentInTx(client, claims, instance, body.trim(), "comment", null, visibility);
    });
  }

  async listComments(claims: RequestClaims, instanceId: string): Promise<WorkflowCommentView[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const inst = await client.query(`SELECT * FROM workflow_instances WHERE id = $1`, [instanceId]);
      if (!inst.rowCount) throw new NotFoundException("Workflow instance not found");
      const who = await this.isParticipant(client, claims, inst.rows[0]);
      if (!who.participant) throw new ForbiddenException("You are not a participant in this request");
      const r = await client.query(
        `SELECT * FROM workflow_comments WHERE workflow_instance_id = $1 AND ($2::boolean OR visibility = 'participants') ORDER BY created_at, id`,
        [instanceId, who.approver]
      );
      return r.rows.map(rowToComment);
    });
  }

  private async addCommentInTx(
    client: PoolClient,
    claims: RequestClaims,
    instance: Pick<InstanceRow, "id" | "company_id">,
    body: string,
    kind: WorkflowCommentKind,
    stepInstanceId: string | null,
    visibility: "participants" | "approvers"
  ): Promise<WorkflowCommentView> {
    const r = await client.query(
      `INSERT INTO workflow_comments (company_id, workflow_instance_id, step_instance_id, author_user_account_id, kind, body, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [instance.company_id, instance.id, stepInstanceId, claims.sub === "system" ? null : claims.sub, kind, body, visibility]
    );
    return rowToComment(r.rows[0]);
  }

  // =========================================================================
  // SLA sweeps
  // =========================================================================

  /** Escalates overdue approval lines of instances that are actively waiting (on-hold requests are paused). */
  async escalateOverdue(): Promise<number> {
    const serviceClaims: RequestClaims = { is_platform_admin: false, company_id: null, sub: "system", is_service: true };
    return this.db.withClaims(serviceClaims, async (client) => {
      const overdue = await client.query<{
        id: string;
        company_id: string;
        template_approver_id: string | null;
        escalation_approver_type: EscalationApproverType | null;
        escalation_role_id: string | null;
        escalation_user_account_id: string | null;
      }>(
        `SELECT a.id, wi.company_id, a.template_approver_id, a.escalation_approver_type, a.escalation_role_id, a.escalation_user_account_id
           FROM workflow_step_approvals a
           JOIN workflow_step_instances si ON si.id = a.step_instance_id
           JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
          WHERE a.status = 'pending' AND a.due_at IS NOT NULL AND a.due_at < now() AND wi.status = 'in_progress'`
      );

      let escalatedCount = 0;
      for (const approval of overdue.rows) {
        let type = approval.escalation_approver_type;
        let roleId = approval.escalation_role_id;
        let userId = approval.escalation_user_account_id;
        if (!type && approval.template_approver_id) {
          // lines created before versioning carry no snapshot; fall back to the template row
          const t = await client.query(
            `SELECT escalation_approver_type, escalation_role_id, escalation_user_account_id FROM workflow_template_step_approvers WHERE id = $1`,
            [approval.template_approver_id]
          );
          if (t.rowCount) {
            type = t.rows[0].escalation_approver_type;
            roleId = t.rows[0].escalation_role_id;
            userId = t.rows[0].escalation_user_account_id;
          }
        }
        let escalationTarget: string | null = null;
        if (type === "specific_user") {
          escalationTarget = userId;
        } else if (type === "role" && roleId) {
          const holder = await client.query<{ user_account_id: string }>(
            `SELECT user_account_id FROM user_role_assignments WHERE role_id = $1 AND company_id = $2 ORDER BY created_at LIMIT 1`,
            [roleId, approval.company_id]
          );
          escalationTarget = holder.rows[0]?.user_account_id ?? null;
        }
        await client.query(
          `UPDATE workflow_step_approvals SET status = 'escalated', escalated_at = now(), escalated_to_user_account_id = $1 WHERE id = $2`,
          [escalationTarget, approval.id]
        );
        escalatedCount++;
      }
      return escalatedCount;
    });
  }

  /** Writes a reminder note for lines pending longer than the step's reminder interval (delivery is the notification layer's job). */
  async remindDue(): Promise<number> {
    const serviceClaims: RequestClaims = { is_platform_admin: false, company_id: null, sub: "system", is_service: true };
    return this.db.withClaims(serviceClaims, async (client) => {
      const due = await client.query(
        `SELECT a.id, a.step_instance_id, si.workflow_instance_id, wi.company_id
           FROM workflow_step_approvals a
           JOIN workflow_step_instances si ON si.id = a.step_instance_id AND si.status = 'pending' AND si.reminder_hours IS NOT NULL
           JOIN workflow_instances wi ON wi.id = si.workflow_instance_id AND wi.status = 'in_progress'
          WHERE a.status IN ('pending','escalated')
            AND COALESCE(a.last_reminded_at, a.created_at) + (si.reminder_hours || ' hours')::interval < now()`
      );
      for (const row of due.rows) {
        await client.query(`UPDATE workflow_step_approvals SET last_reminded_at = now() WHERE id = $1`, [row.id]);
        await client.query(
          `INSERT INTO workflow_comments (company_id, workflow_instance_id, step_instance_id, kind, body, visibility)
           VALUES ($1, $2, $3, 'reminder', 'Approval reminder', 'approvers')`,
          [row.company_id, row.workflow_instance_id, row.step_instance_id]
        );
      }
      return due.rowCount ?? 0;
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async lockInstance(client: PoolClient, instanceId: string): Promise<InstanceRow> {
    const r = await client.query<InstanceRow>(`SELECT * FROM workflow_instances WHERE id = $1 FOR UPDATE`, [instanceId]);
    if (!r.rowCount) throw new NotFoundException("Workflow instance not found");
    return r.rows[0];
  }

  private async loadLines(client: PoolClient, stepInstanceId: string, all = false): Promise<LineRow[]> {
    const r = await client.query<LineRow>(
      `SELECT id, step_instance_id, approver_type, role_id, user_account_id, employee_group_id, status,
              escalated_to_user_account_id, delegated_to_user_account_id
         FROM workflow_step_approvals WHERE step_instance_id = $1 ${all ? "" : "AND status IN ('pending','escalated')"} ORDER BY created_at, id`,
      [stepInstanceId]
    );
    return r.rows;
  }

  /** The steps an instance runs, from the version it was pinned to (legacy rows fall back to the live template). */
  private async loadDefinition(client: PoolClient, instance: Pick<InstanceRow, "template_id" | "template_version_id">): Promise<TemplateDefinition> {
    if (instance.template_version_id) {
      const v = await client.query<{ definition: TemplateDefinition }>(`SELECT definition FROM workflow_template_versions WHERE id = $1`, [instance.template_version_id]);
      if (v.rowCount) return v.rows[0].definition;
    }
    const t = await this.loadTemplate(client, instance.template_id);
    return this.toDefinition({ key: "", name: "", objectKey: "", steps: t?.steps ?? [] } as CreateTemplateInput);
  }

  /** [start, end] indexes of the parallel stage that contains steps[index]. */
  private stageRange(steps: StepDef[], index: number): { start: number; end: number } {
    const g = steps[index]?.parallelGroup;
    if (!g) return { start: index, end: index };
    let start = index;
    let end = index;
    while (start > 0 && steps[start - 1].parallelGroup === g) start--;
    while (end < steps.length - 1 && steps[end + 1].parallelGroup === g) end++;
    return { start, end };
  }

  private async stageStepInstances(client: PoolClient, instanceId: string, steps: StepDef[], stepOrder: number) {
    const idx = steps.findIndex((s) => s.stepOrder === stepOrder);
    const { start, end } = this.stageRange(steps, idx);
    const orders = steps.slice(start, end + 1).map((s) => s.stepOrder);
    const r = await client.query<{ id: string; status: string; step_order: number }>(
      `SELECT id, status, step_order FROM workflow_step_instances WHERE workflow_instance_id = $1 AND step_order = ANY($2::int[]) ORDER BY step_order`,
      [instanceId, orders]
    );
    return r.rows;
  }

  /**
   * Activates the parallel stage starting at `index`. Steps whose condition does not
   * match are recorded as skipped; a stage with no matching step passes straight
   * through to the next. Past the last step the instance is approved. Existing step
   * rows (a resubmission) are reopened rather than duplicated.
   */
  private async activateStage(
    client: PoolClient,
    instanceId: string,
    steps: StepDef[],
    index: number,
    record: Record<string, unknown>,
    subjectUserAccountId: string,
    claims: RequestClaims
  ): Promise<void> {
    if (index >= steps.length) {
      await client.query(`UPDATE workflow_instances SET status = 'approved', completed_at = now(), updated_at = now() WHERE id = $1`, [instanceId]);
      await this.refreshDueAt(client, instanceId);
      return;
    }
    const { start, end } = this.stageRange(steps, index);
    let activated = 0;
    for (let i = start; i <= end; i++) {
      const step = steps[i];
      const upsert = async (status: "pending" | "skipped") => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO workflow_step_instances
             (workflow_instance_id, step_order, name, status, approval_mode, quorum_count, parallel_group, reminder_hours, require_comment_on_reject, require_comment_on_approve)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (workflow_instance_id, step_order) DO UPDATE
             SET status = EXCLUDED.status, name = EXCLUDED.name, approval_mode = EXCLUDED.approval_mode, quorum_count = EXCLUDED.quorum_count,
                 parallel_group = EXCLUDED.parallel_group, reminder_hours = EXCLUDED.reminder_hours,
                 require_comment_on_reject = EXCLUDED.require_comment_on_reject, require_comment_on_approve = EXCLUDED.require_comment_on_approve, updated_at = now()
           RETURNING id`,
          [instanceId, step.stepOrder, step.name, status, step.approvalMode, step.quorumCount, step.parallelGroup, step.reminderHours, step.requireCommentOnReject, Boolean(step.requireCommentOnApprove)]
        );
        return r.rows[0].id;
      };
      if (!conditionMatches(step.condition, record)) {
        await upsert("skipped");
        continue;
      }
      const stepInstanceId = await upsert("pending");
      activated++;
      const dueAt = step.slaHours ? new Date(Date.now() + step.slaHours * 3_600_000) : null;
      for (const approver of step.approvers) {
        const resolved = await this.resolveApprover(client, approver, subjectUserAccountId);
        await client.query(
          `INSERT INTO workflow_step_approvals
             (step_instance_id, template_approver_id, approver_type, role_id, user_account_id, position_id, employee_group_id, due_at,
              escalation_approver_type, escalation_role_id, escalation_user_account_id, org_unit_id)
           VALUES ($1, (SELECT id FROM workflow_template_step_approvers WHERE id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            stepInstanceId,
            approver.id ?? null,
            approver.approverType,
            approver.roleId ?? null,
            resolved,
            approver.positionId ?? null,
            approver.employeeGroupId ?? null,
            dueAt,
            approver.escalationApproverType ?? null,
            approver.escalationRoleId ?? null,
            approver.escalationUserAccountId ?? null,
            approver.orgUnitId ?? null,
          ]
        );
      }
    }
    if (activated === 0) {
      return this.activateStage(client, instanceId, steps, end + 1, record, subjectUserAccountId, claims);
    }
    await this.refreshDueAt(client, instanceId);
  }

  /** instance.due_at = explicit deadline, else the earliest open approval deadline. */
  private async refreshDueAt(client: PoolClient, instanceId: string): Promise<void> {
    await client.query(
      `UPDATE workflow_instances wi
          SET due_at = CASE WHEN wi.due_at_explicit THEN wi.due_at ELSE
                (SELECT min(a.due_at) FROM workflow_step_approvals a JOIN workflow_step_instances si ON si.id = a.step_instance_id
                  WHERE si.workflow_instance_id = wi.id AND a.status IN ('pending','escalated')) END
        WHERE wi.id = $1`,
      [instanceId]
    );
  }

  /** Resolves the person behind a person-resolved approver type at activation; role / group stay symbolic. */
  private async resolveApprover(client: PoolClient, approver: ApproverDef, subjectUserAccountId: string): Promise<string | null> {
    const t = approver.approverType;
    if (t === "role" || t === "group") return null;
    if (t === "specific_user") return approver.userAccountId ?? null;
    let userId: string | null = null;
    if (t === "manager_of_submitter") {
      userId = await this.resolveManagerOfSubmitter(client, subjectUserAccountId);
      if (!userId) {
        throw new BadRequestException(
          "Cannot route to manager_of_submitter: the subject has no employee record, no manager on file, or their manager has no login"
        );
      }
    } else if (t === "dotted_line_manager") {
      const r = await client.query<{ uid: string | null }>(
        `SELECT m.user_account_id AS uid
           FROM employees e
           JOIN org_relationships r ON r.employee_id = e.id AND r.relationship_type = 'dotted_line' AND r.status = 'active'
           JOIN employees m ON m.id = r.manager_employee_id
          WHERE e.user_account_id = $1 AND m.user_account_id IS NOT NULL ORDER BY r.created_at LIMIT 1`,
        [subjectUserAccountId]
      );
      userId = r.rows[0]?.uid ?? null;
      if (!userId) throw new BadRequestException("Cannot route to dotted_line_manager: the subject has no active dotted-line manager with a login");
    } else if (t === "position") {
      userId = await this.positionOccupant(client, approver.positionId!, null);
      if (!userId) throw new BadRequestException("Cannot route to position: nobody with a login currently holds it");
    } else if (t === "org_unit_head") {
      userId = await this.resolveOrgUnitHead(client, approver.orgUnitId ?? null, subjectUserAccountId);
      if (!userId) throw new BadRequestException("Cannot route to org_unit_head: no head with a login was found for the subject's unit");
    }
    return userId;
  }

  /**
   * Gap Register ORG-06. After an organization change (manager, seat holder,
   * unit head, dotted line) re-resolves the person behind every STILL-PENDING,
   * person-resolved approval line of the company's open instances, so a request
   * is not stranded with a former manager. A line that is decided, delegated or
   * no longer resolvable is left exactly as it is (never cleared). Returns the
   * lines that moved; each is audited. Idempotent.
   */
  async refreshDynamicApproversInTx(
    client: PoolClient,
    companyId: string
  ): Promise<Array<{ approvalId: string; instanceId: string; from: string | null; to: string }>> {
    const lines = await client.query<{
      id: string;
      instance_id: string;
      subject: string;
      approver_type: ApproverType;
      user_account_id: string | null;
      position_id: string | null;
      org_unit_id: string | null;
    }>(
      `SELECT a.id, wi.id AS instance_id, wi.subject_user_account_id AS subject, a.approver_type, a.user_account_id, a.position_id, a.org_unit_id
         FROM workflow_step_approvals a
         JOIN workflow_step_instances si ON si.id = a.step_instance_id AND si.status = 'pending'
         JOIN workflow_instances wi ON wi.id = si.workflow_instance_id AND wi.status IN ('in_progress', 'on_hold')
        WHERE wi.company_id = $1 AND a.status = 'pending' AND a.delegated_to_user_account_id IS NULL
          AND a.approver_type IN ('manager_of_submitter', 'dotted_line_manager', 'position', 'org_unit_head')
          AND wi.subject_user_account_id IS NOT NULL
        FOR UPDATE OF a`,
      [companyId]
    );
    const moved: Array<{ approvalId: string; instanceId: string; from: string | null; to: string }> = [];
    for (const line of lines.rows) {
      let next: string | null = null;
      try {
        next = await this.resolveApprover(
          client,
          { approverType: line.approver_type, positionId: line.position_id ?? undefined, orgUnitId: line.org_unit_id } as ApproverDef,
          line.subject
        );
      } catch {
        continue; // unresolvable now: keep the previous approver rather than strand the request
      }
      if (!next || next === line.user_account_id) continue;
      await client.query("UPDATE workflow_step_approvals SET user_account_id = $2 WHERE id = $1", [line.id, next]);
      await this.audit.record(client, { is_platform_admin: false, is_service: true, sub: "org-event-consumer", company_id: companyId }, {
        companyId,
        action: "workflow.approver_refreshed",
        target: line.instance_id,
        metadata: { approvalId: line.id, approverType: line.approver_type, from: line.user_account_id, to: next },
      });
      moved.push({ approvalId: line.id, instanceId: line.instance_id, from: line.user_account_id, to: next });
    }
    return moved;
  }

  private async positionOccupant(client: PoolClient, positionId: string, excludeUserId: string | null): Promise<string | null> {
    const r = await client.query<{ uid: string }>(
      `SELECT e.user_account_id AS uid
         FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id
        WHERE a.position_id = $1 AND a.status = 'active' AND e.employment_status <> 'terminated'
          AND e.user_account_id IS NOT NULL AND ($2::uuid IS NULL OR e.user_account_id <> $2)
        ORDER BY (a.assignment_type = 'primary') DESC, a.created_at LIMIT 1`,
      [positionId, excludeUserId]
    );
    return r.rows[0]?.uid ?? null;
  }

  /** Head of the given unit (or the subject's own); a head approving their own request moves up to the parent unit's head. */
  private async resolveOrgUnitHead(client: PoolClient, orgUnitId: string | null, subjectUserAccountId: string): Promise<string | null> {
    let unitId = orgUnitId;
    if (!unitId) {
      const r = await client.query<{ unit: string | null }>(
        `SELECT COALESCE((SELECT a.org_unit_id FROM employee_org_assignments a WHERE a.employee_id = e.id AND a.assignment_type = 'primary' AND a.status = 'active' LIMIT 1), e.org_unit_id) AS unit
           FROM employees e WHERE e.user_account_id = $1`,
        [subjectUserAccountId]
      );
      unitId = r.rows[0]?.unit ?? null;
    }
    for (let depth = 0; unitId && depth < 20; depth++) {
      const u = await client.query<{ head_position_id: string | null; parent_id: string | null }>(`SELECT head_position_id, parent_id FROM org_units WHERE id = $1`, [unitId]);
      if (!u.rowCount) return null;
      if (u.rows[0].head_position_id) {
        const occupant = await this.positionOccupant(client, u.rows[0].head_position_id, subjectUserAccountId);
        if (occupant) return occupant;
      }
      unitId = u.rows[0].parent_id;
    }
    return null;
  }

  private async resolveManagerOfSubmitter(client: PoolClient, subjectUserAccountId: string): Promise<string | null> {
    const result = await client.query<{ manager_user_account_id: string | null }>(
      `SELECT mgr.user_account_id AS manager_user_account_id
         FROM employees e JOIN employees mgr ON mgr.id = e.manager_id
        WHERE e.user_account_id = $1`,
      [subjectUserAccountId]
    );
    return result.rows[0]?.manager_user_account_id ?? null;
  }

  private async fireOutcome(client: PoolClient, claims: RequestClaims, instanceId: string, event: WorkflowOutcomeEvent, comment: string | null): Promise<void> {
    const r = await client.query<{ object_key: string; record_id: string }>(`SELECT object_key, record_id FROM workflow_instances WHERE id = $1`, [instanceId]);
    const adapter = this.adapters.get(r.rows[0].object_key);
    if (!adapter?.onOutcome) return;
    await adapter.onOutcome({ client, claims, instanceId, objectKey: r.rows[0].object_key, recordId: r.rows[0].record_id, event, comment });
  }

  async loadInstanceView(client: PoolClient, instanceId: string): Promise<WorkflowInstanceView | null> {
    return this.loadInstance(client, instanceId);
  }

  private async loadInstance(client: PoolClient, instanceId: string): Promise<WorkflowInstanceView | null> {
    const instanceResult = await client.query(
      `SELECT wi.*, t.key AS template_key, v.version_no AS template_version_no
         FROM workflow_instances wi
         JOIN workflow_templates t ON t.id = wi.template_id
         LEFT JOIN workflow_template_versions v ON v.id = wi.template_version_id
        WHERE wi.id = $1`,
      [instanceId]
    );
    if (instanceResult.rowCount === 0) return null;
    const inst = instanceResult.rows[0];

    const stepsResult = await client.query(`SELECT * FROM workflow_step_instances WHERE workflow_instance_id = $1 ORDER BY step_order ASC`, [instanceId]);
    const stepIds = stepsResult.rows.map((s) => s.id);
    const approvalsResult =
      stepIds.length > 0
        ? await client.query(`SELECT * FROM workflow_step_approvals WHERE step_instance_id = ANY($1::uuid[]) ORDER BY created_at, id`, [stepIds])
        : { rows: [] as Array<Record<string, unknown>> };

    const steps: WorkflowStepInstanceView[] = stepsResult.rows.map((s) => {
      const approvals: WorkflowStepApprovalView[] = approvalsResult.rows
        .filter((a) => a.step_instance_id === s.id)
        .map((a) => ({
          id: a.id as string,
          approverType: a.approver_type as ApproverType,
          roleId: a.role_id as string | null,
          userAccountId: a.user_account_id as string | null,
          status: a.status as WorkflowStepApprovalView["status"],
          dueAt: a.due_at ? toIso(a.due_at) : null,
          escalatedAt: a.escalated_at ? toIso(a.escalated_at) : null,
          escalatedToUserAccountId: a.escalated_to_user_account_id as string | null,
          decidedByUserAccountId: a.decided_by_user_account_id as string | null,
          decidedAt: a.decided_at ? toIso(a.decided_at) : null,
          decision: a.decision as WorkflowStepApprovalView["decision"],
          comment: a.comment as string | null,
          delegatedToUserAccountId: (a.delegated_to_user_account_id as string | null) ?? null,
          delegatedFromUserAccountId: (a.delegated_from_user_account_id as string | null) ?? null,
        }));
      return {
        id: s.id,
        stepOrder: s.step_order,
        name: s.name,
        status: s.status,
        approvals,
        approvalMode: s.approval_mode,
        quorumCount: s.quorum_count,
        parallelGroup: s.parallel_group,
        requireCommentOnReject: s.require_comment_on_reject,
        requireCommentOnApprove: s.require_comment_on_approve ?? false,
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
      templateVersionNo: inst.template_version_no ?? null,
      title: inst.title,
      priority: inst.priority,
      dueAt: inst.due_at ? toIso(inst.due_at) : null,
      holdReason: inst.hold_reason,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToComment(r: any): WorkflowCommentView {
  return {
    id: r.id,
    workflowInstanceId: r.workflow_instance_id,
    stepInstanceId: r.step_instance_id,
    authorUserAccountId: r.author_user_account_id,
    kind: r.kind,
    body: r.body,
    visibility: r.visibility,
    createdAt: toIso(r.created_at),
  };
}
