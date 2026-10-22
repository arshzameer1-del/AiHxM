import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollSchemesController } from "./payroll-schemes.controller";
import { PayrollSchemesService } from "./payroll-schemes.service";
import { PayrollFinalSettlementService } from "./payroll-final-settlement.service";
import { PayrollPaymentsController } from "./payroll-payments.controller";
import { PayrollPaymentsService } from "./payroll-payments.service";
import { PayrollReconciliationService } from "./payroll-reconciliation.service";
import { PayrollAccountingController } from "./payroll-accounting.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { MailerModule } from "../mailer/mailer.module";
import { PayrollPayslipNoticesController } from "./payroll-payslip-notices.controller";
import { PayrollPayslipNoticesService } from "./payroll-payslip-notices.service";
import { PayrollStatutoryReportsController } from "./payroll-statutory-reports.controller";
import { PayrollStatutoryReportsService } from "./payroll-statutory-reports.service";
import { PayrollAccountingService } from "./payroll-accounting.service";
import { PayrollDocumentsController } from "./payroll-documents.controller";
import { PayrollDocumentsService } from "./payroll-documents.service";
import { PayslipDesignController } from "./payslip-design.controller";
import { PayslipDesignService } from "./payslip-design.service";
import { PayrollBenefitsController } from "./payroll-benefits.controller";
import { PayrollBenefitsService } from "./payroll-benefits.service";
import { PayrollOperationsController } from "./payroll-operations.controller";
import { PayrollDashboardService } from "./payroll-dashboard.service";
import { PayrollInputImportService } from "./payroll-input-import.service";
import { PayrollInputImportWorker } from "./payroll-input-import.worker";
import { PayrollService } from "./payroll.service";
import { PayrollRunControlService } from "./payroll-run-control.service";
import { PayrollRetroService } from "./payroll-retro.service";
import { PayrollTaxService } from "./payroll-tax.service";
import { PayrollTaxController } from "./payroll-tax.controller";
import { PayrollCalculationWorker } from "./payroll-calculation.worker";
import { HrAdministrationModule } from "../hr-administration/hr-administration.module";
import { PayrollAreasController } from "./payroll-areas.controller";
import { PayrollAreasService } from "./payroll-areas.service";
import { PayrollPeriodsController } from "./payroll-periods.controller";
import { PayrollPeriodsService } from "./payroll-periods.service";
import { FormulaExpressionEngine } from "./formula-expression.engine";
import { PayrollFormulaService } from "./payroll-formula.service";
import { PayrollFormulaOverridesController } from "./payroll-formula-overrides.controller";
import { PayrollFormulaOverridesService } from "./payroll-formula-overrides.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { ImportExportModule } from "../import-export/import-export.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { LeaveModule } from "../leave/leave.module";
import { ShiftsModule } from "../shifts/shifts.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { EmployeesModule } from "../employees/employees.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";

// Cross-module integration gap audit (2026-10-01) remediation:
//  - LeaveModule: LeaveRequestsService.getApprovedUnpaidLeaveDaysInRange()
//    (item 6 — Payroll no longer queries leave_requests itself) and
//    OvertimeService.getApprovedOvertimeInRange() (item 4/5 — approved,
//    snapshotted overtime amounts reach gross pay).
//  - ShiftsModule: WorkScheduleResolutionService, for schedule-aware
//    (working-day) proration of employees with an explicit work schedule
//    assignment (item 5/10).
//  - WebhooksModule: payroll_run.finalized / payroll_run.disbursed events
//    (item 9), the same slim-module import EmployeesModule/
//    OrganizationModule already use.
// Payroll Enterprise Gap Analysis Phase P3 (2026-10-02):
//  - EmployeesModule: EmployeeLoansService (installment preview at
//    calculate(), repayment ledger write at finalize()) and
//    EmployeeAdditionalPaymentsService (one-time earning/deduction
//    preview + consumed-marking) — unlike compensation (deliberately raw
//    SQL, see EmployeeCompensationService's own class doc comment), both
//    of these need real write-side logic (balance decrement, idempotent
//    ledger rows) at finalize time, so they're injected services, the
//    same posture LeaveModule/ShiftsModule already established for
//    Leave/Overtime. EmployeesModule does not import PayrollModule
//    (directly or transitively — only ConfigurationCenterModule does,
//    and EmployeesModule does not import that), so this is not circular.
// Payroll Enterprise Gap Analysis Phase P4 (2026-10-02):
//  - EmployeesModule also exports EmployeeOffCyclePaymentsService now
//    (the IT0267 equivalent) — same reasoning, same module, no new import.
@Module({
  imports: [
    RbacModule,
    EntitlementsModule,
    AuditModule,
    ImportExportModule,
    EffectiveDatingModule,
    WorkflowModule,
    LeaveModule,
    ShiftsModule,
    WebhooksModule,
    EmployeesModule,
    HrAdministrationModule,
    EmployeeGroupsModule,
    NotificationsModule,
    MailerModule,
  ],
  // Payroll Areas (0101_payroll_areas.sql) — needs only RbacModule/
  // EntitlementsModule/AuditModule, all already imported above.
  // Payroll Formula Engine (0105_payroll_formulas.sql) — FormulaExpressionEngine
  // is a pure, dependency-free numeric evaluator (deliberately separate from
  // the boolean-only RulesEngine; see its header). PayrollFormulaService
  // resolves/evaluates overrides inside calculateRun(); the Overrides
  // service/controller manage them. All reuse modules already imported above.
  controllers: [PayrollController, PayrollPaymentsController, PayrollSchemesController, PayrollAccountingController, PayrollStatutoryReportsController, PayrollPayslipNoticesController, PayrollDocumentsController, PayslipDesignController, PayrollBenefitsController, PayrollOperationsController, PayrollAreasController, PayrollPeriodsController, PayrollFormulaOverridesController, PayrollTaxController],
  providers: [PayrollService, PayrollRunControlService, PayrollAreasService, PayrollPeriodsService, FormulaExpressionEngine, PayrollFormulaService, PayrollFormulaOverridesService, PayrollCalculationWorker, PayrollRetroService, PayrollTaxService, PayrollPaymentsService, PayrollReconciliationService, PayrollSchemesService, PayrollFinalSettlementService, PayrollAccountingService, PayrollStatutoryReportsService, PayrollPayslipNoticesService, PayrollDocumentsService, PayslipDesignService, PayrollBenefitsService, PayrollDashboardService, PayrollInputImportService, PayrollInputImportWorker],
  exports: [PayrollService, PayrollAccountingService, PayrollDocumentsService, PayslipDesignService, PayrollBenefitsService, PayrollDashboardService, PayrollInputImportService, PayrollSchemesService, PayrollFinalSettlementService, PayrollPaymentsService, PayrollReconciliationService, PayrollRetroService, PayrollTaxService, PayrollRunControlService, PayrollAreasService, PayrollPeriodsService],
})
export class PayrollModule {}
