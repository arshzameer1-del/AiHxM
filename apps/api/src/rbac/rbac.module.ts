import { Module } from "@nestjs/common";
import { RbacService } from "./rbac.service";
import { RoleAssignmentsController } from "./role-assignments.controller";
import { RoleAssignmentsService } from "./role-assignments.service";
import { RolesController, TenantRolesController } from "./roles.controller";
import { FieldPermissionRulesController } from "./field-permission-rules.controller";
import { FieldPermissionRulesService } from "./field-permission-rules.service";
import { RolesService } from "./roles.service";
import { DataScopeAssignmentsController } from "./data-scope-assignments.controller";
import { DataScopeAssignmentsService } from "./data-scope-assignments.service";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [AuditModule],
  controllers: [RoleAssignmentsController, RolesController, TenantRolesController, DataScopeAssignmentsController, FieldPermissionRulesController],
  providers: [RbacService, RoleAssignmentsService, RolesService, DataScopeAssignmentsService, FieldPermissionRulesService],
  exports: [RbacService, RolesService],
})
export class RbacModule {}
