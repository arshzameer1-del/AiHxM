import { Module } from "@nestjs/common";
import { PerformanceController } from "./performance.controller";
import { PerformanceService } from "./performance.service";
import { PerformanceDepthService } from "./performance-depth.service";
import { PerformanceDepthController } from "./performance-depth.controller";
import { KeyResultsController } from "./key-results.controller";
import { KeyResultsService } from "./key-results.service";
import { PerformanceScheduler } from "./performance.scheduler";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeeGroupsModule],
  controllers: [PerformanceController, PerformanceDepthController, KeyResultsController],
  providers: [PerformanceService, PerformanceDepthService, KeyResultsService, PerformanceScheduler],
  exports: [PerformanceService, PerformanceDepthService],
})
export class PerformanceModule {}
