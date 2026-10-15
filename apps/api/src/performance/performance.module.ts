import { Module } from "@nestjs/common";
import { PerformanceController } from "./performance.controller";
import { PerformanceService } from "./performance.service";
import { PerformanceDepthService } from "./performance-depth.service";
import { PerformanceDepthController } from "./performance-depth.controller";
import { PerformanceScheduler } from "./performance.scheduler";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeeGroupsModule],
  controllers: [PerformanceController, PerformanceDepthController],
  providers: [PerformanceService, PerformanceDepthService, PerformanceScheduler],
  exports: [PerformanceService, PerformanceDepthService],
})
export class PerformanceModule {}
