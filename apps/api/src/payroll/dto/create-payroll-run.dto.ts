import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CreatePayrollRunDto {
  /** Required unless payrollPeriodId is given (then it must equal the period's start). */
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  /** PAY-03 - create the run for this payroll period; a tenant policy can require it. */
  @IsOptional()
  @IsUUID()
  payrollPeriodId?: string | null;

  /** Payroll Areas (0101_payroll_areas.sql) — omit/null for a company-wide run. */
  @IsOptional()
  @IsUUID()
  payrollAreaId?: string | null;

  /** Phase P4 — omit for a regular run. (Added to the HTTP contract in Step 9: the service always supported it.) */
  @IsOptional()
  @IsIn(["regular", "off_cycle"])
  runType?: "regular" | "off_cycle";

  @IsOptional()
  @IsIn(["bonus", "arrears", "final_settlement", "other"])
  offCycleReason?: "bonus" | "arrears" | "final_settlement" | "other";

  @IsOptional()
  @IsUUID()
  targetEmployeeId?: string;

  /** PAY-02 - calculate without ever consuming inputs; cannot be approved or finalised. */
  @IsOptional()
  @IsBoolean()
  isSimulation?: boolean;

  /** PAY-02 - the same key with the same request returns the run already created. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}
