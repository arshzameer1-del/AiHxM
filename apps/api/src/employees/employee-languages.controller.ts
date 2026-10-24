import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CreateEmployeeLanguageDto, UpdateEmployeeLanguageDto } from "./dto/employee-languages.dto";
import { EmployeeLanguagesService } from "./employee-languages.service";

/** BACKLOG54 - languages. */
@Controller("employees/languages")
@UseGuards(SessionGuard)
export class EmployeeLanguagesController {
  constructor(private readonly languages: EmployeeLanguagesService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.languages.list(claims, employeeId);
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeLanguageDto) {
    return this.languages.create(claims, dto);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeLanguageDto) {
    return this.languages.update(claims, id, dto);
  }

  @Delete(":id")
  remove(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.languages.remove(claims, id);
  }
}
