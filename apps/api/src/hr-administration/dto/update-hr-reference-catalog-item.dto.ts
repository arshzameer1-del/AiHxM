import { IsBoolean, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";

export class UpdateHrReferenceCatalogItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** null clears the bound. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveTo?: string | null;

  @IsOptional()
  @IsObject()
  applicability?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;
}
