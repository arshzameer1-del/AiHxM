import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ProfitCentersService } from "./profit-centers.service";
import { CreateProfitCenterDto } from "./dto/create-profit-center.dto";
import { UpdateProfitCenterDto } from "./dto/update-profit-center.dto";

/**
 * Any real session (SessionGuard) can call these — ProfitCentersService's own
 * entitlement + profit_center.manage.all/profit_center.view.all checks are what
 * actually decide who succeeds, exactly `JobsController`'s own split.
 */
@Controller("organization/profit-centers")
@UseGuards(SessionGuard)
export class ProfitCentersController {
  constructor(private readonly profitCenters: ProfitCentersService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateProfitCenterDto) {
    return this.profitCenters.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.profitCenters.list(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.profitCenters.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.profitCenters.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateProfitCenterDto) {
    return this.profitCenters.update(claims, id, dto);
  }

  @Post(":id/archive")
  archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.profitCenters.archive(claims, id);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.profitCenters.activate(claims, id);
  }
}
