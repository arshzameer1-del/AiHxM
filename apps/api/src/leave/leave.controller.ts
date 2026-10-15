import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { LeaveRequestsService } from "./leave-requests.service";
import { LeaveTypesService } from "./leave-types.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { AdjustLeaveBalanceDto, CreateLeaveTypeDto, DecideLeaveCancellationDto, RequestLeaveCancellationDto, UpdateLeaveTypeDto } from "./dto/leave-type.dto";
import { AttendanceService } from "./attendance.service";
import { AttendanceCorrectionsService } from "./attendance-corrections.service";
import { OvertimeService } from "./overtime.service";
import { OnDutyService } from "./on-duty.service";
import { SubmitLeaveRequestDto } from "./dto/submit-leave-request.dto";
import { UpdateLeaveRequestDto } from "./dto/update-leave-request.dto";
import { TeamCalendarQueryDto } from "./dto/team-calendar-query.dto";
import { DecideLeaveRequestDto } from "./dto/decide-leave-request.dto";
import { ClockInDto } from "./dto/clock-in.dto";
import { ClockOutDto } from "./dto/clock-out.dto";
import { SubmitAttendanceCorrectionDto } from "./dto/submit-attendance-correction.dto";
import { DecideAttendanceCorrectionDto } from "./dto/decide-attendance-correction.dto";
import { SetOvertimePolicyDto, SetScopedOvertimePolicyDto } from "./dto/set-overtime-policy.dto";
import { SetCompanyWorkTimeDefaultDto, SetWorkProfileDto } from "./dto/work-profile.dto";
import { WorkProfileService } from "./work-profile.service";
import { CreateOvertimeAuthorizationDto, SubmitOvertimeClaimDto } from "./dto/submit-overtime-claim.dto";
import { DecideOvertimeClaimDto } from "./dto/decide-overtime-claim.dto";
import { SubmitOnDutyRequestDto } from "./dto/submit-on-duty-request.dto";
import { DecideOnDutyRequestDto } from "./dto/decide-on-duty-request.dto";

/**
 * Any real session can call these (SessionGuard) — LeaveRequestsService/
 * AttendanceService's own entitlement + permission (and, for decisions,
 * workflow-routing) checks are what actually decide who succeeds, the
 * same split every module since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class LeaveController {
  constructor(
    private readonly leaveRequests: LeaveRequestsService,
    private readonly attendance: AttendanceService,
    private readonly attendanceCorrections: AttendanceCorrectionsService,
    private readonly overtime: OvertimeService,
    private readonly workProfiles: WorkProfileService,
    private readonly onDuty: OnDutyService,
    private readonly leaveTypes: LeaveTypesService,
    private readonly ledger: LeaveLedgerService
  ) {}

  // --- TLM-01: leave type catalogue --------------------------------------
  @Get("leave-types")
  listLeaveTypes(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.leaveTypes.list(claims, { includeInactive: includeInactive === "true" });
  }

  @Post("leave-types")
  createLeaveType(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateLeaveTypeDto) {
    return this.leaveTypes.create(claims, dto);
  }

  @Patch("leave-types/:id")
  updateLeaveType(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateLeaveTypeDto) {
    return this.leaveTypes.update(claims, id, dto);
  }

  // --- TLM-02: ledger ----------------------------------------------------
  @Get("employees/:employeeId/leave-ledger")
  leaveLedger(
    @CurrentClaims() claims: RequestClaims,
    @Param("employeeId") employeeId: string,
    @Query("leaveType") leaveType?: string,
    @Query("year") year?: string
  ) {
    return this.ledger.history(claims, employeeId, { leaveType, year: year ? Number(year) : undefined });
  }

  @Post("leave-balances/adjustments")
  adjustLeaveBalance(@CurrentClaims() claims: RequestClaims, @Body() dto: AdjustLeaveBalanceDto) {
    return this.ledger.adjust(claims, dto);
  }

  // --- TLM-03: cancellation of approved leave ----------------------------
  @Post("leave-requests/:id/cancellation-request")
  requestLeaveCancellation(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RequestLeaveCancellationDto) {
    return this.leaveRequests.requestCancellation(claims, id, dto.reason);
  }

  @Patch("leave-requests/:id/cancellation-decision")
  decideLeaveCancellation(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideLeaveCancellationDto) {
    return this.leaveRequests.decideCancellation(claims, id, dto);
  }

  @Post("leave-requests")
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitLeaveRequestDto) {
    return this.leaveRequests.submit(claims, dto);
  }

  @Get("leave-requests")
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.leaveRequests.listRequests(claims, { employeeId });
  }

  /** LV-UP. Declared before `leave-requests/:id` so "team-calendar" is not read as an id. */
  @Get("leave-requests/team-calendar")
  teamCalendar(@CurrentClaims() claims: RequestClaims, @Query() query: TeamCalendarQueryDto) {
    return this.leaveRequests.teamCalendar(claims, query);
  }

  /** LV-UP: expected approvers for the create form. Also before `:id`. */
  @Get("leave-requests/approver-preview")
  approverPreview(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.leaveRequests.approverPreview(claims, employeeId);
  }

  /** LV-UP: relief-person candidates (colleagues under the same manager). */
  @Get("leave-requests/colleagues")
  colleagues(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.leaveRequests.listColleagues(claims, employeeId);
  }

  @Get("leave-requests/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.leaveRequests.getRequest(claims, id);
  }

  /** LV-UP: edit a request that is still pending. */
  @Patch("leave-requests/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateLeaveRequestDto) {
    return this.leaveRequests.update(claims, id, dto);
  }

  @Patch("leave-requests/:id/decision")
  decide(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideLeaveRequestDto) {
    return this.leaveRequests.decide(claims, id, dto);
  }

  @Post("leave-requests/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.leaveRequests.cancel(claims, id);
  }

  @Get("employees/:employeeId/leave-balances")
  getBalances(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.leaveRequests.getBalances(claims, employeeId);
  }

  @Post("attendance/clock-in")
  clockIn(@CurrentClaims() claims: RequestClaims, @Body() dto: ClockInDto) {
    return this.attendance.clockIn(claims, dto);
  }

  @Post("attendance/clock-out")
  clockOut(@CurrentClaims() claims: RequestClaims, @Body() dto: ClockOutDto) {
    return this.attendance.clockOut(claims, dto);
  }

  @Get("employees/:employeeId/attendance")
  listAttendance(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.attendance.listForEmployee(claims, employeeId);
  }

  @Post("attendance-corrections")
  submitCorrection(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitAttendanceCorrectionDto) {
    return this.attendanceCorrections.submit(claims, dto);
  }

  @Get("attendance-corrections/pending")
  listPendingCorrections(@CurrentClaims() claims: RequestClaims) {
    return this.attendanceCorrections.listPendingForDecider(claims);
  }

  @Patch("attendance-corrections/:id/decision")
  decideCorrection(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: DecideAttendanceCorrectionDto
  ) {
    return this.attendanceCorrections.decide(claims, id, dto);
  }

  @Get("employees/:employeeId/attendance-corrections")
  listCorrectionsForEmployee(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.attendanceCorrections.listForEmployee(claims, employeeId);
  }

  @Get("overtime-policy")
  getOvertimePolicy(@CurrentClaims() claims: RequestClaims) {
    return this.overtime.getPolicy(claims);
  }

  @Patch("overtime-policy")
  setOvertimePolicy(@CurrentClaims() claims: RequestClaims, @Body() dto: SetOvertimePolicyDto) {
    return this.overtime.setPolicy(claims, dto);
  }

  @Get("overtime-policies")
  listOvertimePolicies(@CurrentClaims() claims: RequestClaims) {
    return this.overtime.listPolicies(claims);
  }

  @Put("overtime-policies/scoped")
  setScopedOvertimePolicy(@CurrentClaims() claims: RequestClaims, @Body() dto: SetScopedOvertimePolicyDto) {
    return this.overtime.setScopedPolicy(claims, dto);
  }

  @Delete("overtime-policies/:id")
  @HttpCode(204)
  endScopedOvertimePolicy(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.overtime.endScopedPolicy(claims, id);
  }

  @Post("overtime-authorizations")
  authorizeOvertime(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateOvertimeAuthorizationDto) {
    return this.overtime.authorize(claims, dto);
  }

  @Delete("overtime-authorizations/:id")
  @HttpCode(204)
  revokeOvertimeAuthorization(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.overtime.revokeAuthorization(claims, id);
  }

  @Get("employees/:employeeId/overtime-authorizations")
  listOvertimeAuthorizations(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.overtime.listAuthorizations(claims, employeeId);
  }

  @Get("company/work-time-default")
  getCompanyWorkTimeDefault(@CurrentClaims() claims: RequestClaims, @Query("asOf") asOf?: string) {
    return this.workProfiles.companyDefault(claims, asOf);
  }

  @Put("company/work-time-default")
  setCompanyWorkTimeDefault(@CurrentClaims() claims: RequestClaims, @Body() dto: SetCompanyWorkTimeDefaultDto) {
    return this.workProfiles.setCompanyDefault(claims, dto);
  }

  @Get("employees/:employeeId/work-profile")
  getWorkProfile(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Query("asOf") asOf?: string) {
    return this.workProfiles.current(claims, employeeId, asOf);
  }

  @Get("employees/:employeeId/work-profile/history")
  workProfileHistory(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.workProfiles.history(claims, employeeId);
  }

  @Put("employees/:employeeId/work-profile")
  setWorkProfile(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: SetWorkProfileDto) {
    return this.workProfiles.set(claims, employeeId, dto);
  }

  @Post("overtime-claims")
  submitOvertimeClaim(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitOvertimeClaimDto) {
    return this.overtime.submit(claims, dto);
  }

  @Get("overtime-claims/pending")
  listPendingOvertimeClaims(@CurrentClaims() claims: RequestClaims) {
    return this.overtime.listPendingForDecider(claims);
  }

  @Patch("overtime-claims/:id/decision")
  decideOvertimeClaim(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: DecideOvertimeClaimDto
  ) {
    return this.overtime.decide(claims, id, dto);
  }

  @Get("employees/:employeeId/overtime-claims")
  listOvertimeClaimsForEmployee(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.overtime.listForEmployee(claims, employeeId);
  }

  @Post("on-duty-requests")
  submitOnDutyRequest(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitOnDutyRequestDto) {
    return this.onDuty.submit(claims, dto);
  }

  @Get("on-duty-requests/pending")
  listPendingOnDutyRequests(@CurrentClaims() claims: RequestClaims) {
    return this.onDuty.listPendingForDecider(claims);
  }

  @Patch("on-duty-requests/:id/decision")
  decideOnDutyRequest(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideOnDutyRequestDto) {
    return this.onDuty.decide(claims, id, dto);
  }

  @Get("employees/:employeeId/on-duty-requests")
  listOnDutyRequestsForEmployee(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.onDuty.listForEmployee(claims, employeeId);
  }
}
