import { Body, Controller, Delete, Get, Header, Param, Post, Put, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsObject, IsOptional } from "class-validator";
import type { Response } from "express";
import { CurrentClaims } from "../auth/current-claims.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { RequestClaims } from "../database/tenant-context";
import { ReportsService } from "./reports.service";
import { REPORT_ID_PATTERN } from "./catalog/report-catalog";
import { NotFoundException, PipeTransform, Injectable } from "@nestjs/common";

/** Report ids are letter + two digits. Anything else is a 404 before it reaches a service. */
@Injectable()
export class ReportIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!REPORT_ID_PATTERN.test(value)) throw new NotFoundException("No such report");
    return value;
  }
}

export class RunReportDto {
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;
}

@Controller("reports")
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("catalog")
  catalog(@CurrentClaims() claims: RequestClaims) {
    return this.reports.catalog(claims);
  }

  @Get("catalog/:id")
  entry(@CurrentClaims() claims: RequestClaims, @Param("id", ReportIdPipe) id: string) {
    return this.reports.entry(claims, id);
  }

  @Get("catalog/:id/filter-options")
  filterOptions(@CurrentClaims() claims: RequestClaims, @Param("id", ReportIdPipe) id: string) {
    return this.reports.filterOptions(claims, id);
  }

  @Post(":id/run")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  run(@CurrentClaims() claims: RequestClaims, @Param("id", ReportIdPipe) id: string, @Body() body: RunReportDto) {
    return this.reports.run(claims, id, body.filters ?? {});
  }

  @Post(":id/export")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async export(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", ReportIdPipe) id: string,
    @Body() body: RunReportDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const { filename, csv } = await this.reports.exportCsv(claims, id, body.filters ?? {});
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return csv;
  }

  @Put(":id/favorite")
  favorite(@CurrentClaims() claims: RequestClaims, @Param("id", ReportIdPipe) id: string) {
    return this.reports.setFavorite(claims, id, true);
  }

  @Delete(":id/favorite")
  unfavorite(@CurrentClaims() claims: RequestClaims, @Param("id", ReportIdPipe) id: string) {
    return this.reports.setFavorite(claims, id, false);
  }
}
