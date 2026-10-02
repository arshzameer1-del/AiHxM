import { Module } from "@nestjs/common";
import { HrReferenceCatalogController } from "./hr-reference-catalog.controller";
import { HrReferenceCatalogService } from "./hr-reference-catalog.service";
import { HrBusinessPolicyController } from "./hr-business-policy.controller";
import { HrBusinessPolicyService } from "./hr-business-policy.service";
import { ConfigurationRuleMappingController } from "./configuration-rule-mapping.controller";
import { ConfigurationRuleMappingService } from "./configuration-rule-mapping.service";
import { ConfigurationChangeRequestController } from "./configuration-change-request.controller";
import { ConfigurationChangeRequestService } from "./configuration-change-request.service";
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
 *
 * "then 2" Phase 2 (2026-10-02, gap-table item #8) adds
 * `HrBusinessPolicyService`/`HrBusinessPolicyController` here too, the
 * same workspace rather than a separate module — a business policy is
 * still HR Administration reference/configuration data in the v2 spec's
 * own sense, just a richer (named, rules-carrying) shape than a flat
 * catalog item. Exported the same one-directional way so
 * `EmployeesModule` (which already imports this module) can resolve
 * `HrBusinessPolicyService` into `EmployeesService` without a new module
 * edge.
 *
 * "then 2" Phases 4+5 (2026-10-02, gap-table items #11+#12) add
 * `ConfigurationRuleMappingService`/`ConfigurationRuleMappingController`
 * here too — see that service's own class doc comment. It is exported
 * (though no other module imports it directly today — `HrBusinessPolicyService`
 * reaches it by default-instantiating its own instance, see that
 * service's constructor comment) so a future direct consumer can resolve
 * it through Nest's DI instead of hand-constructing a second copy.
 *
 * "then 2" Phase 6 (2026-10-02, gap-table item #13) adds
 * `ConfigurationChangeRequestService`/`ConfigurationChangeRequestController`
 * here too — the Configuration Publish Lifecycle wrapping the three
 * services above (see that service's own class doc comment). It
 * default-instantiates its own copies of all three the same way
 * `HrBusinessPolicyService` already does for `ConfigurationRuleMappingService`,
 * so it needs no new provider wiring beyond itself.
 */
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [
    HrReferenceCatalogController,
    HrBusinessPolicyController,
    ConfigurationRuleMappingController,
    ConfigurationChangeRequestController,
  ],
  providers: [HrReferenceCatalogService, HrBusinessPolicyService, ConfigurationRuleMappingService, ConfigurationChangeRequestService],
  exports: [HrReferenceCatalogService, HrBusinessPolicyService, ConfigurationRuleMappingService, ConfigurationChangeRequestService],
})
export class HrAdministrationModule {}
