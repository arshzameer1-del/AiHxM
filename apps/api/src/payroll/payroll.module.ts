import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";
import { PayrollAreasController } from "./payroll-areas.controller";
import { PayrollAreasService } from "./payroll-areas.service";
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
  ],
  // Payroll Areas (0101_payroll_areas.sql) — needs only RbacModule/
  // EntitlementsModule/AuditModule, all already imported above.
  // Payroll Formula Engine (0105_payroll_formulas.sql) — FormulaExpressionEngine
  // is a pure, dependency-free numeric evaluator (deliberately separate from
  // the boolean-only RulesEngine; see its header). PayrollFormulaService
  // resolves/evaluates overrides inside calculateRun(); the Overrides
  // service/controller manage them. All reuse modules already imported above.
  controllers: [PayrollController, PayrollAreasController, PayrollFormulaOverridesController],
  providers: [PayrollService, PayrollAreasService, FormulaExpressionEngine, PayrollFormulaService, PayrollFormulaOverridesService],
  exports: [PayrollService, PayrollAreasService],
})
export class PayrollModule {}
