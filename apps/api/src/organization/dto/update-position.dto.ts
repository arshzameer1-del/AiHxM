import { IsDateString, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MinLength, ValidateIf } from "class-validator";

/** Renames/retitles/recodes/reassigns-job/adjusts-headcount/reparents-org-unit
 * in place — status transitions (freeze/unfreeze/abolish/reactivate,
 * assign/unassign) are their own dedicated actions, not a plain field
 * patch. See PositionsService.update()'s doc comment. */
export class UpdatePositionDto {
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  /** `null` clears the job link (a position can exist without a job
   * assigned yet); omitted leaves it unchanged. */
  @ValidateIf((o) => o.jobId !== null)
  @IsOptional()
  @IsUUID()
  jobId?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  positionTitle?: string;

  @IsOptional()
  @IsString()
  positionCode?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  headcountFte?: number;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
