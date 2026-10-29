import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { SmartChecksController } from "./smart-checks.controller";
import { SmartChecksService } from "./smart-checks.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [SmartChecksController],
  providers: [SmartChecksService],
  exports: [SmartChecksService],
})
export class SmartChecksModule {}
