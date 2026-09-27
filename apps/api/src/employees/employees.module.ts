import { Module } from "@nestjs/common";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { PersonsService } from "./persons.service";
import { HiringController, HiringConfigurationController } from "./hiring/hiring.controller";
import { HiringProcessService } from "./hiring/hiring-process.service";
import { EmployeeContactsController } from "./employee-contacts.controller";
import { EmployeeContactsService } from "./employee-contacts.service";
import { EmployeeAddressesController } from "./employee-addresses.controller";
import { EmployeeAddressesService } from "./employee-addresses.service";
import { EmployeeImportantDatesController } from "./employee-important-dates.controller";
import { EmployeeImportantDatesService } from "./employee-important-dates.service";
import { EmployeePaymentAccountsController } from "./employee-payment-accounts.controller";
import { EmployeePaymentAccountsService } from "./employee-payment-accounts.service";
import { EmployeeCostAllocationsController } from "./employee-cost-allocations.controller";
import { EmployeeCostAllocationsService } from "./employee-cost-allocations.service";
import { EmployeeFamilyMembersController } from "./employee-family-members.controller";
import { EmployeeFamilyMembersService } from "./employee-family-members.service";
import { EmployeeEducationController } from "./employee-education.controller";
import { EmployeeEducationService } from "./employee-education.service";
import { EmployeeQualificationsController } from "./employee-qualifications.controller";
import { EmployeeQualificationsService } from "./employee-qualifications.service";
import { EmployeeAssetsController } from "./employee-assets.controller";
import { EmployeeAssetsService } from "./employee-assets.service";
import { EmployeeLifecycleController } from "./employee-lifecycle.controller";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";
import { EmployeeAnalyticsController } from "./employee-analytics.controller";
import { EmployeeAnalyticsService } from "./employee-analytics.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { ShiftsModule } from "../shifts/shifts.module";
import { PayrollModule } from "../payroll/payroll.module";
import { ImportExportModule } from "../import-export/import-export.module";
import { HrAdministrationModule } from "../hr-administration/hr-administration.module";

@Module({
  // Phase 3 item #4 — WebhooksModule is deliberately slim (exports only
  // WebhookDispatchService, imports nothing of ours) specifically so this
  // module can depend on it without pulling in TenantManagementModule —
  // see WebhooksModule's own doc comment.
  // Phase 7 — ShiftsModule imports NEITHER EmployeesModule nor anything
  // that transitively does (its own imports are RbacModule/
  // EntitlementsModule/AuditModule/EffectiveDatingModule/RulesEngineModule/
  // HolidaysModule), so this is not a circular module dependency — unlike
  // OrganizationModule, which already imports EmployeesModule and is why
  // the `organization_assignment`/`reporting_relationships` cards map onto
  // EmployeesService's own existing fields instead of a new DI edge back
  // into that module (see hiring-process.service.ts's own comment).
  // Phase 8 — PayrollModule likewise imports none of EmployeesModule's own
  // exports (RbacModule/EntitlementsModule/AuditModule/ImportExportModule/
  // EffectiveDatingModule only), so importing it here for
  // PayrollService.setCompensationWithinTransaction() is not circular
  // either.
  // HR Administration v2 — HrAdministrationModule imports nothing of
  // EmployeesModule's own (see its own doc comment), so importing it here
  // for EmployeesService/EmployeeLifecycleService's `employment_type`/
  // `lifecycle_reason:*` validation is not circular either.
  imports: [
    RbacModule,
    EntitlementsModule,
    AuditModule,
    FileStorageModule,
    WebhooksModule,
    ShiftsModule,
    PayrollModule,
    ImportExportModule,
    HrAdministrationModule,
  ],
  // Core Employee Enterprise Phase 2/3 — HiringController (the hire
  // process engine) and HiringConfigurationController (Phase 3's scoped
  // Configuration Center admin surface) live here, not their own module,
  // for the same reason PersonsService does — see HiringProcessService's
  // own class doc comment.
  // Phase 6 — EmployeeContactsController/EmployeeAddressesController are
  // the Contact/Addresses cards' own CRUD surface for an EXISTING
  // employee (0084_core_employee_contact_address.sql); HiringProcessService
  // itself calls their services' createWithinTransaction() directly at
  // hire completion, the same transaction-sharing pattern Phase 2
  // established for EmployeesService.
  controllers: [
    EmployeesController,
    HiringController,
    HiringConfigurationController,
    EmployeeContactsController,
    EmployeeAddressesController,
    EmployeeImportantDatesController,
    EmployeePaymentAccountsController,
    EmployeeCostAllocationsController,
    EmployeeFamilyMembersController,
    EmployeeEducationController,
    EmployeeQualificationsController,
    EmployeeAssetsController,
    EmployeeLifecycleController,
    EmployeeAnalyticsController,
  ],
  // PersonsService is exported so a later phase's own module can read
  // persons without duplicating this provider; HiringProcessService is
  // exported for the same reason.
  providers: [
    EmployeesService,
    PersonsService,
    HiringProcessService,
    EmployeeContactsService,
    EmployeeAddressesService,
    EmployeeImportantDatesService,
    EmployeePaymentAccountsService,
    EmployeeCostAllocationsService,
    EmployeeFamilyMembersService,
    EmployeeEducationService,
    EmployeeQualificationsService,
    EmployeeAssetsService,
    EmployeeLifecycleService,
    EmployeeAnalyticsService,
  ],
  exports: [
    EmployeesService,
    PersonsService,
    HiringProcessService,
    EmployeeContactsService,
    EmployeeAddressesService,
    EmployeeImportantDatesService,
    EmployeePaymentAccountsService,
    EmployeeCostAllocationsService,
    EmployeeFamilyMembersService,
    EmployeeEducationService,
    EmployeeQualificationsService,
    EmployeeAssetsService,
    EmployeeLifecycleService,
    EmployeeAnalyticsService,
  ],
})
export class EmployeesModule {}
