import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

const CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR"];

// TM-014 — Tenant Profile's "Company Information" section.
export class UpdateCompanyProfileDto {
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
}
