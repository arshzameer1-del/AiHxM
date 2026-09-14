import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { CompaniesModule } from "./companies/companies.module";
import { AuditModule } from "./audit/audit.module";
import { PlatformAdminsModule } from "./platform-admins/platform-admins.module";
import { RbacModule } from "./rbac/rbac.module";
import { EntitlementsModule } from "./entitlements/entitlements.module";
import { DummyModule } from "./dummy/dummy.module";
import { WorkflowModule } from "./workflow/workflow.module";
import { CustomFieldsModule } from "./custom-fields/custom-fields.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { DocumentTemplatesModule } from "./document-templates/document-templates.module";
import { ImportExportModule } from "./import-export/import-export.module";
import { FileStorageModule } from "./file-storage/file-storage.module";
import { EmployeesModule } from "./employees/employees.module";
import { EmployeeGroupsModule } from "./employee-groups/employee-groups.module";
import { LeaveModule } from "./leave/leave.module";
import { RecruitmentModule } from "./recruitment/recruitment.module";
import { PerformanceModule } from "./performance/performance.module";
import { SystemAdminModule } from "./system-admin/system-admin.module";

/**
 * Phase 2/3/4/5 root module: health check, the Platform Provisioning Panel
 * (companies, config, admins, audit log), Platform Admin management, real
 * auth (password + mandatory MFA), the RBAC / field-permission engine, and
 * the module-licensing gate every subsequent tenant-facing feature module
 * (starting with Employee Core, Phase 7) is built against.
 *
 * ThrottlerModule is registered globally (default: 100 req/min per IP) as
 * a generic abuse guard — auth.controller.ts's public, unauthenticated
 * endpoints layer a much stricter per-route limit on top via `@Throttle`,
 * since account lockout alone (AuthService) only protects a KNOWN
 * account's password, not a brute-force sweep across many harvested
 * emails, and doesn't rate-limit MFA code guessing at all.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    CompaniesModule,
    AuditModule,
    PlatformAdminsModule,
    RbacModule,
    EntitlementsModule,
    DummyModule,
    WorkflowModule,
    CustomFieldsModule,
    NotificationsModule,
    DocumentTemplatesModule,
    ImportExportModule,
    FileStorageModule,
    EmployeesModule,
    EmployeeGroupsModule,
    LeaveModule,
    RecruitmentModule,
    PerformanceModule,
    SystemAdminModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
