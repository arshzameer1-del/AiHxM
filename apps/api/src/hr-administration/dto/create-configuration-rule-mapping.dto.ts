import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

const SCOPE_TYPES = ["org_unit", "location", "employee"] as const;

export class CreateConfigurationRuleMappingDto {
  @IsString()
  @MaxLength(100)
  configDomain!: string;

  @IsString()
  @MaxLength(100)
  configKey!: string;

  @IsIn(SCOPE_TYPES)
  scopeType!: "org_unit" | "location" | "employee";

  @IsString()
  @MaxLength(255)
  scopeValue!: string;

  @IsOptional()
  @IsObject()
  ruleValue?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  priority?: number;
}
