import { IsDateString, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class CreateCostCenterDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
