import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { LeaveRequestsService } from "./leave-requests.service";
import { AttendanceService } from "./attendance.service";
import { SubmitLeaveRequestDto } from "./dto/submit-leave-request.dto";
import { DecideLeaveRequestDto } from "./dto/decide-leave-request.dto";
import { ClockInDto } from "./dto/clock-in.dto";
import { ClockOutDto } from "./dto/clock-out.dto";

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
    private readonly attendance: AttendanceService
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
}
