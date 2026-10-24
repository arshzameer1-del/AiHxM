import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { UpsertEmployeeStatutoryIdsDto } from "./dto/upsert-employee-statutory-ids.dto";
import { EmployeeStatutoryIdsService } from "./employee-statutory-ids.service";

/** BACKLOG49 - EOBI, social security, provident fund, CNIC expiry, visa / work permit. */
@Controller("employees/statutory")
@UseGuards(SessionGuard)
export class EmployeeStatutoryIdsController {
  constructor(private readonly statutory: EmployeeStatutoryIdsService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.statutory.get(claims, employeeId);
  }

  @Put()
  upsert(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertEmployeeStatutoryIdsDto) {
    return this.statutory.upsert(claims, dto);
  }
}
