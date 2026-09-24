import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import type { PolicyType } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeGroupsService } from "./employee-groups.service";
import { CreateEmployeeGroupDto } from "./dto/create-employee-group.dto";
import { UpdateEmployeeGroupDto } from "./dto/update-employee-group.dto";
import { CreateLeavePolicyDto } from "./dto/create-leave-policy.dto";
import { UpdateLeavePolicyDto } from "./dto/update-leave-policy.dto";
import { AssignGroupPolicyDto } from "./dto/assign-group-policy.dto";

/**
 * Any real session can call these (SessionGuard) — EmployeeGroupsService's
 * own entitlement + employee_group.manage/leave_policy.manage checks are
 * what actually decide who succeeds, the same split every module since
 * Phase 4 has used. `resolved-policy` is declared on `employees/:employeeId`
 * rather than nested under `employee-groups` since it resolves FOR an
 * employee, not for a specific group.
 */
@Controller()
@UseGuards(SessionGuard)
export class EmployeeGroupsController {
  constructor(private readonly employeeGroups: EmployeeGroupsService) {}

  @Post("employee-groups")
  createGroup(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeGroupDto) {
    return this.employeeGroups.createGroup(claims, dto);
  }

  @Get("employee-groups")
  listGroups(@CurrentClaims() claims: RequestClaims) {
    return this.employeeGroups.listGroups(claims);
  }

  @Get("employee-groups/:id")
  getGroup(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employeeGroups.getGroup(claims, id);
  }

  @Patch("employee-groups/:id")
  updateGroup(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeGroupDto) {
    return this.employeeGroups.updateGroup(claims, id, dto);
  }

  @Delete("employee-groups/:id")
  deleteGroup(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employeeGroups.deleteGroup(claims, id);
  }

  @Post("employee-groups/:id/policy-assignments")
  assignPolicy(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AssignGroupPolicyDto) {
    return this.employeeGroups.assignPolicy(claims, id, dto);
  }

  @Delete("employee-groups/:id/policy-assignments/:policyType")
  unassignPolicy(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("policyType") policyType: PolicyType
  ) {
    return this.employeeGroups.unassignPolicy(claims, id, policyType);
  }

  @Post("leave-policies")
  createLeavePolicy(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateLeavePolicyDto) {
    return this.employeeGroups.createLeavePolicy(claims, dto);
  }

  @Get("leave-policies")
  listLeavePolicies(@CurrentClaims() claims: RequestClaims) {
    return this.employeeGroups.listLeavePolicies(claims);
  }

  @Patch("leave-policies/:id")
  updateLeavePolicy(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateLeavePolicyDto) {
    return this.employeeGroups.updateLeavePolicy(claims, id, dto);
  }

  @Delete("leave-policies/:id")
  deleteLeavePolicy(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employeeGroups.deleteLeavePolicy(claims, id);
  }

  @Get("leave-policies/:id/history")
  getLeavePolicyHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.employeeGroups.getLeavePolicyHistory(claims, id);
  }

  @Get("employees/:employeeId/resolved-policy")
  resolvePolicy(
    @CurrentClaims() claims: RequestClaims,
    @Param("employeeId") employeeId: string,
    @Query("policyType") policyType: PolicyType
  ) {
    return this.employeeGroups.resolvePolicy(claims, employeeId, policyType ?? "leave");
  }
}
