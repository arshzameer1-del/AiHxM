import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, Min, MaxLength } from "class-validator";
import type { ConfigurationRuleMappingScopeType } from "@aihxm/shared-types";

const SCOPE_TYPES = ["org_unit", "location", "employee", "tenant", "employee_group", "position", "job"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateConfigurationRuleMappingDto {
  @IsString()
  @MaxLength(100)
  configDomain!: string;

  @IsString()
  @MaxLength(100)
  configKey!: string;

  @IsIn(SCOPE_TYPES)
  scopeType!: ConfigurationRuleMappingScopeType;

  @IsString()
  @MaxLength(255)
  scopeValue!: string;

  @IsOptional()
  @IsObject()
  ruleValue?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  objectType?: string;

  @IsOptional()
  @IsUUID()
  objectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  fieldKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ruleType?: string;

  @IsOptional()
  @IsUUID()
  ruleReference?: string;

  @IsOptional()
  @Matches(DAY)
  effectiveFrom?: string;

  @IsOptional()
  @Matches(DAY)
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changeReason?: string;
}
