import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from "class-validator";
import type { DataScopeType } from "@aihxm/shared-types";

const SCOPE_TYPES: DataScopeType[] = ["org_unit", "location", "cost_center"];

export class CreatePayrollAreaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;
}

export class UpdatePayrollAreaDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AddPayrollAreaScopeLinkDto {
  @IsIn(SCOPE_TYPES)
  scopeType!: DataScopeType;

  @IsUUID()
  scopeEntityId!: string;
}

export class AssignEmployeePayrollAreaDto {
  @IsUUID()
  employeeId!: string;

  /** `null` removes the employee from any payroll area. */
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  payrollAreaId!: string | null;
}
