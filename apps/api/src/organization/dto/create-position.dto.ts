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

  /** Organization Management Phase 4 — tags this position with a
   * reusable financial dimension; see PositionsService.create()'s own
   * existence check. */
  @IsOptional()
  @IsUUID()
  costCenterId?: string;

  @IsOptional()
  @IsUUID()
  profitCenterId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
