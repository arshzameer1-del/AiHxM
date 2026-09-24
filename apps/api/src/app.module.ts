import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { CacheModule } from "./cache/cache.module";
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
import { ShiftsModule } from "./shifts/shifts.module";
import { HolidaysModule } from "./holidays/holidays.module";
import { LeaveModule } from "./leave/leave.module";
import { RecruitmentModule } from "./recruitment/recruitment.module";
import { PerformanceModule } from "./performance/performance.module";
import { SystemAdminModule } from "./system-admin/system-admin.module";
import { PayrollModule } from "./payroll/payroll.module";
import { SignupModule } from "./signup/signup.module";
import { ConfigurationCenterModule } from "./configuration-center/configuration-center.module";
import { OnboardingOffboardingModule } from "./onboarding-offboarding/onboarding-offboarding.module";
import { TenantManagementModule } from "./tenant-management/tenant-management.module";
import { UsageTrackingInterceptor } from "./tenant-management/usage-tracking.interceptor";

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
    CacheModule,
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
    ShiftsModule,
    HolidaysModule,
    LeaveModule,
    RecruitmentModule,
    PerformanceModule,
    SystemAdminModule,
    PayrollModule,
    ConfigurationCenterModule,
    OnboardingOffboardingModule,
    SignupModule,
    TenantManagementModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: UsageTrackingInterceptor },
  ],
})
export class AppModule {}
