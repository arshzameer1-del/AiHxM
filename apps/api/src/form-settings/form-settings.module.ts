import { Global, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { FormLayoutController, FormSettingsController } from "./form-settings.controller";
import { FormLayoutService } from "./form-layout.service";
import { FormSettingsService } from "./form-settings.service";

/** Global so a form's own controller can call `enforce()` without importing this module. */
@Global()
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [FormSettingsController, FormLayoutController],
  providers: [FormSettingsService, FormLayoutService],
  exports: [FormSettingsService, FormLayoutService],
})
export class FormSettingsModule {}
