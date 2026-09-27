import { Controller, Get, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAnalyticsService } from "./employee-analytics.service";

/** Core Employee Enterprise Phase 12 — Workforce Analytics. Its own
 * controller, not folded into `EmployeesController`, since Phase 10's
 * `EmployeeLifecycleController` and this class' own service each already
 * established "one focused controller per sub-capability" as this
 * module's pattern rather than one ever-growing `EmployeesController`. */
@Controller("employees/analytics")
@UseGuards(SessionGuard)
export class EmployeeAnalyticsController {
  constructor(private readonly analytics: EmployeeAnalyticsService) {}

  @Get("summary")
  getSummary(@CurrentClaims() claims: RequestClaims) {
    return this.analytics.getSummary(claims);
  }
}
