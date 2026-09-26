import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { StepUpGuard } from "../auth/step-up.guard";
import { RequireStepUp } from "../auth/step-up.decorator";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { TenantExportKeyService } from "./tenant-export-key.service";

/**
 * Phase 3 item #5 — Platform-Admin-facing management of a tenant's
 * dedicated export encryption key. See `TenantExportKeyService`'s own doc
 * comment for the full design and its honest scope (a tenant-dedicated,
 * independently-rotatable key wrapped under the platform's own server
 * key — NOT a true customer-held/HSM-backed key).
 *
 * Enable/Rotate/Disable are each `@RequireStepUp()` — same posture as
 * rotating an integration secret (Phase 2 item #2) or generating/disabling
 * a SCIM token: this is exactly the kind of consequential,
 * credential-adjacent action step-up already gates elsewhere in this
 * codebase. Disabling is included even though it "only" turns a
 * protection off, not on — weakening a tenant's security posture is just
 * as consequential as strengthening it. `GET` (a pure status read, never
 * key material) needs no step-up, same as every other status endpoint in
 * this module.
 */
@Controller("platform/companies/:companyId/export-key")
@UseGuards(PlatformAdminGuard, StepUpGuard)
@ScopedCompanyParam("companyId")
export class TenantExportKeyController {
  constructor(private readonly exportKey: TenantExportKeyService) {}

  @Get()
  status(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.exportKey.getStatus(claims, companyId);
  }

  @RequireStepUp()
  @Post("enable")
  enable(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.exportKey.enable(claims, companyId);
  }

  @RequireStepUp()
  @Post("rotate")
  rotate(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.exportKey.rotate(claims, companyId);
  }

  @RequireStepUp()
  @Post("disable")
  disable(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.exportKey.disable(claims, companyId);
  }
}
