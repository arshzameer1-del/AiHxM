import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
import type { DataScopeType } from "@aihxm/shared-types";

const SCOPE_TYPES: DataScopeType[] = ["org_unit", "location", "cost_center"];
const FREQUENCIES = ["monthly", "semi_monthly", "bi_weekly", "weekly"] as const;

class PayrollAreaAttributesDto {
  @IsOptional()
  @IsIn(FREQUENCIES)
  frequency?: (typeof FREQUENCIES)[number];

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: "currencyCode must be a three-letter ISO code such as PKR" })
  currencyCode?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  calendarId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jurisdiction?: string | null;
}

export class CreatePayrollAreaDto extends PayrollAreaAttributesDto {
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

export class UpdatePayrollAreaDto extends PayrollAreaAttributesDto {
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
