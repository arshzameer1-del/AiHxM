import { IsBoolean, IsOptional } from "class-validator";

/** Hiring Card Field Configuration (2026-09-27) — enable/disable + required for ONE built-in field on ONE card. See `CardFieldConfigService.updateFieldConfig()`. */
export class UpdateCardFieldConfigDto {
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}
