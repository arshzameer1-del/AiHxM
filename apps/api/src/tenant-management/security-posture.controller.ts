import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { SecurityPostureService } from "./security-posture.service";

/**
 * Phase 3 item #8 — read-only security posture score for the Security tab.
 * See SecurityPostureService's own doc comment for the point-weighting
 * behind the number this returns.
 */
@Controller("platform/companies/:companyId/security-posture")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class SecurityPostureController {
  constructor(private readonly posture: SecurityPostureService) {}

  @Get()
  getScore(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.posture.getScore(claims, companyId);
  }
}
