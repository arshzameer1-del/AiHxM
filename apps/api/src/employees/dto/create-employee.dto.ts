import { IsDateString, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

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
