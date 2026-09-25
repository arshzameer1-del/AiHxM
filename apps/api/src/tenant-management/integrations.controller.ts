import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsBoolean, IsObject, IsOptional } from "class-validator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { StepUpGuard } from "../auth/step-up.guard";
import { RequireStepUp } from "../auth/step-up.decorator";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { IntegrationProviderKey } from "@aihxm/shared-types";
import { IntegrationsService } from "./integrations.service";

class ConfigureIntegrationDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

// TM-031 — Integration catalog (SMTP, SSO, biometric device, webhook).
@Controller("platform/companies/:companyId/integrations")
@UseGuards(PlatformAdminGuard, StepUpGuard)
@ScopedCompanyParam("companyId")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.integrations.list(claims, companyId);
  }

  @Patch(":providerKey")
  configure(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("providerKey") providerKey: string,
    @Body() dto: ConfigureIntegrationDto
  ) {
    return this.integrations.configure(claims, companyId, providerKey as IntegrationProviderKey, dto);
  }

  // Tenant Management gap-fill Phase 1 item #12 — rotate a
  // AIHXM-issued secret (biometric_device apiKey, webhook signingSecret)
  // with a grace period for the old value. Phase 2 item #2 — also
  // requires step-up: a rotated secret is handed back in the response
  // body once, so this is exactly the kind of credential-issuing action
  // step-up exists to gate.
  @RequireStepUp()
  @Post(":providerKey/rotate")
  rotateSecret(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("providerKey") providerKey: string
  ) {
    return this.integrations.rotateSecret(claims, companyId, providerKey as IntegrationProviderKey);
  }
}
