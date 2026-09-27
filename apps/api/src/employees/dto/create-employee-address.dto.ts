import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { EmployeeAddressType } from "@aihxm/shared-types";

const ADDRESS_TYPES: EmployeeAddressType[] = ["permanent", "current", "mailing"];

export class CreateEmployeeAddressDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(ADDRESS_TYPES)
  addressType!: EmployeeAddressType;

  @IsString()
  @MaxLength(255)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  stateProvince?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  country?: string;
}

export { ADDRESS_TYPES };
