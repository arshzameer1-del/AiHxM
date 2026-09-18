import { Module } from "@nestjs/common";
import { ConfigurationCenterController } from "./configuration-center.controller";
import { ConfigurationCenterService } from "./configuration-center.service";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";
import { ShiftsModule } from "../shifts/shifts.module";
import { HolidaysModule } from "../holidays/holidays.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { PayrollModule } from "../payroll/payroll.module";
import { CustomFieldsModule } from "../custom-fields/custom-fields.module";

@Module({
  imports: [EmployeeGroupsModule, ShiftsModule, HolidaysModule, WorkflowModule, PayrollModule, CustomFieldsModule],
  controllers: [ConfigurationCenterController],
  providers: [ConfigurationCenterService],
})
export class ConfigurationCenterModule {}
