import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from "class-validator";
import type { EmploymentStatus, EmploymentType } from "@aihxm/shared-types";

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

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

  /** Organization Management Phase 1 — see CreateEmployeeDto's own doc
   * comment. */
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsString()
  designation?: string;

  @IsOptional()
  @IsString()
  location?: string;

  /** Organization Management Phase 4 — see CreateEmployeeDto's own doc
   * comment. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

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
  @IsIn(["active", "on_leave", "terminated"])
  employmentStatus?: EmploymentStatus;

  @IsOptional()
  @IsDateString()
  terminationDate?: string;

  @IsOptional()
  @IsString()
  terminationReason?: string;
}
