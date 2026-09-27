import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { EmployeeContactType } from "@aihxm/shared-types";

const CONTACT_TYPES: EmployeeContactType[] = [
  "business_email",
  "personal_email",
  "business_phone",
  "personal_phone",
  "emergency_contact",
];

export class CreateEmployeeContactDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(CONTACT_TYPES)
  contactType!: EmployeeContactType;

  @IsString()
  @MaxLength(255)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export { CONTACT_TYPES };
