import { IsEmail, IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";
import type { PackageTier } from "@boostfactor/shared-types";

const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

/**
 * The public, unauthenticated counterpart of `CreateCompanyDto`
 * (`companies/dto/create-company.dto.ts`) — same slug pattern, same
 * package-tier whitelist — but for a caller who isn't a Platform Admin
 * and doesn't get to name arbitrary `enabledModules` or an
 * `employeeNumberFormat` up front; those stay sane defaults, editable
 * later from Admin Center once the admin is actually logged in.
 */
export class SignupDto {
  @IsString()
  @MinLength(2, { message: "companyName must be at least 2 characters" })
  companyName!: string;

  @IsOptional()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "slug must be lowercase letters/digits, hyphen-separated (e.g. zaman-textiles)",
  })
  slug?: string;

  @IsOptional()
  @IsIn(PACKAGE_TIERS)
  packageTier?: PackageTier;

  @IsString()
  @MinLength(2, { message: "adminFullName must be at least 2 characters" })
  adminFullName!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(10, { message: "adminPassword must be at least 10 characters" })
  adminPassword!: string;
}
