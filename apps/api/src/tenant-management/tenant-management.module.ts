import { Module } from "@nestjs/common";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";
import { SavedViewsController } from "./saved-views.controller";
import { SavedViewsService } from "./saved-views.service";
import { TenantConfigurationController } from "./tenant-configuration.controller";
import { TenantConfigurationService } from "./tenant-configuration.service";
import { TenantFeaturesController } from "./tenant-features.controller";
import { TenantFeaturesService } from "./tenant-features.service";
import { SubscriptionController } from "./subscription.controller";
import { SubscriptionService } from "./subscription.service";
import { UsageController } from "./usage.controller";
import { UsageService } from "./usage.service";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { SupportTicketsController } from "./support-tickets.controller";
import { SupportTicketsService } from "./support-tickets.service";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";
import { DataExportsController } from "./data-exports.controller";
import { DataExportsService } from "./data-exports.service";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { ImportExportModule } from "../import-export/import-export.module";

/**
 * Home for the Platform Admin "Tenant Management" module's pieces that
 * don't naturally belong inside an existing module (companies.module.ts
 * already owns everything that's really about the `companies` row itself
 * — profile, lifecycle, config, admins). Sessions, Saved Views, Tenant
 * Configuration, and Feature Entitlements live here; more Tenant
 * Management resources (support tickets, backups, data exports,
 * integrations, health, usage) land in this module as they're built,
 * rather than each becoming a one-off top-level module.
 */
@Module({
  imports: [AuditModule, EntitlementsModule, NotificationsModule, FileStorageModule, ImportExportModule],
  controllers: [
    SessionsController,
    SavedViewsController,
    TenantConfigurationController,
    TenantFeaturesController,
    SubscriptionController,
    UsageController,
    IntegrationsController,
    HealthController,
    SupportTicketsController,
    BackupsController,
    DataExportsController,
  ],
  providers: [
    SessionsService,
    SavedViewsService,
    TenantConfigurationService,
    TenantFeaturesService,
    SubscriptionService,
    UsageService,
    IntegrationsService,
    HealthService,
    SupportTicketsService,
    BackupsService,
    DataExportsService,
  ],
})
export class TenantManagementModule {}
