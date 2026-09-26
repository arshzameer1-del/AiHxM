import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { OrgUnitsService } from "./org-units.service";
import { CreateOrgUnitDto } from "./dto/create-org-unit.dto";
import { UpdateOrgUnitDto } from "./dto/update-org-unit.dto";
import { MoveOrgUnitDto } from "./dto/move-org-unit.dto";
import { SetOrgUnitHeadPositionDto } from "./dto/set-org-unit-head-position.dto";

/**
 * Any real session (SessionGuard) can call these — OrgUnitsService's own
 * entitlement + org_unit.manage.all/org_unit.view.all checks are what
 * actually decide who succeeds, the same split every module since Phase 4
 * uses. `tree`/`roots` are declared before the `:id` routes deliberately —
 * Nest matches routes in declaration order, and either would otherwise be
 * swallowed as a `:id` value (EmployeesController's own `org-chart`
 * ordering note).
 */
@Controller("organization/units")
@UseGuards(SessionGuard)
export class OrgUnitsController {
  constructor(private readonly orgUnits: OrgUnitsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateOrgUnitDto) {
    return this.orgUnits.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.orgUnits.list(claims);
  }

  @Get("tree")
  getTree(@CurrentClaims() claims: RequestClaims) {
    return this.orgUnits.getTree(claims);
  }

  @Get("roots")
  listRoots(@CurrentClaims() claims: RequestClaims) {
    return this.orgUnits.listRoots(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgUnits.get(claims, id);
  }

  @Get(":id/children")
  listChildren(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgUnits.listChildren(claims, id);
  }

  @Get(":id/descendants")
  getDescendants(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgUnits.getDescendants(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgUnits.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateOrgUnitDto) {
    return this.orgUnits.update(claims, id, dto);
  }

  @Post(":id/move")
  move(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: MoveOrgUnitDto) {
    return this.orgUnits.move(claims, id, dto);
  }

  @Post(":id/head-position")
  setHeadPosition(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: SetOrgUnitHeadPositionDto
  ) {
    return this.orgUnits.setHeadPosition(claims, id, dto);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgUnits.activate(claims, id);
  }

  @Post(":id/archive")
  archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgUnits.archive(claims, id);
  }
}
