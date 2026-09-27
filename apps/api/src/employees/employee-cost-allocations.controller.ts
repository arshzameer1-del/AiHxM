import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeCostAllocationsService } from "./employee-cost-allocations.service";
import { CreateEmployeeCostAllocationDto } from "./dto/create-employee-cost-allocation.dto";
import { UpdateEmployeeCostAllocationDto } from "./dto/update-employee-cost-allocation.dto";

/** Core Employee Enterprise Phase 8 — the Cost Allocation card's own CRUD surface, outside the hiring flow (editing an existing employee's split costing). */
@Controller("employees/cost-allocations")
@UseGuards(SessionGuard)
export class EmployeeCostAllocationsController {
  constructor(private readonly costAllocations: EmployeeCostAllocationsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeCostAllocationDto) {
    return this.costAllocations.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.costAllocations.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeCostAllocationDto) {
    return this.costAllocations.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.costAllocations.end(claims, id);
  }
}
