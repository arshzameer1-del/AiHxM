import { IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

const DOMAINS = ["hr_reference_catalog_item", "hr_business_policy", "configuration_rule_mapping"] as const;
const OPERATIONS = ["create", "update", "deactivate"] as const;

export class CreateConfigurationChangeRequestDto {
  @IsIn(DOMAINS)
  configDomain!: "hr_reference_catalog_item" | "hr_business_policy" | "configuration_rule_mapping";

  @IsIn(OPERATIONS)
  operation!: "create" | "update" | "deactivate";

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  effectiveFrom?: string;
}
