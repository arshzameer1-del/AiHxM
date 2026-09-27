import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAddressesService } from "./employee-addresses.service";
import { CreateEmployeeAddressDto } from "./dto/create-employee-address.dto";
import { UpdateEmployeeAddressDto } from "./dto/update-employee-address.dto";

/** Core Employee Enterprise Phase 6 — the Addresses card's own CRUD surface, outside the hiring flow (editing an existing employee's addresses). */
@Controller("employees/addresses")
@UseGuards(SessionGuard)
export class EmployeeAddressesController {
  constructor(private readonly addresses: EmployeeAddressesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeAddressDto) {
    return this.addresses.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.addresses.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeAddressDto) {
    return this.addresses.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.addresses.end(claims, id);
  }
}
