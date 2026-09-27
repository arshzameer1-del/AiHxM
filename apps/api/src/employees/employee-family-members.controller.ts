import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeFamilyMembersService } from "./employee-family-members.service";
import { CreateEmployeeFamilyMemberDto } from "./dto/create-employee-family-member.dto";
import { UpdateEmployeeFamilyMemberDto } from "./dto/update-employee-family-member.dto";

/** Core Employee Enterprise Phase 9 — the Family/Dependents card's own CRUD surface, outside the hiring flow. */
@Controller("employees/family-members")
@UseGuards(SessionGuard)
export class EmployeeFamilyMembersController {
  constructor(private readonly familyMembers: EmployeeFamilyMembersService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeFamilyMemberDto) {
    return this.familyMembers.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId: string) {
    return this.familyMembers.list(claims, employeeId);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeFamilyMemberDto) {
    return this.familyMembers.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.familyMembers.end(claims, id);
  }
}
