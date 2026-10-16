import { Module } from "@nestjs/common";
import { StarterSetupController } from "./starter-setup.controller";
import { StarterSetupService } from "./starter-setup.service";
import { RbacModule } from "../rbac/rbac.module";
import { AuditModule } from "../audit/audit.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { HolidaysModule } from "../holidays/holidays.module";
import { ShiftsModule } from "../shifts/shifts.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";

@Module({
  imports: [RbacModule, AuditModule, WorkflowModule, HolidaysModule, ShiftsModule, EmployeeGroupsModule],
  controllers: [StarterSetupController],
  providers: [StarterSetupService],
})
export class StarterSetupModule {}
