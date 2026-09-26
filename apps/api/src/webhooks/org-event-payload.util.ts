import type { RequestClaims } from "../database/tenant-context";

/**
 * Organization Management, Phase 7 (Unified Integration & Synchronization
 * Requirements, Section 14 — Event Contract). Every domain event this
 * initiative fires (`org.unit.changed`, `org.position.changed`,
 * `org.assignment.changed`, and this phase's new
 * `org.relationship.changed`/`org.location.changed`/
 * `org.financial_center.changed`/`org.reorganization.published`) shares one
 * payload shape, built here once rather than duplicated at each of the
 * (by now) seven call sites across `organization/*.service.ts`. Additive
 * only: `eventVersion`/`changeType`/the nested entity are exactly what
 * Phase 6 already shipped and existing consumers already read; this phase
 * adds `tenantId`/`entityId`/`effectiveDate`/`occurredAt` alongside them,
 * per the requirements document's own Section 14 payload contract, without
 * removing or renaming anything a Phase 6-era consumer already depends on.
 *
 * `effectiveDate` is deliberately "today" (the date the mutation is
 * actually applied) for every one of these entities: none of
 * OrgUnitsService/PositionsService/EmployeeOrgAssignmentsService/
 * OrgRelationshipsService/LocationsService/CostCentersService/
 * ProfitCentersService's own mutation methods accept a caller-supplied
 * effective date distinct from "now" (unlike `OrgChangesService`, whose
 * `org_changes.effective_date` is a real, separate field the caller sets
 * — that event builds its own payload with the real value instead of
 * calling this helper).
 */
export function buildOrgEventPayload(
  claims: RequestClaims,
  changeType: string,
  entityKey: string,
  entity: { id: string },
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    eventVersion: 1,
    changeType,
    tenantId: claims.company_id,
    entityId: entity.id,
    effectiveDate: new Date().toISOString().slice(0, 10),
    occurredAt: new Date().toISOString(),
    [entityKey]: entity,
    ...extra,
  };
}
