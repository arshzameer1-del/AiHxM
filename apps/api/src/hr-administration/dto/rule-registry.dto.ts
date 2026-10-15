import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import type { RuleType } from "@aihxm/shared-types";

const RULE_TYPES = ["validation", "default", "visibility", "editability", "applicability", "eligibility", "calculation"] as const;

export class CreateRuleDefinitionDto {
  @IsString() @MaxLength(100) ruleKey!: string;
  @IsIn(RULE_TYPES) ruleType!: RuleType;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(100) targetObject?: string;
  @IsOptional() @IsString() @MaxLength(100) targetField?: string;
  @IsOptional() @IsString() @MaxLength(100) ownerModule?: string;
}

export class CreateRuleVersionDto {
  @IsObject() expression!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
  @IsOptional() @IsString() @MaxLength(1000) changeReason?: string;
}

export class EvaluateRuleDto {
  @IsString() @MaxLength(100) ruleKey!: string;
  @IsObject() context!: Record<string, unknown>;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) asOf?: string;
}
