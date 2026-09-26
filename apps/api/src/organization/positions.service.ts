import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
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

type PositionRow = {
  id: string;
  company_id: string;
  org_unit_id: string;
  job_id: string | null;
  position_code: string | null;
  position_title: string;
  headcount_fte: string; // numeric comes back as a driver string
  status: string;
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
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  async create(claims: RequestClaims, input: CreatePositionRequest): Promise<PositionView> {
    await this.requireManage(claims);
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

      const headcountFte = input.headcountFte ?? 1.0;
      const inserted = await client.query(
        `INSERT INTO positions (company_id, org_unit_id, job_id, position_code, position_title, headcount_fte, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'vacant') RETURNING *`,
        [claims.company_id, input.orgUnitId, input.jobId ?? null, input.positionCode ?? null, title, headcountFte]
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
        },
        effectiveFrom: input.effectiveFrom,
      });

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position.create",
        target: position.id,
        metadata: { orgUnitId: input.orgUnitId, jobId: input.jobId ?? null, positionTitle: title },
      });

      return rowToPosition(position);
    });
  }

  /** Every position in the tenant, optionally filtered by status/org
   * unit — the raw material the Position Workbench's list view renders
   * from. */
  async list(claims: RequestClaims, filters: PositionListFilters = {}): Promise<PositionView[]> {
    await this.requireView(claims);
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
      const result = await client.query(
        `SELECT * FROM positions WHERE ${conditions.join(" AND ")} ORDER BY position_title`,
        values
      );
      return result.rows.map(rowToPosition);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<PositionView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToPosition(await this.mustExist(client, id)));
  }

  /** Retitle/recode/reassign-job/reparent-org-unit/adjust-headcount in
   * place — status transitions are their own dedicated actions below. */
  async update(claims: RequestClaims, id: string, patch: UpdatePositionRequest): Promise<PositionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);

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
      };

      const position = await this.applyVersionAndSync(client, claims, id, next, patch.effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position.update",
        target: id,
        metadata: { before: rowToPosition(before), after: rowToPosition(position) },
      });

      return rowToPosition(position);
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
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const before = await this.mustExist(client, id);
      const nextStatus = next(before.status as PositionStatus);

      const data = {
        org_unit_id: before.org_unit_id,
        job_id: before.job_id,
        position_code: before.position_code,
        position_title: before.position_title,
        headcount_fte: Number(before.headcount_fte),
        status: nextStatus,
      };
      const position = await this.applyVersionAndSync(client, claims, id, data);

      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action, target: id });

      return rowToPosition(position);
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
   */
  async assignEmployee(claims: RequestClaims, positionId: string, employeeId: string, effectiveFrom?: string): Promise<PositionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const position = await this.mustExist(client, positionId);
      if (position.status !== "vacant") {
        throw new ConflictException(`Position is ${position.status}, not vacant — it cannot be assigned`);
      }

      const employeeResult = await client.query<{ id: string; position_id: string | null }>(
        "SELECT id, position_id FROM employees WHERE id = $1 AND company_id = $2",
        [employeeId, claims.company_id]
      );
      if (employeeResult.rowCount === 0) throw new NotFoundException("Employee not found");
      const employee = employeeResult.rows[0];

      if (employee.position_id && employee.position_id !== positionId) {
        await this.vacate(client, claims, employee.position_id, effectiveFrom);
      }

      await client.query("UPDATE employees SET position_id = $2, updated_at = now() WHERE id = $1", [
        employeeId,
        positionId,
      ]);

      const updated = await this.applyVersionAndSync(
        client,
        claims,
        positionId,
        {
          org_unit_id: position.org_unit_id,
          job_id: position.job_id,
          position_code: position.position_code,
          position_title: position.position_title,
          headcount_fte: Number(position.headcount_fte),
          status: "filled",
        },
        effectiveFrom
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position.assign",
        target: positionId,
        metadata: { employeeId },
      });

      return rowToPosition(updated);
    });
  }

  /** Unassign whoever currently occupies this position (if anyone) and
   * flip it back to `vacant`. A no-op (returns the position unchanged) if
   * it wasn't `filled` to begin with — unassigning an already-vacant
   * position isn't an error, the same "setStatus is a no-op if already
   * there" posture OrgUnitsService.setStatus() takes. */
  async unassignEmployee(claims: RequestClaims, positionId: string, effectiveFrom?: string): Promise<PositionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const position = await this.mustExist(client, positionId);
      if (position.status !== "filled") {
        return rowToPosition(position);
      }
      const updated = await this.vacate(client, claims, positionId, effectiveFrom);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "position.unassign",
        target: positionId,
      });

      return rowToPosition(updated);
    });
  }

  /** Shared by unassignEmployee() and assignEmployee()'s "moving to a new
   * seat vacates the old one" side effect — clears every employee row
   * pointing at this position (defensive: the application only ever lets
   * one at a time via assignEmployee()'s own vacant-check, but this
   * doesn't rely on that never being violated) and flips the position to
   * `vacant`. */
  private async vacate(
    client: PoolClient,
    claims: RequestClaims,
    positionId: string,
    effectiveFrom?: string
  ): Promise<Record<string, unknown>> {
    await client.query("UPDATE employees SET position_id = NULL, updated_at = now() WHERE position_id = $1", [
      positionId,
    ]);
    const before = await this.mustExist(client, positionId);
    return this.applyVersionAndSync(
      client,
      claims,
      positionId,
      {
        org_unit_id: before.org_unit_id,
        job_id: before.job_id,
        position_code: before.position_code,
        position_title: before.position_title,
        headcount_fte: Number(before.headcount_fte),
        status: "vacant",
      },
      effectiveFrom
    );
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

  /** Shared by update()/transitionStatus()/assignEmployee()/vacate():
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
         headcount_fte = $6, status = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, data.org_unit_id, data.job_id, data.position_code, data.position_title, data.headcount_fte, data.status]
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

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage positions");
    }
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
}
