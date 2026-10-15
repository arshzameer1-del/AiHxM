import { IsDateString, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CorrectLifecycleEventDto {
  /** Fields of the original request to change (designation, orgUnitId, ...). */
  @IsObject()
  changes!: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class CancelLifecycleEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
