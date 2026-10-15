import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RolesService } from "./roles.service";
import { CreateCustomRoleDto, SetRolePermissionsDto } from "./dto/custom-role.dto";

@Controller("platform/roles")
@UseGuards(PlatformAdminGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.roles.list(claims);
  }
}

/** ACC-02 -- a company's own roles and the permission matrix. */
@Controller("rbac/roles")
@UseGuards(SessionGuard)
export class TenantRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.roles.list(claims);
  }

  @Get("permissions")
  permissions(@CurrentClaims() claims: RequestClaims) {
    return this.roles.listPermissions(claims);
  }

  @Get(":id/permissions")
  rolePermissions(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.roles.getPermissionKeys(claims, id);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCustomRoleDto) {
    return this.roles.createCustom(claims, dto);
  }

  @Put(":id/permissions")
  setPermissions(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetRolePermissionsDto) {
    return this.roles.setPermissions(claims, id, dto.permissionKeys);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.roles.setActive(claims, id, true);
  }

  @Post(":id/deactivate")
  deactivate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.roles.setActive(claims, id, false);
  }
}
