import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { EmployeesService } from "../employees/employees.service";
import { OrgRelationshipsService } from "./org-relationships.service";
import type {
  EmployeeView,
  LegacyReconciliationEmployeeView,
  LegacyReconciliationGap,
  LegacyReconciliationReport,
  LegacyReconciliationSuggestion,
} from "@aihxm/shared-types";

// Gated on the same permission `EmployeesService.update()` itself
// requires — see this class's own header comment for why a separate,
// narrower permission was deliberately NOT introduced for this tool.
const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";

type GapRow = {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  org_unit_id: string | null;
  location: string | null;
  location_id: string | null;
  manager_id: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  manager_gap: boolean;
};

type NameCandidate = { id: string; name: string };

/**
 * Organization Management Phase 12 (Unified Integration & Synchronization
 * Requirements, Section 24 — Legacy Data Migration). Builds directly on
 * Phase 8's `OrganizationCommandCenterService.legacy_records_not_mapped`
 * warning (see that class's own header comment): that warning is a
 * COUNT ONLY, explicitly left as "this report's read-only first half; the
 * actual backfill tool is Phase 12's own scope" — this service is that
 * second half, both the actual per-employee report (`getReport()`) and
 * the three actions that close each of the three gap types it finds
 * (`linkOrgUnit()` / `linkLocation()` / `linkManagerRelationship()`).
 *
 * SAME DETECTION QUERY AS PHASE 8, ON PURPOSE — `getReport()`'s WHERE
 * clause is character-for-character the same predicate
 * `OrganizationCommandCenterService`'s own `legacyRecordsNotMapped` count
 * query already uses (active/non-terminated employee; `department` set
 * with no `orgUnitId`; OR `location` set with no `locationId`; OR
 * `managerId` set with no open `direct` `org_relationships` row). Keeping
 * these in sync means the dashboard's warning count and this report's own
 * row count can never silently drift apart into two different ideas of
 * "not mapped." If a future change to what counts as "not mapped" is
 * ever needed, both queries should change together.
 *
 * NO NEW BACKFILL LOGIC — every write here is a thin, validating
 * delegation to a service that already owns the actual mutation, its own
 * RBAC gate, and its own audit trail:
 *   - `linkOrgUnit()` calls `EmployeesService.update(claims, id,
 *     { orgUnitId })` — `department` is then DERIVED from the unit's
 *     current name by that service's own already-existing
 *     `resolveDepartment()`, exactly as if an admin had edited the
 *     employee's org unit by hand on the regular Employee screen.
 *   - `linkLocation()` is the same, calling `update()` with
 *     `{ locationId }` (derives `location` via `resolveLocation()`).
 *   - `linkManagerRelationship()` calls
 *     `OrgRelationshipsService.create(claims, { employeeId,
 *     managerEmployeeId, relationshipType: "direct" })` using the
 *     `managerId` legacy field already has — there is nothing to choose
 *     here (see `LegacyReconciliationGap`'s own doc comment in
 *     shared-types), only a missing typed record to create.
 * This mirrors the "no second permission framework" / "reuse the
 * existing engine" posture every prior phase of this initiative has
 * followed: this service invents no new mutation path, it only finds
 * records that need one of three already-existing ones applied, and lets
 * each existing service's own validation (existence checks, cycle
 * detection, conflict handling) run exactly as it would from its own
 * normal screen.
 *
 * GATING — deliberately `employee.manage.all` alone, not a new
 * `legacy_reconciliation.*` permission key and not also requiring
 * `org_relationship.manage.all` up front: every row this report surfaces
 * is actionable by *at least* a department or location fix (both gated on
 * `employee.manage.all`), so that's the permission that decides whether
 * this screen is visible at all; `linkManagerRelationship()`'s own call
 * into `OrgRelationshipsService.create()` still separately enforces
 * `org_relationship.manage.all` at the point of that specific action, so
 * a caller who holds `employee.manage.all` but not
 * `org_relationship.manage.all` sees the report and can fix
 * department/location gaps, but gets a `ForbiddenException` on that one
 * action — least-privilege at the point of mutation, exactly like every
 * other layered permission check in this codebase, not duplicated or
 * loosened here.
 *
 * MATCHING IS SUGGEST-ONLY — `suggestMatches()` never applies anything
 * itself; it only ranks existing org units/locations against the legacy
 * free text so an admin has somewhere to start. See
 * `LegacyReconciliationSuggestion`'s own doc comment in shared-types for
 * why this is a plain trim+lowercase equality/substring heuristic rather
 * than a `pg_trgm` dependency this codebase has never taken elsewhere.
 */
@Injectable()
export class LegacyReconciliationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly rbac: RbacService,
    private readonly employees: EmployeesService,
    private readonly orgRelationships: OrgRelationshipsService
  ) {}

  async getReport(claims: RequestClaims): Promise<LegacyReconciliationReport> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id;

      const [gapRows, orgUnitCandidates, locationCandidates] = await Promise.all([
        client.query<GapRow>(
          `SELECT e.id, e.employee_number, e.first_name, e.last_name,
                  e.department, e.org_unit_id, e.location, e.location_id, e.manager_id,
                  mgr.first_name AS manager_first_name, mgr.last_name AS manager_last_name,
                  (e.manager_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM org_relationships r
                    WHERE r.employee_id = e.id AND r.relationship_type = 'direct' AND r.status = 'active'
                  )) AS manager_gap
           FROM employees e
           LEFT JOIN employees mgr ON mgr.id = e.manager_id
           WHERE e.company_id = $1 AND e.employment_status <> 'terminated'
           AND (
             (e.department IS NOT NULL AND e.department <> '' AND e.org_unit_id IS NULL)
             OR (e.location IS NOT NULL AND e.location <> '' AND e.location_id IS NULL)
             OR (
               e.manager_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM org_relationships r
                 WHERE r.employee_id = e.id AND r.relationship_type = 'direct' AND r.status = 'active'
               )
             )
           )
           ORDER BY e.employee_number`,
          [companyId]
        ),
        client.query<NameCandidate>(
          `SELECT id, name FROM org_units WHERE company_id = $1 AND status <> 'archived'`,
          [companyId]
        ),
        client.query<NameCandidate>(
          `SELECT id, name FROM locations WHERE company_id = $1 AND status <> 'archived'`,
          [companyId]
        ),
      ]);

      const employeesOut: LegacyReconciliationEmployeeView[] = gapRows.rows.map((row) => ({
        employeeId: row.id,
        employeeNumber: row.employee_number,
        fullName: `${row.first_name} ${row.last_name}`,
        gaps: buildGaps(row, orgUnitCandidates.rows, locationCandidates.rows),
      }));

      return {
        generatedAt: new Date().toISOString(),
        totalAffectedEmployees: employeesOut.length,
        employees: employeesOut,
      };
    });
  }

  /** Links this employee to `orgUnitId` via `EmployeesService.update()`
   * (which derives `department` from the unit's own name) — guarded so
   * this reconciliation-only action can't be used as a back door to
   * re-point an employee who is already linked to a different org unit
   * (use the regular Employee edit screen for that). */
  async linkOrgUnit(claims: RequestClaims, employeeId: string, orgUnitId: string): Promise<EmployeeView> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const employee = await this.mustExistEmployee(client, claims.company_id!, employeeId);
      if (employee.org_unit_id) {
        throw new BadRequestException(
          "This employee is already linked to an org unit — use the Employee edit screen to change it"
        );
      }
    });
    return this.employees.update(claims, employeeId, { orgUnitId });
  }

  /** The location-side mirror of `linkOrgUnit()` — see that method's own
   * doc comment. */
  async linkLocation(claims: RequestClaims, employeeId: string, locationId: string): Promise<EmployeeView> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const employee = await this.mustExistEmployee(client, claims.company_id!, employeeId);
      if (employee.location_id) {
        throw new BadRequestException(
          "This employee is already linked to a location — use the Employee edit screen to change it"
        );
      }
    });
    return this.employees.update(claims, employeeId, { locationId });
  }

  /** Creates the missing typed `direct` `org_relationships` row from this
   * employee's already-known legacy `managerId` — see this class's own
   * header comment for why there is nothing to choose here, unlike
   * `linkOrgUnit()`/`linkLocation()`. `OrgRelationshipsService.create()`
   * runs its own existence/self-management/cycle/conflict checks exactly
   * as it would from its own normal screen. */
  async linkManagerRelationship(claims: RequestClaims, employeeId: string): Promise<void> {
    await this.requireManage(claims);
    const managerId = await this.db.withClaims(claims, async (client) => {
      const employee = await this.mustExistEmployee(client, claims.company_id!, employeeId);
      if (!employee.manager_id) {
        throw new BadRequestException("This employee has no legacy manager to reconcile");
      }
      return employee.manager_id;
    });
    await this.orgRelationships.create(claims, {
      employeeId,
      managerEmployeeId: managerId,
      relationshipType: "direct",
    });
  }

  private async mustExistEmployee(client: PoolClient, companyId: string, employeeId: string): Promise<GapRow> {
    const result = await client.query<GapRow>(
      `SELECT id, employee_number, first_name, last_name, department, org_unit_id, location, location_id, manager_id,
              NULL AS manager_first_name, NULL AS manager_last_name, false AS manager_gap
       FROM employees WHERE id = $1 AND company_id = $2`,
      [employeeId, companyId]
    );
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage legacy data reconciliation");
    }
  }
}

/** One employee row -> its list of gaps (0-3). */
function buildGaps(
  row: GapRow,
  orgUnitCandidates: NameCandidate[],
  locationCandidates: NameCandidate[]
): LegacyReconciliationGap[] {
  const gaps: LegacyReconciliationGap[] = [];

  if (row.department && row.department !== "" && !row.org_unit_id) {
    gaps.push({ gapType: "department", legacyValue: row.department, suggestions: suggestMatches(row.department, orgUnitCandidates) });
  }
  if (row.location && row.location !== "" && !row.location_id) {
    gaps.push({ gapType: "location", legacyValue: row.location, suggestions: suggestMatches(row.location, locationCandidates) });
  }
  if (row.manager_id && row.manager_gap) {
    gaps.push({
      gapType: "manager",
      legacyValue: `${row.manager_first_name ?? ""} ${row.manager_last_name ?? ""}`.trim(),
      managerEmployeeId: row.manager_id,
    });
  }
  return gaps;
}

/**
 * Two-tier, dependency-free candidate match: `"exact"` when the free text
 * equals a candidate's name once both are trimmed and lowercased,
 * else `"fuzzy"` for a substring match either direction under the same
 * normalization, capped at 5 results. Returns an empty array (not an
 * error) when nothing matches at all — that's a legitimate outcome (the
 * canonical org unit/location for this legacy text may not exist yet),
 * and the report still surfaces the gap so an admin can create it first.
 */
function suggestMatches(legacyText: string, candidates: NameCandidate[]): LegacyReconciliationSuggestion[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const target = norm(legacyText);
  if (!target) return [];

  const exact = candidates.filter((c) => norm(c.name) === target);
  if (exact.length > 0) {
    return exact.slice(0, 5).map((c) => ({ id: c.id, name: c.name, matchType: "exact" as const }));
  }

  const fuzzy = candidates.filter((c) => {
    const n = norm(c.name);
    return n.length > 0 && (n.includes(target) || target.includes(n));
  });
  return fuzzy.slice(0, 5).map((c) => ({ id: c.id, name: c.name, matchType: "fuzzy" as const }));
}
