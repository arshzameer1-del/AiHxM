import { Controller, Get, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { RolesService } from "./roles.service";

@Controller("platform/roles")
@UseGuards(PlatformAdminGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.roles.list(claims);
  }
}
