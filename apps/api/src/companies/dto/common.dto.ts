import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { HorizontalPosition, LogoAlignment, VerticalPosition } from "@aihxm/shared-types";

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

  // --- Login page layout — the full-page background photo and the
  // sign-in card itself. Same merge path as everything above.
  @IsOptional()
  @IsIn(["left", "center", "right"])
  loginBackgroundPositionX?: HorizontalPosition;

  @IsOptional()
  @IsIn(["top", "center", "bottom"])
  loginBackgroundPositionY?: VerticalPosition;

  @IsOptional()
  @IsInt()
  @Min(280)
  @Max(720)
  loginCardWidthPx?: number;

  @IsOptional()
  @IsIn(["left", "center", "right"])
  loginCardPosition?: HorizontalPosition;

  @IsOptional()
  @IsString()
  loginCardBackgroundColor?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  loginCardOpacity?: number;
}
