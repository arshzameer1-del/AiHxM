import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { DataResidencyService } from "./data-residency.service";

class SetRequiredRegionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requiredRegion?: string | null;
}

/**
 * Phase 3 item #6 — Data Residency & Sovereignty (declaration + disclosure
 * only — see DataResidencyService's own doc comment for the honest scope).
 * No step-up: declaring a requirement or acknowledging a disclosed
 * mismatch is a compliance record-keeping action, not a
 * credential/security-posture change (unlike the export-key
 * enable/rotate/disable actions next door, which ARE step-up gated).
 */
@Controller("platform/companies/:companyId/residency")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class DataResidencyController {
  constructor(private readonly residency: DataResidencyService) {}

  @Get()
  getStatus(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.residency.getStatus(claims, companyId);
  }

  @Post()
  setRequiredRegion(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Body() dto: SetRequiredRegionDto
  ) {
    return this.residency.setRequiredRegion(claims, companyId, dto.requiredRegion ?? null);
  }

  @Post("acknowledge")
  acknowledge(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.residency.acknowledge(claims, companyId);
  }
}
