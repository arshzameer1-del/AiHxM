import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RoleAssignmentsService } from "./role-assignments.service";
import { AssignRoleDto } from "./dto/assign-role.dto";

@Controller("platform/role-assignments")
@UseGuards(PlatformAdminGuard)
export class RoleAssignmentsController {
  constructor(private readonly roleAssignments: RoleAssignmentsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("companyId") companyId?: string) {
    return this.roleAssignments.list(claims, companyId || undefined);
  }

  @Post()
  assign(@CurrentClaims() claims: RequestClaims, @Body() dto: AssignRoleDto) {
    return this.roleAssignments.assign(claims, dto);
  }

  @Delete(":id")
  async revoke(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    await this.roleAssignments.revoke(claims, id);
    return { message: "Role assignment revoked." };
  }
}
