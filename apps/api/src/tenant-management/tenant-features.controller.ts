import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { IsBoolean, IsInt, IsOptional, Min } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { TenantFeaturesService } from "./tenant-features.service";

class SetFeatureEntitlementDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  usageLimit?: number | null;
}

// TM-023/024.
@Controller("platform/companies/:companyId/features")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class TenantFeaturesController {
  constructor(private readonly features: TenantFeaturesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.features.list(claims, companyId);
  }

  @Patch(":featureKey")
  setEntitlement(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("featureKey") featureKey: string,
    @Body() dto: SetFeatureEntitlementDto
  ) {
    return this.features.setEntitlement(claims, companyId, featureKey, dto);
  }
}
