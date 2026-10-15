import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../../auth/session.guard";
import { CurrentClaims } from "../../auth/current-claims.decorator";
import type { RequestClaims } from "../../database/tenant-context";
import { IdempotencyKey } from "../../idempotency/idempotency-key.decorator";
import { EmployeeImportService } from "./employee-import.service";
import { DryRunEmployeeImportDto } from "./dto/employee-import.dto";

/** Gap Register LIF-11. Authorisation (module + employee.manage.all) lives in EmployeeImportService. */
@Controller("employee-import-batches")
@UseGuards(SessionGuard)
export class EmployeeImportController {
  constructor(private readonly imports: EmployeeImportService) {}

  @Post()
  dryRun(@CurrentClaims() claims: RequestClaims, @Body() dto: DryRunEmployeeImportDto, @IdempotencyKey() key?: string) {
    return this.imports.dryRun(claims, dto, key);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.imports.list(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.get(claims, id);
  }

  @Get(":id/rows")
  rows(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.imports.rows(claims, id, { status, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  }

  @Get(":id/error-report")
  @Header("Content-Type", "text/csv; charset=utf-8")
  errorReport(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.errorReportCsv(claims, id);
  }

  @Post(":id/execute")
  execute(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @IdempotencyKey() key?: string) {
    return this.imports.execute(claims, id, key);
  }

  @Post(":id/retry-failed")
  retryFailed(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.retryFailed(claims, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.imports.cancel(claims, id);
  }
}
