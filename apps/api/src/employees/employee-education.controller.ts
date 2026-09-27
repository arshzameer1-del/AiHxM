import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeEducationService } from "./employee-education.service";
import { CreateEmployeeEducationDto } from "./dto/create-employee-education.dto";
import { UpdateEmployeeEducationDto } from "./dto/update-employee-education.dto";

/** Core Employee Enterprise Phase 9 — the Education card's own CRUD surface, outside the hiring flow. */
@Controller("employees/education")
@UseGuards(SessionGuard)
export class EmployeeEducationController {
  constructor(private readonly education: EmployeeEducationService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeEducationDto) {
    return this.education.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.education.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeEducationDto) {
    return this.education.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.education.end(claims, id);
  }
}
