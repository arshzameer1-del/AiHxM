import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Min, ValidateIf, ValidateNested } from "class-validator";

/** Phase 3's scoped admin surface — enable/disable and reorder, plus requiredness. Deeper per-field rules are deliberately not here yet (kumail's own scoping decision #2). */
export class UpdateCardDefinitionEntryDto {
  @IsString()
  cardKey!: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  // CFG-11 metadata - nullable rule slots accept null to clear.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  applicabilityRule?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  workflowTemplateKey?: string | null;

  @IsOptional()
  @IsBoolean()
  isEffectiveDated?: boolean;

  @IsOptional()
  @IsIn(["none", "optional", "required"])
  attachmentRequirement?: "none" | "optional" | "required";

  @IsOptional()
  @IsBoolean()
  editableAfterSave?: boolean;

  @IsOptional()
  @IsBoolean()
  isCompletionGate?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  visibilityRule?: Record<string, unknown> | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  validationRuleKeys?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  defaultRuleKeys?: string[];

  @IsOptional()
  @IsObject()
  displayNameI18n?: Record<string, string>;

  @IsOptional()
  @IsIn(["draft", "validated", "published", "retired"])
  configStatus?: "draft" | "validated" | "published" | "retired";
}

export class UpdateHiringConfigurationDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateCardDefinitionEntryDto)
  cards!: UpdateCardDefinitionEntryDto[];
}
