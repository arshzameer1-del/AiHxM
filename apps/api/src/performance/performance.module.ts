import { Module } from "@nestjs/common";
import { PerformanceController } from "./performance.controller";
import { PerformanceService } from "./performance.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeeGroupsModule],
  controllers: [PerformanceController],
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
