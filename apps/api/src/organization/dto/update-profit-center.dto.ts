import { IsDateString, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from "class-validator";

export class UpdateProfitCenterDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  code?: string;

  /** `null` clears the org unit link; omitted leaves it unchanged — the
   * same three-way "set / clear / leave alone" distinction
   * `UpdatePositionDto.jobId` already established. */
  @ValidateIf((o) => o.orgUnitId !== null)
  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
