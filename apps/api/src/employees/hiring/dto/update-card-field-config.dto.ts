import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
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
}
