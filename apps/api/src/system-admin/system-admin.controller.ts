import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { SystemAdminService } from "./system-admin.service";
import { AssignSystemAdminRoleDto } from "./dto/assign-system-admin-role.dto";

/**
 * Any real session can call these — same posture as every other module
 * controller since Phase 4 (WorkflowController, RecruitmentController,
 * etc.): SystemAdminService itself enforces `role_assignment.manage.all`
 * on every method, scoped to the caller's own company.
 */
@Controller("system-admin")
@UseGuards(SessionGuard)
export class SystemAdminController {
  constructor(private readonly systemAdmin: SystemAdminService) {}

  @Get("assignable-users")
  listAssignableUsers(@CurrentClaims() claims: RequestClaims) {
    return this.systemAdmin.listAssignableUsers(claims);
  }

  @Get("role-assignments")
  listRoleAssignments(@CurrentClaims() claims: RequestClaims) {
    return this.systemAdmin.listRoleAssignments(claims);
  }

  @Post("role-assignments")
  assignRole(@CurrentClaims() claims: RequestClaims, @Body() dto: AssignSystemAdminRoleDto) {
    return this.systemAdmin.assignRole(claims, dto);
  }

  @Delete("role-assignments/:id")
  async revokeRole(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.systemAdmin.revokeRole(claims, id);
    return { message: "Role assignment revoked." };
  }
}
