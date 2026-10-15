import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { LegacyReconciliationService } from "./legacy-reconciliation.service";
import { OrgReconciliationService, type ReconciliationOutcome } from "./org-reconciliation.service";
import { RunBackfillDto, RunDriftRepairDto } from "./dto/org-reconciliation.dto";
import { LinkOrgUnitDto } from "./dto/link-org-unit.dto";
import { LinkLocationDto } from "./dto/link-location.dto";
import { LinkPositionDto } from "./dto/link-position.dto";

/** Organization Management Phase 12 (Section 24) — see
 * `LegacyReconciliationService`'s own class doc comment for the full
 * design writeup. `LinkOrgUnitDto`/`LinkLocationDto` gate is exactly the
 * shape of the `PositionsController` pattern (thin controller, all
 * validation/business logic in the service). No body on the manager-
 * relationship action — see that method's own doc comment for why. */
@Controller("organization/legacy-reconciliation")
@UseGuards(SessionGuard)
export class LegacyReconciliationController {
  constructor(
    private readonly legacyReconciliation: LegacyReconciliationService,
    private readonly reconciliation: OrgReconciliationService
  ) {}

  @Get()
  getReport(@CurrentClaims() claims: RequestClaims) {
    return this.legacyReconciliation.getReport(claims);
  }

  // ORG-09 / ORG-03 (Step 7). Static paths are declared before ":employeeId/..." routes.
  @Post("backfill")
  @HttpCode(200)
  runBackfill(@CurrentClaims() claims: RequestClaims, @Body() dto: RunBackfillDto) {
    return this.reconciliation.runLegacyBackfill(claims, dto);
  }

  @Post("drift/repair")
  @HttpCode(200)
  runDriftRepair(@CurrentClaims() claims: RequestClaims, @Body() dto: RunDriftRepairDto) {
    return this.reconciliation.runDriftRepair(claims, dto);
  }

  @Get("runs")
  listRuns(@CurrentClaims() claims: RequestClaims) {
    return this.reconciliation.listRuns(claims);
  }

  @Get("runs/:runId")
  getRun(@CurrentClaims() claims: RequestClaims, @Param("runId") runId: string, @Query("outcome") outcome?: ReconciliationOutcome) {
    return this.reconciliation.getRun(claims, runId, outcome);
  }

  @Get("unresolved")
  listUnresolved(@CurrentClaims() claims: RequestClaims, @Query("gapType") gapType?: string) {
    return this.reconciliation.listUnresolved(claims, gapType);
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

  @Post(":employeeId/link-position")
  @HttpCode(200)
  linkPosition(@CurrentClaims() claims: RequestClaims, @Param("employeeId") employeeId: string, @Body() dto: LinkPositionDto) {
    return this.legacyReconciliation.linkPosition(claims, employeeId, dto.positionId);
  }
}
