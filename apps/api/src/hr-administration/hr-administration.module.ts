import { Module } from "@nestjs/common";
import { HrReferenceCatalogController } from "./hr-reference-catalog.controller";
import { HrReferenceCatalogService } from "./hr-reference-catalog.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";

/**
 * HR Administration (Core Employee Configuration/HR-Admin v2, 2026-09-27)
 * — a new top-level module, deliberately separate from `EmployeesModule`
 * and from Configuration Center, matching the v2 spec's own Section 19
 * information architecture ("HR Administration" as its own IA area). This
 * module imports nothing from `EmployeesModule` and exports
 * `HrReferenceCatalogService` so `EmployeesModule` can import THIS module
 * (one-directional — no circular dependency) to validate `employment_type`
 * and lifecycle reason codes against these catalogs.
 */
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [HrReferenceCatalogController],
  providers: [HrReferenceCatalogService],
  exports: [HrReferenceCatalogService],
})
export class HrAdministrationModule {}
