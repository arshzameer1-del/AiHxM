import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { DrTestOutcome } from "@aihxm/shared-types";
import { BackupsService } from "./backups.service";

class RecordDrTestDto {
  @IsISO8601()
  testedAt!: string;

  @IsIn(["pass", "fail", "partial"])
  outcome!: DrTestOutcome;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// TM-035 — Backups.
@Controller("platform/companies/:companyId/backups")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
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

  // Phase 3 item #7 — manual DR test evidence log (see BackupsService.recordDrTest's own doc comment).
  @Get("dr-tests")
  listDrTests(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.backups.listDrTests(claims, companyId);
  }

  @Post("dr-tests")
  recordDrTest(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Body() dto: RecordDrTestDto
  ) {
    return this.backups.recordDrTest(claims, companyId, dto);
  }
}
