import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import type { PayrollPeriodStatus } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollPeriodsService } from "./payroll-periods.service";
import { CreatePayrollCalendarDto, GeneratePayrollPeriodsDto, ReopenPayrollPeriodDto, UpdatePayrollCalendarDto } from "./dto/payroll-calendar.dto";

/** PAY-03. SessionGuard only - entitlement and payroll_calendar.manage.all live in PayrollPeriodsService. */
@Controller("payroll")
@UseGuards(SessionGuard)
export class PayrollPeriodsController {
  constructor(private readonly periods: PayrollPeriodsService) {}

  @Get("calendars")
  listCalendars(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.periods.listCalendars(claims, { includeInactive: includeInactive === "true" });
  }

  @Post("calendars")
  createCalendar(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePayrollCalendarDto) {
    return this.periods.createCalendar(claims, dto);
  }

  @Patch("calendars/:id")
  updateCalendar(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdatePayrollCalendarDto) {
    return this.periods.updateCalendar(claims, id, dto);
  }

  @Post("calendars/:id/generate-periods")
  generate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: GeneratePayrollPeriodsDto) {
    return this.periods.generatePeriods(claims, id, dto);
  }

  @Get("periods")
  listPeriods(
    @CurrentClaims() claims: RequestClaims,
    @Query("calendarId") calendarId?: string,
    @Query("status") status?: PayrollPeriodStatus,
    @Query("year") year?: string
  ) {
    return this.periods.listPeriods(claims, { calendarId, status, year: year ? Number(year) : undefined });
  }

  @Post("periods/:id/lock")
  lock(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.periods.lockPeriod(claims, id);
  }

  @Post("periods/:id/unlock")
  unlock(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.periods.unlockPeriod(claims, id);
  }

  @Post("periods/:id/close")
  close(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.periods.closePeriod(claims, id);
  }

  @Post("periods/:id/reopen")
  reopen(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ReopenPayrollPeriodDto) {
    return this.periods.reopenPeriod(claims, id, dto.reason);
  }
}
