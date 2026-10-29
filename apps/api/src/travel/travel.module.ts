import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EmployeesModule } from "../employees/employees.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RbacModule } from "../rbac/rbac.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { TravelController } from "./travel.controller";
import { TravelService } from "./travel.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeesModule, WorkflowModule, NotificationsModule],
  controllers: [TravelController],
  providers: [TravelService],
  exports: [TravelService],
})
export class TravelModule {}
