import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CostCentersService } from "./cost-centers.service";
import { CreateCostCenterDto } from "./dto/create-cost-center.dto";
import { UpdateCostCenterDto } from "./dto/update-cost-center.dto";

/**
 * Any real session (SessionGuard) can call these — CostCentersService's own
 * entitlement + cost_center.manage.all/cost_center.view.all checks are what
 * actually decide who succeeds, exactly `JobsController`'s own split.
 */
@Controller("organization/cost-centers")
@UseGuards(SessionGuard)
export class CostCentersController {
  constructor(private readonly costCenters: CostCentersService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCostCenterDto) {
    return this.costCenters.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.costCenters.list(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.costCenters.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.costCenters.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateCostCenterDto) {
    return this.costCenters.update(claims, id, dto);
  }

  @Post(":id/archive")
  archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.costCenters.archive(claims, id);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.costCenters.activate(claims, id);
  }
}
