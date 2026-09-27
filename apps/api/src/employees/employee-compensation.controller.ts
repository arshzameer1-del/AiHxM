import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeCompensationService } from "./employee-compensation.service";
import { SetCompensationDto } from "./dto/set-compensation.dto";
import { SetEmployeeCompensationComponentsDto } from "./dto/set-employee-compensation-components.dto";
import { CreateCompensationComponentDto } from "./dto/create-compensation-component.dto";
import { UpdateCompensationComponentDto } from "./dto/update-compensation-component.dto";

/**
 * Core Employee master data (SAP IT0008/IT0014-equivalent) — moved here
 * from PayrollController (2026-09-27, kumail's own architecture
 * correction). Any real session can call these (SessionGuard) —
 * EmployeeCompensationService's own entitlement + `employee.manage.all`
 * permission checks are what actually decide who succeeds, the same split
 * every module since Phase 4 has used.
 */
@Controller("employees/compensation")
@UseGuards(SessionGuard)
export class EmployeeCompensationController {
  constructor(private readonly compensation: EmployeeCompensationService) {}

  @Get("components")
  listCompensationComponents(@CurrentClaims() claims: RequestClaims) {
    return this.compensation.listCompensationComponents(claims);
  }

  @Post("components")
  createCompensationComponent(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCompensationComponentDto) {
    return this.compensation.createCompensationComponent(claims, dto);
  }

  @Patch("components/:id")
  updateCompensationComponent(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCompensationComponentDto
  ) {
    return this.compensation.updateCompensationComponent(claims, id, dto);
  }

  @Post()
  setCompensation(@CurrentClaims() claims: RequestClaims, @Body() dto: SetCompensationDto) {
    return this.compensation.setCompensation(claims, dto);
  }

  @Post("set-components")
  setCompensationComponents(@CurrentClaims() claims: RequestClaims, @Body() dto: SetEmployeeCompensationComponentsDto) {
    return this.compensation.setCompensationComponents(claims, dto);
  }

  @Get(":employeeId")
  getCurrentCompensation(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.compensation.getCurrentCompensation(claims, employeeId);
  }

  @Get(":employeeId/history")
  getCompensationHistory(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.compensation.getCompensationHistory(claims, employeeId);
  }
}
