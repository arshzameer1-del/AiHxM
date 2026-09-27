import { IsUUID } from "class-validator";

/** `POST /organization/legacy-reconciliation/:employeeId/link-position`
 * (Core Employee Enterprise Phase 11). The designation-side counterpart
 * of `LinkOrgUnitDto`/`LinkLocationDto` — see
 * `LegacyReconciliationService.linkPosition()`'s own doc comment. */
export class LinkPositionDto {
  @IsUUID()
  positionId!: string;
}
