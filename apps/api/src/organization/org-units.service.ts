import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { buildOrgEventPayload } from "../webhooks/org-event-payload.util";
import type {
  CreateOrgUnitRequest,
  MoveOrgUnitRequest,
  OrgUnitTreeNode,
  OrgUnitVersionView,
  OrgUnitView,
  UpdateOrgUnitRequest,
} from "@aihxm/shared-types";

// Org Units are gated under the same `employee` module every other
// Employee Core object (department/designation, Employee Groups) already
// lives under — this is that same object's canonical replacement, not a
// separately-licensed capability.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "org_unit.manage.all";
const VIEW_PERMISSION = "org_unit.view.all";
// Organization Management Phase 11 (Section 19) — the alternative to
// VIEW_PERMISSION a role can hold instead: restricted to the caller's own
// `data_scope_assignments` org-unit rows, expanded to each assigned
// unit's subtree, rather than every org unit in the tenant.
const SCOPED_VIEW_PERMISSION_BASE = "org_unit.view";

type OrgUnitRow = {
  id: string;
  company_id: string;
  parent_id: string | null;
  unit_type: string;
  code: string | null;
  name: string;
  status: string;
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToOrgUnit(row: any): OrgUnitView {
  return {
    id: row.id,
    companyId: row.company_id,
    parentId: row.parent_id,
    unitType: row.unit_type,
    code: row.code,
    name: row.name,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(row: any): OrgUnitVersionView {
  return {
    id: row.id,
    orgUnitId: row.org_unit_id,
    parentId: row.parent_id,
    unitType: row.unit_type,
    code: row.code,
    name: row.name,
    status: row.status,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

/**
 * Organization Management, Phase 1 (see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md and
 * 0065_organization_units.sql's own header comment for the full design
 * writeup): the canonical, unlimited-depth, self-referencing Org Unit
 * hierarchy that replaces free-text `employees.department`.
 *
 * Layering matches every module since Phase 4 exactly: is the module
 * licensed (EntitlementsService) -> can the role touch this object
 * (RbacService) -> business logic (this service) -> audit write
 * (AuditService), with RLS as the tenant-isolation backstop underneath
 * all of it (0065's own RLS policies).
 *
 * `org_units` (the stable identity + current-state cache this service's
 * hierarchy queries read) and `org_unit_versions` (the
 * EffectiveDatingEngine-managed history, scope = `{ org_unit_id }`) are
 * kept in sync by every mutating method here — see `syncCurrentState()`.
 */
@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    // Optional for the same reason EmployeesService's own `webhooks` field
    // is (see that class's own doc comment) — a large number of unrelated
    // spec files hand-construct `OrgUnitsService` directly. Organization
    // Management Phase 6 — the `org.unit.changed` domain event, fired at
    // every one of this service's own already-audited mutation points
    // (create/update/move/archive/activate).
    private readonly webhooks?: WebhookDispatchService
  ) {}

  private publishChanged(claims: RequestClaims, changeType: string, unit: OrgUnitView): void {
    this.webhooks
      ?.enqueue(claims.company_id!, "org.unit.changed", buildOrgEventPayload(claims, changeType, "orgUnit", unit))
      .catch(() => undefined);
  }

  async create(claims: RequestClaims, input: CreateOrgUnitRequest): Promise<OrgUnitView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      if (input.parentId) {
        await this.mustExist(client, input.parentId);
      }
      if (input.code) {
        const dup = await client.query("SELECT 1 FROM org_units WHERE company_id = $1 AND code = $2", [
          claims.company_id,
          input.code,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`An org unit with code "${input.code}" already exists`);
        }
      }

      const inserted = await client.query(
        `INSERT INTO org_units (company_id, parent_id, unit_type, code, name, status)
         VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
        [claims.company_id, input.parentId ?? null, input.unitType, input.code ?? null, input.name]
      );
      const unit = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "org_unit_versions",
        scope: { org_unit_id: unit.id },
        extraInsertColumns: { company_id: claims.company_id },
        data: {
          parent_id: unit.parent_id,
          unit_type: unit.unit_type,
          code: unit.code,
          name: unit.name,
          status: unit.status,
        },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_unit.create",
        target: unit.id,
        metadata: { name: input.name, unitType: input.unitType, parentId: input.parentId ?? null },
      });

      const view = rowToOrgUnit(unit);
      this.publishChanged(claims, "create", view);
      return view;
    });
  }

  /** Every org unit in the tenant, flat, alphabetical — the raw material
   * an admin table or a tree-building client renders from. A caller who
   * only holds `org_unit.view.scoped` (Phase 11, Section 19) instead sees
   * only their assigned unit(s) and those units' descendants. */
  async list(claims: RequestClaims): Promise<OrgUnitView[]> {
    const scope = await this.resolveViewAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const conditions = ["company_id = $1"];
      const values: unknown[] = [claims.company_id];
      if (!scope.unrestricted) {
        values.push(scope.allowedIds);
        conditions.push(`id = ANY($${values.length}::uuid[])`);
      }
      const result = await client.query(
        `SELECT * FROM org_units WHERE ${conditions.join(" AND ")} ORDER BY name`,
        values
      );
      return result.rows.map(rowToOrgUnit);
    });
  }

  async listRoots(claims: RequestClaims): Promise<OrgUnitView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        "SELECT * FROM org_units WHERE company_id = $1 AND parent_id IS NULL ORDER BY name",
        [claims.company_id]
      );
      return result.rows.map(rowToOrgUnit);
    });
  }

  async listChildren(claims: RequestClaims, id: string): Promise<OrgUnitView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const result = await client.query(
        "SELECT * FROM org_units WHERE company_id = $1 AND parent_id = $2 ORDER BY name",
        [claims.company_id, id]
      );
      return result.rows.map(rowToOrgUnit);
    });
  }

  /**
   * Every descendant of `id` (not including `id` itself), via a recursive
   * CTE — the "full recursive descendant fetch" the phase brief calls
   * for, and the same primitive `move()` below reuses to guard against
   * reparenting a unit under its own subtree. `NOT ou.id = ANY(s.path)`
   * is defense-in-depth against a cycle that shouldn't be able to exist
   * (this service's own `move()` is the real guard) — without it, a
   * cycle anywhere in the data would make this query recurse forever
   * instead of just returning a wrong-but-finite answer.
   */
  async getDescendants(claims: RequestClaims, id: string): Promise<OrgUnitView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.descendantRows(client, claims.company_id!, id);
      return rows.map(rowToOrgUnit);
    });
  }

  private async descendantRows(client: PoolClient, companyId: string, rootId: string): Promise<Record<string, unknown>[]> {
    const result = await client.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, company_id, parent_id, unit_type, code, name, status, created_at, updated_at,
                0 AS depth, ARRAY[id] AS path
         FROM org_units
         WHERE company_id = $1 AND id = $2
         UNION ALL
         SELECT ou.id, ou.company_id, ou.parent_id, ou.unit_type, ou.code, ou.name, ou.status,
                ou.created_at, ou.updated_at, s.depth + 1, s.path || ou.id
         FROM org_units ou
         JOIN subtree s ON ou.parent_id = s.id
         WHERE ou.company_id = $1 AND NOT ou.id = ANY(s.path)
       )
       SELECT * FROM subtree WHERE depth > 0 ORDER BY depth ASC, name ASC`,
      [companyId, rootId]
    );
    return result.rows;
  }

  /** `GET /organization/units/tree` — the whole company's hierarchy,
   * nested, in one call. A flat fetch + in-memory nesting (same shape
   * `EmployeesService.orgChart()` already uses for the manager
   * self-reference) rather than a recursive CTE — the whole table is
   * being read either way, so SQL-side recursion buys nothing here. */
  async getTree(claims: RequestClaims): Promise<OrgUnitTreeNode[]> {
    const units = await this.list(claims);
    const byId = new Map<string, OrgUnitTreeNode>();
    for (const unit of units) {
      byId.set(unit.id, { ...unit, children: [] });
    }
    const roots: OrgUnitTreeNode[] = [];
    for (const unit of units) {
      const node = byId.get(unit.id)!;
      const parent = unit.parentId ? byId.get(unit.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async get(claims: RequestClaims, id: string): Promise<OrgUnitView> {
    const scope = await this.resolveViewAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (!scope.unrestricted && !scope.allowedIds.includes(id)) {
        // Same NotFoundException a nonexistent id gets — a Data Scope
        // rejection shouldn't confirm to an out-of-scope caller that the
        // unit exists at all.
        throw new NotFoundException("Org unit not found");
      }
      return rowToOrgUnit(row);
    });
  }

  /**
   * Rename/retype/recode in place — reparenting is `move()` below, kept
   * deliberately separate since it's the one edit that needs the cycle
   * guard (see that method's doc comment).
   */
  async update(claims: RequestClaims, id: string, patch: UpdateOrgUnitRequest): Promise<OrgUnitView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.code && patch.code !== before.code) {
        const dup = await client.query("SELECT 1 FROM org_units WHERE company_id = $1 AND code = $2 AND id != $3", [
          claims.company_id,
          patch.code,
          id,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`An org unit with code "${patch.code}" already exists`);
        }
      }

      const next = {
        parent_id: before.parent_id,
        unit_type: patch.unitType ?? before.unit_type,
        code: patch.code ?? before.code,
        name: patch.name ?? before.name,
        status: before.status,
      };

      const unit = await this.applyVersionAndSync(client, claims, id, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_unit.update",
        target: id,
        metadata: { before: rowToOrgUnit(before), after: rowToOrgUnit(unit) },
      });

      const view = rowToOrgUnit(unit);
      this.publishChanged(claims, "update", view);
      return view;
    });
  }

  /**
   * Reparent — the ONE edit that can corrupt every recursive hierarchy
   * query if left unguarded, so it gets its own endpoint and its own
   * checks rather than being folded into `update()`:
   *   1. `parentId === id` — a unit can't be its own parent (also a DB
   *      CHECK, belt-and-braces).
   *   2. the new parent must actually exist in this tenant.
   *   3. the new parent must not be `id` itself OR any descendant of
   *      `id` — moving a unit under its own subtree would disconnect
   *      that subtree from the root entirely (a cycle). A full graph-
   *      cycle/orphan-detection engine is explicitly Phase 5 territory
   *      (Rules-Engine-backed); this is the minimum guard that keeps
   *      today's recursive CTEs from looping or returning nonsense.
   */
  async move(claims: RequestClaims, id: string, input: MoveOrgUnitRequest): Promise<OrgUnitView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (input.parentId) {
        if (input.parentId === id) {
          throw new BadRequestException("A unit cannot be its own parent");
        }
        await this.mustExist(client, input.parentId);
        const descendants = await this.descendantRows(client, claims.company_id!, id);
        if (descendants.some((d) => d.id === input.parentId)) {
          throw new BadRequestException("Cannot move a unit under one of its own descendants");
        }
      }

      const next = {
        parent_id: input.parentId ?? null,
        unit_type: before.unit_type,
        code: before.code,
        name: before.name,
        status: before.status,
      };

      const unit = await this.applyVersionAndSync(client, claims, id, next, input.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_unit.move",
        target: id,
        metadata: { fromParentId: before.parent_id, toParentId: input.parentId ?? null },
      });

      const view = rowToOrgUnit(unit);
      this.publishChanged(claims, "move", view);
      return view;
    });
  }

  async archive(claims: RequestClaims, id: string): Promise<OrgUnitView> {
    return this.setStatus(claims, id, "archived");
  }

  async activate(claims: RequestClaims, id: string): Promise<OrgUnitView> {
    return this.setStatus(claims, id, "active");
  }

  private async setStatus(claims: RequestClaims, id: string, status: "active" | "archived"): Promise<OrgUnitView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === status) return rowToOrgUnit(before);

      const next = {
        parent_id: before.parent_id,
        unit_type: before.unit_type,
        code: before.code,
        name: before.name,
        status,
      };
      const unit = await this.applyVersionAndSync(client, claims, id, next);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: status === "archived" ? "org_unit.archive" : "org_unit.activate",
        target: id,
      });

      const view = rowToOrgUnit(unit);
      this.publishChanged(claims, status === "archived" ? "archive" : "activate", view);
      return view;
    });
  }

  /** `GET /organization/units/:id/history` — every version this unit has
   * ever had, oldest first, the same "reconstruct what was in effect on
   * date X" deliverable `LeavePolicyService.getLeavePolicyHistory()`
   * already provides for leave policies. */
  async getHistory(claims: RequestClaims, id: string): Promise<OrgUnitVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "org_unit_versions",
        scope: { org_unit_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  /**
   * Shared by update()/move()/setStatus(): supersedes the open
   * `org_unit_versions` row via the EffectiveDatingEngine, then syncs
   * `org_units`' own denormalized current-state columns to match — see
   * 0065_organization_units.sql's header comment for why both tables
   * exist and why staying in sync matters (every hierarchy query reads
   * `org_units`, never the versions table).
   */
  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    data: { parent_id: string | null; unit_type: string; code: string | null; name: string; status: string },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "org_unit_versions",
      scope: { org_unit_id: id },
      extraInsertColumns: { company_id: claims.company_id },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE org_units SET parent_id = $2, unit_type = $3, code = $4, name = $5, status = $6, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.parent_id, data.unit_type, data.code, data.name, data.status]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<OrgUnitRow> {
    const result = await client.query<OrgUnitRow>("SELECT * FROM org_units WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Org unit not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage the org unit hierarchy");
    }
  }

  /** Manage implies view — an HR Admin who can edit the hierarchy can
   * obviously also see it, without needing both permissions seeded onto
   * every role that gets one. */
  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view the org unit hierarchy");
    }
  }

  /**
   * Organization Management Phase 11 (Section 19) — the scope-aware
   * sibling of `requireView()` that `list()`/`get()` use instead: same
   * entitlement + `.all` gate, but a caller who instead only holds
   * `org_unit.view.scoped` gets `{ unrestricted: false, allowedIds }`
   * (their assigned unit(s) plus every descendant) rather than an outright
   * ForbiddenException. Every other view-only method on this service
   * (`listRoots`/`listChildren`/`getDescendants`) still calls the plain
   * `requireView()` above and stays `.all`-only for now — deliberately
   * out of this phase's scope, see the Phase 11 roadmap note on why tree
   * navigation is a documented follow-on rather than built here.
   */
  private async resolveViewAccess(claims: RequestClaims): Promise<{ unrestricted: boolean; allowedIds: string[] }> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (canView || canManage) {
      return { unrestricted: true, allowedIds: [] };
    }
    if (!(await this.rbac.hasScopedPermission(claims, SCOPED_VIEW_PERMISSION_BASE))) {
      throw new ForbiddenException("Not permitted to view the org unit hierarchy");
    }
    const assignedIds = await this.rbac.resolveDataScopeEntityIds(claims, "org_unit");
    const allowedIds = await this.expandToSubtreeIds(claims, assignedIds);
    return { unrestricted: false, allowedIds };
  }

  /**
   * Every id in `rootIds` plus all of their descendants — Data Scope
   * expansion (Phase 11, Section 19): a caller assigned org unit A is
   * meant to see A's whole subtree, not just A itself. Reuses this
   * service's own `descendantRows()` recursive CTE per root; a stale
   * assignment pointing at a unit that no longer exists (or belongs to a
   * different company) is skipped rather than thrown on, and overlapping
   * assignments just produce a deduplicated union, which is harmless.
   */
  async expandToSubtreeIds(claims: RequestClaims, rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    return this.db.withClaims(claims, async (client) => {
      const ids = new Set<string>();
      for (const rootId of rootIds) {
        const exists = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [
          rootId,
          claims.company_id,
        ]);
        if (exists.rowCount === 0) continue;
        ids.add(rootId);
        const descendants = await this.descendantRows(client, claims.company_id!, rootId);
        for (const row of descendants) ids.add(row.id as string);
      }
      return Array.from(ids);
    });
  }
}
