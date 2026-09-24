import { IsBoolean, IsInt, IsOptional, IsString, Min } from "class-validator";

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

// TM-015 — colors only; logo/favicon/login background go through the
// dedicated upload endpoints (real files via FileStorageService, not a
// pasted-in URL), see CompaniesService.uploadBrandingAsset.
export class BrandingInputDto {
  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsOptional()
  @IsString()
  secondaryColor?: string;
}
