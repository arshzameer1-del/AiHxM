import { IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { EmploymentType } from "@aihxm/shared-types";

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

  /** Organization Management Phase 1 — links this employee to a canonical
   * org unit; `department`'s text is then derived from it server-side
   * (see EmployeesService.resolveDepartment()). */
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsString()
  designation?: string;

  @IsOptional()
  @IsString()
  location?: string;

  /** Organization Management Phase 4 — links this employee to a canonical
   * location; `location`'s text is then derived from it server-side (see
   * EmployeesService.resolveLocation()). */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  // HR Administration v2 (2026-09-27) — no longer a hardcoded `@IsIn`.
  // `EmployeesService.validateEmploymentType()` checks this against the
  // company's own active `employment_type` HR Administration catalog
  // instead (0090_hr_administration_reference_catalog.sql); a tenant may
  // add codes beyond the seeded 4, so a static decorator list can no
  // longer describe every valid value.
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
