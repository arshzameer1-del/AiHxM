import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { LeaveRequestsService } from "./leave-requests.service";
import { AttendanceService } from "./attendance.service";
import { AttendanceCorrectionsService } from "./attendance-corrections.service";
import { OvertimeService } from "./overtime.service";
import { OnDutyService } from "./on-duty.service";
import { SubmitLeaveRequestDto } from "./dto/submit-leave-request.dto";
import { DecideLeaveRequestDto } from "./dto/decide-leave-request.dto";
import { ClockInDto } from "./dto/clock-in.dto";
import { ClockOutDto } from "./dto/clock-out.dto";
import { SubmitAttendanceCorrectionDto } from "./dto/submit-attendance-correction.dto";
import { DecideAttendanceCorrectionDto } from "./dto/decide-attendance-correction.dto";
import { SetOvertimePolicyDto } from "./dto/set-overtime-policy.dto";
import { SubmitOvertimeClaimDto } from "./dto/submit-overtime-claim.dto";
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
    private readonly onDuty: OnDutyService
  ) {}

  @Post("leave-requests")
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitLeaveRequestDto) {
    return this.leaveRequests.submit(claims, dto);
  }

  @Get("leave-requests")
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.leaveRequests.listRequests(claims, { employeeId });
  }

  @Get("leave-requests/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.leaveRequests.getRequest(claims, id);
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
