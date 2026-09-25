import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { LogoAlignment } from "@aihxm/shared-types";

/** Partial, validated input for CompanyConfig.employeeNumberFormat (plan doc Section 5). */
export class EmployeeNumberFormatInputDto {
  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  padding?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  startingSequence?: number;

  @IsOptional()
  @IsBoolean()
  preserveImportedNumbers?: boolean;
}

// TM-015 — colors and logo layout only; logo/favicon/login background
// FILES go through the dedicated upload endpoints (real files via
// FileStorageService, not a pasted-in URL), see
// CompaniesService.uploadBrandingAsset. logoAlignment/logoHeightPx/
// logoBackgroundColor style how that uploaded logo is presented — same
// "just more branding jsonb" merge path as the colors below.
export class BrandingInputDto {
  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsOptional()
  @IsString()
  secondaryColor?: string;

  @IsOptional()
  @IsIn(["left", "center", "right"])
  logoAlignment?: LogoAlignment;

  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(120)
  logoHeightPx?: number;

  @IsOptional()
  @IsString()
  logoBackgroundColor?: string;
}
