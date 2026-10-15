import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { LegacyReconciliationService } from "./legacy-reconciliation.service";
import { OrgOccupancyService } from "./occupancy/org-occupancy.service";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

export type ReconciliationOutcome = "applied" | "would_apply" | "unresolved" | "failed";
export type BackfillGapType = "department" | "location" | "manager" | "designation";

export type ReconciliationItemView = {
  id: string;
  runId: string;
  employeeId: string | null;
  gapType: string;
  legacyValue: string | null;
  outcome: ReconciliationOutcome;
  reason: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type ReconciliationRunView = {
  id: string;
  kind: "legacy_backfill" | "projection_drift";
  dryRun: boolean;
  status: "running" | "completed" | "failed";
  counts: Record<string, number>;
  startedAt: string;
  completedAt: string | null;
  startedByUserAccountId: string | null;
};

type PendingItem = {
  employeeId: string | null;
  gapType: string;
  legacyValue: string | null;
  outcome: ReconciliationOutcome;
  reason?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRun(r: any): ReconciliationRunView {
  return {
    id: r.id,
    kind: r.kind,
    dryRun: r.dry_run,
    status: r.status,
    counts: r.counts ?? {},
    startedAt: new Date(r.started_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    startedByUserAccountId: r.started_by_user_account_id ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toItem(r: any): ReconciliationItemView {
  return {
    id: r.id,
    runId: r.run_id,
    employeeId: r.employee_id,
    gapType: r.gap_type,
    legacyValue: r.legacy_value,
    outcome: r.outcome,
    reason: r.reason,
    targetId: r.target_id,
    details: r.details ?? {},
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function tally(items: PendingItem[]): Record<string, number> {
  const counts: Record<string, number> = { total: items.length };
  for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
  return counts;
}

/**
 * Gap Register ORG-09 + ORG-03 (Step 7). Two corrective tools on top of the Phase 12
 * report, both default to a DRY RUN and both write a durable run + per-record log:
 *
 *  - runLegacyBackfill: closes legacy free-text gaps (department / location /
 *    designation / manager) ONLY where the match is unambiguous - exactly one exact
 *    (trim + case-insensitive) candidate. Everything else is written to the
 *    unresolved-mapping log with the reason (no candidate / ambiguous / fuzzy only), so
 *    an admin can drill down from the warning count to each record. Every applied change
 *    goes through the same services an admin would use by hand (EmployeesService.update,
 *    OrgRelationshipsService.create, PositionsService.assignEmployee) via
 *    LegacyReconciliationService, so their validation and audit still run.
 *  - runDriftRepair: employees.org_unit_id / location_id / position_id are projections of
 *    the open primary assignment. Reports every disagreement and, on request, repairs it in
 *    the direction the admin chooses (`prefer: assignment | employee`). Position
 *    disagreements are never guessed: they go to the log as unresolved unless the
 *    assignment has no seat and the employee does (prefer=employee).
 */
@Injectable()
export class OrgReconciliationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly legacy: LegacyReconciliationService,
    private readonly occupancy: OrgOccupancyService
  ) {}

  // -------------------------------------------------------------- legacy backfill
  async runLegacyBackfill(
    claims: RequestClaims,
    opts: { dryRun?: boolean; gapTypes?: BackfillGapType[]; limit?: number } = {}
  ): Promise<{ run: ReconciliationRunView; items: ReconciliationItemView[] }> {
    await this.requireManage(claims);
    const dryRun = opts.dryRun !== false;
    const limit = this.clampLimit(opts.limit);
    const wanted = new Set<BackfillGapType>(opts.gapTypes?.length ? opts.gapTypes : ["department", "location", "manager", "designation"]);

    const report = await this.legacy.getReport(claims);
    const items: PendingItem[] = [];
    for (const employee of report.employees.slice(0, limit)) {
      for (const gap of employee.gaps) {
        if (!wanted.has(gap.gapType as BackfillGapType)) continue;
        const base = { employeeId: employee.employeeId, gapType: gap.gapType, legacyValue: gap.legacyValue ?? null };

        if (gap.gapType === "manager") {
          if (dryRun) {
            items.push({ ...base, outcome: "would_apply", targetId: gap.managerEmployeeId ?? null });
            continue;
          }
          try {
            await this.legacy.linkManagerRelationship(claims, employee.employeeId);
            items.push({ ...base, outcome: "applied", targetId: gap.managerEmployeeId ?? null });
          } catch (err) {
            items.push({ ...base, outcome: "failed", reason: errorMessage(err), targetId: gap.managerEmployeeId ?? null });
          }
          continue;
        }

        const suggestions = gap.suggestions ?? [];
        const exact = suggestions.filter((s) => s.matchType === "exact");
        if (exact.length !== 1) {
          items.push({
            ...base,
            outcome: "unresolved",
            reason: exact.length > 1 ? "ambiguous: several exact matches" : suggestions.length > 0 ? "fuzzy match only - needs a person to confirm" : "no matching candidate exists",
            details: { suggestions },
          });
          continue;
        }
        const target = exact[0];
        if (dryRun) {
          items.push({ ...base, outcome: "would_apply", targetId: target.id, details: { target: target.name } });
          continue;
        }
        try {
          if (gap.gapType === "department") await this.legacy.linkOrgUnit(claims, employee.employeeId, target.id);
          else if (gap.gapType === "location") await this.legacy.linkLocation(claims, employee.employeeId, target.id);
          else await this.legacy.linkPosition(claims, employee.employeeId, target.id);
          items.push({ ...base, outcome: "applied", targetId: target.id, details: { target: target.name } });
        } catch (err) {
          items.push({ ...base, outcome: "failed", reason: errorMessage(err), targetId: target.id });
        }
      }
    }
    return this.recordRun(claims, "legacy_backfill", dryRun, items, {
      truncated: report.employees.length > limit ? report.employees.length - limit : 0,
    });
  }

  // -------------------------------------------------------------- projection drift (ORG-03)
  async runDriftRepair(
    claims: RequestClaims,
    opts: { dryRun?: boolean; prefer?: "assignment" | "employee"; limit?: number } = {}
  ): Promise<{ run: ReconciliationRunView; items: ReconciliationItemView[] }> {
    await this.requireManage(claims);
    const dryRun = opts.dryRun !== false;
    const prefer = opts.prefer ?? "assignment";
    if (prefer !== "assignment" && prefer !== "employee") throw new BadRequestException("prefer must be 'assignment' or 'employee'");
    const limit = this.clampLimit(opts.limit);

    const rows = await this.db.withClaims(claims, async (client) => {
      const drift = await client.query(
        `SELECT e.id, e.org_unit_id AS e_unit, e.location_id AS e_loc, e.position_id AS e_pos,
                a.org_unit_id AS a_unit, a.location_id AS a_loc, a.position_id AS a_pos, (a.id IS NULL) AS no_assignment
           FROM employees e
           LEFT JOIN employee_org_assignments a ON a.employee_id = e.id AND a.assignment_type = 'primary' AND a.status = 'active'
          WHERE e.company_id = $1 AND e.employment_status <> 'terminated'
            AND (
              (a.id IS NULL AND e.org_unit_id IS NOT NULL)
              OR (a.id IS NOT NULL AND (e.org_unit_id IS DISTINCT FROM a.org_unit_id
                                        OR e.location_id IS DISTINCT FROM a.location_id
                                        OR e.position_id IS DISTINCT FROM a.position_id))
            )
          ORDER BY e.employee_number
          LIMIT $2`,
        [claims.company_id, limit]
      );
      return drift.rows;
    });

    const items: PendingItem[] = [];
    for (const r of rows) {
      const detail = { employee: { orgUnitId: r.e_unit, locationId: r.e_loc, positionId: r.e_pos }, assignment: r.no_assignment ? null : { orgUnitId: r.a_unit, locationId: r.a_loc, positionId: r.a_pos } };
      const unitOrLocDiffers = !r.no_assignment && (r.e_unit !== r.a_unit || (r.e_loc ?? null) !== (r.a_loc ?? null));
      const posDiffers = !r.no_assignment && (r.e_pos ?? null) !== (r.a_pos ?? null);

      if (r.no_assignment) {
        items.push(await this.applyOrPlan(claims, dryRun, { employeeId: r.id, gapType: "missing_primary_assignment", legacyValue: null, outcome: "would_apply", details: detail }, () =>
          this.syncAssignmentFromEmployee(claims, r.id, r.e_unit, r.e_loc)
        ));
        continue;
      }

      // position disagreement is never guessed
      const seatOnlyOnEmployee = posDiffers && r.a_pos === null && r.e_pos !== null && prefer === "employee";
      if (posDiffers && !seatOnlyOnEmployee) {
        items.push({ employeeId: r.id, gapType: "position_mismatch", legacyValue: null, outcome: "unresolved", reason: "the seat on the employee and on the primary assignment differ - review in the Position Workbench", details: detail });
        if (!unitOrLocDiffers) continue;
      }
      if (unitOrLocDiffers || seatOnlyOnEmployee) {
        if (prefer === "assignment") {
          items.push(await this.applyOrPlan(claims, dryRun, { employeeId: r.id, gapType: "projection_drift", legacyValue: null, outcome: "would_apply", reason: "employee columns set from the primary assignment", targetId: r.a_unit, details: detail }, () =>
            this.projectAssignmentOntoEmployee(claims, r.id, r.a_unit, r.a_loc)
          ));
        } else {
          items.push(await this.applyOrPlan(claims, dryRun, { employeeId: r.id, gapType: "projection_drift", legacyValue: null, outcome: "would_apply", reason: "primary assignment re-opened from the employee columns", targetId: r.e_unit, details: detail }, () =>
            this.syncAssignmentFromEmployee(claims, r.id, r.e_unit, r.e_loc)
          ));
        }
      }
    }
    return this.recordRun(claims, "projection_drift", dryRun, items, { prefer: prefer === "assignment" ? 1 : 2 });
  }

  private async applyOrPlan(claims: RequestClaims, dryRun: boolean, planned: PendingItem, apply: () => Promise<void>): Promise<PendingItem> {
    if (dryRun) return planned;
    try {
      await apply();
      return { ...planned, outcome: "applied" };
    } catch (err) {
      return { ...planned, outcome: "failed", reason: errorMessage(err) };
    }
  }

  private async syncAssignmentFromEmployee(claims: RequestClaims, employeeId: string, orgUnitId: string | null, locationId: string | null): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      await this.occupancy.syncPrimaryAssignmentWithinTransaction(client, claims, employeeId, { orgUnitId, locationId, source: "org_reconciliation" });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "org_reconciliation.assignment_from_employee", target: employeeId, metadata: { orgUnitId, locationId } });
    });
  }

  private async projectAssignmentOntoEmployee(claims: RequestClaims, employeeId: string, orgUnitId: string, locationId: string | null): Promise<void> {
    await this.db.withClaims(claims, async (client) => {
      await client.query(
        `UPDATE employees e
            SET org_unit_id = $2,
                department = (SELECT name FROM org_units WHERE id = $2),
                location_id = $3,
                location = COALESCE((SELECT name FROM locations WHERE id = $3), CASE WHEN $3::uuid IS NULL THEN NULL ELSE e.location END),
                updated_at = now()
          WHERE e.id = $1 AND e.company_id = $4`,
        [employeeId, orgUnitId, locationId, claims.company_id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "org_reconciliation.employee_from_assignment", target: employeeId, metadata: { orgUnitId, locationId } });
    });
  }

  // -------------------------------------------------------------- reading the log
  async listRuns(claims: RequestClaims, limit = 20): Promise<ReconciliationRunView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM org_reconciliation_runs WHERE company_id = $1 ORDER BY started_at DESC LIMIT $2", [claims.company_id, Math.min(Math.max(limit, 1), 100)]);
      return r.rows.map(toRun);
    });
  }

  async getRun(claims: RequestClaims, runId: string, outcome?: ReconciliationOutcome): Promise<{ run: ReconciliationRunView; items: ReconciliationItemView[] }> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await client.query("SELECT * FROM org_reconciliation_runs WHERE id = $1 AND company_id = $2", [runId, claims.company_id]);
      if (!run.rowCount) throw new NotFoundException("Reconciliation run not found");
      const items = await client.query(
        `SELECT * FROM org_reconciliation_items WHERE run_id = $1 AND ($2::text IS NULL OR outcome = $2) ORDER BY created_at, id LIMIT 5000`,
        [runId, outcome ?? null]
      );
      return { run: toRun(run.rows[0]), items: items.rows.map(toItem) };
    });
  }

  /** The unresolved-mapping log across runs: the latest unresolved entry per employee and gap type. */
  async listUnresolved(claims: RequestClaims, gapType?: string): Promise<ReconciliationItemView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT DISTINCT ON (employee_id, gap_type) *
           FROM org_reconciliation_items
          WHERE company_id = $1 AND outcome = 'unresolved' AND ($2::text IS NULL OR gap_type = $2)
          ORDER BY employee_id, gap_type, created_at DESC
          LIMIT 5000`,
        [claims.company_id, gapType ?? null]
      );
      return r.rows.map(toItem);
    });
  }

  // -------------------------------------------------------------- internals
  private async recordRun(
    claims: RequestClaims,
    kind: "legacy_backfill" | "projection_drift",
    dryRun: boolean,
    items: PendingItem[],
    extraCounts: Record<string, number>
  ): Promise<{ run: ReconciliationRunView; items: ReconciliationItemView[] }> {
    return this.db.withClaims(claims, async (client: PoolClient) => {
      const run = await client.query(
        `INSERT INTO org_reconciliation_runs (company_id, kind, dry_run, status, started_by_user_account_id, counts, completed_at)
         VALUES ($1, $2, $3, 'completed', $4, $5::jsonb, now()) RETURNING *`,
        [claims.company_id, kind, dryRun, /^[0-9a-f-]{36}$/i.test(claims.sub ?? "") ? claims.sub : null, JSON.stringify({ ...tally(items), ...extraCounts })]
      );
      const saved: ReconciliationItemView[] = [];
      for (const i of items) {
        const row = await client.query(
          `INSERT INTO org_reconciliation_items (run_id, company_id, employee_id, gap_type, legacy_value, outcome, reason, target_id, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`,
          [run.rows[0].id, claims.company_id, i.employeeId, i.gapType, i.legacyValue, i.outcome, i.reason ?? null, i.targetId ?? null, JSON.stringify(i.details ?? {})]
        );
        saved.push(toItem(row.rows[0]));
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: `org_reconciliation.${kind}`,
        target: run.rows[0].id,
        metadata: { dryRun, ...tally(items) },
      });
      return { run: toRun(run.rows[0]), items: saved };
    });
  }

  private clampLimit(limit?: number): number {
    if (limit === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new BadRequestException("limit must be a positive integer");
    return Math.min(limit, MAX_LIMIT);
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to run organization reconciliation");
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
