import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PersonDirectoryService } from "./person-directory.service";
import { UpdatePersonDto } from "./dto/update-person.dto";

/** Gap Register EMP-01..05 - person records, their history and as-of reads. */
@Controller()
@UseGuards(SessionGuard)
export class PersonsController {
  constructor(private readonly directory: PersonDirectoryService) {}

  // literal paths first (see EmployeesController for why)
  @Get("persons/duplicates")
  duplicates(
    @CurrentClaims() claims: RequestClaims,
    @Query("cnic") cnic?: string,
    @Query("dateOfBirth") dateOfBirth?: string,
    @Query("firstName") firstName?: string,
    @Query("lastName") lastName?: string
  ) {
    return this.directory.duplicates(claims, { cnic, dateOfBirth, firstName, lastName });
  }

  @Get("persons/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.directory.get(claims, id);
  }

  @Patch("persons/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdatePersonDto) {
    return this.directory.update(claims, id, dto);
  }

  @Get("persons/:id/history")
  history(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.directory.history(claims, id);
  }

  @Get("persons/:id/employments")
  employments(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.directory.employments(claims, id);
  }

  @Get("employees/:id/as-of")
  employeeAsOf(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Query("date") date: string) {
    return this.directory.employeeAsOf(claims, id, date);
  }

  @Get("workforce/as-of")
  workforceAsOf(@CurrentClaims() claims: RequestClaims, @Query("date") date: string, @Query("orgUnitId") orgUnitId?: string) {
    return this.directory.workforceAsOf(claims, date, orgUnitId);
  }
}
