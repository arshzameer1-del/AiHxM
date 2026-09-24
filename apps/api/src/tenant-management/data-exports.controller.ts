import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import { IsIn } from "class-validator";
import type { Response } from "express";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
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
}

// TM-036 — Data export & migration jobs.
@Controller("platform/companies/:companyId/exports")
@UseGuards(PlatformAdminGuard)
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
    @Res() res: Response
  ) {
    const { fileName, buffer } = await this.exports.download(claims, companyId, exportId);
    res.setHeader("Content-Type", fileName.endsWith(".csv") ? "text/csv" : "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  }
}
