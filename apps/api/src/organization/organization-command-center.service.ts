import { Injectable } from "@nestjs/common";
import type { RequestClaims } from "../database/tenant-context";
import { OrgUnitsService } from "./org-units.service";
import { PositionsService } from "./positions.service";
import { EmployeeOrgAssignmentsService } from "./employee-org-assignments.service";
import { OrgChangesService } from "./org-changes.service";
import type { OrganizationCommandCenterSummary } from "@aihxm/shared-types";

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
 */
@Injectable()
export class OrganizationCommandCenterService {
  constructor(
    private readonly orgUnits: OrgUnitsService,
    private readonly positions: PositionsService,
    private readonly assignments: EmployeeOrgAssignmentsService,
    private readonly orgChanges: OrgChangesService
  ) {}

  async getSummary(claims: RequestClaims): Promise<OrganizationCommandCenterSummary> {
    const [orgUnits, positions, assignments, changes] = await Promise.all([
      this.orgUnits.list(claims),
      this.positions.list(claims),
      this.assignments.list(claims),
      this.orgChanges.list(claims),
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
    };
  }
}
