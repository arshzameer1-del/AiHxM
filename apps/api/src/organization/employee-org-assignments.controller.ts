import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { AssignmentStatus, AssignmentType } from "@aihxm/shared-types";
import { EmployeeOrgAssignmentsService } from "./employee-org-assignments.service";
import { CreateEmployeeOrgAssignmentDto } from "./dto/create-employee-org-assignment.dto";
import { UpdateEmployeeOrgAssignmentDto } from "./dto/update-employee-org-assignment.dto";
import { EndEffectiveDatedDto } from "./dto/end-effective-dated.dto";

/**
 * Any real session (SessionGuard) can call these —
 * EmployeeOrgAssignmentsService's own entitlement +
 * employee_org_assignment.manage.all/employee_org_assignment.view.all
 * checks are what actually decide who succeeds, the same split
 * OrgUnitsController/JobsController/PositionsController use.
 */
@Controller("organization/employee-assignments")
@UseGuards(SessionGuard)
export class EmployeeOrgAssignmentsController {
  constructor(private readonly assignments: EmployeeOrgAssignmentsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateEmployeeOrgAssignmentDto) {
    return this.assignments.create(claims, dto);
  }

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("employeeId") employeeId?: string,
    @Query("orgUnitId") orgUnitId?: string,
    // Organization Management Phase 9 — PositionDetailPage's "Assignment
    // History" tab filters by positionId.
    @Query("positionId") positionId?: string,
    @Query("assignmentType") assignmentType?: AssignmentType,
    @Query("status") status?: AssignmentStatus
  ) {
    return this.assignments.list(claims, { employeeId, orgUnitId, positionId, assignmentType, status });
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.assignments.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.assignments.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateEmployeeOrgAssignmentDto) {
    return this.assignments.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: EndEffectiveDatedDto) {
    return this.assignments.end(claims, id, dto?.effectiveFrom);
  }
}
