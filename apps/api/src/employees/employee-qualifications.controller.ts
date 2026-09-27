import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeQualificationsService } from "./employee-qualifications.service";
import { CreateEmployeeQualificationDto } from "./dto/create-employee-qualification.dto";
import { UpdateEmployeeQualificationDto } from "./dto/update-employee-qualification.dto";

/** Core Employee Enterprise Phase 9 — the Qualifications/Skills card's own CRUD surface, outside the hiring flow. */
@Controller("employees/qualifications")
@UseGuards(SessionGuard)
export class EmployeeQualificationsController {
  constructor(private readonly qualifications: EmployeeQualificationsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeQualificationDto) {
    return this.qualifications.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.qualifications.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeQualificationDto) {
    return this.qualifications.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.qualifications.end(claims, id);
  }
}
