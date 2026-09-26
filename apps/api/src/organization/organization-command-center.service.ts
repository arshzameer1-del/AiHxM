import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { OrgUnitsService } from "./org-units.service";
import { PositionsService } from "./positions.service";
import { EmployeeOrgAssignmentsService } from "./employee-org-assignments.service";
import { OrgChangesService } from "./org-changes.service";
import { LocationsService } from "./locations.service";
import { CostCentersService } from "./cost-centers.service";
import { ProfitCentersService } from "./profit-centers.service";
import type { OrganizationCommandCenterSummary, OrganizationIntegrityWarning } from "@aihxm/shared-types";

const IN_FLIGHT_STATUSES = new Set(["draft", "validated", "pending_approval", "approved"]);

/**
 * Organization Management, Phase 6 — the "scoped Organization Command
 * Center panel" the roadmap calls for, reusing the exact Dashboard-panel
 * pattern already proven for Tenant Management's own Platform Health
 * panel (`HealthService.getPlatformSummary()` -> `DashboardPage.tsx`'s
 * "Platform Health" card): one small, read-only aggregation service
 * behind one endpoint, rendered as one card, not the full eleven-
 * workspace enterprise suite (Organization Command Center, Hierarchy
 * Explorer, Organization Designer, ... the master instruction names) —
 * that fuller suite is explicitly deferred per this initiative's own
 * scoping decision (see the roadmap doc's "Recommend deferring" section).
 *
 * Deliberately NOT a new data store, same discipline
 * `ConfigurationCenterService` already established for its own summary:
 * every count here comes from calling an existing service's own
 * already-gated `list()` method with the caller's real claims, never a
 * duplicated SQL query against those tables directly. Unlike
 * `ConfigurationCenterService`'s per-card "no access -> omit that card"
 * degrade, this is one glance panel, not a list of independent cards, so
 * a caller without `org_unit.view.all` simply can't see the panel at all
 * (whatever `OrgUnitsService.list()` itself throws propagates unchanged).
 *
 * Phase 8 (Unified Integration & Synchronization Requirements, Section
 * 25 — "Organization Integrity Dashboard") extends this same panel with
 * `totalLocations`/`totalCostCenters`/`totalProfitCenters` (three more
 * counts Section 25's own mockup names, composed the same
 * already-gated-`list()`-call way as everything above) and
 * `integrityWarnings`/`dataQualityIssues` — the seven data-quality checks
 * that section also asks for. Those seven are a deliberate, documented
 * EXCEPTION to the "always compose from an existing service's `list()`"
 * rule above: no existing service exposes "employees with no primary
 * assignment" or "assignments pointing at an archived org unit" as a
 * method, because these are cross-entity integrity joins, not a single
 * domain's own listing. Rather than inventing seven new public methods on
 * seven different services purely to serve one diagnostic panel, this
 * service runs its own read-only, tenant-scoped SQL directly (still
 * inside `db.withClaims(claims, ...)`, so the same RLS backstop every
 * other query in this codebase relies on still applies) — the same
 * posture `HealthService.runCheck()`'s own checks already take for
 * their own cross-cutting diagnostics. Gating is still the panel's single
 * gate: `getSummary()` still calls `orgUnits.list(claims)` first (via
 * `requireView()`), so a caller who can't see the rest of the panel can't
 * see the warnings either — no separate permission is introduced.
 *
 * Each warning's real-world meaning, and the judgment call it embeds:
 *
 * - `employees_without_primary_assignment` — an active employee with no
 *   open (`status = 'active'`) `primary`-type `employee_org_assignments`
 *   row. A brand-new hire who hasn't been assigned yet, or a data-entry
 *   gap from before Phase 3 existed.
 * - `positions_without_org_unit` — `positions.org_unit_id` has been
 *   `NOT NULL ... ON DELETE RESTRICT` since 0068 (a position IS a seat in
 *   some org unit; see that migration's own header comment), so this
 *   count is structurally always 0 today. Computed anyway, deliberately,
 *   rather than hard-coded or omitted: Section 25 names it explicitly,
 *   and a live query is a real defensive check against a future schema
 *   relaxation or an errant raw-SQL write (`OrgChangesService.execute()`
 *   already writes `org_units`/`positions` via raw SQL for its own
 *   documented reasons) ever actually producing one, rather than a count
 *   that would silently stay "correct" even if the invariant it names
 *   broke.
 * - `employees_without_reporting_line` — an active employee with no open
 *   `direct`-type `org_relationships` row. Expected, common, and NOT a
 *   bug for a company's most senior person (a CEO/founder genuinely has
 *   no manager) — this warning intentionally does not try to exclude
 *   "the top of the hierarchy" (there is no `is_root`/`org_chart_top`
 *   flag anywhere in this schema to key that off), so a healthy tenant
 *   will typically show a small nonzero count here. Documented, not
 *   silently special-cased.
 * - `invalid_expired_locations` — a `locations` row already `archived`
 *   that is still pointed at by an active employee (`employees.location_id`,
 *   for a non-terminated employee) or an open assignment
 *   (`employee_org_assignments.location_id`, `status = 'active'`). There
 *   is no separate "expiry date" concept on Location today (only
 *   `status`), so "expired" here is read as "archived but still in
 *   active use" — the real-world case this check can actually catch.
 * - `conflicting_assignments` — an active employee whose denormalized
 *   `employees.org_unit_id`/`position_id` (the legacy "current place"
 *   fields every phase before Phase 3 already wrote) disagrees with
 *   their own current OPEN `primary` `employee_org_assignments` row.
 *   This is exactly the reconciliation gap Phase 3's and Phase 4's own
 *   roadmap entries already documented and left open ("reconciling the
 *   richer multi-slot model with the plain `employees.orgUnitId`/
 *   `positionId` fields into one obviously-consistent picture is an
 *   explicit, documented gap") — this warning is what finally surfaces
 *   that drift to an admin instead of leaving it silently invisible.
 * - `orphaned_organizational_references` — three real "the reference is
 *   still there but the thing on the other end moved on" cases, summed:
 *   an OPEN assignment whose org unit is archived; an OPEN assignment
 *   whose position has been abolished; an OPEN reporting relationship
 *   whose manager has since been terminated. None of these can be a hard
 *   FK violation (every FK here is `ON DELETE RESTRICT`/`SET NULL`, and
 *   archiving/abolishing/terminating is a status flip, never a delete),
 *   which is exactly why they need a live query rather than relying on
 *   referential integrity to catch them.
 * - `legacy_records_not_mapped` — an active (non-terminated) employee who
 *   still carries legacy free-text data with no canonical ID behind it:
 *   `department` set but `org_unit_id` NULL, `location` set but
 *   `location_id` NULL, or `manager_id` set but no open `direct`
 *   `org_relationships` row exists for them. This is Section 24's own
 *   "legacy records not yet mapped to canonical IDs" case, and directly
 *   the gap Phase 7's audit flagged as having "no reconciliation report
 *   or backfill tool" — this warning is that report's first, read-only
 *   half; the actual backfill tool is Phase 12's own scope.
 */
@Injectable()
export class OrganizationCommandCenterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly orgUnits: OrgUnitsService,
    private readonly positions: PositionsService,
    private readonly assignments: EmployeeOrgAssignmentsService,
    private readonly orgChanges: OrgChangesService,
    private readonly locations: LocationsService,
    private readonly costCenters: CostCentersService,
    private readonly profitCenters: ProfitCentersService
  ) {}

  async getSummary(claims: RequestClaims): Promise<OrganizationCommandCenterSummary> {
    const [orgUnits, positions, assignments, changes, locations, costCenters, profitCenters, integrityWarnings] =
      await Promise.all([
        this.orgUnits.list(claims),
        this.positions.list(claims),
        this.assignments.list(claims),
        this.orgChanges.list(claims),
        this.locations.list(claims),
        this.costCenters.list(claims),
        this.profitCenters.list(claims),
        this.getIntegrityWarnings(claims),
      ]);

    const recentReorganizations = [...changes]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 5)
      .map((c) => ({ id: c.id, title: c.title, status: c.status, effectiveDate: c.effectiveDate, updatedAt: c.updatedAt }));

    return {
      generatedAt: new Date().toISOString(),
      totalOrgUnits: orgUnits.length,
      totalPositions: positions.length,
      vacantPositions: positions.filter((p) => p.status === "vacant").length,
      filledPositions: positions.filter((p) => p.status === "filled").length,
      frozenPositions: positions.filter((p) => p.status === "frozen").length,
      abolishedPositions: positions.filter((p) => p.status === "abolished").length,
      activeAssignments: assignments.filter((a) => a.status === "active").length,
      reorganizationsInFlight: changes.filter((c) => IN_FLIGHT_STATUSES.has(c.status)).length,
      recentReorganizations,
      totalLocations: locations.length,
      totalCostCenters: costCenters.length,
      totalProfitCenters: profitCenters.length,
      dataQualityIssues: integrityWarnings.reduce((sum, w) => sum + w.count, 0),
      integrityWarnings,
    };
  }

  /**
   * Section 25's seven data-quality warnings. Deliberately gate-free on
   * its own — `getSummary()` above is this method's only caller, and it
   * has already run `orgUnits.list(claims)` (which throws first if the
   * caller lacks `org_unit.view.all`) by the time this runs. See this
   * class's own header comment for what each of the seven checks means.
   */
  private async getIntegrityWarnings(claims: RequestClaims): Promise<OrganizationIntegrityWarning[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id;

      const [
        employeesWithoutPrimaryAssignment,
        positionsWithoutOrgUnit,
        employeesWithoutReportingLine,
        invalidExpiredLocations,
        conflictingAssignments,
        orphanedAssignmentOrgUnits,
        orphanedAssignmentPositions,
        orphanedRelationshipManagers,
        legacyRecordsNotMapped,
      ] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS n FROM employees e
           WHERE e.company_id = $1 AND e.employment_status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM employee_org_assignments a
             WHERE a.employee_id = e.id AND a.assignment_type = 'primary' AND a.status = 'active'
           )`,
          [companyId]
        ),
        client.query(`SELECT COUNT(*)::int AS n FROM positions p WHERE p.company_id = $1 AND p.org_unit_id IS NULL`, [
          companyId,
        ]),
        client.query(
          `SELECT COUNT(*)::int AS n FROM employees e
           WHERE e.company_id = $1 AND e.employment_status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM org_relationships r
             WHERE r.employee_id = e.id AND r.relationship_type = 'direct' AND r.status = 'active'
           )`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(DISTINCT l.id)::int AS n FROM locations l
           WHERE l.company_id = $1 AND l.status = 'archived'
           AND (
             EXISTS (
               SELECT 1 FROM employees e
               WHERE e.location_id = l.id AND e.company_id = $1 AND e.employment_status <> 'terminated'
             )
             OR EXISTS (
               SELECT 1 FROM employee_org_assignments a
               WHERE a.location_id = l.id AND a.company_id = $1 AND a.status = 'active'
             )
           )`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n FROM employees e
           JOIN employee_org_assignments a
             ON a.employee_id = e.id AND a.assignment_type = 'primary' AND a.status = 'active'
           WHERE e.company_id = $1 AND e.employment_status = 'active'
           AND (e.org_unit_id IS DISTINCT FROM a.org_unit_id OR e.position_id IS DISTINCT FROM a.position_id)`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n FROM employee_org_assignments a
           JOIN org_units u ON u.id = a.org_unit_id
           WHERE a.company_id = $1 AND a.status = 'active' AND u.status = 'archived'`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n FROM employee_org_assignments a
           JOIN positions p ON p.id = a.position_id
           WHERE a.company_id = $1 AND a.status = 'active' AND p.status = 'abolished'`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n FROM org_relationships r
           JOIN employees m ON m.id = r.manager_employee_id
           WHERE r.company_id = $1 AND r.status = 'active' AND m.employment_status = 'terminated'`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS n FROM employees e
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
           )`,
          [companyId]
        ),
      ]);

      const count = (r: { rows: Array<{ n: number }> }) => r.rows[0]?.n ?? 0;

      return [
        {
          code: "employees_without_primary_assignment",
          label: "Employees without primary assignment",
          count: count(employeesWithoutPrimaryAssignment),
        },
        {
          code: "positions_without_org_unit",
          label: "Positions without Organization Unit",
          count: count(positionsWithoutOrgUnit),
        },
        {
          code: "employees_without_reporting_line",
          label: "Employees without valid reporting line",
          count: count(employeesWithoutReportingLine),
        },
        {
          code: "invalid_expired_locations",
          label: "Invalid/expired locations",
          count: count(invalidExpiredLocations),
        },
        {
          code: "conflicting_assignments",
          label: "Conflicting assignments",
          count: count(conflictingAssignments),
        },
        {
          code: "orphaned_organizational_references",
          label: "Orphaned organizational references",
          count:
            count(orphanedAssignmentOrgUnits) + count(orphanedAssignmentPositions) + count(orphanedRelationshipManagers),
        },
        {
          code: "legacy_records_not_mapped",
          label: "Legacy records not mapped to canonical IDs",
          count: count(legacyRecordsNotMapped),
        },
      ];
    });
  }
}
