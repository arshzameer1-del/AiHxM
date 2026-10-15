import { IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

export class CreateCompensationComponentDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  // Payroll Enterprise Gap Analysis Phase P3 — defaults to "earning" in
  // the service when omitted.
  @IsOptional()
  @IsIn(["earning", "deduction", "employer_contribution", "reimbursement", "non_cash_benefit", "arrears", "retro", "shift_premium"])
  componentType?: "earning" | "deduction" | "employer_contribution" | "reimbursement" | "non_cash_benefit" | "arrears" | "retro" | "shift_premium";

  @IsOptional() @IsUUID() categoryCatalogItemId?: string | null;
  @IsOptional() @IsIn(["fixed", "percentage", "per_unit", "formula", "threshold"]) calculationType?: "fixed" | "percentage" | "per_unit" | "formula" | "threshold";
  @IsOptional() @IsIn(["none", "basic_salary", "component", "gross_fixed_earnings"]) basisType?: "none" | "basic_salary" | "component" | "gross_fixed_earnings";
  @IsOptional() @IsUUID() basisComponentId?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) defaultPercentage?: number | null;
  @IsOptional() @IsNumber() @Min(0) unitRate?: number | null;
  @IsOptional() @IsString() @MaxLength(40) unitLabel?: string | null;
  @IsOptional() @IsNumber() @Min(0) thresholdAmount?: number | null;
  @IsOptional() @IsObject() formulaExpression?: Record<string, unknown> | null;
  @IsOptional() @IsNumber() @Min(0) capAmount?: number | null;
  @IsOptional() @IsNumber() @Min(0) floorAmount?: number | null;
  @IsOptional() @IsIn(["none", "nearest", "up", "down"]) roundingMode?: "none" | "nearest" | "up" | "down";
  @IsOptional() @IsNumber() @Min(0.01) roundingIncrement?: number;
  @IsOptional() @IsIn(["prorated", "none"]) prorationMode?: "prorated" | "none";
  @IsOptional() @IsObject() eligibility?: { minServiceMonths?: number; employmentTypeCatalogItemIds?: string[] };
  @IsOptional() @IsBoolean() countsTowardEobiBase?: boolean;
  @IsOptional() @IsBoolean() countsTowardGratuityBase?: boolean;
  @IsOptional() @IsBoolean() countsTowardProvidentFundBase?: boolean;
  @IsOptional() @IsString() @MaxLength(60) glAccountCode?: string | null;
  @IsOptional() @IsString() @MaxLength(120) payslipLabel?: string | null;
  @IsOptional() @IsInt() @Min(0) displayOrder?: number;

}
