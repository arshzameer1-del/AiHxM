import { Type } from "class-transformer";
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { MODULE_KEYS, type ModuleKey, type PackageTier } from "@aihxm/shared-types";
import { EmployeeNumberFormatInputDto } from "./common.dto";

const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];
const CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR"];

class InitialAdminDto {
  @IsString()
  fullName!: string;

  @IsEmail()
  email!: string;
}

export class CreateCompanyDto {
  @IsString()
  name!: string;

  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "slug must be lowercase letters/digits, hyphen-separated (e.g. zaman-textiles)",
  })
  slug!: string;

  @IsOptional()
  @IsIn(PACKAGE_TIERS)
  packageTier?: PackageTier;

  @IsOptional()
  @IsArray()
  @IsIn(MODULE_KEYS, { each: true })
  enabledModules?: ModuleKey[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EmployeeNumberFormatInputDto)
  employeeNumberFormat?: EmployeeNumberFormatInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => InitialAdminDto)
  initialAdmin?: InitialAdminDto;

  // TM-006/007/008 — Create Tenant wizard's Company/Business/Domain steps.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  companyCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customDomain?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  seatsPurchased?: number;
}
