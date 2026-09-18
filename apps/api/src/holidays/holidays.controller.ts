import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { HolidaysService } from "./holidays.service";
import { CreateHolidayDto } from "./dto/create-holiday.dto";
import { UpdateHolidayDto } from "./dto/update-holiday.dto";

/**
 * Any real session can call these (SessionGuard) — HolidaysService's own
 * entitlement + RBAC checks decide who succeeds, same split every module
 * since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Post("holidays")
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateHolidayDto) {
    return this.holidays.createHoliday(claims, dto);
  }

  @Get("holidays")
  list(@CurrentClaims() claims: RequestClaims, @Query("year") year?: string) {
    return this.holidays.listHolidays(claims, year);
  }

  @Patch("holidays/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateHolidayDto) {
    return this.holidays.updateHoliday(claims, id, dto);
  }

  @Delete("holidays/:id")
  remove(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.holidays.deleteHoliday(claims, id);
  }
}
