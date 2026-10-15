import { Module } from "@nestjs/common";
import { RecruitmentController } from "./recruitment.controller";
import { RecruitmentService } from "./recruitment.service";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { RecruitmentScheduler } from "./recruitment.scheduler";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { EmployeesModule } from "../employees/employees.module";
import { HrAdministrationModule } from "../hr-administration/hr-administration.module";
import { OnboardingOffboardingModule } from "../onboarding-offboarding/onboarding-offboarding.module";
import { OrgOccupancyModule } from "../organization/occupancy/org-occupancy.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, WorkflowModule, EmployeesModule, HrAdministrationModule, OrgOccupancyModule, FileStorageModule, OnboardingOffboardingModule],
  controllers: [RecruitmentController],
  providers: [RecruitmentService, RecruitmentPipelineService, RecruitmentScheduler],
  exports: [RecruitmentService, RecruitmentPipelineService],
})
export class RecruitmentModule {}
