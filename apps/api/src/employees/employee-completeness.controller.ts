import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EMPLOYEE_ID } from "./employee-id-route";
import { EmployeeCompletenessService } from "./employee-completeness.service";

/** BACKLOG53 - how complete a record is and what is missing. */
@Controller("employees")
@UseGuards(SessionGuard)
export class EmployeeCompletenessController {
  constructor(private readonly completeness: EmployeeCompletenessService) {}

  @Get("me/completeness")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.completeness.forMe(claims);
  }

  @Get(`${EMPLOYEE_ID}/completeness`)
  one(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.completeness.forEmployee(claims, id);
  }
}
