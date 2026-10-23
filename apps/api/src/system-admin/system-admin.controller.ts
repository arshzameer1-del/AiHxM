import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { SystemAdminService } from "./system-admin.service";
import { AssignSystemAdminRoleDto } from "./dto/assign-system-admin-role.dto";
import { SetMfaRequirementDto } from "./dto/set-mfa-requirement.dto";
import { ResetEmployeePasswordDto } from "./dto/reset-employee-password.dto";

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

  @Get("roles")
  listAssignableRoles(@CurrentClaims() claims: RequestClaims) {
    return this.systemAdmin.listAssignableRoles(claims);
  }

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

  /** Sets a new temporary password for an employee's login (and signs them out everywhere). */
  @Post("users/:employeeId/reset-password")
  async resetPassword(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: ResetEmployeePasswordDto) {
    await this.systemAdmin.resetPassword(claims, employeeId, dto.newPassword);
    return { message: "Password changed." };
  }

  /** Clears a person's authenticator so their next sign-in sets it up again (lost or changed phone). Signs them out everywhere. */
  @Post("users/:employeeId/reset-mfa")
  async resetMfa(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    await this.systemAdmin.resetMfa(claims, employeeId);
    return { message: "Authenticator reset." };
  }

  /** Per login: must the person enter an authenticator code at sign-in (true) or only login ID + password (false)? */
  @Put("users/:employeeId/mfa-requirement")
  async setMfaRequired(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: SetMfaRequirementDto) {
    await this.systemAdmin.setMfaRequired(claims, employeeId, dto.required);
    return { message: dto.required ? "Authenticator is now required for this login." : "This login can now sign in with password only." };
  }

  @Delete("role-assignments/:id")
  async revokeRole(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.systemAdmin.revokeRole(claims, id);
    return { message: "Role assignment revoked." };
  }
}
