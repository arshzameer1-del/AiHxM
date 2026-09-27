import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";

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
}

export class UpdateHiringConfigurationDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateCardDefinitionEntryDto)
  cards!: UpdateCardDefinitionEntryDto[];
}
