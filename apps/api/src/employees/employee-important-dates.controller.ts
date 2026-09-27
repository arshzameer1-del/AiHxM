import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeImportantDatesService } from "./employee-important-dates.service";
import { CreateEmployeeImportantDateDto } from "./dto/create-employee-important-date.dto";
import { UpdateEmployeeImportantDateDto } from "./dto/update-employee-important-date.dto";

/** Core Employee Enterprise Phase 7 — the Important Dates card's own CRUD surface, outside the hiring flow (editing an existing employee's dates). */
@Controller("employees/important-dates")
@UseGuards(SessionGuard)
export class EmployeeImportantDatesController {
  constructor(private readonly importantDates: EmployeeImportantDatesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeImportantDateDto) {
    return this.importantDates.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.importantDates.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeImportantDateDto) {
    return this.importantDates.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.importantDates.end(claims, id);
  }
}
