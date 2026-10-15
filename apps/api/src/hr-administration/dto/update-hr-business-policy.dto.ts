import { IsBoolean, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";

export class UpdateHrBusinessPolicyDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsObject()
  rules?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

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
}
