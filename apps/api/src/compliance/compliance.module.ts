import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [ComplianceController],
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
