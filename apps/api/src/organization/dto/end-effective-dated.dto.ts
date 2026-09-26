import { IsDateString, IsOptional } from "class-validator";

/** Shared by `POST .../:id/end` on both EmployeeOrgAssignmentsController
 * and OrgRelationshipsController — ending a slot takes only an optional
 * effective date (defaults to today, same as every other
 * EffectiveDatingEngine consumer), no other field. */
export class EndEffectiveDatedDto {
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
