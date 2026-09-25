import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { StepUpGuard } from "../auth/step-up.guard";
import { RequireStepUp } from "../auth/step-up.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { UpdateCompanyAdminDto } from "../companies/dto/update-company-admin.dto";
import { PlatformAdminsService } from "./platform-admins.service";
import { CreatePlatformAdminDto } from "./dto/create-platform-admin.dto";
import { SetPlatformAdminAccessDto } from "./dto/set-platform-admin-access.dto";

@Controller("platform/admins")
@UseGuards(PlatformAdminGuard, StepUpGuard)
export class PlatformAdminsController {
  constructor(private readonly platformAdmins: PlatformAdminsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.platformAdmins.list(claims);
  }

  // Phase 2 gap-fill item #2 — creating a new Platform Admin grants
  // standing backend access; step-up closes the window where a hijacked
  // (but not yet detected) admin session could otherwise mint another one.
  @RequireStepUp()
  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePlatformAdminDto) {
    return this.platformAdmins.create(claims, dto);
  }

  @Patch(":id")
  setStatus(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompanyAdminDto
  ) {
    return this.platformAdmins.setStatus(claims, id, dto.status);
  }

  // Phase 2 gap-fill item #7 — Platform Admin delegation. Also gated by
  // item #2's step-up: changing another admin's access level is exactly
  // the kind of standing-privilege change step-up exists for.
  @RequireStepUp()
  @Patch(":id/access")
  setAccess(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: SetPlatformAdminAccessDto
  ) {
    return this.platformAdmins.setAccess(claims, id, dto.accessLevel, dto.scopedCompanyIds);
  }
}
