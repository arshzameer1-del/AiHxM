import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { EmployeeQualificationType } from "@aihxm/shared-types";

const QUALIFICATION_TYPES: EmployeeQualificationType[] = ["certificate", "license", "skill"];

export class CreateEmployeeQualificationDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(QUALIFICATION_TYPES)
  qualificationType!: EmployeeQualificationType;

  @IsString()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  issuingAuthority?: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  proficiencyLevel?: string;
}

export { QUALIFICATION_TYPES };
