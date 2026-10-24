import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import type { Response } from "express";
import type { ReportDatePreset, ReportExportFormat, SaveDashboardRequest, SaveReportRequest, SaveScheduleRequest } from "@aihxm/shared-types";
import { CurrentClaims } from "../auth/current-claims.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { RequestClaims } from "../database/tenant-context";
import { BuilderService } from "./builder/builder.service";
import { DATE_PRESETS } from "./engine/presets";
import { ExportService } from "./export/export.service";
import { OverviewService } from "./overview.service";
import { SchedulesService } from "./schedules/schedules.service";
import { DashboardsService } from "./saved/dashboards.service";
import { SavedReportsService } from "./saved/saved-reports.service";

const PRESETS = DATE_PRESETS as unknown as string[];
const FORMATS = ["csv", "xlsx", "pdf"];

export class SaveReportDto implements SaveReportRequest {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsIn(["catalog", "custom"]) kind!: "catalog" | "custom";
  @IsOptional() @IsString() @MaxLength(3) reportId?: string;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() @IsIn(PRESETS) preset?: ReportDatePreset | null;
  @IsOptional() @IsBoolean() compare?: boolean;
  @IsOptional() @IsObject() definition?: SaveReportRequest["definition"];
}

export class ShareDto {
  @IsArray() grantees!: Array<{ type: "user" | "role"; id: string }>;
}

export class BuilderRunDto {
  @IsObject() definition!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsIn(FORMATS) format?: ReportExportFormat;
}

export class SaveDashboardDto implements SaveDashboardRequest {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsArray() widgets?: SaveDashboardRequest["widgets"];
}

export class SaveScheduleDto implements SaveScheduleRequest {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(3) reportId?: string | null;
  @IsOptional() @IsUUID() savedReportId?: string | null;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsIn(["daily", "weekly", "monthly"]) frequency!: SaveScheduleRequest["frequency"];
  @IsOptional() @IsInt() @Min(0) @Max(6) dayOfWeek?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(28) dayOfMonth?: number | null;
  @IsInt() @Min(0) @Max(23) hourLocal!: number;
  @IsIn(FORMATS) format!: ReportExportFormat;
  @IsOptional() @IsIn(PRESETS) preset?: ReportDatePreset | null;
  @IsArray() recipientUserIds!: string[];
}

export class StatusDto {
  @IsIn(["active", "paused"]) status!: "active" | "paused";
}

export class ExportQueryDto {
  @IsOptional() @IsIn(FORMATS) format?: ReportExportFormat;
}

function send(res: Response, f: { filename: string; mime: string; buffer: Buffer }): Buffer {
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return f.buffer;
}

// These controllers are listed BEFORE ReportsController in the module: their fixed paths (reports/saved, reports/builder ...)
// must be matched before the catalog report routes (reports/:id/run), which would otherwise take "builder" for a report id.

@Controller("reports/overview")
@UseGuards(SessionGuard)
export class ReportsOverviewController {
  constructor(private readonly overview: OverviewService) {}
  @Get()
  get(@CurrentClaims() claims: RequestClaims) {
    return this.overview.overview(claims);
  }
}

@Controller("reports/builder")
@UseGuards(SessionGuard)
export class ReportBuilderController {
  constructor(
    private readonly builder: BuilderService,
    private readonly exports: ExportService
  ) {}

  @Get("datasets")
  datasets(@CurrentClaims() claims: RequestClaims) {
    return this.builder.catalog(claims);
  }

  @Get("datasets/:dataset/fields/:field/values")
  values(@CurrentClaims() claims: RequestClaims, @Param("dataset") dataset: string, @Param("field") field: string) {
    return this.builder.values(claims, dataset, field);
  }

  @Post("run")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async run(@CurrentClaims() claims: RequestClaims, @Body() body: BuilderRunDto) {
    await this.builder.catalog(claims); // building needs reports.build
    return (await this.builder.run(claims, body.definition, { rowLimit: 500, kind: "run", title: body.title })).result;
  }

  @Post("export")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(@CurrentClaims() claims: RequestClaims, @Body() body: BuilderRunDto, @Res({ passthrough: true }) res: Response) {
    await this.builder.catalog(claims);
    const f = await this.exports.build(claims, { kind: "custom", definition: body.definition as never, title: body.title ?? "Custom report" }, ExportService.parseFormat(body.format), { title: body.title });
    return send(res, f);
  }
}

@Controller("reports/saved")
@UseGuards(SessionGuard)
export class SavedReportsController {
  constructor(
    private readonly saved: SavedReportsService,
    private readonly exports: ExportService
  ) {}

  @Get() list(@CurrentClaims() claims: RequestClaims) { return this.saved.list(claims); }
  @Post() create(@CurrentClaims() claims: RequestClaims, @Body() body: SaveReportDto) { return this.saved.create(claims, body); }
  @Get("share-targets") targets(@CurrentClaims() claims: RequestClaims) { return this.saved.targets(claims); }
  @Get(":id") get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.saved.get(claims, id); }
  @Put(":id") update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() body: SaveReportDto) { return this.saved.update(claims, id, body); }
  @Delete(":id") archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.saved.archive(claims, id); }

  @Post(":id/run")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  run(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.saved.run(claims, id); }

  @Post(":id/export")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Query() q: ExportQueryDto, @Res({ passthrough: true }) res: Response) {
    const { source, row } = await this.saved.sourceFor(claims, id);
    return send(res, await this.exports.build(claims, source, ExportService.parseFormat(q.format), { title: row.name, savedReportId: id }));
  }

  @Get(":id/shares") shares(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.saved.shares(claims, id); }
  @Put(":id/shares") setShares(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() body: ShareDto) { return this.saved.setShares(claims, id, body.grantees); }
}

@Controller("reports/dashboards")
@UseGuards(SessionGuard)
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Get() list(@CurrentClaims() claims: RequestClaims) { return this.dashboards.list(claims); }
  @Post() create(@CurrentClaims() claims: RequestClaims, @Body() body: SaveDashboardDto) { return this.dashboards.create(claims, body); }
  @Get(":id") get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.dashboards.get(claims, id); }
  @Put(":id") update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() body: SaveDashboardDto) { return this.dashboards.update(claims, id, body); }
  @Delete(":id") archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.dashboards.archive(claims, id); }

  @Get(":id/data")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  data(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.dashboards.data(claims, id); }

  @Get(":id/shares") shares(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.dashboards.shares(claims, id); }
  @Put(":id/shares") setShares(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() body: ShareDto) { return this.dashboards.setShares(claims, id, body.grantees); }
}

@Controller("reports/schedules")
@UseGuards(SessionGuard)
export class ReportSchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get() list(@CurrentClaims() claims: RequestClaims) { return this.schedules.list(claims); }
  @Post() create(@CurrentClaims() claims: RequestClaims, @Body() body: SaveScheduleDto) { return this.schedules.create(claims, body); }
  @Get("inbox") inbox(@CurrentClaims() claims: RequestClaims) { return this.schedules.inbox(claims); }

  @Get("deliveries/:deliveryId/download")
  @Header("Cache-Control", "no-store")
  async download(@CurrentClaims() claims: RequestClaims, @Param("deliveryId") deliveryId: string, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.schedules.download(claims, deliveryId));
  }

  @Put(":id") update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() body: SaveScheduleDto) { return this.schedules.update(claims, id, body); }
  @Put(":id/status") status(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() body: StatusDto) { return this.schedules.setStatus(claims, id, body.status); }
  @Delete(":id") remove(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.schedules.remove(claims, id); }
  @Get(":id/deliveries") deliveries(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.schedules.deliveries(claims, id); }

  @Post(":id/run-now")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  runNow(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) { return this.schedules.runNow(claims, id); }
}

@Controller("reports/exports")
@UseGuards(SessionGuard)
export class ReportExportsController {
  constructor(private readonly exports: ExportService) {}
  @Get("history")
  history(@CurrentClaims() claims: RequestClaims) {
    return this.exports.history(claims);
  }
}
