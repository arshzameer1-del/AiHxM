import { Type } from "class-transformer";
import {
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator";
import { MODULE_KEYS, type ModuleKey, type PackageTier } from "@boostfactor/shared-types";
import { EmployeeNumberFormatInputDto } from "./common.dto";

const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

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
}
