import { Module } from "@nestjs/common";
import { RecruitmentController } from "./recruitment.controller";
import { RecruitmentService } from "./recruitment.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { EmployeesModule } from "../employees/employees.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, WorkflowModule, EmployeesModule],
  controllers: [RecruitmentController],
  providers: [RecruitmentService],
  exports: [RecruitmentService],
})
export class RecruitmentModule {}
