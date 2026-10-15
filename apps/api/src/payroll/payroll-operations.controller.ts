import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { PAYROLL_EVENT_CATALOG } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { IdempotencyKey } from "../idempotency/idempotency-key.decorator";
import { PayrollDashboardService } from "./payroll-dashboard.service";
import { PayrollInputImportService } from "./payroll-input-import.service";
import { DryRunPayrollInputDto } from "./dto/payroll-input-import.dto";

/** PAY-25 dashboard, PAY-26 bulk payroll inputs and the PAY-27 event catalogue. Permissions are decided in the services. */
@Controller()
@UseGuards(SessionGuard)
export class PayrollOperationsController {
  constructor(
    private readonly dashboard: PayrollDashboardService,
    private readonly imports: PayrollInputImportService
  ) {}

  @Get("payroll/dashboard")
  getDashboard(@CurrentClaims() claims: RequestClaims) {
    return this.dashboard.get(claims);
  }

  @Get("payroll/event-catalog")
  eventCatalog() {
    return PAYROLL_EVENT_CATALOG;
  }

  @Get("payroll/input-imports/templates")
  templates() {
    return this.imports.templates();
  }

  @Post("payroll/input-imports")
  dryRun(@CurrentClaims() claims: RequestClaims, @Body() dto: DryRunPayrollInputDto, @IdempotencyKey() key?: string) {
    return this.imports.dryRun(claims, dto, key);
  }

  @Get("payroll/input-imports")
  list(@CurrentClaims() claims: RequestClaims) {
    return this.imports.list(claims);
  }

  @Get("payroll/input-imports/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.get(claims, id);
  }

  @Get("payroll/input-imports/:id/rows")
  rows(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.imports.rows(claims, id, { status, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  }

  @Get("payroll/input-imports/:id/error-report")
  @Header("Content-Type", "text/csv; charset=utf-8")
  errorReport(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.errorReportCsv(claims, id);
  }

  @Post("payroll/input-imports/:id/execute")
  execute(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @IdempotencyKey() key?: string) {
    return this.imports.execute(claims, id, key);
  }

  @Post("payroll/input-imports/:id/retry-failed")
  retryFailed(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.retryFailed(claims, id);
  }

  @Post("payroll/input-imports/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.cancel(claims, id);
  }
}
