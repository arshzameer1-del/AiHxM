import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { EmployeeFamilyRelationship } from "@aihxm/shared-types";

const FAMILY_RELATIONSHIPS: EmployeeFamilyRelationship[] = ["spouse", "child", "parent", "sibling", "other"];

export class UpdateEmployeeFamilyMemberDto {
  @IsOptional()
  @IsIn(FAMILY_RELATIONSHIPS)
  relationship?: EmployeeFamilyRelationship;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullName?: string;

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
}
