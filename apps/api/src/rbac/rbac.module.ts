import { Module } from "@nestjs/common";
import { RbacService } from "./rbac.service";
import { RoleAssignmentsController } from "./role-assignments.controller";
import { RoleAssignmentsService } from "./role-assignments.service";
import { RolesController } from "./roles.controller";
import { RolesService } from "./roles.service";
import { DataScopeAssignmentsController } from "./data-scope-assignments.controller";
import { DataScopeAssignmentsService } from "./data-scope-assignments.service";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [AuditModule],
  controllers: [RoleAssignmentsController, RolesController, DataScopeAssignmentsController],
  providers: [RbacService, RoleAssignmentsService, RolesService, DataScopeAssignmentsService],
  exports: [RbacService],
})
export class RbacModule {}
