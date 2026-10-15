import { IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class CreateHrReferenceCatalogItemDto {
  @IsString()
  @MaxLength(100)
  catalogType!: string;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsString()
  @MaxLength(255)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveTo?: string;

  @IsOptional()
  @IsObject()
  applicability?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;
}
