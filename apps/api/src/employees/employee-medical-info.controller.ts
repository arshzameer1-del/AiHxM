import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { UpsertEmployeeMedicalInfoDto } from "./dto/employee-medical-info.dto";
import { EmployeeMedicalInfoService } from "./employee-medical-info.service";

/** BACKLOG54 - medical information (strict access). */
@Controller("employees/medical")
@UseGuards(SessionGuard)
export class EmployeeMedicalInfoController {
  constructor(private readonly medical: EmployeeMedicalInfoService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.medical.get(claims, employeeId);
  }

  @Put()
  upsert(@CurrentClaims() claims: RequestClaims, @Body() dto: UpsertEmployeeMedicalInfoDto) {
    return this.medical.upsert(claims, dto);
  }
}
