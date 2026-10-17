import { EMPLOYEE_ID } from "./employee-id-route";
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeLifecycleService } from "./employee-lifecycle.service";
import { TransferEmployeeDto } from "./dto/transfer-employee.dto";
import { PromoteEmployeeDto } from "./dto/promote-employee.dto";
import { DemoteEmployeeDto } from "./dto/demote-employee.dto";
import { SecondEmployeeDto } from "./dto/second-employee.dto";
import { AssignActingRoleDto } from "./dto/assign-acting-role.dto";
import { ChangeEmployeeManagerDto } from "./dto/change-employee-manager.dto";
import { ChangeEmployeeLocationDto } from "./dto/change-employee-location.dto";
import { TerminateEmployeeLifecycleDto } from "./dto/terminate-employee-lifecycle.dto";
import { ReactivateEmployeeDto } from "./dto/reactivate-employee.dto";
import { CancelLifecycleEventDto, CorrectLifecycleEventDto } from "./dto/correct-lifecycle-event.dto";

/**
 * Core Employee Enterprise Phase 10 — the explicit Lifecycle Transactions
 * surface (spec Section 26), one route per named transaction. See
 * `EmployeeLifecycleService`'s own class doc comment for how this relates
 * to `EmployeesController`'s existing generic `PATCH /employees/:id`.
 */
@Controller("employees")
@UseGuards(SessionGuard)
export class EmployeeLifecycleController {
  constructor(private readonly lifecycle: EmployeeLifecycleService) {}

  @Post(`${EMPLOYEE_ID}/transfer`)
  transfer(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: TransferEmployeeDto) {
    return this.lifecycle.transfer(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/promote`)
  promote(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: PromoteEmployeeDto) {
    return this.lifecycle.promote(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/demote`)
  demote(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DemoteEmployeeDto) {
    return this.lifecycle.demote(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/second`)
  second(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SecondEmployeeDto) {
    return this.lifecycle.second(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/act`)
  act(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AssignActingRoleDto) {
    return this.lifecycle.assignActingRole(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/change-manager`)
  changeManager(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ChangeEmployeeManagerDto) {
    return this.lifecycle.changeManager(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/change-location`)
  changeLocation(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ChangeEmployeeLocationDto) {
    return this.lifecycle.changeLocation(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/terminate`)
  terminate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: TerminateEmployeeLifecycleDto) {
    return this.lifecycle.terminate(claims, id, dto);
  }

  @Post(`${EMPLOYEE_ID}/reactivate`)
  reactivate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ReactivateEmployeeDto) {
    return this.lifecycle.reactivate(claims, id, dto);
  }

  // Step 4 (LIF-01/03/04): the event stream, cancelling a scheduled action,
  // and corrections (a new event referencing the original).
  @Get(`${EMPLOYEE_ID}/lifecycle-events`)
  events(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) {
    return this.lifecycle.listEvents(claims, id);
  }

  @Post(`${EMPLOYEE_ID}/lifecycle-events/:eventId/cancel`)
  cancelEvent(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Body() dto: CancelLifecycleEventDto
  ) {
    return this.lifecycle.cancelScheduled(claims, id, eventId, dto.reason);
  }

  @Post(`${EMPLOYEE_ID}/lifecycle-events/:eventId/correct`)
  correctEvent(
    @CurrentClaims() claims: RequestClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Body() dto: CorrectLifecycleEventDto
  ) {
    return this.lifecycle.correct(claims, id, eventId, dto);
  }
}
