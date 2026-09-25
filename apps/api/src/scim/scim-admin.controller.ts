import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { StepUpGuard } from "../auth/step-up.guard";
import { RequireStepUp } from "../auth/step-up.decorator";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ScimService } from "./scim.service";

/**
 * Platform-Admin-facing SCIM configuration — generating/rotating/disabling
 * a tenant's bearer token, the credential their IdP's SCIM connector
 * authenticates with against `ScimController` (a wholly separate,
 * unguarded-by-session controller — see its own doc comment). Kept as its
 * own small controller rather than folded into `IntegrationsController`:
 * the token isn't a `tenant_integrations.config` jsonb field
 * `IntegrationsService`'s generic redact/rotate machinery already models —
 * it's a dedicated, hashed, typed column with its own one-time-reveal
 * semantics.
 *
 * `@RequireStepUp()` on generate/disable, same posture as rotating an
 * integration's own secret (Phase 2 item #2) — this credential controls
 * provisioning of tenant portal access, at least as sensitive as any other
 * secret this step-up gate already protects.
 */
@Controller("platform/companies/:companyId/scim")
@UseGuards(PlatformAdminGuard, StepUpGuard)
@ScopedCompanyParam("companyId")
export class ScimAdminController {
  constructor(private readonly scim: ScimService) {}

  @Get("status")
  status(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.scim.getStatus(claims, companyId);
  }

  @RequireStepUp()
  @Post("token")
  generateToken(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.scim.generateToken(claims, companyId);
  }

  @RequireStepUp()
  @Post("disable")
  disable(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.scim.disableScim(claims, companyId);
  }
}
