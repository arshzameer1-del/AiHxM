import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsBoolean, IsIn, IsObject, IsOptional } from "class-validator";
import { DATE_PRESETS } from "./engine/presets";
import type { Response } from "express";
import type { ReportDatePreset } from "@aihxm/shared-types";
import { CurrentClaims } from "../auth/current-claims.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { RequestClaims } from "../database/tenant-context";
import { ReportsService } from "./reports.service";
import { ExportService } from "./export/export.service";
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

  @IsOptional()
  @IsIn(DATE_PRESETS as unknown as string[])
  preset?: ReportDatePreset;

  @IsOptional()
  @IsBoolean()
  compare?: boolean;
}

@Controller("reports")
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ExportService
  ) {}

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
    return this.reports.run(claims, id, body.filters ?? {}, { preset: body.preset, compare: body.compare });
  }

  @Post(":id/export")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", ReportIdPipe) id: string,
    @Body() body: RunReportDto,
    @Query("format") format: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    const f = await this.exports.build(claims, { kind: "catalog", reportId: id, filters: body.filters ?? {}, preset: body.preset ?? null, compare: false }, ExportService.parseFormat(format));
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    return f.buffer;
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
