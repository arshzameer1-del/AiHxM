import { Module } from "@nestjs/common";
import { LeaveController } from "./leave.controller";
import { LeaveRequestsService } from "./leave-requests.service";
import { LeaveTypesService } from "./leave-types.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { LeaveDurationSettingsService } from "./leave-duration-settings.service";
import { LeaveValidationRulesService } from "./leave-validation-rules.service";
import { LeaveRequestValidationService } from "./leave-request-validation.service";
import { LeaveAccrualService } from "./leave-accrual.service";
import { LeaveYearEndService } from "./leave-year-end.service";
import { AttendanceEvaluationService } from "./attendance-evaluation.service";
import { AttendanceDevicesService } from "./attendance-devices.service";
import { TimesheetsService } from "./timesheets.service";
import { AttendanceOpsController, DeviceIngestController } from "./attendance-ops.controller";
import { DeviceKeyGuard } from "./device-key.guard";
import { AttendanceService } from "./attendance.service";
import { AttendanceAutoCloseService } from "./attendance-auto-close.service";
import { AttendanceAutoCloseScheduler } from "./attendance-auto-close.scheduler";
import { AttendanceCorrectionsService } from "./attendance-corrections.service";
import { OvertimeService } from "./overtime.service";
import { WorkProfileService } from "./work-profile.service";
import { OnDutyService } from "./on-duty.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EmployeeGroupsModule } from "../employee-groups/employee-groups.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { ShiftsModule } from "../shifts/shifts.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";

// HolidaysModule is no longer imported directly here: WorkScheduleResolutionService
// (exported by ShiftsModule, already imported below) now owns the one
// holiday lookup this module's services needed — see
// leave-requests.service.ts's countLeaveDays() and attendance.service.ts's
// rowToRecord(), both rewritten 2026-09-18 for the Work Schedule &
// Employee Schedule Assignment Architecture.
//
// EffectiveDatingModule is imported for OvertimeService's overtime policy
// (a single open row per company, versioned exactly like Tax Slabs — see
// 0038_overtime.sql's header comment).

@Module({
  imports: [
    RbacModule,
    EntitlementsModule,
    AuditModule,
    EmployeeGroupsModule,
    WorkflowModule,
    ShiftsModule,
    EffectiveDatingModule,
  ],
  controllers: [LeaveController, AttendanceOpsController, DeviceIngestController],
  providers: [LeaveRequestsService, LeaveTypesService, LeaveLedgerService, LeaveDurationSettingsService, LeaveValidationRulesService, LeaveRequestValidationService, LeaveAccrualService, LeaveYearEndService, AttendanceEvaluationService, AttendanceDevicesService, TimesheetsService, DeviceKeyGuard, AttendanceService, AttendanceAutoCloseService, AttendanceAutoCloseScheduler, AttendanceCorrectionsService, OvertimeService, WorkProfileService, OnDutyService],
  exports: [LeaveRequestsService, LeaveTypesService, LeaveLedgerService, LeaveDurationSettingsService, LeaveValidationRulesService, LeaveAccrualService, LeaveYearEndService, AttendanceEvaluationService, AttendanceDevicesService, TimesheetsService, AttendanceService, AttendanceAutoCloseService, AttendanceCorrectionsService, OvertimeService, WorkProfileService, OnDutyService],
})
export class LeaveModule {}
