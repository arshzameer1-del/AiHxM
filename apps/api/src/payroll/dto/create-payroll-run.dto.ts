import { IsDateString, IsOptional, IsUUID } from "class-validator";

export class CreatePayrollRunDto {
  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  /** Payroll Areas (0101_payroll_areas.sql) — omit/null for a company-wide run. */
  @IsOptional()
  @IsUUID()
  payrollAreaId?: string | null;
}
