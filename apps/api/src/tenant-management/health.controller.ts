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
