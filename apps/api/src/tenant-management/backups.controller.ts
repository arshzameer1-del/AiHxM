import { Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { BackupsService } from "./backups.service";

// TM-035 — Backups.
@Controller("platform/companies/:companyId/backups")
@UseGuards(PlatformAdminGuard)
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.backups.list(claims, companyId);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.backups.create(claims, companyId);
  }

  @Get(":backupId/download")
  async download(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("backupId") backupId: string,
    @Res() res: Response
  ) {
    const { fileName, buffer } = await this.backups.download(claims, companyId, backupId);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  }
}
