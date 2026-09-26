import { IsUUID } from "class-validator";

/** `POST /organization/legacy-reconciliation/:employeeId/link-location`
 * (Phase 12, Section 24) — the location-side mirror of `LinkOrgUnitDto`;
 * see that DTO's own doc comment. */
export class LinkLocationDto {
  @IsUUID()
  locationId!: string;
}
