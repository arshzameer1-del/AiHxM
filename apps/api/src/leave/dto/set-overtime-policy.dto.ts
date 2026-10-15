import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, Min, MaxLength, ValidateIf } from "class-validator";

/**
 * All fields optional — `OvertimeService.setPolicy()` merges onto the
 * currently-effective policy (seeding sensible defaults if none exists
 * yet) rather than requiring every field on every edit, the same partial-
 * patch ergonomics `PayrollService.updateSettings()` already gives its
 * own settings row.
 */
export class SetOvertimePolicyDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyThresholdMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  roundingMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  weekdayRateMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  restDayRateMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  holidayRateMultiplier?: number;

  /** TLM-07 - null clears a cap. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  maxDailyMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  maxMonthlyMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  requiresPreApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  compOffAllowed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  compOffMinutesPerDay?: number;
}

/** A policy for an employee group and/or a location. */
export class SetScopedOvertimePolicyDto extends SetOvertimePolicyDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  employeeGroupId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
