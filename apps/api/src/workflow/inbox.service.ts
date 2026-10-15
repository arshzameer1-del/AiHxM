import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { WorkflowAdapterRegistry } from "./workflow-adapter.registry";
import { WorkflowService } from "./workflow.service";
import type {
  InboxCountsView,
  InboxDecisionRequest,
  InboxItemView,
  InboxSlaState,
  WorkflowAttachmentView,
  WorkflowCommentView,
  WorkflowInstanceView,
  WorkflowPriority,
} from "@aihxm/shared-types";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const PRIORITY_RANK: Record<WorkflowPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const DUE_SOON_MS = 24 * 3_600_000;

export type InboxFilter = {
  tab?: "to_approve" | "returned" | "waiting" | "tasks" | "all";
  objectKey?: string;
  priority?: WorkflowPriority;
  overdueOnly?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
};

export type InboxDetail = {
  instance: WorkflowInstanceView;
  title: string;
  objectLabel: string;
  summary: string | null;
  deepLink: string | null;
  comments: WorkflowCommentView[];
  attachments: WorkflowAttachmentView[];
  actions: {
    canDecide: boolean;
    canSendBack: boolean;
    canRequestInfo: boolean;
    canDelegate: boolean;
    canRespond: boolean;
    canResubmit: boolean;
    canCancel: boolean;
    actingFor: string | null;
  };
};

export function slaState(dueAt: Date | string | null, now = Date.now()): InboxSlaState {
  if (!dueAt) return "none";
  const t = new Date(dueAt).getTime();
  if (t < now) return "overdue";
  return t - now <= DUE_SOON_MS ? "due_soon" : "on_track";
}

/**
 * Gap Register WFL-01/03/06/07 -- My Inbox, the single approval center.
 * Lists everything waiting on the caller (as approver, escalation target,
 * delegate or standing-delegation substitute), requests returned to or held
 * for the caller as submitter, and non-approval tasks modules contribute.
 * Decisions go through the engine; modules that apply their effect inside
 * their own decide() are reached through their registered adapter.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly adapters: WorkflowAdapterRegistry = new WorkflowAdapterRegistry(),
    @Optional() @Inject(FILE_STORAGE) private readonly storage: FileStorageService = new LocalFileStorageService()
  ) {}

  // ------------------------------------------------------------------ list
  async list(claims: RequestClaims, filter: InboxFilter = {}): Promise<InboxItemView[]> {
    if (!claims.company_id) return [];
    const items = await this.db.withClaims(claims, (client) => this.collect(client, claims));
    const tab = filter.tab ?? "all";
    const q = filter.q?.trim().toLowerCase();
    const filtered = items
      .filter((i) => {
        if (tab === "to_approve" && !["approver", "delegate", "escalation"].includes(i.reason)) return false;
        if (tab === "returned" && i.reason !== "submitter_returned") return false;
        if (tab === "waiting" && i.reason !== "submitter_on_hold") return false;
        if (tab === "tasks" && i.reason !== "task") return false;
        if (filter.objectKey && i.objectKey !== filter.objectKey) return false;
        if (filter.priority && i.priority !== filter.priority) return false;
        if (filter.overdueOnly && i.slaState !== "overdue") return false;
        if (q && !`${i.title} ${i.objectLabel} ${i.stepName ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        if (ad !== bd) return ad - bd;
        return a.submittedAt < b.submittedAt ? -1 : 1;
      });
    const offset = Math.max(filter.offset ?? 0, 0);
    return filtered.slice(offset, offset + Math.min(Math.max(filter.limit ?? 100, 1), 500));
  }

  async counts(claims: RequestClaims): Promise<InboxCountsView> {
    const items = await this.list(claims, { limit: 500 });
    return {
      toApprove: items.filter((i) => ["approver", "delegate", "escalation"].includes(i.reason)).length,
      overdue: items.filter((i) => i.slaState === "overdue").length,
      returnedToMe: items.filter((i) => i.reason === "submitter_returned").length,
      waitingOnMe: items.filter((i) => i.reason === "submitter_on_hold").length,
    };
  }

  private async collect(client: PoolClient, claims: RequestClaims): Promise<InboxItemView[]> {
    const companyId = claims.company_id!;
    const me = claims.sub;
    const delegators = await client.query<{ delegator_user_account_id: string }>(
      `SELECT DISTINCT delegator_user_account_id FROM delegations
        WHERE company_id = $1 AND delegate_user_account_id = $2 AND status = 'active' AND valid_from <= CURRENT_DATE AND valid_to >= CURRENT_DATE`,
      [companyId, me]
    );
    const users = [me, ...delegators.rows.map((d) => d.delegator_user_account_id)];

    const candidates = await client.query(
      `SELECT a.id AS line_id, a.step_instance_id, a.approver_type, a.role_id, a.user_account_id, a.employee_group_id, a.status AS line_status,
              a.escalated_to_user_account_id, a.delegated_to_user_account_id,
              si.name AS step_name, si.step_order,
              wi.id AS instance_id, wi.object_key, wi.record_id, wi.title, wi.priority, wi.due_at, wi.created_at,
              wi.submitted_by_user_account_id, wi.subject_user_account_id, wi.company_id, wi.status AS instance_status,
              t.name AS template_name
         FROM workflow_step_approvals a
         JOIN workflow_step_instances si ON si.id = a.step_instance_id AND si.status = 'pending'
         JOIN workflow_instances wi ON wi.id = si.workflow_instance_id AND wi.status = 'in_progress' AND wi.company_id = $1
         JOIN workflow_templates t ON t.id = wi.template_id
        WHERE a.status IN ('pending', 'escalated')
          AND (a.user_account_id = ANY($2) OR a.delegated_to_user_account_id = ANY($2) OR a.escalated_to_user_account_id = ANY($2)
               OR (a.approver_type = 'role' AND a.role_id IN (SELECT role_id FROM user_role_assignments WHERE user_account_id = ANY($2) AND company_id = $1))
               OR (a.approver_type = 'group' AND a.employee_group_id IN
                     (SELECT m.group_id FROM employee_group_memberships m JOIN employees e ON e.id = m.employee_id WHERE e.user_account_id = ANY($2))))
        ORDER BY wi.created_at`,
      [companyId, users]
    );

    const items: InboxItemView[] = [];
    const seen = new Set<string>();
    for (const c of candidates.rows) {
      const key = `${c.instance_id}:${c.step_instance_id}`;
      if (seen.has(key)) continue;
      const actor = await this.workflow.resolveActor(client, me, c, {
        id: c.line_id,
        step_instance_id: c.step_instance_id,
        approver_type: c.approver_type,
        role_id: c.role_id,
        user_account_id: c.user_account_id,
        employee_group_id: c.employee_group_id,
        status: c.line_status,
        escalated_to_user_account_id: c.escalated_to_user_account_id,
        delegated_to_user_account_id: c.delegated_to_user_account_id,
      });
      if (!actor) continue;
      seen.add(key);
      const adapter = this.adapters.get(c.object_key);
      items.push({
        instanceId: c.instance_id,
        stepInstanceId: c.step_instance_id,
        objectKey: c.object_key,
        objectLabel: adapter?.label ?? c.object_key,
        recordId: c.record_id,
        title: c.title ?? c.template_name,
        status: c.instance_status,
        priority: c.priority,
        stepName: c.step_name,
        submittedByUserAccountId: c.submitted_by_user_account_id,
        submittedAt: new Date(c.created_at).toISOString(),
        dueAt: c.due_at ? new Date(c.due_at).toISOString() : null,
        slaState: slaState(c.due_at),
        actingFor: actor.actingFor,
        reason: actor.actingFor ? "delegate" : c.line_status === "escalated" && c.escalated_to_user_account_id === me ? "escalation" : "approver",
        canSendBack: !!adapter?.canSendBack || !adapter,
      });
    }

    // requests the caller submitted (or that are about them) which came back or are waiting on them
    const mine = await client.query(
      `SELECT wi.*, t.name AS template_name FROM workflow_instances wi JOIN workflow_templates t ON t.id = wi.template_id
        WHERE wi.company_id = $1 AND wi.status IN ('returned', 'on_hold') AND (wi.submitted_by_user_account_id = $2 OR wi.subject_user_account_id = $2)
        ORDER BY wi.updated_at DESC`,
      [companyId, me]
    );
    for (const w of mine.rows) {
      const adapter = this.adapters.get(w.object_key);
      items.push({
        instanceId: w.id,
        stepInstanceId: null,
        objectKey: w.object_key,
        objectLabel: adapter?.label ?? w.object_key,
        recordId: w.record_id,
        title: w.title ?? w.template_name,
        status: w.status,
        priority: w.priority,
        stepName: null,
        submittedByUserAccountId: w.submitted_by_user_account_id,
        submittedAt: new Date(w.created_at).toISOString(),
        dueAt: null,
        slaState: "none",
        actingFor: null,
        reason: w.status === "returned" ? "submitter_returned" : "submitter_on_hold",
        canSendBack: false,
        summary: w.hold_reason,
      });
    }

    for (const adapter of this.adapters.all()) {
      if (!adapter.listTasks) continue;
      for (const task of await adapter.listTasks(client, claims)) items.push({ ...task, slaState: task.slaState ?? slaState(task.dueAt), reason: "task" });
    }
    return items;
  }

  // ---------------------------------------------------------------- detail
  async get(claims: RequestClaims, instanceId: string): Promise<InboxDetail> {
    if (!claims.company_id) throw new NotFoundException();
    return this.db.withClaims(claims, async (client) => {
      const instance = await this.workflow.loadInstanceView(client, instanceId);
      if (!instance) throw new NotFoundException("Workflow instance not found");
      const raw = await client.query("SELECT * FROM workflow_instances WHERE id = $1", [instanceId]);
      const who = await this.workflow.isParticipant(client, claims, raw.rows[0]);
      if (!who.participant) throw new ForbiddenException("You are not a participant in this request");

      const adapter = this.adapters.get(instance.objectKey);
      const described = (await adapter?.describe?.(client, instance.recordId)) ?? null;
      const comments = await client.query(`SELECT * FROM workflow_comments WHERE workflow_instance_id = $1 AND ($2::boolean OR visibility = 'participants') ORDER BY created_at, id`, [instanceId, who.approver]);
      const atts = await client.query(`SELECT * FROM workflow_attachments WHERE workflow_instance_id = $1 AND ($2::boolean OR visibility = 'participants') ORDER BY created_at`, [instanceId, who.approver]);

      const actionable = instance.status === "in_progress" ? await this.workflow.findActionableLine(client, claims.sub, raw.rows[0]) : null;
      const isSubmitter = [instance.submittedByUserAccountId, instance.subjectUserAccountId].includes(claims.sub);
      const open = ["in_progress", "on_hold", "returned"].includes(instance.status);
      return {
        instance,
        title: instance.title ?? instance.templateKey,
        objectLabel: adapter?.label ?? instance.objectKey,
        summary: described?.summary ?? null,
        deepLink: described?.deepLink ?? null,
        comments: comments.rows.map(rowToComment),
        attachments: atts.rows.map(rowToAttachment),
        actions: {
          canDecide: !!actionable,
          canSendBack: !!actionable && (!adapter || !!adapter.canSendBack),
          canRequestInfo: !!actionable,
          canDelegate: !!actionable,
          canRespond: isSubmitter && instance.status === "on_hold",
          canResubmit: isSubmitter && instance.status === "returned",
          canCancel: isSubmitter && open,
          actingFor: actionable?.actingFor ?? null,
        },
      };
    });
  }

  // -------------------------------------------------------------- decisions
  async decide(claims: RequestClaims, instanceId: string, dto: InboxDecisionRequest): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    if (dto.decision === "request_info") return this.workflow.requestInfo(claims, instanceId, dto.comment ?? "");
    if (dto.decision === "delegate") {
      if (!dto.delegateToUserAccountId) throw new BadRequestException("Choose who to delegate to");
      return this.workflow.delegateLine(claims, instanceId, dto.delegateToUserAccountId, dto.comment);
    }

    const head = await this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT object_key, record_id, status FROM workflow_instances WHERE id = $1", [instanceId]);
      if (!r.rowCount) throw new NotFoundException("Workflow instance not found");
      return r.rows[0] as { object_key: string; record_id: string; status: string };
    });
    const adapter = this.adapters.get(head.object_key);

    if (dto.decision !== "send_back" && adapter?.legacyDecide) {
      // the owning module applies its own effect; the engine decision happens inside it
      await adapter.legacyDecide(claims, head.record_id, { decision: dto.decision, comment: dto.comment });
      return this.workflow.getInstance(claims, instanceId);
    }
    if (dto.decision === "send_back" && adapter && !adapter.canSendBack) {
      throw new BadRequestException(`${adapter.label} requests cannot be sent back`);
    }
    return this.db.withClaims(claims, async (client) => {
      const inst = await client.query("SELECT * FROM workflow_instances WHERE id = $1", [instanceId]);
      const found = await this.workflow.findActionableLine(client, claims.sub, inst.rows[0]);
      if (!found) throw new ForbiddenException("You are not an approver on this request");
      return this.workflow.decideInTx(client, claims, found.stepInstanceId, { decision: dto.decision as "approved" | "rejected" | "send_back", comment: dto.comment });
    });
  }

  /**
   * Decide by step id (the legacy /workflow/steps/:id/decision route). A step on a
   * module-owned record goes through that module's own decide so its effect applies.
   */
  async decideStep(claims: RequestClaims, stepInstanceId: string, dto: { decision: "approved" | "rejected" | "send_back"; comment?: string }): Promise<WorkflowInstanceView> {
    if (!claims.company_id) throw new ForbiddenException();
    const head = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT wi.id, wi.object_key, wi.record_id
           FROM workflow_step_instances s JOIN workflow_instances wi ON wi.id = s.workflow_instance_id
          WHERE s.id = $1`,
        [stepInstanceId]
      );
      return r.rows[0] as { id: string; object_key: string; record_id: string } | undefined;
    });
    if (!head) throw new NotFoundException("Workflow step not found");
    const adapter = this.adapters.get(head.object_key);
    if (dto.decision !== "send_back" && adapter?.legacyDecide) {
      await adapter.legacyDecide(claims, head.record_id, { decision: dto.decision, comment: dto.comment });
      return this.workflow.getInstance(claims, head.id);
    }
    return this.workflow.decide(claims, stepInstanceId, dto);
  }

  // ----------------------------------------------------------- attachments
  async addAttachment(
    claims: RequestClaims,
    instanceId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    visibility: "participants" | "approvers" = "participants"
  ): Promise<WorkflowAttachmentView> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!file) throw new BadRequestException("A file is required");
    if (file.size > MAX_ATTACHMENT_BYTES) throw new BadRequestException(`File exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`);
    if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException(`File type ${file.mimetype} is not allowed`);
    return this.db.withClaims(claims, async (client) => {
      const inst = await client.query("SELECT * FROM workflow_instances WHERE id = $1 FOR UPDATE", [instanceId]);
      if (!inst.rowCount) throw new NotFoundException("Workflow instance not found");
      const who = await this.workflow.isParticipant(client, claims, inst.rows[0]);
      if (!who.participant) throw new ForbiddenException("You are not a participant in this request");
      if (visibility === "approvers" && !who.approver) throw new ForbiddenException("Only approvers can attach approver-only files");
      const stored = await this.storage.save(claims.company_id!, `workflow-${instanceId}`, file.originalname, file.buffer);
      const r = await client.query(
        `INSERT INTO workflow_attachments (company_id, workflow_instance_id, file_name, content_type, size_bytes, storage_key, visibility, uploaded_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, instanceId, file.originalname, file.mimetype, stored.sizeBytes, stored.storagePath, visibility, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "workflow_attachment.add", target: r.rows[0].id, metadata: { instanceId, fileName: file.originalname } });
      return rowToAttachment(r.rows[0]);
    });
  }

  async downloadAttachment(claims: RequestClaims, instanceId: string, attachmentId: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    if (!claims.company_id) throw new ForbiddenException();
    const row = await this.db.withClaims(claims, async (client) => {
      const inst = await client.query("SELECT * FROM workflow_instances WHERE id = $1", [instanceId]);
      if (!inst.rowCount) throw new NotFoundException("Workflow instance not found");
      const who = await this.workflow.isParticipant(client, claims, inst.rows[0]);
      if (!who.participant) throw new ForbiddenException("You are not a participant in this request");
      const a = await client.query("SELECT * FROM workflow_attachments WHERE id = $1 AND workflow_instance_id = $2", [attachmentId, instanceId]);
      if (!a.rowCount) throw new NotFoundException("Attachment not found");
      if (a.rows[0].visibility === "approvers" && !who.approver) throw new ForbiddenException("This attachment is visible to approvers only");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "workflow_attachment.download", target: attachmentId, metadata: { instanceId } });
      return a.rows[0];
    });
    return { buffer: await this.storage.read(row.storage_key), fileName: row.file_name, mimeType: row.content_type };
  }

  async listAttachments(claims: RequestClaims, instanceId: string): Promise<WorkflowAttachmentView[]> {
    return (await this.get(claims, instanceId)).attachments;
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
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAttachment(r: any): WorkflowAttachmentView {
  return {
    id: r.id,
    workflowInstanceId: r.workflow_instance_id,
    commentId: r.comment_id,
    fileName: r.file_name,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    visibility: r.visibility,
    uploadedByUserAccountId: r.uploaded_by_user_account_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
