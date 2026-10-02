import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

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
}
