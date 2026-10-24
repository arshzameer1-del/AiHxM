import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeDataConsistencyService } from "./employee-data-consistency.service";

/** BACKLOG46 — where the employee record disagrees with the data that owns the value, and a one-click repair. */
@Controller("employees/data-consistency")
@UseGuards(SessionGuard)
export class EmployeeDataConsistencyController {
  constructor(private readonly consistency: EmployeeDataConsistencyService) {}

  @Get()
  report(@CurrentClaims() claims: RequestClaims) {
    return this.consistency.getReport(claims);
  }

  @Post("repair")
  repair(@CurrentClaims() claims: RequestClaims) {
    return this.consistency.repair(claims);
  }
}
