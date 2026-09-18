import { IsInt, IsNumber, IsOptional, Min } from "class-validator";

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
}
