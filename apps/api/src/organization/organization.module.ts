import { Module } from "@nestjs/common";
import { OrgUnitsController } from "./org-units.controller";
import { OrgUnitsService } from "./org-units.service";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";
import { PositionsController } from "./positions.controller";
import { PositionsService } from "./positions.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";

/**
 * Organization Management — see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md,
 * 0065_organization_units.sql (Phase 1 — Org Units) and
 * 0068_job_position_architecture.sql (Phase 2 — Job + Position). All
 * three services are exported: `OrgUnitsService` so `EmployeesModule` can
 * depend on it directly (department-sync-on-set — see EmployeesService's
 * own doc comment); `JobsService` so `ConfigurationCenterModule` can
 * count the job catalog (0070_configuration_center_job.sql);
 * `PositionsService` for symmetry and any future consumer, even though
 * nothing outside this module calls it yet. Deliberately ONE module for
 * all three — Job and Position are new Phase 2 concepts of the same
 * "Organization Management" domain Org Units already anchors, not a
 * reason to fragment into per-entity modules the way this codebase never
 * does for a single cohesive feature area (EmployeeGroupsModule already
 * covers both employee groups AND leave policies for the same reason).
 */
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EffectiveDatingModule],
  controllers: [OrgUnitsController, JobsController, PositionsController],
  providers: [OrgUnitsService, JobsService, PositionsService],
  exports: [OrgUnitsService, JobsService, PositionsService],
})
export class OrganizationModule {}
