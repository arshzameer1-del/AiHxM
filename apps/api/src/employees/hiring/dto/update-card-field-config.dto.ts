import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, ValidateIf, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

/** "then 2" Phase 3 (2026-10-02) — see 0108_hiring_card_field_depth.sql. */
export class FieldValidationRulesDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pattern?: string;

  @IsOptional()
  @IsNumber()
  minLength?: number;

  @IsOptional()
  @IsNumber()
  maxLength?: number;

  @IsOptional()
  @IsNumber()
  min?: number;

  @IsOptional()
  @IsNumber()
  max?: number;
}

export class FieldConditionalOnDto {
  @IsString()
  @MaxLength(100)
  fieldKey!: string;

  @IsIn(["equals", "notEquals"])
  operator!: "equals" | "notEquals";

  @IsString()
  @MaxLength(200)
  value!: string;
}

/** Hiring Card Field Configuration (2026-09-27) — enable/disable + required for ONE built-in field on ONE card. See `CardFieldConfigService.updateFieldConfig()`. */
export class UpdateCardFieldConfigDto {
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultValue?: string | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FieldValidationRulesDto)
  validationRules?: FieldValidationRulesDto | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FieldConditionalOnDto)
  conditionalOn?: FieldConditionalOnDto | null;

  // ---- CFG-12 metadata (null clears where the column is nullable)
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(["text", "textarea", "number", "date", "boolean", "select", "catalog", "reference", "file", "email", "phone"])
  fieldType?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  label?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  helpText?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  placeholder?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsArray()
  @IsString({ each: true })
  optionValues?: string[] | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  referenceCatalogType?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  referenceObject?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(["normal", "confidential", "restricted", "highly_restricted"])
  sensitivityClass?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  visibilityRule?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  editabilityRule?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  dataScopeRule?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  workflowRule?: Record<string, unknown> | null;

  @IsOptional()
  @IsIn(["none", "changes", "reads_and_changes"])
  auditPolicy?: string;

  @IsOptional()
  @IsBoolean()
  isEffectiveDated?: boolean;

  @IsOptional()
  @IsObject()
  labelI18n?: Record<string, string>;

  @IsOptional()
  @IsObject()
  helpI18n?: Record<string, string>;
}
