import { IsDateString, IsOptional, IsString, IsUUID, ValidateIf } from "class-validator";

/** Moves this assignment to a different org unit/position/location in
 * place — `assignmentType` is immutable (create a new assignment slot
 * instead) and ending it is a dedicated action (`POST .../:id/end`), not a
 * plain field patch. See EmployeeOrgAssignmentsService.update()'s doc
 * comment. */
export class UpdateEmployeeOrgAssignmentDto {
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  /** `null` clears the position link; omitted leaves it unchanged — the
   * same three-way "set / clear / leave alone" distinction
   * `UpdatePositionDto.jobId` already established. */
  @ValidateIf((o) => o.positionId !== null)
  @IsOptional()
  @IsUUID()
  positionId?: string | null;

  /** `null` clears the location link; omitted leaves it unchanged. */
  @ValidateIf((o) => o.locationId !== null)
  @IsOptional()
  @IsString()
  locationId?: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
