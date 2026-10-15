import { IsBoolean, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";

export class CreateHrBusinessPolicyDto {
  @IsString()
  @MaxLength(100)
  policyType!: string;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

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
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveTo?: string;

  @IsOptional()
  @IsObject()
  applicability?: Record<string, unknown>;
}
