import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EmployeesModule } from "../employees/employees.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { LeaveModule } from "../leave/leave.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PayrollModule } from "../payroll/payroll.module";
import { RbacModule } from "../rbac/rbac.module";
import { EmployeeRequestsController } from "./employee-requests.controller";
import { EmployeeRequestsService } from "./employee-requests.service";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EmployeesModule, PayrollModule, NotificationsModule, LeaveModule],
  controllers: [EmployeeRequestsController],
  providers: [EmployeeRequestsService],
  exports: [EmployeeRequestsService],
})
export class EmployeeRequestsModule {}
