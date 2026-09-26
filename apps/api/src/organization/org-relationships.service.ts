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
  CreateOrgRelationshipRequest,
  OrgRelationshipType,
  OrgRelationshipVersionView,
  OrgRelationshipView,
  UpdateOrgRelationshipRequest,
} from "@aihxm/shared-types";

// Org Relationships are gated under the same `employee` module every
// other Organization Management object lives under.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "org_relationship.manage.all";
const VIEW_PERMISSION = "org_relationship.view.all";

type RelationshipRow = {
  id: string;
  company_id: string;
  employee_id: string;
  manager_employee_id: string;
  relationship_type: OrgRelationshipType;
  status: "active" | "ended";
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRelationship(row: any): OrgRelationshipView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    managerEmployeeId: row.manager_employee_id,
    relationshipType: row.relationship_type,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(row: any): OrgRelationshipVersionView {
  return {
    id: row.id,
    orgRelationshipId: row.org_relationship_id,
    employeeId: row.employee_id,
    managerEmployeeId: row.manager_employee_id,
    relationshipType: row.relationship_type,
    status: row.status,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

export type RelationshipListFilters = {
  employeeId?: string;
  managerEmployeeId?: string;
  relationshipType?: OrgRelationshipType;
  status?: "active" | "ended";
};

/**
 * Organization Management, Phase 3 (see the Master Engineering
 * Instruction doc's Section 12, and
 * 0071_employee_org_assignments_and_relationships.sql's own header comment
 * for the full design writeup): a canonical, TYPED reporting relationship
 * between two employees, replacing the untyped `employees.managerId`
 * self-reference (0010_employee_core.sql) as the source of truth for "who
 * reports to whom, and how."
 *
 * Mirrors OrgUnitsService's own layering exactly (entitlement -> RBAC ->
 * business logic -> audit, RLS underneath), with the same stable-identity
 * (`org_relationships`) + effective-dated-history
 * (`org_relationship_versions`) split.
 *
 * `employees.managerId` SYNC — THE MOST IMPORTANT CONTRACT THIS SERVICE
 * HOLDS: every create()/update()/end() that touches a `direct` relationship
 * writes `employees.managerId` via plain SQL, reaching across the table
 * boundary exactly like PositionsService.assignEmployee()/
 * unassignEmployee() already do for `employees.positionId` (see that
 * service's own class doc comment for why: "the same reach across a table
 * boundary via plain SQL rather than injecting the other domain's
 * service" — zero new cross-module DI in either direction). This is a
 * ONE-DIRECTIONAL, POINT-IN-TIME sync, NOT a live view:
 *   - Creating/updating a `direct` relationship SETS `employees.managerId`
 *     to the relationship's current `managerEmployeeId` at that moment.
 *   - Ending a `direct` relationship CLEARS `employees.managerId` back to
 *     NULL (guarded on it still matching this relationship's own
 *     `managerEmployeeId`, so a manager_id someone changed out from under
 *     this relationship through some other path is never clobbered — the
 *     same defensive guard PositionsService.vacate() documents for
 *     `employees.positionId`).
 *   - A non-`direct` relationship (dotted_line/matrix/temporary/acting)
 *     NEVER touches `employees.managerId` — that column is specifically
 *     the "solid-line manager," which only a `direct` relationship
 *     represents.
 *
 * KNOWN, DELIBERATE GAP (documented here and in the phase report, not an
 * oversight): `EmployeesService.create()`/`update()` ALSO write
 * `employees.managerId` directly from their own pre-existing `managerId`
 * input field — that behavior is UNCHANGED and MUST keep working (this
 * phase's backward-compatibility mandate). That legacy write path does
 * NOT create or update a corresponding `org_relationships` row. In other
 * words: the sync is complete in the direction org_relationships ->
 * employees.managerId, but NOT in the reverse direction
 * employees.managerId -> org_relationships. A tenant that keeps using only
 * the legacy `managerId` field never gets a typed relationship record for
 * it; a tenant that adopts this typed API gets both.
 *
 * CYCLE PREVENTION (Section 12 / phase brief item #3): before creating or
 * updating a `direct` relationship, `assertNoCycle()` walks the ascending
 * `direct`-relationship chain from the PROPOSED manager upward (who is
 * their manager, and their manager's manager, ...) via a recursive CTE —
 * the same "recursive CTE, path array, `NOT x = ANY(path)` to keep it
 * finite even if a cycle already existed somehow" shape
 * OrgUnitsService.descendantRows() already established for the org unit
 * hierarchy. If the proposed report's own id appears anywhere in that
 * ascending chain, adding the edge would close a loop (A manages B manages
 * C manages A) and is rejected with BadRequestException. `employeeId ===
 * managerEmployeeId` (self-management) is rejected before that, and is
 * also a DB CHECK (belt).
 */
@Injectable()
export class OrgRelationshipsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    // Optional for the same reason every other Organization Management
    // service's own `webhooks` field is (see OrgUnitsService's own doc
    // comment) — a large number of unrelated spec files hand-construct
    // this service directly. Organization Management Phase 7 (Unified
    // Integration & Synchronization Requirements, Section 14) — the
    // `org.relationship.changed` domain event, fired at every one of this
    // service's own already-audited mutation points (create/update/end).
    private readonly webhooks?: WebhookDispatchService
  ) {}

  private publishChanged(claims: RequestClaims, changeType: string, relationship: OrgRelationshipView): void {
    this.webhooks
      ?.enqueue(
        claims.company_id!,
        "org.relationship.changed",
        buildOrgEventPayload(claims, changeType, "relationship", relationship)
      )
      .catch(() => undefined);
  }

  async create(claims: RequestClaims, input: CreateOrgRelationshipRequest): Promise<OrgRelationshipView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      if (input.employeeId === input.managerEmployeeId) {
        throw new BadRequestException("An employee cannot be their own manager");
      }
      await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
      await this.mustExistEmployee(client, claims.company_id!, input.managerEmployeeId);

      if (input.relationshipType === "direct") {
        const existing = await client.query(
          "SELECT 1 FROM org_relationships WHERE employee_id = $1 AND relationship_type = 'direct' AND status = 'active'",
          [input.employeeId]
        );
        if ((existing.rowCount ?? 0) > 0) {
          throw new ConflictException("This employee already has an open direct (solid-line) relationship — end it first");
        }
        await this.assertNoCycle(client, input.employeeId, input.managerEmployeeId);
      }

      const inserted = await client.query(
        `INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type, status)
         VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
        [claims.company_id, input.employeeId, input.managerEmployeeId, input.relationshipType]
      );
      const relationship = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "org_relationship_versions",
        scope: { org_relationship_id: relationship.id },
        extraInsertColumns: {
          company_id: claims.company_id,
          employee_id: relationship.employee_id,
          relationship_type: relationship.relationship_type,
        },
        data: {
          manager_employee_id: relationship.manager_employee_id,
          status: relationship.status,
        },
        effectiveFrom: input.effectiveFrom,
      });

      if (input.relationshipType === "direct") {
        await this.syncManagerId(client, input.employeeId, input.managerEmployeeId);
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_relationship.create",
        target: relationship.id,
        metadata: {
          employeeId: input.employeeId,
          managerEmployeeId: input.managerEmployeeId,
          relationshipType: input.relationshipType,
        },
      });

      const view = rowToRelationship(relationship);
      this.publishChanged(claims, "create", view);
      return view;
    });
  }

  async list(claims: RequestClaims, filters: RelationshipListFilters = {}): Promise<OrgRelationshipView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const conditions = ["company_id = $1"];
      const values: unknown[] = [claims.company_id];
      if (filters.employeeId) {
        values.push(filters.employeeId);
        conditions.push(`employee_id = $${values.length}`);
      }
      if (filters.managerEmployeeId) {
        values.push(filters.managerEmployeeId);
        conditions.push(`manager_employee_id = $${values.length}`);
      }
      if (filters.relationshipType) {
        values.push(filters.relationshipType);
        conditions.push(`relationship_type = $${values.length}`);
      }
      if (filters.status) {
        values.push(filters.status);
        conditions.push(`status = $${values.length}`);
      }
      const result = await client.query(
        `SELECT * FROM org_relationships WHERE ${conditions.join(" AND ")} ORDER BY created_at`,
        values
      );
      return result.rows.map(rowToRelationship);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<OrgRelationshipView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToRelationship(await this.mustExist(client, id)));
  }

  /** Reassigns the manager/counterpart side in place — `relationshipType`/
   * `employeeId` never change here (create a new relationship instead);
   * ending it is `end()` below, not a plain field patch. */
  async update(claims: RequestClaims, id: string, patch: UpdateOrgRelationshipRequest): Promise<OrgRelationshipView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      const nextManagerId = patch.managerEmployeeId ?? before.manager_employee_id;
      if (nextManagerId === before.employee_id) {
        throw new BadRequestException("An employee cannot be their own manager");
      }
      if (patch.managerEmployeeId && patch.managerEmployeeId !== before.manager_employee_id) {
        await this.mustExistEmployee(client, claims.company_id!, patch.managerEmployeeId);
        if (before.relationship_type === "direct") {
          await this.assertNoCycle(client, before.employee_id, patch.managerEmployeeId);
        }
      }

      const next = { manager_employee_id: nextManagerId, status: before.status };
      const relationship = await this.applyVersionAndSync(client, claims, id, before, next, patch.effectiveFrom);

      if (before.relationship_type === "direct" && nextManagerId !== before.manager_employee_id) {
        await this.syncManagerId(client, before.employee_id, nextManagerId);
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_relationship.update",
        target: id,
        metadata: { before: rowToRelationship(before), after: rowToRelationship(relationship) },
      });

      const view = rowToRelationship(relationship);
      this.publishChanged(claims, "update", view);
      return view;
    });
  }

  /** End this relationship — a no-op (returns unchanged) if it was already
   * ended. Ending an open `direct` relationship clears
   * `employees.managerId` back to NULL — see this service's own class doc
   * comment for the exact, guarded semantics. */
  async end(claims: RequestClaims, id: string, effectiveFrom?: string): Promise<OrgRelationshipView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") {
        return rowToRelationship(before);
      }

      const next = { manager_employee_id: before.manager_employee_id, status: "ended" as const };
      const relationship = await this.applyVersionAndSync(client, claims, id, before, next, effectiveFrom);

      if (before.relationship_type === "direct") {
        await client.query("UPDATE employees SET manager_id = NULL, updated_at = now() WHERE id = $1 AND manager_id = $2", [
          before.employee_id,
          before.manager_employee_id,
        ]);
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "org_relationship.end",
        target: id,
      });

      const view = rowToRelationship(relationship);
      this.publishChanged(claims, "end", view);
      return view;
    });
  }

  /** `GET /organization/relationships/:id/history` — every version this
   * relationship has ever had, oldest first. */
  async getHistory(claims: RequestClaims, id: string): Promise<OrgRelationshipVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "org_relationship_versions",
        scope: { org_relationship_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  /**
   * Walks the ascending `direct`-relationship chain from `managerEmployeeId`
   * upward (their manager, their manager's manager, ...) and rejects if
   * `employeeId` appears anywhere in it — adding the edge `employeeId ->
   * managerEmployeeId` on top of that chain would close a loop. Mirrors
   * OrgUnitsService.descendantRows()'s recursive-CTE/path-array shape
   * exactly, walked in the opposite (ascending, manager-of-manager)
   * direction instead of descending children.
   */
  private async assertNoCycle(client: PoolClient, employeeId: string, managerEmployeeId: string): Promise<void> {
    const result = await client.query(
      `WITH RECURSIVE chain AS (
         SELECT manager_employee_id AS mgr, ARRAY[manager_employee_id] AS path
         FROM org_relationships
         WHERE employee_id = $1 AND relationship_type = 'direct' AND status = 'active'
         UNION ALL
         SELECT r.manager_employee_id, chain.path || r.manager_employee_id
         FROM org_relationships r
         JOIN chain ON r.employee_id = chain.mgr
         WHERE r.relationship_type = 'direct' AND r.status = 'active' AND NOT r.manager_employee_id = ANY(chain.path)
       )
       SELECT 1 FROM chain WHERE mgr = $2 LIMIT 1`,
      [managerEmployeeId, employeeId]
    );
    if ((result.rowCount ?? 0) > 0) {
      throw new BadRequestException("This would create a manager reporting cycle");
    }
  }

  /** The one place this service ever writes `employees.managerId` — see
   * this service's own class doc comment for the full contract. */
  private async syncManagerId(client: PoolClient, employeeId: string, managerEmployeeId: string): Promise<void> {
    await client.query("UPDATE employees SET manager_id = $2, updated_at = now() WHERE id = $1", [
      employeeId,
      managerEmployeeId,
    ]);
  }

  /** Shared by update()/end(): supersedes the open
   * `org_relationship_versions` row via the EffectiveDatingEngine, then
   * syncs `org_relationships`' own denormalized current-state columns to
   * match — exactly OrgUnitsService's/PositionsService's own
   * `applyVersionAndSync()`. */
  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    before: RelationshipRow,
    data: { manager_employee_id: string; status: string },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "org_relationship_versions",
      scope: { org_relationship_id: id },
      extraInsertColumns: {
        company_id: claims.company_id,
        employee_id: before.employee_id,
        relationship_type: before.relationship_type,
      },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE org_relationships SET manager_employee_id = $2, status = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.manager_employee_id, data.status]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<RelationshipRow> {
    const result = await client.query<RelationshipRow>("SELECT * FROM org_relationships WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Org relationship not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage reporting relationships");
    }
  }

  /** Manage implies view, same as every other Organization Management
   * service's requireView(). */
  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view reporting relationships");
    }
  }
}
