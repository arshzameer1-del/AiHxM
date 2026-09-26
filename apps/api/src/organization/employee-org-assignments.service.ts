import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
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
  AssignmentType,
  CreateEmployeeOrgAssignmentRequest,
  EmployeeOrgAssignmentVersionView,
  EmployeeOrgAssignmentView,
  UpdateEmployeeOrgAssignmentRequest,
} from "@aihxm/shared-types";

// Employee Org Assignments are gated under the same `employee` module
// every other Organization Management object lives under.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee_org_assignment.manage.all";
const VIEW_PERMISSION = "employee_org_assignment.view.all";
// Organization Management Phase 11 (Section 19) — the alternative to
// VIEW_PERMISSION a role can hold instead: restricted to assignments
// inside the caller's assigned org-unit data scope (expanded to subtree)
// OR at one of the caller's assigned locations (also expanded to
// subtree) — visible along EITHER dimension the caller has assignments
// for, same "either dimension" rule PositionsService's own
// `position.view.scoped` uses.
const SCOPED_VIEW_PERMISSION_BASE = "employee_org_assignment.view";

type AssignmentRow = {
  id: string;
  company_id: string;
  employee_id: string;
  assignment_type: AssignmentType;
  org_unit_id: string;
  position_id: string | null;
  location_id: string | null;
  status: "active" | "ended";
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignment(row: any): EmployeeOrgAssignmentView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    assignmentType: row.assignment_type,
    orgUnitId: row.org_unit_id,
    positionId: row.position_id,
    locationId: row.location_id,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(row: any): EmployeeOrgAssignmentVersionView {
  return {
    id: row.id,
    employeeOrgAssignmentId: row.employee_org_assignment_id,
    employeeId: row.employee_id,
    assignmentType: row.assignment_type,
    orgUnitId: row.org_unit_id,
    positionId: row.position_id,
    locationId: row.location_id,
    status: row.status,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

export type AssignmentListFilters = {
  employeeId?: string;
  orgUnitId?: string;
  // Organization Management Phase 9 — needed by PositionDetailPage's
  // "Assignment History" tab (every assignment slot ever pointed at this
  // position, not just the one employee currently holding it).
  positionId?: string;
  assignmentType?: AssignmentType;
  status?: "active" | "ended";
};

/**
 * Organization Management, Phase 3 (see the Master Engineering
 * Instruction doc's Section 11, and
 * 0071_employee_org_assignments_and_relationships.sql's own header comment
 * for the full design writeup): the canonical, typed assignment of an
 * employee to an org unit / position (/ location, once Location exists),
 * replacing the implicit assumption that `employees.orgUnitId`/
 * `employees.positionId` are the only assignment an employee can ever
 * have.
 *
 * Mirrors OrgUnitsService's/JobsService's/PositionsService's layering
 * exactly (entitlement -> RBAC -> business logic -> audit, RLS underneath),
 * with the same stable-identity (`employee_org_assignments`) +
 * effective-dated-history (`employee_org_assignment_versions`) split.
 *
 * ONE OPEN `primary` PER EMPLOYEE, MANY OPEN OF EVERYTHING ELSE: exactly
 * the master instruction's own invariant (this migration's own header
 * comment has the full reasoning) — `create()` pre-checks it
 * (ConflictException) before the DB's own partial unique index would
 * reject it, the same "application check first, DB constraint as
 * belt-and-braces" posture OrgUnitsService's cycle guard already
 * established.
 *
 * This service does NOT touch `employees.orgUnitId`/`employees.positionId`
 * at all — those stay exactly what PositionsService/EmployeesService
 * already make them (the CURRENT primary-ish state a plain employee record
 * read shows). `employee_org_assignments` is the richer, typed, multi-slot
 * model layered on top; reconciling the two into one obviously-consistent
 * picture (e.g. auto-updating `employees.orgUnitId` when a `primary`
 * assignment changes) is an explicit, documented gap for a later phase —
 * see this service's own KNOWN LIMITATIONS in the phase report, not
 * something silently assumed here.
 */
@Injectable()
export class EmployeeOrgAssignmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    // Optional for the same reason EmployeesService's own `webhooks` field
    // is (see that class's own doc comment). Organization Management
    // Phase 6 — the `org.assignment.changed` domain event, fired at every
    // one of this service's own already-audited mutation points
    // (create/update/end).
    private readonly webhooks?: WebhookDispatchService
  ) {}

  private publishChanged(claims: RequestClaims, changeType: string, assignment: EmployeeOrgAssignmentView): void {
    this.webhooks
      ?.enqueue(claims.company_id!, "org.assignment.changed", buildOrgEventPayload(claims, changeType, "assignment", assignment))
      .catch(() => undefined);
  }

  async create(claims: RequestClaims, input: CreateEmployeeOrgAssignmentRequest): Promise<EmployeeOrgAssignmentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, claims.company_id!, input.employeeId);
      await this.mustExistOrgUnit(client, claims.company_id!, input.orgUnitId);
      if (input.positionId) {
        await this.mustExistPosition(client, claims.company_id!, input.positionId);
      }

      if (input.assignmentType === "primary") {
        const existing = await client.query(
          "SELECT 1 FROM employee_org_assignments WHERE employee_id = $1 AND assignment_type = 'primary' AND status = 'active'",
          [input.employeeId]
        );
        if ((existing.rowCount ?? 0) > 0) {
          throw new ConflictException("This employee already has an open primary assignment — end it first");
        }
      }

      const inserted = await client.query(
        `INSERT INTO employee_org_assignments (company_id, employee_id, assignment_type, org_unit_id, position_id, location_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
        [
          claims.company_id,
          input.employeeId,
          input.assignmentType,
          input.orgUnitId,
          input.positionId ?? null,
          input.locationId ?? null,
        ]
      );
      const assignment = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "employee_org_assignment_versions",
        scope: { employee_org_assignment_id: assignment.id },
        extraInsertColumns: { company_id: claims.company_id, employee_id: assignment.employee_id, assignment_type: assignment.assignment_type },
        data: {
          org_unit_id: assignment.org_unit_id,
          position_id: assignment.position_id,
          location_id: assignment.location_id,
          status: assignment.status,
        },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_org_assignment.create",
        target: assignment.id,
        metadata: {
          employeeId: input.employeeId,
          assignmentType: input.assignmentType,
          orgUnitId: input.orgUnitId,
          positionId: input.positionId ?? null,
        },
      });

      const view = rowToAssignment(assignment);
      this.publishChanged(claims, "create", view);
      return view;
    });
  }

  /** A caller who only holds `employee_org_assignment.view.scoped`
   * (Phase 11, Section 19) instead sees only assignments inside their
   * assigned org unit(s)' subtree or at one of their assigned locations
   * (also expanded to subtree). */
  async list(claims: RequestClaims, filters: AssignmentListFilters = {}): Promise<EmployeeOrgAssignmentView[]> {
    const scope = await this.resolveViewAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const conditions = ["company_id = $1"];
      const values: unknown[] = [claims.company_id];
      if (filters.employeeId) {
        values.push(filters.employeeId);
        conditions.push(`employee_id = $${values.length}`);
      }
      if (filters.orgUnitId) {
        values.push(filters.orgUnitId);
        conditions.push(`org_unit_id = $${values.length}`);
      }
      if (filters.positionId) {
        values.push(filters.positionId);
        conditions.push(`position_id = $${values.length}`);
      }
      if (filters.assignmentType) {
        values.push(filters.assignmentType);
        conditions.push(`assignment_type = $${values.length}`);
      }
      if (filters.status) {
        values.push(filters.status);
        conditions.push(`status = $${values.length}`);
      }
      if (!scope.unrestricted) {
        values.push(scope.orgUnitIds);
        const orgUnitParam = values.length;
        values.push(scope.locationIds);
        const locationParam = values.length;
        conditions.push(
          `(org_unit_id = ANY($${orgUnitParam}::uuid[]) OR location_id = ANY($${locationParam}::uuid[]))`
        );
      }
      const result = await client.query(
        `SELECT * FROM employee_org_assignments WHERE ${conditions.join(" AND ")} ORDER BY created_at`,
        values
      );
      return result.rows.map(rowToAssignment);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<EmployeeOrgAssignmentView> {
    const scope = await this.resolveViewAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (!scope.unrestricted) {
        const inOrgUnitScope = scope.orgUnitIds.includes(row.org_unit_id);
        const inLocationScope = Boolean(row.location_id) && scope.locationIds.includes(row.location_id as string);
        if (!inOrgUnitScope && !inLocationScope) {
          throw new NotFoundException("Employee org assignment not found");
        }
      }
      return rowToAssignment(row);
    });
  }

  /** Moves this assignment to a different org unit/position/location in
   * place — `assignmentType` never changes here (create a new assignment
   * slot instead); ending it is `end()` below, not a plain field patch. */
  async update(claims: RequestClaims, id: string, patch: UpdateEmployeeOrgAssignmentRequest): Promise<EmployeeOrgAssignmentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

      if (patch.orgUnitId) {
        await this.mustExistOrgUnit(client, claims.company_id!, patch.orgUnitId);
      }
      if (patch.positionId) {
        await this.mustExistPosition(client, claims.company_id!, patch.positionId);
      }

      const next = {
        org_unit_id: patch.orgUnitId ?? before.org_unit_id,
        // `positionId === null` explicitly clears the link; `undefined`
        // (field omitted) leaves it unchanged — the same three-way
        // "set / clear / leave alone" distinction `UpdatePositionDto.jobId`
        // established.
        position_id: patch.positionId === null ? null : patch.positionId ?? before.position_id,
        location_id: patch.locationId === null ? null : patch.locationId ?? before.location_id,
        status: before.status,
      };

      const assignment = await this.applyVersionAndSync(client, claims, id, before, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_org_assignment.update",
        target: id,
        metadata: { before: rowToAssignment(before), after: rowToAssignment(assignment) },
      });

      const view = rowToAssignment(assignment);
      this.publishChanged(claims, "update", view);
      return view;
    });
  }

  /** End this assignment slot — a no-op (returns unchanged) if it was
   * already ended, the same "setStatus is a no-op if already there"
   * posture OrgUnitsService.setStatus()/PositionsService.unassignEmployee()
   * both take. Ending a `primary` assignment does NOT touch
   * `employees.orgUnitId` — see this service's own class doc comment. */
  async end(claims: RequestClaims, id: string, effectiveFrom?: string): Promise<EmployeeOrgAssignmentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      if (before.status === "ended") {
        return rowToAssignment(before);
      }

      const next = {
        org_unit_id: before.org_unit_id,
        position_id: before.position_id,
        location_id: before.location_id,
        status: "ended" as const,
      };
      const assignment = await this.applyVersionAndSync(client, claims, id, before, next, effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_org_assignment.end",
        target: id,
      });

      const view = rowToAssignment(assignment);
      this.publishChanged(claims, "end", view);
      return view;
    });
  }

  /** `GET /organization/employee-assignments/:id/history` — every version
   * this assignment slot has ever had, oldest first. */
  async getHistory(claims: RequestClaims, id: string): Promise<EmployeeOrgAssignmentVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "employee_org_assignment_versions",
        scope: { employee_org_assignment_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  /** Shared by update()/end(): supersedes the open
   * `employee_org_assignment_versions` row via the EffectiveDatingEngine,
   * then syncs `employee_org_assignments`' own denormalized current-state
   * columns to match — exactly OrgUnitsService's/PositionsService's own
   * `applyVersionAndSync()`. */
  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    before: AssignmentRow,
    data: { org_unit_id: string; position_id: string | null; location_id: string | null; status: string },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "employee_org_assignment_versions",
      scope: { employee_org_assignment_id: id },
      extraInsertColumns: { company_id: claims.company_id, employee_id: before.employee_id, assignment_type: before.assignment_type },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE employee_org_assignments SET org_unit_id = $2, position_id = $3, location_id = $4, status = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.org_unit_id, data.position_id, data.location_id, data.status]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<AssignmentRow> {
    const result = await client.query<AssignmentRow>("SELECT * FROM employee_org_assignments WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Employee org assignment not found");
    return result.rows[0];
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [employeeId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async mustExistOrgUnit(client: PoolClient, companyId: string, orgUnitId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [orgUnitId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Org unit not found");
  }

  private async mustExistPosition(client: PoolClient, companyId: string, positionId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM positions WHERE id = $1 AND company_id = $2", [positionId, companyId]);
    if (result.rowCount === 0) throw new NotFoundException("Position not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee organizational assignments");
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
      throw new ForbiddenException("Not permitted to view employee organizational assignments");
    }
  }

  /**
   * Organization Management Phase 11 (Section 19) — scope-aware sibling
   * of `requireView()`. Two independent dimensions, same "either
   * dimension" rule `PositionsService.resolveViewAccess()` uses: an
   * org-unit assignment (expanded to subtree) and a location assignment
   * (also expanded to subtree) — both via this method's own inline
   * recursive CTEs, the same duplication-over-injection choice
   * `PositionsService` already made for its own org-unit dimension.
   */
  private async resolveViewAccess(
    claims: RequestClaims
  ): Promise<{ unrestricted: boolean; orgUnitIds: string[]; locationIds: string[] }> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (canView || canManage) {
      return { unrestricted: true, orgUnitIds: [], locationIds: [] };
    }
    if (!(await this.rbac.hasScopedPermission(claims, SCOPED_VIEW_PERMISSION_BASE))) {
      throw new ForbiddenException("Not permitted to view employee organizational assignments");
    }
    const [assignedOrgUnitIds, assignedLocationIds] = await Promise.all([
      this.rbac.resolveDataScopeEntityIds(claims, "org_unit"),
      this.rbac.resolveDataScopeEntityIds(claims, "location"),
    ]);
    const [orgUnitIds, locationIds] = await Promise.all([
      this.expandSubtreeIds(claims, "org_units", assignedOrgUnitIds),
      this.expandSubtreeIds(claims, "locations", assignedLocationIds),
    ]);
    return { unrestricted: false, orgUnitIds, locationIds };
  }

  /** Every id in `rootIds` plus all of its descendants, in whichever
   * hierarchy table `table` names (`org_units` or `locations` — both
   * share the same `id`/`company_id`/`parent_id` shape this recursive CTE
   * relies on). Duplicated here rather than injecting
   * `OrgUnitsService`/`LocationsService`; see
   * `PositionsService.resolveViewAccess()`'s own doc comment for why. */
  private async expandSubtreeIds(
    claims: RequestClaims,
    table: "org_units" | "locations",
    rootIds: string[]
  ): Promise<string[]> {
    if (rootIds.length === 0) return [];
    return this.db.withClaims(claims, async (client) => {
      const ids = new Set<string>();
      for (const rootId of rootIds) {
        const exists = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`, [
          rootId,
          claims.company_id,
        ]);
        if (exists.rowCount === 0) continue;
        ids.add(rootId);
        const descendants = await client.query<{ id: string }>(
          `WITH RECURSIVE subtree AS (
             SELECT id, parent_id FROM ${table} WHERE company_id = $1 AND id = $2
             UNION ALL
             SELECT t.id, t.parent_id FROM ${table} t JOIN subtree s ON t.parent_id = s.id WHERE t.company_id = $1
           )
           SELECT id FROM subtree WHERE id != $2`,
          [claims.company_id, rootId]
        );
        for (const row of descendants.rows) ids.add(row.id);
      }
      return Array.from(ids);
    });
  }
}
