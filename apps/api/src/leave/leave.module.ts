import { Module } from "@nestjs/common";
import { LeaveController } from "./leave.controller";
import { LeaveRequestsService } from "./leave-requests.service";
import { AttendanceService } from "./attendance.service";
import { AttendanceCorrectionsService } from "./attendance-corrections.service";
import { OvertimeService } from "./overtime.service";
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
  controllers: [LeaveController],
  providers: [LeaveRequestsService, AttendanceService, AttendanceCorrectionsService, OvertimeService, OnDutyService],
  exports: [LeaveRequestsService, AttendanceService, AttendanceCorrectionsService, OvertimeService, OnDutyService],
})
export class LeaveModule {}
