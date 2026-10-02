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
import { OrgOccupancyService } from "./occupancy/org-occupancy.service";
import type {
  CreatePositionRequest,
  PositionStatus,
  PositionVersionView,
  PositionView,
  UpdatePositionRequest,
} from "@aihxm/shared-types";

// Positions are gated under the same `employee` module every other
// Employee Core / Organization Management object lives under.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "position.manage.all";
const VIEW_PERMISSION = "position.view.all";
// Organization Management Phase 11 (Section 19) — the alternative to
// VIEW_PERMISSION a role can hold instead: restricted to positions inside
// the caller's assigned org-unit data scope (expanded to subtree) OR
// tagged with one of the caller's assigned cost centers — a position is
// visible along EITHER dimension a caller has assignments for (Regional
// HR is scoped by org unit, Regional Finance by cost center, and both
// permissions ride on this same `position.view.scoped` key).
const SCOPED_VIEW_PERMISSION_BASE = "position.view";
// Cross-module integration audit (2026-10-01), gap #3/#7 — the write-side
// sibling of SCOPED_VIEW_PERMISSION_BASE. Same two dimensions (org unit
// subtree OR a tagged cost center), same "caller's side only" resolution,
// but gating create/update/freeze/unfreeze/abolish/reactivate/assign/
// unassign instead of list/get. See `resolveManageAccess()`'s own doc
// comment.
const SCOPED_MANAGE_PERMISSION_BASE = "position.manage";

type PositionRow = {
  id: string;
  company_id: string;
  org_unit_id: string;
  job_id: string | null;
  position_code: string | null;
  position_title: string;
  headcount_fte: string; // numeric comes back as a driver string
  status: string;
  // Organization Management Phase 4 (0073_locations_and_financial_centers.sql)
  // — nullable, additive: a position may optionally be tagged with one
  // cost center and/or one profit center, the reusable financial
  // dimensions Payroll/Reporting will eventually roll up by.
  cost_center_id: string | null;
  profit_center_id: string | null;
  created_at: unknown;
  updated_at: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

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
function rowToVersion(row: any): PositionVersionView {
  return {
    id: row.id,
    positionId: row.position_id,
    orgUnitId: row.org_unit_id,
    jobId: row.job_id,
    positionCode: row.position_code,
    positionTitle: row.position_title,
    headcountFte: Number(row.headcount_fte),
    status: row.status,
    costCenterId: row.cost_center_id ?? null,
    profitCenterId: row.profit_center_id ?? null,
    effectiveFrom: toIso(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to ? toIso(row.effective_to).slice(0, 10) : null,
    createdAt: toIso(row.created_at),
  };
}

export type PositionListFilters = {
  status?: PositionStatus;
  orgUnitId?: string;
};

/**
 * Organization Management, Phase 2 (see the Master Engineering
 * Instruction doc's Section 9, and 0068_job_position_architecture.sql's
 * own header comment for the full design writeup): an actual
 * organizational SEAT — belongs to exactly one Org Unit, optionally
 * references a Job, and can exist with zero occupants (`vacant`) as a
 * first-class, valid state, not an edge case.
 *
 * Mirrors OrgUnitsService's/JobsService's layering exactly (entitlement
 * -> RBAC -> business logic -> audit, RLS underneath), with the same
 * stable-identity (`positions`) + effective-dated-history
 * (`position_versions`) split.
 *
 * OCCUPANCY IS OWNED HERE, NOT IN EmployeesService: per the master
 * instruction's explicit direction ("a real, tested state transition in
 * OrgUnitsService's sibling PositionsService, not a trigger"),
 * `assignEmployee()`/`unassignEmployee()` below are the ONLY code paths
 * in this codebase that ever write `employees.position_id` — mirroring
 * how `ShiftsService`/`EmployeesService.resolveDepartment()` already
 * reach across a table boundary via plain SQL rather than injecting the
 * other domain's service (no `EmployeesService` dependency here, and
 * `EmployeesService` gets no `PositionsService` dependency either — zero
 * new cross-module DI, zero blast radius against the dozen-plus spec
 * files that hand-construct `EmployeesService` directly). Both writes
 * (the employee row and the position's status) happen inside the SAME
 * `db.withClaims` transaction as every other mutation on this service, so
 * they are always atomically consistent — see `assignEmployee()`'s own
 * doc comment. `EmployeesController`'s create/update endpoints
 * deliberately do NOT accept a `positionId` input this phase (see
 * `EmployeeView.positionId`'s own doc comment in shared-types) — the
 * Position Workbench's assign/unassign actions below are the single
 * source of truth for who occupies what.
 */
@Injectable()
export class PositionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    // Optional for the same reason EmployeesService's own `webhooks` field
    // is (see that class's own doc comment): a large number of unrelated
    // spec files hand-construct `PositionsService` directly with no
    // interest in webhooks at all. Organization Management Phase 6 — the
    // `org.position.changed` domain event, fired at every one of this
    // service's own already-audited mutation points (create/update/
    // freeze/unfreeze/abolish/reactivate/assign/unassign).
    private readonly webhooks?: WebhookDispatchService,
    // Cross-module integration audit (2026-10-01) — the shared,
    // transaction-scoped occupancy writer (see `assignEmployee()`). Default-
    // instantiated from this service's own dependencies, the same
    // "optional-with-default" convention HiringProcessService uses, so the
    // many spec files that hand-construct `PositionsService` positionally
    // keep working unchanged.
    occupancy?: OrgOccupancyService
  ) {
    this.occupancy = occupancy ?? new OrgOccupancyService(audit, effectiveDating, webhooks);
  }

  private readonly occupancy: OrgOccupancyService;

  private publishChanged(claims: RequestClaims, changeType: string, position: PositionView): void {
    this.webhooks
      ?.enqueue(claims.company_id!, "org.position.changed", buildOrgEventPayload(claims, changeType, "position", position))
      .catch(() => undefined);
  }

  async create(claims: RequestClaims, input: CreatePositionRequest): Promise<PositionView> {
    const scope = await this.resolveManageAccess(claims);
    this.assertInManageScope(scope, { org_unit_id: input.orgUnitId, cost_center_id: input.costCenterId ?? null });
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistOrgUnit(client, claims.company_id!, input.orgUnitId);

      let title = input.positionTitle?.trim();
      if (input.jobId) {
        const job = await client.query<{ title: string }>(
          "SELECT title FROM jobs WHERE id = $1 AND company_id = $2",
          [input.jobId, claims.company_id]
        );
        if (job.rowCount === 0) throw new NotFoundException("Job not found");
        if (!title) title = job.rows[0].title;
      }
      if (!title) {
        throw new BadRequestException("positionTitle is required when no jobId is given");
      }

      if (input.positionCode) {
        const dup = await client.query("SELECT 1 FROM positions WHERE company_id = $1 AND position_code = $2", [
          claims.company_id,
          input.positionCode,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A position with code "${input.positionCode}" already exists`);
        }
      }
      if (input.costCenterId) {
        await this.mustExistCostCenter(client, claims.company_id!, input.costCenterId);
      }
      if (input.profitCenterId) {
        await this.mustExistProfitCenter(client, claims.company_id!, input.profitCenterId);
      }

      const headcountFte = input.headcountFte ?? 1.0;
      const inserted = await client.query(
        `INSERT INTO positions (company_id, org_unit_id, job_id, position_code, position_title, headcount_fte, status, cost_center_id, profit_center_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'vacant', $7, $8) RETURNING *`,
        [
          claims.company_id,
          input.orgUnitId,
          input.jobId ?? null,
          input.positionCode ?? null,
          title,
          headcountFte,
          input.costCenterId ?? null,
          input.profitCenterId ?? null,
        ]
      );
      const position = inserted.rows[0];

      await this.effectiveDating.applyVersionedRow(client, {
        table: "position_versions",
        scope: { position_id: position.id },
        extraInsertColumns: { company_id: claims.company_id },
        data: {
          org_unit_id: position.org_unit_id,
          job_id: position.job_id,
          position_code: position.position_code,
          position_title: position.position_title,
          headcount_fte: position.headcount_fte,
          status: position.status,
          cost_center_id: position.cost_center_id,
          profit_center_id: position.profit_center_id,
        },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position.create",
        target: position.id,
        metadata: { orgUnitId: input.orgUnitId, jobId: input.jobId ?? null, positionTitle: title },
      });

      const view = rowToPosition(position);
      this.publishChanged(claims, "create", view);
      return view;
    });
  }

  /** Every position in the tenant, optionally filtered by status/org
   * unit — the raw material the Position Workbench's list view renders
   * from. */
  /** Every position in the tenant, optionally filtered by status/org
   * unit — the raw material the Position Workbench's list view renders
   * from. A caller who only holds `position.view.scoped` (Phase 11,
   * Section 19) instead sees only positions inside their assigned org
   * unit(s)' subtree or tagged with one of their assigned cost centers. */
  async list(claims: RequestClaims, filters: PositionListFilters = {}): Promise<PositionView[]> {
    const scope = await this.resolveViewAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const conditions = ["company_id = $1"];
      const values: unknown[] = [claims.company_id];
      if (filters.status) {
        values.push(filters.status);
        conditions.push(`status = $${values.length}`);
      }
      if (filters.orgUnitId) {
        values.push(filters.orgUnitId);
        conditions.push(`org_unit_id = $${values.length}`);
      }
      if (!scope.unrestricted) {
        values.push(scope.orgUnitIds);
        const orgUnitParam = values.length;
        values.push(scope.costCenterIds);
        const costCenterParam = values.length;
        conditions.push(
          `(org_unit_id = ANY($${orgUnitParam}::uuid[]) OR cost_center_id = ANY($${costCenterParam}::uuid[]))`
        );
      }
      const result = await client.query(
        `SELECT * FROM positions WHERE ${conditions.join(" AND ")} ORDER BY position_title`,
        values
      );
      return result.rows.map(rowToPosition);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<PositionView> {
    const scope = await this.resolveViewAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (!scope.unrestricted) {
        const inOrgUnitScope = scope.orgUnitIds.includes(row.org_unit_id);
        const inCostCenterScope = Boolean(row.cost_center_id) && scope.costCenterIds.includes(row.cost_center_id as string);
        if (!inOrgUnitScope && !inCostCenterScope) {
          throw new NotFoundException("Position not found");
        }
      }
      return rowToPosition(row);
    });
  }

  /** Retitle/recode/reassign-job/reparent-org-unit/adjust-headcount in
   * place — status transitions are their own dedicated actions below. */
  async update(claims: RequestClaims, id: string, patch: UpdatePositionRequest): Promise<PositionView> {
    const scope = await this.resolveManageAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      this.assertInManageScope(scope, before);

      if (patch.orgUnitId) {
        await this.mustExistOrgUnit(client, claims.company_id!, patch.orgUnitId);
      }
      if (patch.jobId) {
        const job = await client.query("SELECT 1 FROM jobs WHERE id = $1 AND company_id = $2", [
          patch.jobId,
          claims.company_id,
        ]);
        if (job.rowCount === 0) throw new NotFoundException("Job not found");
      }
      if (patch.positionCode && patch.positionCode !== before.position_code) {
        const dup = await client.query(
          "SELECT 1 FROM positions WHERE company_id = $1 AND position_code = $2 AND id != $3",
          [claims.company_id, patch.positionCode, id]
        );
        if ((dup.rowCount ?? 0) > 0) {
          throw new ConflictException(`A position with code "${patch.positionCode}" already exists`);
        }
      }
      if (patch.costCenterId) {
        await this.mustExistCostCenter(client, claims.company_id!, patch.costCenterId);
      }
      if (patch.profitCenterId) {
        await this.mustExistProfitCenter(client, claims.company_id!, patch.profitCenterId);
      }

      const next = {
        org_unit_id: patch.orgUnitId ?? before.org_unit_id,
        // `jobId === null` explicitly clears the link; `undefined` (field
        // omitted) leaves it unchanged — the same three-way "set / clear /
        // leave alone" distinction MoveOrgUnitDto's parentId established.
        job_id: patch.jobId === null ? null : patch.jobId ?? before.job_id,
        position_code: patch.positionCode ?? before.position_code,
        position_title: patch.positionTitle ?? before.position_title,
        headcount_fte: patch.headcountFte ?? Number(before.headcount_fte),
        status: before.status,
        // Same three-way "set / clear / leave alone" distinction as jobId
        // above.
        cost_center_id: patch.costCenterId === null ? null : patch.costCenterId ?? before.cost_center_id,
        profit_center_id: patch.profitCenterId === null ? null : patch.profitCenterId ?? before.profit_center_id,
      };
      // A scoped caller may not move a position's org unit/cost center to
      // one outside their own data scope, even though they were allowed
      // to touch the position in its CURRENT (in-scope) location.
      this.assertInManageScope(scope, { org_unit_id: next.org_unit_id, cost_center_id: next.cost_center_id });

      const position = await this.applyVersionAndSync(client, claims, id, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position.update",
        target: id,
        metadata: { before: rowToPosition(before), after: rowToPosition(position) },
      });

      const view = rowToPosition(position);
      this.publishChanged(claims, "update", view);
      return view;
    });
  }

  /**
   * Freeze — only valid from `vacant`. A `filled` position must be
   * unassigned first: freezing out from under a current occupant would
   * leave `employees.position_id` pointing at a frozen seat with no
   * record of the fact that used to be a normal fill, and it's not clear
   * what "frozen but occupied" should even mean operationally. This is a
   * deliberate, documented simplification for this phase (see this
   * service's own class doc comment and the phase's final report's
   * KNOWN LIMITATIONS) — a richer "freeze in place" concept can be a
   * later refinement once real usage shows it's needed.
   */
  async freeze(claims: RequestClaims, id: string): Promise<PositionView> {
    return this.transitionStatus(claims, id, "position.freeze", (status) => {
      if (status !== "vacant") {
        throw new BadRequestException("Only a vacant position can be frozen — unassign it first");
      }
      return "frozen";
    });
  }

  async unfreeze(claims: RequestClaims, id: string): Promise<PositionView> {
    return this.transitionStatus(claims, id, "position.unfreeze", (status) => {
      if (status !== "frozen") {
        throw new BadRequestException("Only a frozen position can be unfrozen");
      }
      return "vacant";
    });
  }

  /** Abolish — a soft-delete/retirement state; the row is never removed
   * (every position/job in this schema is a permanent record, exactly
   * like org units). Only valid from `vacant` or `frozen` — a `filled`
   * position must be unassigned first, same reasoning as `freeze()`. */
  async abolish(claims: RequestClaims, id: string): Promise<PositionView> {
    return this.transitionStatus(claims, id, "position.abolish", (status) => {
      if (status !== "vacant" && status !== "frozen") {
        throw new BadRequestException("Only a vacant or frozen position can be abolished — unassign it first");
      }
      return "abolished";
    });
  }

  async reactivate(claims: RequestClaims, id: string): Promise<PositionView> {
    return this.transitionStatus(claims, id, "position.reactivate", (status) => {
      if (status !== "abolished") {
        throw new BadRequestException("Only an abolished position can be reactivated");
      }
      return "vacant";
    });
  }

  private async transitionStatus(
    claims: RequestClaims,
    id: string,
    action: string,
    next: (current: PositionStatus) => PositionStatus
  ): Promise<PositionView> {
    const scope = await this.resolveManageAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      this.assertInManageScope(scope, before);
      const nextStatus = next(before.status as PositionStatus);

      const data = {
        org_unit_id: before.org_unit_id,
        job_id: before.job_id,
        position_code: before.position_code,
        position_title: before.position_title,
        headcount_fte: Number(before.headcount_fte),
        status: nextStatus,
        cost_center_id: before.cost_center_id,
        profit_center_id: before.profit_center_id,
      };
      const position = await this.applyVersionAndSync(client, claims, id, data);

      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action, target: id });

      const view = rowToPosition(position);
      this.publishChanged(claims, action, view);
      return view;
    });
  }

  /**
   * Assign an employee to a vacant position — the canonical occupancy
   * state transition the master instruction calls for. Both writes
   * (`employees.position_id` and this position's own `status`) happen
   * inside this ONE `db.withClaims` transaction, so a failure partway
   * through (e.g. the position-status update) rolls back the employee
   * write too — real atomicity, not two independent calls hoping to
   * agree (see `runInTenantContext`'s own doc comment for why a second,
   * separately-opened `withClaims` call could never give the same
   * guarantee).
   *
   * If the employee already occupies a DIFFERENT position, that old
   * position is vacated as a side effect — an employee occupies at most
   * one position at a time (`employees.position_id` is a single FK, not
   * a join table), so moving them to a new seat must free the old one or
   * the old seat would be left permanently marked `filled` with no real
   * occupant.
   *
   * Cross-module integration audit (2026-10-01): the actual writes now live
   * in `OrgOccupancyService.assignPositionWithinTransaction()` — moved
   * BELOW this module (not duplicated) so hiring completion and the
   * lifecycle transactions in `EmployeesModule` can run the exact same
   * occupancy transition inside their own transactions without a circular
   * module import. This method is unchanged in contract (same gate, same
   * ConflictException on a non-vacant seat, same audit action, same
   * `org.position.changed` event); it simply hands its own transaction
   * client down.
   *
   * Cross-module integration follow-up (2026-10-01): a Workbench
   * assignment used to fill the seat only, leaving the employee's
   * `employee_org_assignments` primary row (and `employees.org_unit_id`)
   * describing wherever they were before. The same transaction now also
   * runs `OrgOccupancyService.syncEmployeeOrgSideToSeatWithinTransaction()`
   * — org unit/department follow the seat and the open `primary`
   * assignment is replaced (or opened) to name it — so the Workbench, a
   * hire and a lifecycle transfer/promotion all leave identical org-side
   * state behind.
   */
  async assignEmployee(claims: RequestClaims, positionId: string, employeeId: string, effectiveFrom?: string): Promise<PositionView> {
    const scope = await this.resolveManageAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const position = await this.mustExist(client, positionId);
      this.assertInManageScope(scope, position);
      // Cross-module integration follow-up (2026-10-01): captured BEFORE
      // either occupancy write below so it reflects the seat the employee
      // is moving FROM, not the one they're moving to.
      const before = await client.query<{ org_unit_id: string | null; designation: string | null; salary_band: string | null }>(
        "SELECT org_unit_id, designation, salary_band FROM employees WHERE id = $1 AND company_id = $2",
        [employeeId, claims.company_id]
      );
      if (before.rowCount === 0) throw new NotFoundException("Employee not found");
      const beforeRow = before.rows[0];

      const view = await this.occupancy.assignPositionWithinTransaction(client, claims, {
        positionId,
        employeeId,
        effectiveFrom,
        source: "position_workbench",
      });
      await this.occupancy.syncEmployeeOrgSideToSeatWithinTransaction(client, claims, {
        employeeId,
        effectiveFrom,
        source: "position_workbench",
      });

      // Cross-module integration follow-up (2026-10-01): a Workbench
      // assignment that moves the employee into a seat in a DIFFERENT org
      // unit used to leave `employees.org_unit_id`/`department` updated
      // (the prior follow-up above, `syncEmployeeOrgSideToSeatWithinTransaction`)
      // but no trace in `employee_job_history` — the same trail
      // `EmployeeLifecycleService.transfer()` already writes for the
      // equivalent lifecycle-surface move (see that method, and its
      // shared `execute()` helper's own history INSERT). Keyed off
      // `org_unit_id` rather than the `department` display name it
      // derives from: `department` is re-set to match the seat's org
      // unit on every sync regardless of whether the unit actually
      // changed, so comparing it would under/over-fire. A same-org-unit
      // reassignment (filling a different vacant seat in the same unit)
      // is deliberately not logged here — nothing about the employee's
      // org placement changed, only which position row points at them.
      const after = await client.query<{ org_unit_id: string | null; department: string | null }>(
        "SELECT org_unit_id, department FROM employees WHERE id = $1 AND company_id = $2",
        [employeeId, claims.company_id]
      );
      const afterRow = after.rows[0];
      if (afterRow && afterRow.org_unit_id !== beforeRow.org_unit_id) {
        await client.query(
          `INSERT INTO employee_job_history
             (company_id, employee_id, event_type, effective_date, department, designation, salary_band, recorded_by_user_account_id)
           VALUES ($1, $2, 'position_assignment', COALESCE($3, CURRENT_DATE), $4, $5, $6, $7)`,
          [claims.company_id, employeeId, effectiveFrom ?? null, afterRow.department, beforeRow.designation, beforeRow.salary_band, claims.sub]
        );
      }

      return view;
    });
  }

  /** Unassign whoever currently occupies this position (if anyone) and
   * flip it back to `vacant`. A no-op (returns the position unchanged) if
   * it wasn't `filled` to begin with — unassigning an already-vacant
   * position isn't an error, the same "setStatus is a no-op if already
   * there" posture OrgUnitsService.setStatus() takes. Delegates to
   * `OrgOccupancyService` for the same reason `assignEmployee()` does,
   * including the follow-up org-side sync: the former occupant's open
   * `primary` assignment stops naming this seat (org unit/location kept). */
  async unassignEmployee(claims: RequestClaims, positionId: string, effectiveFrom?: string): Promise<PositionView> {
    const scope = await this.resolveManageAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const position = await this.mustExist(client, positionId);
      this.assertInManageScope(scope, position);
      const occupants = await client.query<{ id: string }>("SELECT id FROM employees WHERE position_id = $1 AND company_id = $2", [
        positionId,
        claims.company_id,
      ]);
      const view = await this.occupancy.vacatePositionWithinTransaction(client, claims, {
        positionId,
        effectiveFrom,
        source: "position_workbench",
      });
      for (const occupant of occupants.rows) {
        await this.occupancy.syncEmployeeOrgSideToSeatWithinTransaction(client, claims, {
          employeeId: occupant.id,
          effectiveFrom,
          source: "position_workbench",
        });
      }
      return view;
    });
  }

  /** `GET /organization/positions/:id/history` — every version this
   * position has ever had, oldest first. */
  async getHistory(claims: RequestClaims, id: string): Promise<PositionVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExist(client, id);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "position_versions",
        scope: { position_id: id },
      });
      return rows.map(rowToVersion);
    });
  }

  /** Shared by update()/transitionStatus() (occupancy transitions use
   * OrgOccupancyService's own copy of this SQL shape):
   * supersedes the open `position_versions` row via the
   * EffectiveDatingEngine, then syncs `positions`' own denormalized
   * current-state columns to match — exactly OrgUnitsService's/
   * JobsService's own `applyVersionAndSync()`. */
  private async applyVersionAndSync(
    client: PoolClient,
    claims: RequestClaims,
    id: string,
    data: {
      org_unit_id: string;
      job_id: string | null;
      position_code: string | null;
      position_title: string;
      headcount_fte: number;
      status: string;
      cost_center_id: string | null;
      profit_center_id: string | null;
    },
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await this.effectiveDating.applyVersionedRow(client, {
      table: "position_versions",
      scope: { position_id: id },
      extraInsertColumns: { company_id: claims.company_id },
      data,
      effectiveFrom,
    });

    const result = await client.query(
      `UPDATE positions SET org_unit_id = $2, job_id = $3, position_code = $4, position_title = $5,
         headcount_fte = $6, status = $7, cost_center_id = $8, profit_center_id = $9, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        data.org_unit_id,
        data.job_id,
        data.position_code,
        data.position_title,
        data.headcount_fte,
        data.status,
        data.cost_center_id,
        data.profit_center_id,
      ]
    );
    return result.rows[0];
  }

  private async mustExist(client: PoolClient, id: string): Promise<PositionRow> {
    const result = await client.query<PositionRow>("SELECT * FROM positions WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Position not found");
    return result.rows[0];
  }

  private async mustExistOrgUnit(client: PoolClient, companyId: string, orgUnitId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM org_units WHERE id = $1 AND company_id = $2", [
      orgUnitId,
      companyId,
    ]);
    if (result.rowCount === 0) throw new NotFoundException("Org unit not found");
  }

  private async mustExistCostCenter(client: PoolClient, companyId: string, costCenterId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM cost_centers WHERE id = $1 AND company_id = $2", [
      costCenterId,
      companyId,
    ]);
    if (result.rowCount === 0) throw new NotFoundException("Cost center not found");
  }

  private async mustExistProfitCenter(client: PoolClient, companyId: string, profitCenterId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM profit_centers WHERE id = $1 AND company_id = $2", [
      profitCenterId,
      companyId,
    ]);
    if (result.rowCount === 0) throw new NotFoundException("Profit center not found");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view positions");
    }
  }

  /**
   * Organization Management Phase 11 (Section 19) — scope-aware sibling
   * of `requireView()`. Two independent dimensions instead of one: an
   * org-unit assignment (expanded to subtree, via this method's own
   * inline recursive CTE — the same duplication `OrgChangesService.
   * analyzeImpact()` already established rather than injecting
   * `OrgUnitsService` here just for this one query) and a cost-center
   * assignment (used flat, Cost Center has no hierarchy). `list()`/`get()`
   * treat a position as visible if it matches EITHER dimension the caller
   * holds assignments for.
   */
  private async resolveViewAccess(
    claims: RequestClaims
  ): Promise<{ unrestricted: boolean; orgUnitIds: string[]; costCenterIds: string[] }> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const [canView, canManage] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
    ]);
    if (canView || canManage) {
      return { unrestricted: true, orgUnitIds: [], costCenterIds: [] };
    }
    if (!(await this.rbac.hasScopedPermission(claims, SCOPED_VIEW_PERMISSION_BASE))) {
      throw new ForbiddenException("Not permitted to view positions");
    }
    const [assignedOrgUnitIds, costCenterIds] = await Promise.all([
      this.rbac.resolveDataScopeEntityIds(claims, "org_unit"),
      this.rbac.resolveDataScopeEntityIds(claims, "cost_center"),
    ]);
    const orgUnitIds = await this.expandOrgUnitIdsToSubtree(claims, assignedOrgUnitIds);
    return { unrestricted: false, orgUnitIds, costCenterIds };
  }

  /** Every assigned org-unit id plus all of its descendants — exactly
   * `OrgUnitsService.expandToSubtreeIds()`'s own shape, duplicated here
   * rather than injected (see `resolveViewAccess()`'s own doc comment). */
  private async expandOrgUnitIdsToSubtree(claims: RequestClaims, rootIds: string[]): Promise<string[]> {
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
        const descendants = await client.query<{ id: string }>(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM org_units WHERE company_id = $1 AND id = $2
             UNION ALL
             SELECT ou.id FROM org_units ou JOIN subtree s ON ou.parent_id = s.id WHERE ou.company_id = $1
           )
           SELECT id FROM subtree WHERE id != $2`,
          [claims.company_id, rootId]
        );
        for (const row of descendants.rows) ids.add(row.id);
      }
      return Array.from(ids);
    });
  }

  /**
   * Cross-module integration audit (2026-10-01), gap #3/#7 — write-side
   * sibling of `resolveViewAccess()`. `.manage.all` wins outright
   * (unrestricted, exactly today's behavior); otherwise a caller holding
   * only `position.manage.scoped` gets back their assigned org-unit
   * subtree and cost-center ids, to be checked against the SPECIFIC
   * position being written by `assertInManageScope()` below; otherwise
   * (neither) throws — same fail-closed posture as the view side.
   */
  private async resolveManageAccess(
    claims: RequestClaims
  ): Promise<{ unrestricted: boolean; orgUnitIds: string[]; costCenterIds: string[] }> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (await this.rbac.can(claims, MANAGE_PERMISSION)) {
      return { unrestricted: true, orgUnitIds: [], costCenterIds: [] };
    }
    if (!(await this.rbac.hasScopedPermission(claims, SCOPED_MANAGE_PERMISSION_BASE))) {
      throw new ForbiddenException("Not permitted to manage positions");
    }
    const [assignedOrgUnitIds, costCenterIds] = await Promise.all([
      this.rbac.resolveDataScopeEntityIds(claims, "org_unit"),
      this.rbac.resolveDataScopeEntityIds(claims, "cost_center"),
    ]);
    const orgUnitIds = await this.expandOrgUnitIdsToSubtree(claims, assignedOrgUnitIds);
    return { unrestricted: false, orgUnitIds, costCenterIds };
  }

  /** Throws unless `record` (the position's CURRENT, or a write's
   * PROPOSED, org unit / cost center) falls inside `scope` — called once
   * for the existing row and, when a write would change either field,
   * once more for the new values, so a scoped caller can neither touch a
   * position outside their region nor move one into/out of it. */
  private assertInManageScope(
    scope: { unrestricted: boolean; orgUnitIds: string[]; costCenterIds: string[] },
    record: { org_unit_id: string | null; cost_center_id: string | null }
  ): void {
    if (scope.unrestricted) return;
    const inOrgUnit = Boolean(record.org_unit_id) && scope.orgUnitIds.includes(record.org_unit_id as string);
    const inCostCenter = Boolean(record.cost_center_id) && scope.costCenterIds.includes(record.cost_center_id as string);
    if (!inOrgUnit && !inCostCenter) {
      throw new ForbiddenException("Position is outside your assigned data scope");
    }
  }
}
