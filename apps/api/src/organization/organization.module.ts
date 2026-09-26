import { Module } from "@nestjs/common";
import { OrgUnitsController } from "./org-units.controller";
import { OrgUnitsService } from "./org-units.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";

/**
 * Organization Management, Phase 1 — see
 * claude/organization-management-4000-gap-analysis-and-roadmap.md and
 * 0065_organization_units.sql. `OrgUnitsService` is exported so
 * `EmployeesModule` can depend on it directly (department-sync-on-set —
 * see EmployeesService's own doc comment) without an HTTP round trip, the
 * same cross-module-call shape ShiftsService/EmployeeGroupsService
 * already use for each other's internals.
 */
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EffectiveDatingModule],
  controllers: [OrgUnitsController],
  providers: [OrgUnitsService],
  exports: [OrgUnitsService],
})
export class OrganizationModule {}
