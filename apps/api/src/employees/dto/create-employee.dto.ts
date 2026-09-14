import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import type { EmploymentType } from "@boostfactor/shared-types";

export class CreateEmployeeDto {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  cnic?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsOptional()
  @IsString()
  maritalStatus?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  designation?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsIn(["permanent", "contract", "probation", "intern"])
  employmentType?: EmploymentType;

  @IsOptional()
  @IsUUID()
  managerId?: string;

  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @IsOptional()
  @IsString()
  salaryBand?: string;

  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @IsOptional()
  @IsUUID()
  userAccountId?: string;

  /** Set only when preserving a legacy staff number — see EmployeesService.assignEmployeeNumber. */
  @IsOptional()
  @IsString()
  employeeNumber?: string;
}
