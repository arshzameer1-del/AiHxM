import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../../database/tenant-context";
import { AuditService } from "../../audit/audit.service";
import { EffectiveDatingEngine } from "../../effective-dating/effective-dating.engine";
import { WebhookDispatchService } from "../../webhooks/webhook-dispatch.service";
import { buildOrgEventPayload } from "../../webhooks/org-event-payload.util";
import type {
  AssignmentType,
  EmployeeOrgAssignmentView,
  OrgRelationshipType,
  OrgRelationshipView,
  PositionView,
} from "@aihxm/shared-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

// Same shapes PositionsService/EmployeeOrgAssignmentsService/
// OrgRelationshipsService each map their own rows to. Duplicated here
// rather than imported from those files: each of them imports THIS file,
// and a file-level import cycle between two `@Injectable()` classes is
// exactly the case where `emitDecoratorMetadata` can observe an
// `undefined` constructor type at decoration time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPosition(row: any): PositionView {
  return {
    id: row.id,
    companyId: row.company_id,
    orgUnitId: row.org_unit_id,
    jobId: row.job_id,
    positionCode: row.position_code,
    positionTitle: row.position_title,
    headcountFte: Number(row.headcount_fte),
    status: row.status,
    costCenterId: row.cost_center_id ?? null,
    profitCenterId: row.profit_center_id ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
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

type PositionRow = {
  id: string;
  company_id: string;
  org_unit_id: string;
  job_id: string | null;
  position_code: string | null;
  position_title: string;
  headcount_fte: string;
  status: string;
  cost_center_id: string | null;
  profit_center_id: string | null;
};

type AssignmentRow = {
  id: string;
  company_id: string;
  employee_id: string;
  assignment_type: AssignmentType;
  org_unit_id: string;
  position_id: string | null;
  location_id: string | null;
  status: "active" | "ended";
};

type RelationshipRow = {
  id: string;
  company_id: string;
  employee_id: string;
  manager_employee_id: string;
  relationship_type: OrgRelationshipType;
  status: "active" | "ended";
};

/**
 * Who/what drove an occupancy write — recorded on every audit row this
 * service writes (`metadata.source`) so an auditor can always trace a
 * position fill, assignment end, or relationship back to the business
 * transaction that caused it (`hire_process:<id>`,
 * `employee_lifecycle:transfer`, `org_change:<id>`, `position_workbench`).
 */
export type OccupancySource = string;

/**
 * Walks the ascending `direct`-relationship chain from `managerEmployeeId`
 * upward and rejects if `employeeId` appears anywhere in it — adding the
 * edge `employeeId -> managerEmployeeId` would otherwise close a reporting
 * loop. Exported (and called by `OrgRelationshipsService` too) so the one
 * cycle rule lives in exactly one place no matter which entry point is
 * creating the relationship.
 */
export async function assertNoReportingCycle(client: PoolClient, employeeId: string, managerEmployeeId: string): Promise<void> {
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

/**
 * Cross-module integration audit (2026-10-01), Items 1/2/7 — the ONE
 * transaction-scoped write path for Organization Management's occupancy
 * state: `positions.status` + `employees.position_id` (seat occupancy),
 * `employee_org_assignments` (typed assignment slots), and
 * `org_relationships` (typed reporting lines), for every caller that is
 * NOT the Organization Management UI itself — hiring completion
 * (`HiringProcessService.complete()`), the explicit lifecycle
 * transactions (`EmployeeLifecycleService`), and reorganization execution
 * (`OrgChangesService`'s cascade).
 *
 * WHY A SEPARATE, SLIM MODULE (`OrgOccupancyModule`) RATHER THAN AN EVENT
 * OR `forwardRef()`:
 *   - `OrganizationModule` already imports `EmployeesModule`
 *     (`LegacyReconciliationService`), so `EmployeesModule` cannot import
 *     `OrganizationModule` back without a `forwardRef()` cycle — which
 *     would also make every one of `OrganizationModule`'s ~12 providers
 *     resolvable from inside `EmployeesModule`, a far bigger coupling than
 *     the four operations actually needed.
 *   - An in-process event (`@nestjs/event-emitter`, not a dependency here
 *     today) cannot give atomicity: listeners run outside the emitter's
 *     `db.withClaims()` callback, so a failed position fill could never
 *     roll back the employee row the hire just created. Every write in
 *     this class takes the CALLER's own `PoolClient` instead, so it
 *     commits or rolls back with the caller's transaction, exactly the
 *     `*WithinTransaction()` convention
 *     `EmployeeCompensationService.setCompensationWithinTransaction()`/
 *     `ShiftsService.assignShiftWithinTransaction()` already established.
 *   - This module imports only `AuditModule`/`EffectiveDatingModule`/
 *     `WebhooksModule` — none of which import anything of ours — so both
 *     `EmployeesModule` and `OrganizationModule` can import it without any
 *     cycle: the same "deliberately slim, export-only module" shape
 *     `WebhooksModule` already uses for the same reason.
 *
 * `PositionsService.assignEmployee()`/`unassignEmployee()` (the Position
 * Workbench) delegate their writes HERE too, so it stays true that
 * exactly one code path in the codebase ever writes
 * `employees.position_id` — it just now lives below both modules instead
 * of inside one of them.
 *
 * NO RBAC IN THIS CLASS, BY DESIGN: every caller has already cleared its
 * own permission gate (`employee.manage.all` for hiring/lifecycle,
 * `position.manage.all` for the Workbench, an approved workflow for a
 * reorg) before opening the transaction it hands in — the same "caller
 * already authorized, this is the inner write" contract every
 * `*WithinTransaction()` method in this codebase follows. Every query is
 * nonetheless explicitly `company_id`-scoped, since a reorg's cron sweep
 * runs under `is_service` claims where RLS alone would not scope it.
 *
 * Concurrency: every read-then-write on a position takes `FOR UPDATE` on
 * that row first, so the "is it still vacant?" re-check and the fill are
 * atomic against a concurrent hire/Workbench assignment of the same seat
 * — the earlier hiring-card validation (`organization-assignment-
 * validator.ts`) only proves the seat WAS vacant when the card was saved.
 */
@Injectable()
export class OrgOccupancyService {
  constructor(
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    // Optional for the same reason every Organization Management
    // service's own `webhooks` field is — spec files hand-construct this
    // without one.
    private readonly webhooks?: WebhookDispatchService
  ) {}

  // ---------------------------------------------------------------------
  // Positions (seat occupancy)
  // ---------------------------------------------------------------------

  /**
   * Fill a vacant position with an employee. Re-validates the seat under a
   * row lock (`vacant`, belongs to `expectedOrgUnitId` when given) — never
   * trusts an earlier check. If the employee already occupies a different
   * seat, that one is vacated first (an employee holds at most one
   * position; `employees.position_id` is a single FK).
   */
  async assignPositionWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: { positionId: string; employeeId: string; effectiveFrom?: string; expectedOrgUnitId?: string | null; source?: OccupancySource }
  ): Promise<PositionView> {
    const companyId = claims.company_id!;
    const position = await this.lockPosition(client, companyId, input.positionId);
    if (input.expectedOrgUnitId && position.org_unit_id !== input.expectedOrgUnitId) {
      throw new BadRequestException("Selected position belongs to a different organization unit than the one selected");
    }
    if (position.status !== "vacant") {
      throw new ConflictException(`Position is ${position.status}, not vacant — it cannot be assigned`);
    }

    const employeeResult = await client.query<{ id: string; position_id: string | null }>(
      "SELECT id, position_id FROM employees WHERE id = $1 AND company_id = $2 FOR UPDATE",
      [input.employeeId, companyId]
    );
    if (employeeResult.rowCount === 0) throw new NotFoundException("Employee not found");
    const employee = employeeResult.rows[0];

    if (employee.position_id && employee.position_id !== input.positionId) {
      await this.vacateRow(client, claims, employee.position_id, input.effectiveFrom);
    }

    await client.query("UPDATE employees SET position_id = $2, updated_at = now() WHERE id = $1 AND company_id = $3", [
      input.employeeId,
      input.positionId,
      companyId,
    ]);

    const updated = await this.applyPositionVersion(client, claims, position, "filled", input.effectiveFrom);

    await this.audit.record(client, claims, {
      companyId,
      action: "position.assign",
      target: input.positionId,
      metadata: { employeeId: input.employeeId, source: input.source ?? null },
    });

    const view = rowToPosition(updated);
    this.publish(claims, "org.position.changed", "position.assign", "position", view);
    return view;
  }

  /**
   * Vacate a position (whoever occupies it loses `employees.position_id`;
   * the seat flips back to `vacant` — never `abolished`, which is a
   * separate, explicit decision). A no-op returning the position unchanged
   * when it isn't `filled`, the same posture
   * `PositionsService.unassignEmployee()` has always had.
   */
  async vacatePositionWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: { positionId: string; effectiveFrom?: string; source?: OccupancySource }
  ): Promise<PositionView> {
    const companyId = claims.company_id!;
    const position = await this.lockPosition(client, companyId, input.positionId);
    if (position.status !== "filled") return rowToPosition(position);

    const updated = await this.vacateRow(client, claims, input.positionId, input.effectiveFrom);
    await this.audit.record(client, claims, {
      companyId,
      action: "position.unassign",
      target: input.positionId,
      metadata: { source: input.source ?? null },
    });

    const view = rowToPosition(updated);
    this.publish(claims, "org.position.changed", "position.unassign", "position", view);
    return view;
  }

  /** Vacate whatever seat this employee currently occupies, if any. */
  async vacateEmployeePositionWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: { employeeId: string; effectiveFrom?: string; source?: OccupancySource }
  ): Promise<PositionView | null> {
    const result = await client.query<{ position_id: string | null }>(
      "SELECT position_id FROM employees WHERE id = $1 AND company_id = $2",
      [input.employeeId, claims.company_id]
    );
    const positionId = result.rows[0]?.position_id;
    if (!positionId) return null;
    return this.vacatePositionWithinTransaction(client, claims, { positionId, effectiveFrom: input.effectiveFrom, source: input.source });
  }

  // ---------------------------------------------------------------------
  // employee_org_assignments (typed assignment slots)
  // ---------------------------------------------------------------------

  /** The employee's single open `primary` assignment, or null. */
  async findActivePrimaryAssignment(client: PoolClient, claims: RequestClaims, employeeId: string): Promise<EmployeeOrgAssignmentView | null> {
    const result = await client.query<AssignmentRow>(
      `SELECT * FROM employee_org_assignments
       WHERE employee_id = $1 AND company_id = $2 AND assignment_type = 'primary' AND status = 'active'`,
      [employeeId, claims.company_id]
    );
    return result.rows[0] ? rowToAssignment(result.rows[0]) : null;
  }

  /**
   * Open a new assignment slot. For `primary`, any currently-open primary
   * is ENDED first (as of the same effective date) rather than rejected —
   * every caller of this class is a transaction that by definition moves
   * the employee's primary assignment (hire, transfer, promotion into a
   * new seat), unlike `EmployeeOrgAssignmentsService.create()`'s manual
   * admin surface, which still rejects with a ConflictException so a human
   * never silently replaces one by accident.
   */
  async openAssignmentWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      employeeId: string;
      assignmentType: AssignmentType;
      orgUnitId: string;
      positionId?: string | null;
      locationId?: string | null;
      effectiveFrom?: string;
      source?: OccupancySource;
    }
  ): Promise<EmployeeOrgAssignmentView> {
    const companyId = claims.company_id!;
    if (input.assignmentType === "primary") {
      await this.endAssignmentsWithinTransaction(client, claims, {
        employeeId: input.employeeId,
        assignmentTypes: ["primary"],
        effectiveFrom: input.effectiveFrom,
        source: input.source,
      });
    }

    const inserted = await client.query<AssignmentRow>(
      `INSERT INTO employee_org_assignments (company_id, employee_id, assignment_type, org_unit_id, position_id, location_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
      [companyId, input.employeeId, input.assignmentType, input.orgUnitId, input.positionId ?? null, input.locationId ?? null]
    );
    const assignment = inserted.rows[0];

    await this.effectiveDating.applyVersionedRow(client, {
      table: "employee_org_assignment_versions",
      scope: { employee_org_assignment_id: assignment.id },
      extraInsertColumns: { company_id: companyId, employee_id: assignment.employee_id, assignment_type: assignment.assignment_type },
      data: {
        org_unit_id: assignment.org_unit_id,
        position_id: assignment.position_id,
        location_id: assignment.location_id,
        status: assignment.status,
      },
      effectiveFrom: input.effectiveFrom,
    });

    await this.audit.record(client, claims, {
      companyId,
      action: "employee_org_assignment.create",
      target: assignment.id,
      metadata: {
        employeeId: input.employeeId,
        assignmentType: input.assignmentType,
        orgUnitId: input.orgUnitId,
        positionId: input.positionId ?? null,
        source: input.source ?? null,
      },
    });

    const view = rowToAssignment(assignment);
    this.publish(claims, "org.assignment.changed", "create", "assignment", view);
    return view;
  }

  /**
   * Make the employee's open `primary` assignment reflect (org unit,
   * current seat, location): a no-op if it already does; otherwise the old
   * one is ENDED and a new one opened (`openAssignmentWithinTransaction()`
   * ends the old primary itself), so `employee_org_assignment_versions`
   * keeps the before/after as two distinct, effective-dated records. The
   * seat is read back from `employees.position_id` AFTER any seat move the
   * caller made in the same transaction, so it is always the seat actually
   * occupied. Shared by `EmployeeLifecycleService` (transfer/promote/
   * demote/location change) and `PositionsService.assignEmployee()`/
   * `unassignEmployee()` (the Position Workbench) — one implementation.
   * A no-op without an org unit (`employee_org_assignments.org_unit_id` is
   * NOT NULL — a legacy, org-unit-less employee has nothing to sync).
   */
  async syncPrimaryAssignmentWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    input: { orgUnitId: string | null; locationId: string | null; effectiveFrom?: string; source?: OccupancySource }
  ): Promise<EmployeeOrgAssignmentView | null> {
    if (!input.orgUnitId) return null;
    const emp = await client.query<{ position_id: string | null }>("SELECT position_id FROM employees WHERE id = $1 AND company_id = $2", [
      employeeId,
      claims.company_id,
    ]);
    const positionId = emp.rows[0]?.position_id ?? null;
    const current = await this.findActivePrimaryAssignment(client, claims, employeeId);
    if (
      current &&
      current.orgUnitId === input.orgUnitId &&
      (current.positionId ?? null) === positionId &&
      (current.locationId ?? null) === (input.locationId ?? null)
    ) {
      return current;
    }
    return this.openAssignmentWithinTransaction(client, claims, {
      employeeId,
      assignmentType: "primary",
      orgUnitId: input.orgUnitId,
      positionId,
      locationId: input.locationId,
      effectiveFrom: input.effectiveFrom,
      source: input.source,
    });
  }

  /**
   * Reconcile one employee's org side with the seat they now occupy (or no
   * longer occupy), after a seat move that is NOT itself a lifecycle
   * transaction — i.e. the Position Workbench's direct assign/unassign.
   *   - Occupying a seat: a position belongs to exactly one org unit, so
   *     `employees.org_unit_id`/`department` follow the seat (the same rule
   *     `EmployeeLifecycleService.promote()`/`demote()` apply, and the
   *     invariant `transfer()` relies on when it vacates a seat left
   *     behind in another unit), and the open `primary` assignment is made
   *     to point at (seat org unit, seat, current location) — opened if the
   *     employee had none.
   *   - Occupying no seat: an open `primary` that still names a seat is
   *     replaced by one without it (same org unit/location). An employee
   *     with no open primary is left alone — vacating a seat is not a
   *     reason to invent one.
   */
  async syncEmployeeOrgSideToSeatWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: { employeeId: string; effectiveFrom?: string; source?: OccupancySource }
  ): Promise<EmployeeOrgAssignmentView | null> {
    const companyId = claims.company_id!;
    const empResult = await client.query<{ org_unit_id: string | null; location_id: string | null; position_id: string | null }>(
      "SELECT org_unit_id, location_id, position_id FROM employees WHERE id = $1 AND company_id = $2",
      [input.employeeId, companyId]
    );
    const employee = empResult.rows[0];
    if (!employee) throw new NotFoundException("Employee not found");

    if (!employee.position_id) {
      const current = await this.findActivePrimaryAssignment(client, claims, input.employeeId);
      if (!current || !current.positionId) return current;
      return this.syncPrimaryAssignmentWithinTransaction(client, claims, input.employeeId, {
        orgUnitId: current.orgUnitId,
        locationId: current.locationId,
        effectiveFrom: input.effectiveFrom,
        source: input.source,
      });
    }

    const seat = await client.query<{ org_unit_id: string; org_unit_name: string }>(
      `SELECT p.org_unit_id, u.name AS org_unit_name
       FROM positions p JOIN org_units u ON u.id = p.org_unit_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [employee.position_id, companyId]
    );
    const seatOrgUnitId = seat.rows[0].org_unit_id;
    if (employee.org_unit_id !== seatOrgUnitId) {
      await client.query("UPDATE employees SET org_unit_id = $2, department = $3, updated_at = now() WHERE id = $1 AND company_id = $4", [
        input.employeeId,
        seatOrgUnitId,
        seat.rows[0].org_unit_name,
        companyId,
      ]);
    }
    return this.syncPrimaryAssignmentWithinTransaction(client, claims, input.employeeId, {
      orgUnitId: seatOrgUnitId,
      locationId: employee.location_id,
      effectiveFrom: input.effectiveFrom,
      source: input.source,
    });
  }

  /**
   * End every ACTIVE assignment matching the filter (at least one of
   * `employeeId`/`orgUnitId`/`positionId` is required — an unfiltered
   * call would end the whole tenant). Returns the ended rows.
   */
  async endAssignmentsWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      employeeId?: string;
      orgUnitId?: string;
      positionId?: string;
      assignmentTypes?: AssignmentType[];
      effectiveFrom?: string;
      source?: OccupancySource;
    }
  ): Promise<EmployeeOrgAssignmentView[]> {
    if (!input.employeeId && !input.orgUnitId && !input.positionId) {
      throw new Error("endAssignmentsWithinTransaction requires an employeeId, orgUnitId or positionId filter");
    }
    const conditions = ["company_id = $1", "status = 'active'"];
    const values: unknown[] = [claims.company_id];
    if (input.employeeId) {
      values.push(input.employeeId);
      conditions.push(`employee_id = $${values.length}`);
    }
    if (input.orgUnitId) {
      values.push(input.orgUnitId);
      conditions.push(`org_unit_id = $${values.length}`);
    }
    if (input.positionId) {
      values.push(input.positionId);
      conditions.push(`position_id = $${values.length}`);
    }
    if (input.assignmentTypes?.length) {
      values.push(input.assignmentTypes);
      conditions.push(`assignment_type = ANY($${values.length}::text[])`);
    }
    const open = await client.query<AssignmentRow>(
      `SELECT * FROM employee_org_assignments WHERE ${conditions.join(" AND ")} ORDER BY created_at FOR UPDATE`,
      values
    );

    const ended: EmployeeOrgAssignmentView[] = [];
    for (const before of open.rows) {
      await this.effectiveDating.applyVersionedRow(client, {
        table: "employee_org_assignment_versions",
        scope: { employee_org_assignment_id: before.id },
        extraInsertColumns: { company_id: before.company_id, employee_id: before.employee_id, assignment_type: before.assignment_type },
        data: { org_unit_id: before.org_unit_id, position_id: before.position_id, location_id: before.location_id, status: "ended" },
        effectiveFrom: input.effectiveFrom,
      });
      const updated = await client.query<AssignmentRow>(
        "UPDATE employee_org_assignments SET status = 'ended', updated_at = now() WHERE id = $1 RETURNING *",
        [before.id]
      );
      await this.audit.record(client, claims, {
        companyId: before.company_id,
        action: "employee_org_assignment.end",
        target: before.id,
        metadata: { employeeId: before.employee_id, source: input.source ?? null },
      });
      const view = rowToAssignment(updated.rows[0]);
      this.publish(claims, "org.assignment.changed", "end", "assignment", view);
      ended.push(view);
    }
    return ended;
  }

  // ---------------------------------------------------------------------
  // org_relationships (typed reporting lines)
  // ---------------------------------------------------------------------

  /**
   * Create a typed reporting relationship. For `direct`, an existing open
   * direct relationship is SUPERSEDED (ended as of the same effective
   * date) rather than rejected — a manager change is a replacement by
   * definition — and the cycle guard runs first.
   *
   * `syncEmployeeManagerId` (direct only): whether to also write
   * `employees.manager_id`. `OrgRelationshipsService` always does (it is
   * the org_relationships -> employees direction). A caller that has
   * ALREADY written `employees.manager_id` itself in the same transaction
   * (`EmployeeLifecycleService.changeManager()`, hiring's
   * `createWithinTransaction()`) passes `false` — see that service's own
   * ping-pong guard comment.
   */
  async createRelationshipWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      employeeId: string;
      managerEmployeeId: string;
      relationshipType: OrgRelationshipType;
      effectiveFrom?: string;
      syncEmployeeManagerId?: boolean;
      source?: OccupancySource;
    }
  ): Promise<OrgRelationshipView> {
    const companyId = claims.company_id!;
    if (input.employeeId === input.managerEmployeeId) {
      throw new BadRequestException("An employee cannot be their own manager");
    }
    // Company-scoped existence checks for BOTH sides: the FK alone would
    // accept another tenant's employee id (and a reorg's `is_service`
    // claims are not RLS-scoped at all).
    const parties = await client.query<{ id: string; employment_status: string }>(
      "SELECT id, employment_status FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[])",
      [companyId, [input.employeeId, input.managerEmployeeId]]
    );
    if (!parties.rows.some((r) => r.id === input.employeeId)) throw new NotFoundException("Employee not found");
    const manager = parties.rows.find((r) => r.id === input.managerEmployeeId);
    if (!manager) throw new BadRequestException("Manager not found");
    if (manager.employment_status === "terminated") {
      throw new BadRequestException("Cannot assign a terminated employee as manager");
    }
    if (input.relationshipType === "direct") {
      await this.endRelationshipsWithinTransaction(client, claims, {
        employeeId: input.employeeId,
        relationshipTypes: ["direct"],
        effectiveFrom: input.effectiveFrom,
        clearEmployeeManagerId: false,
        source: input.source,
      });
      await assertNoReportingCycle(client, input.employeeId, input.managerEmployeeId);
    }

    const inserted = await client.query<RelationshipRow>(
      `INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
      [companyId, input.employeeId, input.managerEmployeeId, input.relationshipType]
    );
    const relationship = inserted.rows[0];

    await this.effectiveDating.applyVersionedRow(client, {
      table: "org_relationship_versions",
      scope: { org_relationship_id: relationship.id },
      extraInsertColumns: { company_id: companyId, employee_id: relationship.employee_id, relationship_type: relationship.relationship_type },
      data: { manager_employee_id: relationship.manager_employee_id, status: relationship.status },
      effectiveFrom: input.effectiveFrom,
    });

    if (input.relationshipType === "direct" && input.syncEmployeeManagerId !== false) {
      await client.query("UPDATE employees SET manager_id = $2, updated_at = now() WHERE id = $1 AND company_id = $3", [
        input.employeeId,
        input.managerEmployeeId,
        companyId,
      ]);
    }

    await this.audit.record(client, claims, {
      companyId,
      action: "org_relationship.create",
      target: relationship.id,
      metadata: {
        employeeId: input.employeeId,
        managerEmployeeId: input.managerEmployeeId,
        relationshipType: input.relationshipType,
        source: input.source ?? null,
      },
    });

    const view = rowToRelationship(relationship);
    this.publish(claims, "org.relationship.changed", "create", "relationship", view);
    return view;
  }

  /**
   * The employees -> org_relationships direction of the solid-line manager
   * fact: called by every writer that has ALREADY set
   * `employees.manager_id` itself in the caller's transaction
   * (`EmployeeLifecycleService.changeManager()` and the generic
   * `EmployeesService.update()` PATCH), so both paths share exactly one
   * implementation.
   *   - `managerEmployeeId` set: supersede the open `direct` relationship
   *     (cycle guard, self/terminated/foreign-tenant checks included). A
   *     no-op when an open `direct` row to that same manager already exists.
   *   - `managerEmployeeId` null: end the open `direct` relationship.
   *
   * PING-PONG GUARD: this NEVER writes `employees.manager_id`
   * (`syncEmployeeManagerId: false` / `clearEmployeeManagerId: false`) —
   * the caller's own UPDATE is the one writer of that column in the
   * transaction. The opposite direction (`OrgRelationshipsService`, which
   * writes org_relationships -> employees.manager_id) writes the column
   * with plain SQL and never calls back into EmployeesService, so neither
   * side re-triggers the other. Keep both non-reactive; if either is ever
   * made reactive (e.g. an `org.relationship.changed` listener), it must
   * skip changes whose `source` came from the other direction.
   */
  async syncDirectManagerFromEmployeeWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: { employeeId: string; managerEmployeeId: string | null; effectiveFrom?: string; source?: OccupancySource }
  ): Promise<OrgRelationshipView | null> {
    if (!input.managerEmployeeId) {
      await this.endRelationshipsWithinTransaction(client, claims, {
        employeeId: input.employeeId,
        relationshipTypes: ["direct"],
        effectiveFrom: input.effectiveFrom,
        clearEmployeeManagerId: false,
        source: input.source,
      });
      return null;
    }
    const existing = await client.query<RelationshipRow>(
      `SELECT * FROM org_relationships
       WHERE company_id = $1 AND employee_id = $2 AND relationship_type = 'direct' AND status = 'active'`,
      [claims.company_id, input.employeeId]
    );
    if (existing.rows[0]?.manager_employee_id === input.managerEmployeeId) {
      return rowToRelationship(existing.rows[0]);
    }
    return this.createRelationshipWithinTransaction(client, claims, {
      employeeId: input.employeeId,
      managerEmployeeId: input.managerEmployeeId,
      relationshipType: "direct",
      effectiveFrom: input.effectiveFrom,
      syncEmployeeManagerId: false,
      source: input.source,
    });
  }

  /** End every ACTIVE relationship where `employeeId` is the report. */
  async endRelationshipsWithinTransaction(
    client: PoolClient,
    claims: RequestClaims,
    input: {
      employeeId: string;
      relationshipTypes?: OrgRelationshipType[];
      effectiveFrom?: string;
      clearEmployeeManagerId: boolean;
      source?: OccupancySource;
    }
  ): Promise<OrgRelationshipView[]> {
    const values: unknown[] = [claims.company_id, input.employeeId];
    let typeFilter = "";
    if (input.relationshipTypes?.length) {
      values.push(input.relationshipTypes);
      typeFilter = ` AND relationship_type = ANY($3::text[])`;
    }
    const open = await client.query<RelationshipRow>(
      `SELECT * FROM org_relationships WHERE company_id = $1 AND employee_id = $2 AND status = 'active'${typeFilter} FOR UPDATE`,
      values
    );
    const ended: OrgRelationshipView[] = [];
    for (const before of open.rows) {
      await this.effectiveDating.applyVersionedRow(client, {
        table: "org_relationship_versions",
        scope: { org_relationship_id: before.id },
        extraInsertColumns: { company_id: before.company_id, employee_id: before.employee_id, relationship_type: before.relationship_type },
        data: { manager_employee_id: before.manager_employee_id, status: "ended" },
        effectiveFrom: input.effectiveFrom,
      });
      const updated = await client.query<RelationshipRow>(
        "UPDATE org_relationships SET status = 'ended', updated_at = now() WHERE id = $1 RETURNING *",
        [before.id]
      );
      if (before.relationship_type === "direct" && input.clearEmployeeManagerId) {
        await client.query("UPDATE employees SET manager_id = NULL, updated_at = now() WHERE id = $1 AND manager_id = $2", [
          before.employee_id,
          before.manager_employee_id,
        ]);
      }
      await this.audit.record(client, claims, {
        companyId: before.company_id,
        action: "org_relationship.end",
        target: before.id,
        metadata: { source: input.source ?? null },
      });
      const view = rowToRelationship(updated.rows[0]);
      this.publish(claims, "org.relationship.changed", "end", "relationship", view);
      ended.push(view);
    }
    return ended;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async lockPosition(client: PoolClient, companyId: string, positionId: string): Promise<PositionRow> {
    const result = await client.query<PositionRow>("SELECT * FROM positions WHERE id = $1 AND company_id = $2 FOR UPDATE", [
      positionId,
      companyId,
    ]);
    if (result.rowCount === 0) throw new NotFoundException("Position not found");
    return result.rows[0];
  }

  /** Clears every employee row pointing at this position (defensive — the
   * application only ever lets one occupy it) and flips it to `vacant`.
   * No audit/event of its own: used directly only as the "moving to a new
   * seat vacates the old one" side effect of an assign, which the assign's
   * own audit row already covers (unchanged from PositionsService's
   * original behavior). */
  private async vacateRow(client: PoolClient, claims: RequestClaims, positionId: string, effectiveFrom?: string): Promise<Record<string, unknown>> {
    await client.query("UPDATE employees SET position_id = NULL, updated_at = now() WHERE position_id = $1 AND company_id = $2", [
      positionId,
      claims.company_id,
    ]);
    const before = await this.lockPosition(client, claims.company_id!, positionId);
    return this.applyPositionVersion(client, claims, before, "vacant", effectiveFrom);
  }

  /** PositionsService.applyVersionAndSync()'s exact SQL shape, for a
   * status-only transition. */
  private async applyPositionVersion(
    client: PoolClient,
    claims: RequestClaims,
    before: PositionRow,
    status: string,
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    const data = {
      org_unit_id: before.org_unit_id,
      job_id: before.job_id,
      position_code: before.position_code,
      position_title: before.position_title,
      headcount_fte: Number(before.headcount_fte),
      status,
      cost_center_id: before.cost_center_id,
      profit_center_id: before.profit_center_id,
    };
    await this.effectiveDating.applyVersionedRow(client, {
      table: "position_versions",
      scope: { position_id: before.id },
      extraInsertColumns: { company_id: before.company_id },
      data,
      effectiveFrom,
    });
    const result = await client.query("UPDATE positions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [
      before.id,
      status,
    ]);
    return result.rows[0];
  }

  private publish(claims: RequestClaims, event: string, changeType: string, entity: string, view: { id: string }): void {
    if (!claims.company_id) return;
    this.webhooks?.enqueue(claims.company_id, event, buildOrgEventPayload(claims, changeType, entity, view)).catch(() => undefined);
  }
}
