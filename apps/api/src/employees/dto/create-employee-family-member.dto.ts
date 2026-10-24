import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import type { EmployeeFamilyRelationship } from "@aihxm/shared-types";

const FAMILY_RELATIONSHIPS: EmployeeFamilyRelationship[] = ["spouse", "child", "parent", "sibling", "other"];

export class CreateEmployeeFamilyMemberDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(FAMILY_RELATIONSHIPS)
  relationship!: EmployeeFamilyRelationship;

  @IsString()
  @MaxLength(255)
  fullName!: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  cnic?: string;

  @IsOptional()
  @IsBoolean()
  isDependent?: boolean;

  @IsOptional()
  @IsBoolean()
  isBeneficiary?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  beneficiarySharePercent?: number;
}

export { FAMILY_RELATIONSHIPS };
