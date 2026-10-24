import { DataQualitySnapshotService } from "./quality/data-quality-snapshot.service";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerModule } from "../mailer/mailer.module";
import { RbacModule } from "../rbac/rbac.module";
import { BuilderService } from "./builder/builder.service";
import { ExportService } from "./export/export.service";
import { OverviewService } from "./overview.service";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import {
  DashboardsController,
  ReportBuilderController,
  ReportExportsController,
  ReportSchedulesController,
  ReportsOverviewController,
  SavedReportsController,
} from "./reports-v2.controllers";
import { DashboardsService } from "./saved/dashboards.service";
import { ReportRunnerService } from "./saved/runner.service";
import { SavedReportsService } from "./saved/saved-reports.service";
import { SharingService } from "./saved/sharing.service";
import { ReportScheduleWorker } from "./schedules/schedule.worker";
import { SchedulesService } from "./schedules/schedules.service";

@Module({
  imports: [AuditModule, EntitlementsModule, MailerModule, RbacModule],
  // fixed-path controllers first: "reports/builder/run" must not be read as the catalog route "reports/:id/run"
  controllers: [ReportsOverviewController, ReportBuilderController, SavedReportsController, DashboardsController, ReportSchedulesController, ReportExportsController, ReportsController],
  providers: [ReportsService, BuilderService, ReportRunnerService, SavedReportsService, SharingService, DashboardsService, ExportService, SchedulesService, ReportScheduleWorker, OverviewService, DataQualitySnapshotService],
})
export class ReportsModule {}
