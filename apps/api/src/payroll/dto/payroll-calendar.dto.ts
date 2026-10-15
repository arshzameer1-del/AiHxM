import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

const FREQUENCIES = ["monthly", "semi_monthly", "bi_weekly", "weekly"] as const;

export class CreatePayrollCalendarDto {
  @IsString() @MinLength(1) @MaxLength(50) code!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsIn(FREQUENCIES) frequency?: (typeof FREQUENCIES)[number];
  @IsOptional() @Matches(/^[A-Z]{3}$/, { message: "currencyCode must be a three-letter ISO code such as PKR" }) currencyCode?: string;
  @IsOptional() @IsInt() @Min(-31) @Max(62) payDayOffset?: number;
  @IsOptional() @IsInt() @Min(0) @Max(31) cutoffDaysBeforeEnd?: number;
}

export class UpdatePayrollCalendarDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsInt() @Min(-31) @Max(62) payDayOffset?: number;
  @IsOptional() @IsInt() @Min(0) @Max(31) cutoffDaysBeforeEnd?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GeneratePayrollPeriodsDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "fromDate must be YYYY-MM-DD" }) fromDate!: string;
  @IsInt() @Min(1) @Max(60) count!: number;
}

export class ReopenPayrollPeriodDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}
