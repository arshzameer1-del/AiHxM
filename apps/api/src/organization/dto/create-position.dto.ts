import { IsDateString, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MinLength } from "class-validator";

export class CreatePositionDto {
  @IsUUID()
  orgUnitId!: string;

  @IsOptional()
  @IsUUID()
  jobId?: string;

  /** Defaults to the linked job's current title when omitted (only valid
   * when `jobId` is given) — see PositionsService.create()'s own doc
   * comment. */
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
