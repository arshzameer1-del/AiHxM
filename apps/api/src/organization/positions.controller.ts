import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { PositionStatus } from "@aihxm/shared-types";
import { PositionsService } from "./positions.service";
import { CreatePositionDto } from "./dto/create-position.dto";
import { UpdatePositionDto } from "./dto/update-position.dto";
import { AssignPositionDto } from "./dto/assign-position.dto";

/**
 * Any real session (SessionGuard) can call these — PositionsService's own
 * entitlement + position.manage.all/position.view.all checks are what
 * actually decide who succeeds, the same split OrgUnitsController/
 * JobsController use.
 */
@Controller("organization/positions")
@UseGuards(SessionGuard)
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreatePositionDto) {
    return this.positions.create(claims, dto);
  }

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("status") status?: PositionStatus,
    @Query("orgUnitId") orgUnitId?: string
  ) {
    return this.positions.list(claims, { status, orgUnitId });
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdatePositionDto) {
    return this.positions.update(claims, id, dto);
  }

  @Post(":id/assign")
  assign(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AssignPositionDto) {
    return this.positions.assignEmployee(claims, id, dto.employeeId, dto.effectiveFrom);
  }

  @Post(":id/unassign")
  unassign(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.unassignEmployee(claims, id);
  }

  @Post(":id/freeze")
  freeze(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.freeze(claims, id);
  }

  @Post(":id/unfreeze")
  unfreeze(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.unfreeze(claims, id);
  }

  @Post(":id/abolish")
  abolish(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.abolish(claims, id);
  }

  @Post(":id/reactivate")
  reactivate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.positions.reactivate(claims, id);
  }
}
