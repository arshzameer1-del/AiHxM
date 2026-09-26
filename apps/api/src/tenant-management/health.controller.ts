import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { HealthService } from "./health.service";

// TM-032 — Health dashboard.
@Controller("platform/companies/:companyId/health")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  getLatest(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.health.getLatest(claims, companyId);
  }

  @Post("check")
  runCheck(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.health.runCheck(claims, companyId);
  }
}

// Phase 3 item #9 — Monitoring. Cross-tenant, so it deliberately does NOT
// live under platform/companies/:companyId/health above — there is no
// single company to scope it to, and @ScopedCompanyParam has nothing to
// check against here. HealthService.getPlatformSummary itself applies the
// 'scoped' Platform Admin filter (same as CompaniesService.list) since
// there's no single :companyId route param for PlatformAdminGuard's own
// @ScopedCompanyParam check to key off.
@Controller("platform/health")
@UseGuards(PlatformAdminGuard)
export class PlatformHealthController {
  constructor(private readonly health: HealthService) {}

  @Get("summary")
  getSummary(@CurrentClaims() claims: RequestClaims) {
    return this.health.getPlatformSummary(claims);
  }
}
