import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { Response } from "express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ScopedCompanyParam } from "../auth/scoped-company-param.decorator";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { DataExportFormat, DataExportScope } from "@aihxm/shared-types";
import { DataExportsService } from "./data-exports.service";

const SCOPES: DataExportScope[] = ["full", "employees", "payroll", "attendance"];
const FORMATS: DataExportFormat[] = ["json", "csv"];

class RequestExportDto {
  @IsIn(SCOPES)
  scope!: DataExportScope;

  @IsIn(FORMATS)
  format!: DataExportFormat;

  // Phase 2 gap-fill item #6 — optional download password. Never stored;
  // see export-crypto.ts's own doc comment.
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

// TM-036 — Data export & migration jobs.
@Controller("platform/companies/:companyId/exports")
@UseGuards(PlatformAdminGuard)
@ScopedCompanyParam("companyId")
export class DataExportsController {
  constructor(private readonly exports: DataExportsService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Param("companyId") companyId: string) {
    return this.exports.list(claims, companyId);
  }

  @Post()
  request(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Body() dto: RequestExportDto
  ) {
    return this.exports.request(claims, companyId, dto);
  }

  @Get(":exportId/download")
  async download(
    @CurrentClaims() claims: RequestClaims,
    @Param("companyId") companyId: string,
    @Param("exportId") exportId: string,
    @Res() res: Response,
    // Query param, not a body/header, deliberately: this route is hit by
    // a plain authenticated GET (see the frontend's downloadDataExport())
    // so a streamed file download can still work as one request. The
    // route itself stays unchanged for the (default, far more common)
    // non-password-protected case.
    @Query("password") password?: string
  ) {
    const { fileName, buffer } = await this.exports.download(claims, companyId, exportId, password);
    res.setHeader("Content-Type", fileName.endsWith(".csv") ? "text/csv" : "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  }
}
