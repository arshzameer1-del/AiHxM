import { Module } from "@nestjs/common";
import { LeaveController } from "./leave.controller";
import { LeaveRequestsService } from "./leave-requests.service";
import { AttendanceService } from "./attendance.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";
import { WorkflowModule } from "../workflow/workflow.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeeGroupsModule, WorkflowModule],
  controllers: [LeaveController],
  providers: [LeaveRequestsService, AttendanceService],
  exports: [LeaveRequestsService, AttendanceService],
})
export class LeaveModule {}
