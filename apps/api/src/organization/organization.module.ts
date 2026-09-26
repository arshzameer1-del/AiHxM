import { Injectable, Logger, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { OrgUnitsController } from "./org-units.controller";
import { OrgUnitsService } from "./org-units.service";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";
import { PositionsController } from "./positions.controller";
import { PositionsService } from "./positions.service";
import { EmployeeOrgAssignmentsController } from "./employee-org-assignments.controller";
import { EmployeeOrgAssignmentsService } from "./employee-org-assignments.service";
import { OrgRelationshipsController } from "./org-relationships.controller";
import { OrgRelationshipsService } from "./org-relationships.service";
import { LocationsController } from "./locations.controller";
import { LocationsService } from "./locations.service";
import { CostCentersController } from "./cost-centers.controller";
import { CostCentersService } from "./cost-centers.service";
import { ProfitCentersController } from "./profit-centers.controller";
import { ProfitCentersService } from "./profit-centers.service";
import { OrgChangesController } from "./org-changes.controller";
import { OrgChangesService } from "./org-changes.service";
import { OrganizationCommandCenterController } from "./organization-command-center.controller";
import { OrganizationCommandCenterService } from "./organization-command-center.service";
import { LegacyReconciliationController } from "./legacy-reconciliation.controller";
import { LegacyReconciliationService } from "./legacy-reconciliation.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { EmployeesModule } from "../employees/employees.module";

/**
 * Organization Management, Phase 5 — wraps `OrgChangesService.executeDueChanges()`
 * in a real recurring trigger, the exact same shape
 * `WorkflowEscalationScheduler` (workflow.module.ts) already established
 * for `WorkflowService.escalateOverdue()`: a plain @nestjs/schedule cron,
 * no new queue infrastructure, trivially testable by calling
 * `executeDueChanges()` directly (which is exactly what this phase's own
 * test suite does rather than waiting on a timer).
 */
@Injectable()
class OrgChangeExecutionScheduler {
  private readonly logger = new Logger(OrgChangeExecutionScheduler.name);
  constructor(private readonly orgChanges: OrgChangesService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleExecutionSweep() {
    const count = await this.orgChanges.executeDueChanges();
    if (count > 0) {
      this.logger.log(`Executed ${count} due reorganization change(s)`);
    }
  }
}

/**
 * Organization Management — see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md,
 * 0065_organization_units.sql (Phase 1 — Org Units),
 * 0068_job_position_architecture.sql (Phase 2 — Job + Position), and
 * 0071_employee_org_assignments_and_relationships.sql (Phase 3 — Employee
 * Org Assignment + Reporting Relationships), and
 * 0073_locations_and_financial_centers.sql (Phase 4 — Locations, Cost
 * Centers, Profit Centers). All eight services are exported:
 * `OrgUnitsService` so `EmployeesModule` can depend on it directly
 * (department-sync-on-set — see EmployeesService's own doc comment);
 * `JobsService` so `ConfigurationCenterModule` can count the job catalog
 * (0070_configuration_center_job.sql); `LocationsService`,
 * `CostCentersService`, and `ProfitCentersService` so
 * `ConfigurationCenterModule` can likewise count those three catalogs
 * (0075_configuration_center_locations_financial_centers.sql) and so
 * `EmployeesModule` can depend on `LocationsService` directly
 * (location-sync-on-set, mirroring `OrgUnitsService`'s own department
 * sync); `PositionsService`, `EmployeeOrgAssignmentsService`, and
 * `OrgRelationshipsService` for symmetry and any future consumer, even
 * though nothing outside this module calls any of the three yet.
 * Deliberately ONE module for all nine — every phase of this initiative
 * is a new concept of the same "Organization Management" domain Org
 * Units already anchors, not a reason to fragment into per-entity
 * modules the way this codebase never does for a single cohesive feature
 * area (EmployeeGroupsModule already covers both employee groups AND
 * leave policies for the same reason).
 *
 * Phase 5 adds `OrgChangesController`/`OrgChangesService` (the
 * Reorganization workflow — see 0076_reorganization_changes.sql and
 * org-changes.service.ts's own header comments) plus `WorkflowModule`
 * (its approval routing) and `WebhooksModule` (its one
 * `org_change.published` event) as new imports — both deliberately slim,
 * already-exported-only modules other feature areas import the same way
 * (`LeaveRequestsModule` -> `WorkflowModule`, `EmployeesModule` ->
 * `WebhooksModule`), so neither adds any real coupling.
 *
 * Phase 6 adds `OrganizationCommandCenterController`/`...Service` (the
 * scoped Command Center panel — see that service's own header comment)
 * and, on `OrgUnitsService`/`PositionsService`/`EmployeeOrgAssignmentsService`
 * themselves, the `org.unit.changed`/`org.position.changed`/
 * `org.assignment.changed` domain events (fired via the already-imported
 * `WebhooksModule`, no new import needed).
 *
 * Phase 7 (Unified Integration & Synchronization Requirements) completes
 * the event catalog that document's own Section 14 asks for: the same
 * optional `WebhookDispatchService` injection pattern is now also on
 * `OrgRelationshipsService` (`org.relationship.changed`),
 * `LocationsService` (`org.location.changed`), and both
 * `CostCentersService`/`ProfitCentersService` (the one shared
 * `org.financial_center.changed`, distinguished by a `centerType` field) —
 * again via the already-imported `WebhooksModule`, no new import needed.
 * `OrgChangesService` additionally fires `org.reorganization.published`
 * alongside its existing `org_change.published` (kept, not renamed, so no
 * existing subscriber breaks). All seven events now share one payload
 * builder, `buildOrgEventPayload()` in `webhooks/org-event-payload.util.ts`.
 *
 * Phase 8 (Unified Integration & Synchronization Requirements, Section
 * 25 — Organization Integrity Dashboard) extends
 * `OrganizationCommandCenterService` with three more composed counts
 * (`totalLocations`/`totalCostCenters`/`totalProfitCenters`) and the
 * seven data-quality warnings that section names — see that service's
 * own header comment for what each warning checks and why. No new
 * module import: `DatabaseService` is a `@Global()` provider already
 * available everywhere.
 *
 * Phase 12 (Section 24 — Legacy Data Migration) adds
 * `LegacyReconciliationController`/`...Service`, the report-and-backfill
 * tool built on Phase 8's own `legacy_records_not_mapped` warning (see
 * that service's own header comment). This is this module's first import
 * of `EmployeesModule` — every prior phase's cross-module direction ran
 * the other way (`EmployeesModule` -> raw SQL against `org_units`/
 * `locations`, never a DI edge back into this module); `EmployeesModule`
 * itself imports none of this module's exports, so this new edge does
 * not create a cycle. `LegacyReconciliationService` calls
 * `EmployeesService.update()`/`OrgRelationshipsService.create()` directly
 * rather than duplicating either one's validation or audit trail — see
 * that service's own header comment for the full rationale.
 */
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EffectiveDatingModule, WorkflowModule, WebhooksModule, EmployeesModule],
  controllers: [
    OrgUnitsController,
    JobsController,
    PositionsController,
    EmployeeOrgAssignmentsController,
    OrgRelationshipsController,
    LocationsController,
    CostCentersController,
    ProfitCentersController,
    OrgChangesController,
    OrganizationCommandCenterController,
    LegacyReconciliationController,
  ],
  providers: [
    OrgUnitsService,
    JobsService,
    PositionsService,
    EmployeeOrgAssignmentsService,
    OrgRelationshipsService,
    LocationsService,
    CostCentersService,
    ProfitCentersService,
    OrgChangesService,
    OrgChangeExecutionScheduler,
    OrganizationCommandCenterService,
    LegacyReconciliationService,
  ],
  exports: [
    OrgUnitsService,
    JobsService,
    PositionsService,
    EmployeeOrgAssignmentsService,
    OrgRelationshipsService,
    LocationsService,
    CostCentersService,
    ProfitCentersService,
    OrgChangesService,
  ],
})
export class OrganizationModule {}
