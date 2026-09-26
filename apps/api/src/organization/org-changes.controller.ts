import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { OrgChangesService } from "./org-changes.service";
import { CreateOrgChangeDto } from "./dto/create-org-change.dto";
import { DecideOrgChangeDto } from "./dto/decide-org-change.dto";

/**
 * Any real session (SessionGuard) can call these — `OrgChangesService`'s
 * own `org_change.manage.all`/`org_change.view.all` checks (and, for
 * `decide`, the tenant's own configured workflow routing) are what
 * actually decide who succeeds, exactly `LocationsController`'s own
 * split.
 */
@Controller("organization/reorganizations")
@UseGuards(SessionGuard)
export class OrgChangesController {
  constructor(private readonly orgChanges: OrgChangesService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateOrgChangeDto) {
    return this.orgChanges.create(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.orgChanges.list(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgChanges.get(claims, id);
  }

  @Post(":id/validate")
  validate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgChanges.validate(claims, id);
  }

  @Post(":id/impact")
  analyzeImpact(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgChanges.analyzeImpact(claims, id);
  }

  @Post(":id/submit")
  submitForApproval(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgChanges.submitForApproval(claims, id);
  }

  @Post(":id/decide")
  decide(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideOrgChangeDto) {
    return this.orgChanges.decide(claims, id, dto);
  }

  @Post(":id/execute")
  execute(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.orgChanges.execute(claims, id);
  }
}
