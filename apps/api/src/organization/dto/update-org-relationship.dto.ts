import { IsDateString, IsOptional, IsUUID } from "class-validator";

/** Reassigns the manager/counterpart side of this relationship in place —
 * `relationshipType`/`employeeId` are immutable (create a new relationship
 * instead) and ending it is a dedicated action (`POST .../:id/end`), not a
 * plain field patch. See OrgRelationshipsService.update()'s doc comment. */
export class UpdateOrgRelationshipDto {
  @IsOptional()
  @IsUUID()
  managerEmployeeId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
