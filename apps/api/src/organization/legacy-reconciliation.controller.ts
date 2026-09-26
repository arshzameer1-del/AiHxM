import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { LegacyReconciliationService } from "./legacy-reconciliation.service";
import { LinkOrgUnitDto } from "./dto/link-org-unit.dto";
import { LinkLocationDto } from "./dto/link-location.dto";

/** Organization Management Phase 12 (Section 24) — see
 * `LegacyReconciliationService`'s own class doc comment for the full
 * design writeup. `LinkOrgUnitDto`/`LinkLocationDto` gate is exactly the
 * shape of the `PositionsController` pattern (thin controller, all
 * validation/business logic in the service). No body on the manager-
 * relationship action — see that method's own doc comment for why. */
@Controller("organization/legacy-reconciliation")
@UseGuards(SessionGuard)
export class LegacyReconciliationController {
  constructor(private readonly legacyReconciliation: LegacyReconciliationService) {}

  @Get()
  getReport(@CurrentClaims() claims: RequestClaims) {
    return this.legacyReconciliation.getReport(claims);
  }

  @Post(":employeeId/link-org-unit")
  linkOrgUnit(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: LinkOrgUnitDto) {
    return this.legacyReconciliation.linkOrgUnit(claims, employeeId, dto.orgUnitId);
  }

  @Post(":employeeId/link-location")
  linkLocation(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: LinkLocationDto) {
    return this.legacyReconciliation.linkLocation(claims, employeeId, dto.locationId);
  }

  @Post(":employeeId/link-manager-relationship")
  @HttpCode(200)
  linkManagerRelationship(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string) {
    return this.legacyReconciliation.linkManagerRelationship(claims, employeeId);
  }
}
