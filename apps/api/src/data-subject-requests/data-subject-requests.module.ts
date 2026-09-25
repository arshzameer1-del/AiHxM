import { Module } from "@nestjs/common";
import { DataSubjectRequestsController } from "./data-subject-requests.controller";
import { DataSubjectRequestsService } from "./data-subject-requests.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { WorkflowModule } from "../workflow/workflow.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, WorkflowModule],
  controllers: [DataSubjectRequestsController],
  providers: [DataSubjectRequestsService],
  exports: [DataSubjectRequestsService],
})
export class DataSubjectRequestsModule {}
