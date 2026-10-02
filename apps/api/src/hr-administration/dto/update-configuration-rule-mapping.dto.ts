import { IsBoolean, IsInt, IsObject, IsOptional } from "class-validator";

export class UpdateConfigurationRuleMappingDto {
  @IsOptional()
  @IsObject()
  ruleValue?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  priority?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
