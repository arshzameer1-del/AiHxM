import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ShiftsService } from "./shifts.service";
import { WorkScheduleResolutionService } from "./work-schedule-resolution.service";
import { CreateShiftDto } from "./dto/create-shift.dto";
import { UpdateShiftDto } from "./dto/update-shift.dto";
import { AssignShiftDto } from "./dto/assign-shift.dto";
import { SetWeeklyPatternDto } from "./dto/set-weekly-pattern.dto";
import { CreateWorkScheduleAssignmentRuleDto, UpdateWorkScheduleAssignmentRuleDto } from "./dto/work-schedule-assignment-rule.dto";

/**
 * Any real session can call these (SessionGuard) — ShiftsService's own
 * entitlement + RBAC checks decide who succeeds, same split every module
 * since Phase 4 has used. `employees/:employeeId/shift*`/`work-schedule`
 * routes are declared here (not in EmployeesController) to keep the
 * schema's ownership in one module, matching how Payroll owns
 * `employees/:id`-adjacent payroll data via its own controller too.
 */
@Controller()
@UseGuards(SessionGuard)
export class ShiftsController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly workSchedule: WorkScheduleResolutionService
  ) {}

  @Post("shifts")
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateShiftDto) {
    return this.shifts.createShift(claims, dto);
  }

  @Get("shifts")
  list(@CurrentClaims() claims: RequestClaims) {
    return this.shifts.listShifts(claims);
  }

  @Patch("shifts/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateShiftDto) {
    return this.shifts.updateShift(claims, id, dto);
  }

  @Get("shifts/:id/weekly-pattern")
  getWeeklyPattern(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.shifts.getWeeklyPattern(claims, id);
  }

  @Put("shifts/:id/weekly-pattern")
  setWeeklyPattern(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetWeeklyPatternDto) {
    return this.shifts.setWeeklyPattern(claims, id, dto);
  }

  @Post("shift-assignment-rules")
  createAssignmentRule(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateWorkScheduleAssignmentRuleDto) {
    return this.shifts.createAssignmentRule(claims, dto);
  }

  @Get("shift-assignment-rules")
  listAssignmentRules(@CurrentClaims() claims: RequestClaims) {
    return this.shifts.listAssignmentRules(claims);
  }

  @Patch("shift-assignment-rules/:id")
  updateAssignmentRule(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateWorkScheduleAssignmentRuleDto
  ) {
    return this.shifts.updateAssignmentRule(claims, id, dto);
  }

  @Delete("shift-assignment-rules/:id")
  deleteAssignmentRule(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.shifts.deleteAssignmentRule(claims, id);
  }

  @Post("shift-assignments")
  assign(@CurrentClaims() claims: RequestClaims, @Body() dto: AssignShiftDto) {
    return this.shifts.assignShift(claims, dto);
  }

  @Get("employees/:employeeId/shift")
  getCurrent(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.shifts.getCurrentShift(claims, employeeId);
  }

  @Get("employees/:employeeId/shift-history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.shifts.getAssignmentHistory(claims, employeeId);
  }

  /** Section 36's `GET /employees/:id/work-schedule?date=` — the resolved-schedule preview (Section 28), also usable by any future consumer that just wants "what applies on this date" without re-deriving it from the shift + weekly pattern + holiday calendar itself. Defaults to today when `date` is omitted. */
  @Get("employees/:employeeId/work-schedule")
  getEffectiveSchedule(
    @CurrentClaims() claims: RequestClaims,
    @Param("employeeId") employeeId: string,
    @Query("date") date?: string
  ) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException("date must be YYYY-MM-DD");
    }
    return this.workSchedule.getEffectiveSchedule(claims, employeeId, date ?? new Date().toISOString().slice(0, 10));
  }
}
