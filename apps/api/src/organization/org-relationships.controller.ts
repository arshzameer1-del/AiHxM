import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import type { OrgRelationshipStatus, OrgRelationshipType } from "@aihxm/shared-types";
import { OrgRelationshipsService } from "./org-relationships.service";
import { CreateOrgRelationshipDto } from "./dto/create-org-relationship.dto";
import { UpdateOrgRelationshipDto } from "./dto/update-org-relationship.dto";
import { EndEffectiveDatedDto } from "./dto/end-effective-dated.dto";

/**
 * Any real session (SessionGuard) can call these — OrgRelationshipsService's
 * own entitlement + org_relationship.manage.all/org_relationship.view.all
 * checks are what actually decide who succeeds, the same split every
 * Organization Management controller uses.
 */
@Controller("organization/relationships")
@UseGuards(SessionGuard)
export class OrgRelationshipsController {
  constructor(private readonly relationships: OrgRelationshipsService) {}

  @Post()
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateOrgRelationshipDto) {
    return this.relationships.create(claims, dto);
  }

  @Get()
  list(
    @CurrentClaims() claims: RequestClaims,
    @Query("employeeId") employeeId?: string,
    @Query("managerEmployeeId") managerEmployeeId?: string,
    @Query("relationshipType") relationshipType?: OrgRelationshipType,
    @Query("status") status?: OrgRelationshipStatus
  ) {
    return this.relationships.list(claims, { employeeId, managerEmployeeId, relationshipType, status });
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.relationships.get(claims, id);
  }

  @Get(":id/history")
  getHistory(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.relationships.getHistory(claims, id);
  }

  @Patch(":id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: UpdateOrgRelationshipDto) {
    return this.relationships.update(claims, id, dto);
  }

  @Post(":id/end")
  end(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: EndEffectiveDatedDto) {
    return this.relationships.end(claims, id, dto?.effectiveFrom);
  }
}
