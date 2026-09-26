import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { LocationsService } from "./locations.service";
import { CreateLocationDto } from "./dto/create-location.dto";
import { UpdateLocationDto } from "./dto/update-location.dto";
import { MoveLocationDto } from "./dto/move-location.dto";

/**
 * Any real session (SessionGuard) can call these — LocationsService's own
 * entitlement + location.manage.all/location.view.all checks are what
 * actually decide who succeeds, exactly `OrgUnitsController`'s own split.
 * `tree` is declared before the `:id` routes deliberately — Nest matches
 * routes in declaration order, and it would otherwise be swallowed as a
 * `:id` value.
 */
@Controller("organization/locations")
@UseGuards(SessionGuard)
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateLocationDto) {
    return this.locations.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.locations.list(claims);
  }

  @Get("tree")
  getTree(@CurrentClaims() claims: RequestClaims) {
    return this.locations.getTree(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.locations.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.locations.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(claims, id, dto);
  }

  @Post(":id/move")
  move(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: MoveLocationDto) {
    return this.locations.move(claims, id, dto);
  }

  @Post(":id/activate")
  activate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.locations.activate(claims, id);
  }

  @Post(":id/archive")
  archive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.locations.archive(claims, id);
  }
}
