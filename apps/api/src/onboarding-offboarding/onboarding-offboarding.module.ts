import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { OffboardingController } from "./offboarding.controller";
import { OffboardingService } from "./offboarding.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EmployeesModule } from "../employees/employees.module";

/**
 * One module for both sides — see 0035_onboarding_offboarding.sql for
 * why: Onboarding and Offboarding share one checklist mechanic (item
 * templates cloned into a real instance's items) closely enough that
 * splitting them into two modules would mean duplicating this file's
 * own import list for no real isolation benefit — the two Services still
 * gate on their own distinct module_catalog entries (`recruitment` vs
 * `exit`) and permission keys, so entitlement/RBAC isolation between
 * them is unaffected by living in one NestJS module.
 */
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeesModule],
  controllers: [OnboardingController, OffboardingController],
  providers: [OnboardingService, OffboardingService],
  exports: [OnboardingService, OffboardingService],
})
export class OnboardingOffboardingModule {}
