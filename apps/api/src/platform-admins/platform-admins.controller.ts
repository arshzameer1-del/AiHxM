import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { UpdateCompanyAdminDto } from "../companies/dto/update-company-admin.dto";
import { PlatformAdminsService } from "./platform-admins.service";
import { CreatePlatformAdminDto } from "./dto/create-platform-admin.dto";

@Controller("platform/admins")
@UseGuards(PlatformAdminGuard)
export class PlatformAdminsController {
  constructor(private readonly platformAdmins: PlatformAdminsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.platformAdmins.list(claims);
  }

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
}
