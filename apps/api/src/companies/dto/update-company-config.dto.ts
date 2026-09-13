import { Type } from "class-transformer";
import { IsArray, IsIn, IsOptional, ValidateNested } from "class-validator";
import { MODULE_KEYS, type ModuleKey } from "@boostfactor/shared-types";
import { BrandingInputDto, EmployeeNumberFormatInputDto } from "./common.dto";

export class UpdateCompanyConfigDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => BrandingInputDto)
  branding?: BrandingInputDto;

  @IsOptional()
  @IsArray()
  @IsIn(MODULE_KEYS, { each: true })
  enabledModules?: ModuleKey[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EmployeeNumberFormatInputDto)
  employeeNumberFormat?: EmployeeNumberFormatInputDto;
}
