import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EmployeesModule } from "../employees/employees.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { LeaveModule } from "../leave/leave.module";
import { RbacModule } from "../rbac/rbac.module";
import { AttendancePenaltiesController } from "./attendance-penalties.controller";
import { AttendancePenaltiesService } from "./attendance-penalties.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, LeaveModule, EmployeesModule],
  controllers: [AttendancePenaltiesController],
  providers: [AttendancePenaltiesService],
})
export class AttendancePenaltiesModule {}
