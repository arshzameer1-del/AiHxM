import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { RequestContextMiddleware } from "./common/request-context";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { DatabaseInputErrorFilter } from "./common/database-input-error.filter";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AUTH_IP_LIMIT_PER_MINUTE, isAuthStepPath } from "./common/auth-throttle";
import { RedisThrottlerStorage } from "./common/redis-throttler.storage";
import { SIGNED_IN_LIMIT_PER_MINUTE, sessionSubject } from "./common/session-throttle";
import { ScheduleModule } from "@nestjs/schedule";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { CacheModule } from "./cache/cache.module";
import { AuthModule } from "./auth/auth.module";
import { CompaniesModule } from "./companies/companies.module";
import { AuditModule } from "./audit/audit.module";
import { IdempotencyModule } from "./idempotency/idempotency.module";
import { BackgroundJobsModule } from "./background-jobs/background-jobs.module";
import { DomainEventsModule } from "./domain-events/domain-events.module";
import { PlatformAdminsModule } from "./platform-admins/platform-admins.module";
import { RbacModule } from "./rbac/rbac.module";
import { EntitlementsModule } from "./entitlements/entitlements.module";
import { demoFixtureModules } from "./dummy/demo-fixtures.gate";
import { WorkflowModule } from "./workflow/workflow.module";
import { CustomFieldsModule } from "./custom-fields/custom-fields.module";
import { CareersModule } from "./careers/careers.module";
import { AttendancePenaltiesModule } from "./attendance-penalties/attendance-penalties.module";
import { AnnouncementsModule } from "./announcements/announcements.module";
import { MessagingModule } from "./messaging/messaging.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { RemindersModule } from "./reminders/reminders.module";
import { DocumentTemplatesModule } from "./document-templates/document-templates.module";
import { ImportExportModule } from "./import-export/import-export.module";
import { FileStorageModule } from "./file-storage/file-storage.module";
import { EmployeesModule } from "./employees/employees.module";
import { EmployeeGroupsModule } from "./employee-groups/employee-groups.module";
import { OrganizationModule } from "./organization/organization.module";
import { ShiftsModule } from "./shifts/shifts.module";
import { HolidaysModule } from "./holidays/holidays.module";
import { LeaveModule } from "./leave/leave.module";
import { ExpensesModule } from "./expenses/expenses.module";
import { LearningModule } from "./learning/learning.module";
import { RecruitmentModule } from "./recruitment/recruitment.module";
import { PerformanceModule } from "./performance/performance.module";
import { SystemAdminModule } from "./system-admin/system-admin.module";
import { PayrollModule } from "./payroll/payroll.module";
import { SignupModule } from "./signup/signup.module";
import { DemoRequestsModule } from "./demo-requests/demo-requests.module";
import { ReportsModule } from "./reports/reports.module";
import { ConfigurationCenterModule } from "./configuration-center/configuration-center.module";
import { StarterSetupModule } from "./starter-setup/starter-setup.module";
import { OnboardingOffboardingModule } from "./onboarding-offboarding/onboarding-offboarding.module";
import { TenantManagementModule } from "./tenant-management/tenant-management.module";
import { UsageTrackingInterceptor } from "./tenant-management/usage-tracking.interceptor";
import { PublicBrandingModule } from "./public-branding/public-branding.module";
import { PlatformBrandingModule } from "./platform-branding/platform-branding.module";
import { DataSubjectRequestsModule } from "./data-subject-requests/data-subject-requests.module";
import { EmployeeRequestsModule } from "./employee-requests/employee-requests.module";
import { CompanyAppearanceModule } from "./company-appearance/company-appearance.module";
import { SsoModule } from "./sso/sso.module";
import { ScimModule } from "./scim/scim.module";
import { HrAdministrationModule } from "./hr-administration/hr-administration.module";

/**
 * Phase 2/3/4/5 root module: health check, the Platform Provisioning Panel
 * (companies, config, admins, audit log), Platform Admin management, real
 * auth (password + mandatory MFA), the RBAC / field-permission engine, and
 * the module-licensing gate every subsequent tenant-facing feature module
 * (starting with Employee Core, Phase 7) is built against.
 *
 * ThrottlerModule is registered globally (default: 100 req/min per IP) as
 * a generic abuse guard (100 per minute per address; a signed-in person is counted by themselves with a higher limit, see common/session-throttle.ts) — auth.controller.ts's public, unauthenticated
 * endpoints layer a much stricter per-route limit on top via `@Throttle`,
 * since account lockout alone (AuthService) only protects a KNOWN
 * account's password, not a brute-force sweep across many harvested
 * emails, and doesn't rate-limit MFA code guessing at all.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      ...(process.env.REDIS_URL ? { storage: new RedisThrottlerStorage(process.env.REDIS_URL) } : {}),
      throttlers: [
      {
        name: "default",
        ttl: 60_000,
        limit: (ctx) => (sessionSubject(ctx.switchToHttp().getRequest()) ? SIGNED_IN_LIMIT_PER_MINUTE : 100),
        getTracker: (req) => {
          const who = sessionSubject(req);
          return who ? `user:${who}` : String(req.ip);
        },
      },
      // Broad per-address cap on the sign-in routes only (the per-route limits above count per address AND account).
      {
        name: "authIp",
        ttl: 60_000,
        limit: AUTH_IP_LIMIT_PER_MINUTE,
        getTracker: (req) => `authip:${req.ip}`,
        skipIf: (ctx) => !isAuthStepPath(ctx.switchToHttp().getRequest().path),
      },
      ],
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    CacheModule,
    AuthModule,
    CompaniesModule,
    AuditModule,
    IdempotencyModule,
    BackgroundJobsModule,
    DomainEventsModule,
    PlatformAdminsModule,
    RbacModule,
    EntitlementsModule,
    ...demoFixtureModules(),
    WorkflowModule,
    CustomFieldsModule,
    AnnouncementsModule,
    CareersModule,
    AttendancePenaltiesModule,
    MessagingModule,
    NotificationsModule,
    RemindersModule,
    DocumentTemplatesModule,
    ImportExportModule,
    FileStorageModule,
    OrganizationModule,
    HrAdministrationModule,
    EmployeesModule,
    EmployeeGroupsModule,
    ShiftsModule,
    HolidaysModule,
    LeaveModule,
    ExpensesModule,
    LearningModule,
    DataSubjectRequestsModule,
    EmployeeRequestsModule,
    CompanyAppearanceModule,
    SsoModule,
    ScimModule,
    RecruitmentModule,
    PerformanceModule,
    SystemAdminModule,
    PayrollModule,
    ConfigurationCenterModule,
    StarterSetupModule,
    OnboardingOffboardingModule,
    SignupModule,
    DemoRequestsModule,
    ReportsModule,
    TenantManagementModule,
    PublicBrandingModule,
    PlatformBrandingModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: UsageTrackingInterceptor },
    { provide: APP_FILTER, useClass: DatabaseInputErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
