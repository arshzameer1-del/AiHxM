import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { PayrollAreasService } from "./payroll-areas.service";
import {
  AddPayrollAreaScopeLinkDto,
  AssignEmployeePayrollAreaDto,
  CreatePayrollAreaDto,
  UpdatePayrollAreaDto,
} from "./dto/payroll-area.dto";

/**
 * Payroll Areas (0101_payroll_areas.sql). SessionGuard only — the
 * entitlement + `payroll_area.manage.all`/`.scoped` checks live in
 * PayrollAreasService, the same split every module since Phase 4 uses.
 */
@Controller("payroll/areas")
@UseGuards(SessionGuard)
export class PayrollAreasController {
  constructor(private readonly areas: PayrollAreasService) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.areas.list(claims, { includeInactive: includeInactive === "true" });
  }

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePayrollAreaDto) {
    return this.areas.create(claims, dto);
  }

  // Declared before `:id` so "employee-assignments" is never captured as an id.
  @Post("employee-assignments")
  assignEmployee(@CurrentClaims() claims: RequestClaims, @Body() dto: AssignEmployeePayrollAreaDto) {
    return this.areas.assignEmployee(claims, dto);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.areas.get(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdatePayrollAreaDto) {
    return this.areas.update(claims, id, dto);
  }

  @Post(":id/deactivate")
  deactivate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.areas.deactivate(claims, id);
  }

  @Post(":id/scope-links")
  addScopeLink(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AddPayrollAreaScopeLinkDto) {
    return this.areas.addScopeLink(claims, id, dto);
  }

  @Delete(":id/scope-links/:linkId")
  removeScopeLink(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("linkId") linkId: string) {
    return this.areas.removeScopeLink(claims, id, linkId);
  }
}
