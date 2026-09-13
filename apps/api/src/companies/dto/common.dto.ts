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

export class BrandingInputDto {
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  primaryColor?: string;
}
