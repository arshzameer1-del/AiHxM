import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import type {
  CreateOrgChangeRequest,
  OrgChangeImpactSummary,
  OrgChangeItemAction,
  OrgChangeItemView,
  OrgChangeStatus,
  OrgChangeValidationResult,
  OrgChangeView,
  OrgUnitType,
} from "@aihxm/shared-types";

// Same "employee module" gate every other Organization Management object
// lives under (see org-units.service.ts's own doc comment) — a reorg is
// an operation ON the org-unit hierarchy, not a separately licensed
// capability.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "org_change.manage.all";
const VIEW_PERMISSION = "org_change.view.all";
const WORKFLOW_TEMPLATE_KEY = "org_reorganization";
const WORKFLOW_OBJECT_KEY = "org_reorganization";
const VALID_UNIT_TYPES = new Set<OrgUnitType>(["department", "division", "business_unit", "function"]);
// Every non-terminal status a change can be in while it still "owns" the
// org units it targets — used by validate()'s overlap check below.
const OPEN_STATUSES: OrgChangeStatus[] = ["draft", "validated", "pending_approval", "approved"];

type OrgChangeRow = {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  status: OrgChangeStatus;
  effective_date: unknown;
  created_by_user_account_id: string;
  workflow_instance_id: string | null;
  validation_errors: string[] | null;
  validation_warnings: string[] | null;
  impact_summary: OrgChangeImpactSummary | null;
  failure_reason: string | null;
  validated_at: unknown;
  executed_at: unknown;
  published_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type OrgChangeItemRow = {
  id: string;
  org_change_id: string;
  sequence: number;
  org_unit_id: string;
  action: OrgChangeItemAction;
  new_parent_id: string | null;
  new_name: string | null;
  new_unit_type: string | null;
  applied_at: unknown;
  created_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function rowToItem(row: OrgChangeItemRow): OrgChangeItemView {
  return {
    id: row.id,
    orgChangeId: row.org_change_id,
    sequence: row.sequence,
    orgUnitId: row.org_unit_id,
    action: row.action,
    newParentId: row.new_parent_id,
    newName: row.new_name,
    newUnitType: row.new_unit_type,
    appliedAt: row.applied_at ? toIso(row.applied_at) : null,
    createdAt: toIso(row.created_at),
  };
}

function rowToChange(row: OrgChangeRow, items: OrgChangeItemView[]): OrgChangeView {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    description: row.description,
    status: row.status,
    effectiveDate: toIso(row.effective_date).slice(0, 10),
    createdByUserAccountId: row.created_by_user_account_id,
    workflowInstanceId: row.workflow_instance_id,
    validationErrors: row.validation_errors,
    validationWarnings: row.validation_warnings,
    impactSummary: row.impact_summary,
    failureReason: row.failure_reason,
    validatedAt: row.validated_at ? toIso(row.validated_at) : null,
    executedAt: row.executed_at ? toIso(row.executed_at) : null,
    publishedAt: row.published_at ? toIso(row.published_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    items,
  };
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Organization Management, Phase 5 — the Reorganization workflow: Draft ->
 * Validate -> Impact Analysis -> Approval -> Effective-Date Execution ->
 * Publish -> Events. See 0076_reorganization_changes.sql's header comment
 * for the full schema/scope writeup (a change is a batch of proposed Org
 * Unit mutations) and this service's own method-level comments for the
 * two hardest parts: batch-aware cycle detection in `validate()`, and why
 * `execute()`'s actual mutation logic (`applyItem()`) does NOT go through
 * `OrgUnitsService`'s own public methods.
 *
 * PERMISSION MODEL, one real subtlety: `decide()` and the effective-date
 * execution sweep (`executeDueChanges()`) both need to mutate `org_units`
 * with NO real human RBAC context available at that moment (the approver
 * who called `decide()` may not personally hold `org_change.manage.all`
 * — the workflow template's own configured approver is who authorized
 * this, exactly `LeaveRequestsService.decide()`'s own precedent — and the
 * cron sweep has no human at all). `RbacService.can()` deliberately has
 * NO service/platform-admin bypass of any kind (see its own class doc
 * comment), so a synthetic `is_service` claims object can never satisfy
 * `OrgUnitsService`'s `requireManage()` gate — calling `orgUnits.move()`/
 * `.update()`/`.archive()`/`.activate()` from either of those two paths
 * would always throw `ForbiddenException`, the same way
 * `EmployeesService.createLogin()`'s own doc comment explains why it
 * elevates to `is_service` for RLS-blocked tables only AFTER a real
 * caller's own permission was already verified — never as a substitute
 * for that verification. Execution's authorization already happened, once,
 * at `decide()` time (a real approver, checked by `WorkflowService.decide()`
 * itself) or was never needed (the cron sweep only ever touches changes
 * already sitting in `approved` status). So `applyItem()` below applies
 * each item via raw SQL directly against `org_units`/`org_unit_versions`
 * (mirroring `OrgUnitsService`'s own `applyVersionAndSync()` SQL, not
 * calling through it), using whatever claims already got the caller this
 * far — the real approver's claims for an immediate post-decision
 * execution, or a `company_id`-scoped `is_service` claims object for the
 * cron sweep, RLS-legal on `org_units`/`org_unit_versions` the same way
 * `createLogin()`'s own elevated claims are RLS-legal on `employees`.
 * Only the public, HR-Admin-facing `execute()` entry point itself is
 * gated on `org_change.manage.all` — it exists for a caller who wants to
 * force execution immediately rather than waiting for the sweep.
 */
@Injectable()
export class OrgChangesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    private readonly workflow: WorkflowService,
    private readonly webhooks?: WebhookDispatchService
  ) {}

  async create(claims: RequestClaims, input: CreateOrgChangeRequest): Promise<OrgChangeView> {
    await this.requireManage(claims);
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      const changeResult = await client.query<{ id: string }>(
        `INSERT INTO org_changes (company_id, title, description, effective_date, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [claims.company_id, input.title, input.description ?? null, input.effectiveDate, claims.sub]
      );
      const changeId = changeResult.rows[0].id;

      let sequence = 1;
      for (const item of input.items) {
        await client.query(
          `INSERT INTO org_change_items (org_change_id, sequence, org_unit_id, action, new_parent_id, new_name, new_unit_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [changeId, sequence++, item.orgUnitId, item.action, item.newParentId ?? null, item.newName ?? null, item.newUnitType ?? null]
        );
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_change.create",
        target: changeId,
        metadata: { title: input.title, itemCount: input.items.length, effectiveDate: input.effectiveDate },
      });

      const view = await this.loadChange(client, changeId);
      if (!view) throw new Error("Change vanished immediately after insert");
      return view;
    });
  }

  async list(claims: RequestClaims): Promise<OrgChangeView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM org_changes WHERE company_id = $1 ORDER BY created_at DESC`,
        [claims.company_id]
      );
      const views: OrgChangeView[] = [];
      for (const row of result.rows) {
        const v = await this.loadChange(client, row.id);
        if (v) views.push(v);
      }
      return views;
    });
  }

  async get(claims: RequestClaims, id: string): Promise<OrgChangeView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const view = await this.loadChange(client, id);
      if (!view) throw new NotFoundException("Reorganization change not found");
      return view;
    });
  }

  /**
   * VALIDATE — structural correctness across the WHOLE batch at once, the
   * "graph-cycle/orphan detection engine" 0065's own header comment
   * explicitly deferred to this phase. A single `move()` call (
   * `OrgUnitsService`'s own guard) only ever checks ONE reparent against
   * the hierarchy as it exists right now; two items in the SAME batch can
   * each look cycle-free individually and still combine into a cycle once
   * both apply together (A moves under B, B moves under A in the same
   * change) — so this builds an in-memory "what would the parent map look
   * like if every proposed move in this batch applied" map and walks
   * ancestor chains against THAT, not against today's `org_units` alone.
   *
   * Collects every error/warning rather than throwing on the first one —
   * a caller fixing a multi-item batch wants the whole list at once, not
   * one round trip per mistake. Only transitions `draft -> validated` when
   * `errors` is empty; an invalid batch stays `draft` so it can be edited
   * (by discarding and recreating — see this module's own scope note) and
   * re-validated.
   */
  async validate(claims: RequestClaims, id: string): Promise<OrgChangeValidationResult> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const change = await this.mustExistChange(client, id);
      if (change.status !== "draft") {
        throw new BadRequestException(`Cannot validate a change that is already ${change.status}`);
      }
      const items = await this.loadItemRows(client, id);
      const errors: string[] = [];
      const warnings: string[] = [];

      const unitIds = [...new Set(items.map((i) => i.org_unit_id))];
      const existingUnits = await client.query<{ id: string; parent_id: string | null }>(
        `SELECT id, parent_id FROM org_units WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [claims.company_id, unitIds]
      );
      const knownUnitIds = new Set(existingUnits.rows.map((r) => r.id));

      for (const item of items) {
        if (!knownUnitIds.has(item.org_unit_id)) {
          errors.push(`Item ${item.sequence}: org unit ${item.org_unit_id} not found`);
          continue;
        }
        if (item.action === "move") {
          if (!item.new_parent_id) {
            errors.push(`Item ${item.sequence}: "move" requires a newParentId`);
          } else if (item.new_parent_id === item.org_unit_id) {
            errors.push(`Item ${item.sequence}: a unit cannot become its own parent`);
          } else if (!knownUnitIds.has(item.new_parent_id)) {
            const parentCheck = await client.query(`SELECT 1 FROM org_units WHERE company_id = $1 AND id = $2`, [
              claims.company_id,
              item.new_parent_id,
            ]);
            if (parentCheck.rowCount === 0) {
              errors.push(`Item ${item.sequence}: new parent ${item.new_parent_id} not found`);
            }
          }
        } else if (item.action === "rename") {
          if (!item.new_name) errors.push(`Item ${item.sequence}: "rename" requires a newName`);
        } else if (item.action === "retype") {
          if (!item.new_unit_type) {
            errors.push(`Item ${item.sequence}: "retype" requires a newUnitType`);
          } else if (!VALID_UNIT_TYPES.has(item.new_unit_type as OrgUnitType)) {
            errors.push(`Item ${item.sequence}: "${item.new_unit_type}" is not a valid unit type`);
          }
        }
      }

      if (errors.length === 0) {
        const allUnits = await client.query<{ id: string; parent_id: string | null }>(
          `SELECT id, parent_id FROM org_units WHERE company_id = $1`,
          [claims.company_id]
        );
        const parentMap = new Map<string, string | null>(allUnits.rows.map((r) => [r.id, r.parent_id]));
        for (const item of items) {
          if (item.action === "move") {
            parentMap.set(item.org_unit_id, item.new_parent_id);
          }
        }

        for (const item of items.filter((i) => i.action === "move")) {
          const seen = new Set<string>([item.org_unit_id]);
          let cursor = parentMap.get(item.org_unit_id) ?? null;
          let hops = 0;
          while (cursor) {
            if (seen.has(cursor)) {
              errors.push(`Item ${item.sequence}: moving this unit under its proposed new parent would create a cycle`);
              break;
            }
            seen.add(cursor);
            cursor = parentMap.get(cursor) ?? null;
            // A cycle is always caught above long before this — a finite
            // safety valve against a data problem this method didn't
            // itself create, not the real guard.
            if (++hops > 10_000) break;
          }
        }

        const archivedIds = new Set(items.filter((i) => i.action === "archive").map((i) => i.org_unit_id));
        for (const item of items.filter((i) => i.action === "move")) {
          if (item.new_parent_id && archivedIds.has(item.new_parent_id)) {
            errors.push(
              `Item ${item.sequence}: cannot move under org unit ${item.new_parent_id}, which this same batch archives`
            );
          }
        }
      }

      const overlapping = await client.query<{ org_unit_id: string }>(
        `SELECT DISTINCT oci.org_unit_id FROM org_change_items oci
         JOIN org_changes oc ON oc.id = oci.org_change_id
         WHERE oc.company_id = $1 AND oc.id != $2 AND oc.status = ANY($3::text[]) AND oci.org_unit_id = ANY($4::uuid[])`,
        [claims.company_id, id, OPEN_STATUSES, unitIds]
      );
      for (const row of overlapping.rows) {
        warnings.push(`Org unit ${row.org_unit_id} is also targeted by another in-flight reorganization change`);
      }

      const valid = errors.length === 0;
      await client.query(
        `UPDATE org_changes
         SET status = $2, validation_errors = $3::jsonb, validation_warnings = $4::jsonb,
             validated_at = CASE WHEN $2 = 'validated' THEN now() ELSE validated_at END, updated_at = now()
         WHERE id = $1`,
        [id, valid ? "validated" : "draft", JSON.stringify(errors), JSON.stringify(warnings)]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_change.validate",
        target: id,
        metadata: { valid, errorCount: errors.length, warningCount: warnings.length },
      });

      return { valid, errors, warnings };
    });
  }

  /**
   * IMPACT ANALYSIS — the scoped impact-preview screen the roadmap asks
   * for (not a full simulation studio): every org unit this batch directly
   * targets, plus every descendant of each (a moved/archived branch drags
   * its whole subtree along for reporting purposes even though only the
   * root unit's own row changes), and how many positions/employees sit
   * inside that affected set today. Requires `validated` or later — an
   * unvalidated batch's item set can't be trusted to compute a meaningful
   * blast radius from.
   */
  async analyzeImpact(claims: RequestClaims, id: string): Promise<OrgChangeImpactSummary> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const change = await this.mustExistChange(client, id);
      if (change.status !== "validated" && change.status !== "pending_approval" && change.status !== "approved") {
        throw new BadRequestException("Validate this change before analyzing its impact");
      }
      const items = await this.loadItemRows(client, id);
      const rootIds = [...new Set(items.map((i) => i.org_unit_id))];

      const affected = await client.query<{ id: string }>(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM org_units WHERE company_id = $1 AND id = ANY($2::uuid[])
           UNION ALL
           SELECT ou.id FROM org_units ou JOIN subtree s ON ou.parent_id = s.id WHERE ou.company_id = $1
         )
         SELECT id FROM subtree`,
        [claims.company_id, rootIds]
      );
      const affectedIds = affected.rows.map((r) => r.id);

      const positionCount = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM positions WHERE company_id = $1 AND org_unit_id = ANY($2::uuid[])`,
        [claims.company_id, affectedIds]
      );
      const employeeCount = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM employees WHERE company_id = $1 AND org_unit_id = ANY($2::uuid[])`,
        [claims.company_id, affectedIds]
      );

      const warnings: string[] = [];
      if (affectedIds.length > 25) {
        warnings.push(`This change affects a large subtree (${affectedIds.length} org units) — review carefully before approving.`);
      }

      const summary: OrgChangeImpactSummary = {
        affectedOrgUnitCount: affectedIds.length,
        affectedPositionCount: Number(positionCount.rows[0].c),
        affectedEmployeeCount: Number(employeeCount.rows[0].c),
        warnings,
      };

      await client.query(`UPDATE org_changes SET impact_summary = $2::jsonb, updated_at = now() WHERE id = $1`, [
        id,
        JSON.stringify(summary),
      ]);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_change.analyze_impact",
        target: id,
        metadata: summary,
      });

      return summary;
    });
  }

  /** APPROVAL — routes to the tenant's own configured `org_reorganization`
   * workflow template, exactly `LeaveRequestsService.submit()`'s own
   * precedent (no template seeded here either — a tenant configures its
   * own approval routing via the generic Workflow admin screen, same as
   * every other WorkflowService consumer in this codebase). */
  async submitForApproval(claims: RequestClaims, id: string): Promise<OrgChangeView> {
    await this.requireManage(claims);
    const change = await this.db.withClaims(claims, (client) => this.mustExistChange(client, id));
    if (change.status !== "validated") {
      throw new BadRequestException("Only a validated change can be submitted for approval");
    }
    if (!change.impact_summary) {
      throw new BadRequestException("Run impact analysis before submitting for approval");
    }
    const itemCount = (await this.db.withClaims(claims, (client) => this.loadItemRows(client, id))).length;

    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: id,
      record: {
        itemCount,
        affectedOrgUnitCount: change.impact_summary.affectedOrgUnitCount,
        affectedPositionCount: change.impact_summary.affectedPositionCount,
        affectedEmployeeCount: change.impact_summary.affectedEmployeeCount,
      },
    });

    return this.db.withClaims(claims, async (client) => {
      await client.query(
        `UPDATE org_changes SET status = 'pending_approval', workflow_instance_id = $2, updated_at = now() WHERE id = $1`,
        [id, instance.id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_change.submit",
        target: id,
        metadata: { workflowInstanceId: instance.id },
      });
      const view = await this.loadChange(client, id);
      if (!view) throw new Error("Change vanished after submit");
      return view;
    });
  }

  /**
   * Deliberately NOT gated by `org_change.manage.all` — see this class's
   * own doc comment. Whoever the tenant's configured workflow template
   * resolves as the current step's approver is who may call this;
   * `WorkflowService.decide()` itself throws `ForbiddenException` for
   * anyone else, exactly `LeaveRequestsService.decide()`'s own precedent.
   */
  async decide(claims: RequestClaims, id: string, dto: { decision: "approved" | "rejected"; comment?: string }): Promise<OrgChangeView> {
    await this.requireModuleEnabled(claims);
    const change = await this.db.withClaims(claims, (client) => this.mustExistChange(client, id));
    if (change.status !== "pending_approval") {
      throw new BadRequestException(`Change is already ${change.status}`);
    }
    if (!change.workflow_instance_id) {
      throw new BadRequestException("Change has no workflow instance to decide on");
    }

    const instance = await this.workflow.getInstance(claims, change.workflow_instance_id);
    const pendingStep = instance.steps.find((s) => s.status === "pending");
    if (!pendingStep) {
      throw new BadRequestException("No pending approval step found on this change");
    }
    const decidedInstance = await this.workflow.decide(claims, pendingStep.id, dto);

    const updatedView = await this.db.withClaims(claims, async (client) => {
      if (decidedInstance.status === "approved") {
        await client.query(`UPDATE org_changes SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
      } else if (decidedInstance.status === "rejected") {
        await client.query(`UPDATE org_changes SET status = 'rejected', updated_at = now() WHERE id = $1`, [id]);
      }
      await this.audit.record(client, claims, {
        companyId: change.company_id,
        action: "org_change.decide",
        target: id,
        metadata: { decision: dto.decision, workflowStatus: decidedInstance.status },
      });
      const view = await this.loadChange(client, id);
      if (!view) throw new Error("Change vanished during decision recording");
      return view;
    });

    // Effective-Date Execution: if the effective date has already arrived
    // by the time final approval lands, execute immediately rather than
    // waiting for the next sweep tick — the sweep (`executeDueChanges()`)
    // exists for the more common case where approval happens well before
    // the effective date, not as the only path to execution.
    if (updatedView.status === "approved" && updatedView.effectiveDate <= todayIsoDate()) {
      return this.executeInternal(claims, id);
    }
    return updatedView;
  }

  /** Public, HR-Admin-triggered execution — forces an already-`approved`,
   * already-due change to run now rather than waiting for the sweep. */
  async execute(claims: RequestClaims, id: string): Promise<OrgChangeView> {
    await this.requireManage(claims);
    const change = await this.db.withClaims(claims, (client) => this.mustExistChange(client, id));
    if (change.status !== "approved") {
      throw new BadRequestException(`Only an approved change can be executed (this one is ${change.status})`);
    }
    if (toIso(change.effective_date).slice(0, 10) > todayIsoDate()) {
      throw new BadRequestException("Cannot execute before the change's effective date");
    }
    return this.executeInternal(claims, id);
  }

  /**
   * EXECUTE + PUBLISH + EVENTS. See this class's own doc comment for why
   * item application is raw SQL (`applyItem()`) rather than calls through
   * `OrgUnitsService`'s own gated public methods.
   *
   * DELIBERATE NON-ATOMICITY (documented, not an oversight — same posture
   * `LeaveRequestsService`'s own class doc comment takes for its
   * EmployeesService+WorkflowService split): each item is applied in its
   * own transaction. If item 3 of 5 fails (e.g. a concurrent edit removed
   * its target unit between validate() and execute()), items 1-2 stay
   * applied, `failure_reason` records exactly which item and why, and the
   * change is marked `failed` rather than silently retried or rolled
   * back. A `failed` change is terminal in this first pass — resuming a
   * partially-applied batch is real, additive scope for a later pass, not
   * attempted here (the phase brief's own "scoped, not a full
   * simulation-and-rollback studio" framing).
   */
  private async executeInternal(claims: RequestClaims, id: string): Promise<OrgChangeView> {
    const change = await this.db.withClaims(claims, (client) => this.mustExistChange(client, id));
    const effectiveFrom = toIso(change.effective_date).slice(0, 10);
    const items = await this.db.withClaims(claims, (client) => this.loadItemRows(client, id));

    for (const item of items) {
      try {
        await this.db.withClaims(claims, (client) => this.applyItem(client, claims, item, effectiveFrom));
        await this.db.withClaims(claims, (client) =>
          client.query(`UPDATE org_change_items SET applied_at = now() WHERE id = $1`, [item.id])
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        await this.db.withClaims(claims, (client) =>
          client.query(
            `UPDATE org_changes SET status = 'failed', failure_reason = $2, executed_at = now(), updated_at = now() WHERE id = $1`,
            [id, `Item ${item.sequence} (${item.action} on org unit ${item.org_unit_id}): ${message}`]
          )
        );
        const view = await this.db.withClaims(claims, (client) => this.loadChange(client, id));
        if (!view) throw new Error("Change vanished while recording an execution failure");
        return view;
      }
    }

    const publishedView = await this.db.withClaims(claims, async (client) => {
      await client.query(
        `UPDATE org_changes SET status = 'published', executed_at = now(), published_at = now(), updated_at = now() WHERE id = $1`,
        [id]
      );
      await this.audit.record(client, claims, {
        companyId: change.company_id,
        action: "org_change.execute",
        target: id,
        metadata: { itemCount: items.length },
      });
      const view = await this.loadChange(client, id);
      if (!view) throw new Error("Change vanished after execute");
      return view;
    });

    // Publish -> Events: the one event this phase itself fires. The full
    // per-entity event catalog (org.unit.changed/org.position.changed/
    // org.assignment.changed, for every downstream consumer named in the
    // Integration Contract sheet) is Phase 6's own explicit scope, built
    // on the individual org_units mutations `applyItem()` just made.
    this.webhooks?.enqueue(change.company_id, "org_change.published", { orgChangeId: id, itemCount: items.length }).catch(() => undefined);

    return publishedView;
  }

  /**
   * Applies one item's mutation directly against `org_units`/
   * `org_unit_versions` — deliberately mirroring, not calling,
   * `OrgUnitsService.applyVersionAndSync()`'s own SQL shape (see this
   * class's own doc comment for why). Re-checks the cycle guard at apply
   * time (not just at validate() time) since data can shift in between —
   * cheap insurance against a race, not the primary guard.
   */
  private async applyItem(
    client: PoolClient,
    claims: RequestClaims,
    item: OrgChangeItemRow,
    effectiveFrom: string
  ): Promise<void> {
    const before = await client.query(`SELECT * FROM org_units WHERE id = $1 AND company_id = $2`, [
      item.org_unit_id,
      claims.company_id,
    ]);
    if (before.rowCount === 0) {
      throw new Error(`Org unit ${item.org_unit_id} not found`);
    }
    const row = before.rows[0];

    const next = {
      parent_id: row.parent_id as string | null,
      unit_type: row.unit_type as string,
      code: row.code as string | null,
      name: row.name as string,
      status: row.status as string,
    };

    if (item.action === "move") {
      if (item.new_parent_id === item.org_unit_id) {
        throw new Error("A unit cannot be its own parent");
      }
      if (item.new_parent_id) {
        const descendants = await client.query<{ id: string }>(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM org_units WHERE id = $1
             UNION ALL
             SELECT ou.id FROM org_units ou JOIN subtree s ON ou.parent_id = s.id
           )
           SELECT id FROM subtree WHERE id != $1`,
          [item.org_unit_id]
        );
        if (descendants.rows.some((d) => d.id === item.new_parent_id)) {
          throw new Error("Cannot move a unit under one of its own descendants");
        }
      }
      next.parent_id = item.new_parent_id;
    } else if (item.action === "rename") {
      if (!item.new_name) throw new Error("Missing newName for a rename item");
      next.name = item.new_name;
    } else if (item.action === "retype") {
      if (!item.new_unit_type) throw new Error("Missing newUnitType for a retype item");
      next.unit_type = item.new_unit_type;
    } else if (item.action === "archive") {
      next.status = "archived";
    } else if (item.action === "activate") {
      next.status = "active";
    }

    await this.effectiveDating.applyVersionedRow(client, {
      table: "org_unit_versions",
      scope: { org_unit_id: item.org_unit_id },
      extraInsertColumns: { company_id: claims.company_id },
      data: next,
      effectiveFrom,
    });

    await client.query(
      `UPDATE org_units SET parent_id = $2, unit_type = $3, code = $4, name = $5, status = $6, updated_at = now() WHERE id = $1`,
      [item.org_unit_id, next.parent_id, next.unit_type, next.code, next.name, next.status]
    );

    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: `org_unit.${item.action}`,
      target: item.org_unit_id,
      metadata: { viaOrgChangeItemId: item.id },
    });
  }

  /**
   * The effective-date execution sweep — `organization.module.ts`'s
   * `OrgChangeExecutionScheduler` wires this to a cron, the exact mirror
   * of `WorkflowService.escalateOverdue()`: runs with service claims (no
   * tenant scoping on the initial SELECT) so it sees every company's due
   * changes in one pass, then re-scopes to each one's own `company_id`
   * for the actual execution — RLS-legal the same way
   * `EmployeesService.createLogin()`'s own elevated claims are (see this
   * class's own doc comment for the full reasoning on why this bypasses
   * `OrgUnitsService`'s app-layer RBAC gate specifically, and why that's
   * safe here).
   */
  async executeDueChanges(): Promise<number> {
    const serviceClaims: RequestClaims = { is_platform_admin: false, is_service: true, sub: "system", company_id: null };
    const due = await this.db.withClaims(serviceClaims, (client) =>
      client.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM org_changes WHERE status = 'approved' AND effective_date <= CURRENT_DATE`
      )
    );

    let executed = 0;
    for (const row of due.rows) {
      const companyClaims: RequestClaims = {
        is_platform_admin: false,
        is_service: true,
        sub: "system",
        company_id: row.company_id,
      };
      try {
        await this.executeInternal(companyClaims, row.id);
        executed++;
      } catch {
        // executeInternal() already records status='failed' + a specific
        // failure_reason on a per-item apply error; a throw reaching all
        // the way out here means something outside that (the change
        // vanished mid-sweep) — the scheduler logs it and the sweep
        // simply continues to the next due company, exactly
        // escalateOverdue()'s own per-row isolation.
      }
    }
    return executed;
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async loadItemRows(client: PoolClient, orgChangeId: string): Promise<OrgChangeItemRow[]> {
    const result = await client.query<OrgChangeItemRow>(
      `SELECT * FROM org_change_items WHERE org_change_id = $1 ORDER BY sequence ASC`,
      [orgChangeId]
    );
    return result.rows;
  }

  private async loadChange(client: PoolClient, id: string): Promise<OrgChangeView | null> {
    const result = await client.query<OrgChangeRow>(`SELECT * FROM org_changes WHERE id = $1`, [id]);
    if (result.rowCount === 0) return null;
    const items = await this.loadItemRows(client, id);
    return rowToChange(result.rows[0], items.map(rowToItem));
  }

  private async mustExistChange(client: PoolClient, id: string): Promise<OrgChangeRow> {
    const result = await client.query<OrgChangeRow>(`SELECT * FROM org_changes WHERE id = $1`, [id]);
    if (result.rowCount === 0) throw new NotFoundException("Reorganization change not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage reorganization changes");
    }
  }

  /** Manage implies view — same "an HR Admin who can edit can obviously
   * also see it" precedent every other service in this module follows. */
  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view reorganization changes");
    }
  }

  private async requireModuleEnabled(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
  }
}
