import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateConfigurationRuleMappingDto {
  @IsOptional()
  @IsObject()
  ruleValue?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DAY)
  effectiveFrom?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DAY)
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changeReason?: string;
}
