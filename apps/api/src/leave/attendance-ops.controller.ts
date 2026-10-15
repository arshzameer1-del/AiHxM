import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { TimesheetStatus } from "@aihxm/shared-types";
import { AttendanceEvaluationService } from "./attendance-evaluation.service";
import { AttendanceDevicesService } from "./attendance-devices.service";
import { TimesheetsService } from "./timesheets.service";
import { DeviceKeyGuard, type DeviceAuthedRequest } from "./device-key.guard";
import {
  CreateAttendanceDeviceDto, DecideTimesheetDto, EnrollDeviceUserDto, EvaluateAttendanceDto, IngestPunchesDto,
  OverrideAttendanceDayDto, SaveTimesheetEntriesDto, UpdateAttendanceDeviceDto,
} from "./dto/attendance-ops.dto";

/** Processed attendance days, devices / enrolments, and timesheets (Step 8B). */
@Controller()
@UseGuards(SessionGuard)
export class AttendanceOpsController {
  constructor(
    private readonly evaluation: AttendanceEvaluationService,
    private readonly devices: AttendanceDevicesService,
    private readonly timesheets: TimesheetsService
  ) {}

  // --- TLM-04 ------------------------------------------------------------
  @Get("employees/:employeeId/attendance-results")
  results(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Query("from") from: string, @Query("to") to: string) {
    return this.evaluation.list(claims, { employeeId, from, to });
  }

  @Get("employees/:employeeId/attendance-summary")
  summary(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Query("from") from: string, @Query("to") to: string) {
    return this.evaluation.summary(claims, employeeId, from, to);
  }

  @Post("attendance-results/evaluate")
  evaluate(@CurrentClaims() claims: RequestClaims, @Body() dto: EvaluateAttendanceDto) {
    return this.evaluation.evaluate(claims, dto);
  }

  @Post("attendance-results/override")
  override(@CurrentClaims() claims: RequestClaims, @Body() dto: OverrideAttendanceDayDto) {
    return this.evaluation.override(claims, dto);
  }

  // --- TLM-05 ------------------------------------------------------------
  @Get("attendance-devices")
  listDevices(@CurrentClaims() claims: RequestClaims) {
    return this.devices.listDevices(claims);
  }

  @Post("attendance-devices")
  createDevice(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateAttendanceDeviceDto) {
    return this.devices.createDevice(claims, dto);
  }

  @Patch("attendance-devices/:id")
  updateDevice(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateAttendanceDeviceDto) {
    return this.devices.updateDevice(claims, id, dto);
  }

  @Post("attendance-devices/:id/rotate-key")
  rotateKey(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.devices.rotateKey(claims, id);
  }

  @Get("attendance-devices/:id/enrollments")
  enrollments(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.devices.listEnrollments(claims, id);
  }

  @Post("attendance-devices/:id/enrollments")
  enroll(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: EnrollDeviceUserDto) {
    return this.devices.enroll(claims, id, dto);
  }

  @Delete("attendance-devices/:id/enrollments/:enrollmentId")
  @HttpCode(204)
  revoke(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("enrollmentId") enrollmentId: string) {
    return this.devices.revokeEnrollment(claims, id, enrollmentId);
  }

  @Get("attendance-punches")
  punches(@CurrentClaims() claims: RequestClaims, @Query("deviceId") deviceId?: string, @Query("status") status?: string, @Query("limit") limit?: string) {
    return this.devices.listPunches(claims, { deviceId, status, limit: limit ? Number(limit) : undefined });
  }

  // --- TLM-06 ------------------------------------------------------------
  @Get("employees/:employeeId/timesheet")
  timesheetForWeek(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Query("date") date: string) {
    return this.timesheets.getOrCreate(claims, employeeId, date || new Date().toISOString().slice(0, 10));
  }

  @Get("timesheets")
  listTimesheets(
    @CurrentClaims() claims: RequestClaims,
    @Query("employeeId") employeeId?: string,
    @Query("status") status?: TimesheetStatus,
    @Query("forApproval") forApproval?: string
  ) {
    return this.timesheets.list(claims, { employeeId, status, forApproval: forApproval === "true" });
  }

  @Get("timesheets/:id")
  getTimesheet(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.timesheets.get(claims, id);
  }

  @Put("timesheets/:id/entries")
  saveEntries(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SaveTimesheetEntriesDto) {
    return this.timesheets.saveEntries(claims, id, dto);
  }

  @Post("timesheets/:id/submit")
  submitTimesheet(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.timesheets.submit(claims, id);
  }

  @Patch("timesheets/:id/decision")
  decideTimesheet(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideTimesheetDto) {
    return this.timesheets.decide(claims, id, dto);
  }

  @Post("timesheets/:id/cancel")
  cancelTimesheet(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.timesheets.cancel(claims, id);
  }
}

/** Device-facing: authenticated only by the per-device key (see DeviceKeyGuard). */
@Controller("device-ingest")
@UseGuards(DeviceKeyGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class DeviceIngestController {
  constructor(private readonly devices: AttendanceDevicesService) {}

  @Post(":deviceId/punches")
  @HttpCode(200)
  ingest(@Param("deviceId") deviceId: string, @Req() req: DeviceAuthedRequest, @Body() dto: IngestPunchesDto) {
    return this.devices.ingest(req.deviceCompanyId, deviceId, dto.punches);
  }
}
