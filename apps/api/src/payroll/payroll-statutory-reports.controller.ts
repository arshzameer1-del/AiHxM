import { Controller, Get, Header, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollStatutoryReportsService } from "./payroll-statutory-reports.service";

/** Statutory reports of a finalised run. Permissions are decided in the service (payroll-area scoped). */
@Controller()
@UseGuards(SessionGuard)
export class PayrollStatutoryReportsController {
  constructor(private readonly reports: PayrollStatutoryReportsService) {}

  @Get("payroll/runs/:runId/statutory/:kind")
  get(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string, @Param("kind") kind: string) {
    return this.reports.get(claims, runId, kind);
  }

  @Get("payroll/runs/:runId/statutory/:kind/csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  csv(@CurrentClaims() claims: RequestClaims, @Param("runId", ParseUUIDPipe) runId: string, @Param("kind") kind: string, @Query("layout") layout?: string) {
    return this.reports.csv(claims, runId, kind, layout || "standard");
  }
}
