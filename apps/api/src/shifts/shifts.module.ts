import { Module } from "@nestjs/common";
import { ShiftsController } from "./shifts.controller";
import { ShiftRotationsController } from "./shift-rotations.controller";
import { ShiftRotationsService } from "./shift-rotations.service";
import { ShiftsService } from "./shifts.service";
import { WorkScheduleResolutionService } from "./work-schedule-resolution.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { EffectiveDatingModule } from "../effective-dating/effective-dating.module";
import { RulesEngineModule } from "../rules-engine/rules-engine.module";
import { HolidaysModule } from "../holidays/holidays.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, EffectiveDatingModule, RulesEngineModule, HolidaysModule],
  controllers: [ShiftsController, ShiftRotationsController],
  providers: [ShiftsService, WorkScheduleResolutionService, ShiftRotationsService],
  // ShiftsService exported for LeaveModule's AttendanceService to call
  // resolveForEmployeeOnDate() directly — see its own doc comment.
  // WorkScheduleResolutionService exported 2026-09-18 for the same
  // module to consume the higher-level resolution surface (Work Schedule
  // & Employee Schedule Assignment Architecture, Section 20) instead of
  // hand-composing shift + holiday lookups itself.
  exports: [ShiftsService, WorkScheduleResolutionService],
})
export class ShiftsModule {}
