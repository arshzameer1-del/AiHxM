import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, Min, MaxLength } from "class-validator";

export const TIME_RECORDING_PROFILES = ["clock", "timesheet", "exception_only", "none"] as const;

/** TLM-08: every field is optional; the service merges onto the profile in force. */
export class SetWorkProfileDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100)
  employmentPercentage?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.5)
  @Max(168)
  weeklyHours?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(744)
  monthlyHours?: number | null;

  @IsOptional()
  @IsBoolean()
  isPartTime?: boolean;

  @IsOptional()
  @IsIn(TIME_RECORDING_PROFILES as unknown as string[])
  timeRecordingProfile?: (typeof TIME_RECORDING_PROFILES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class SetCompanyWorkTimeDefaultDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(100)
  @Max(300)
  standardMonthlyHours!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.5)
  @Max(168)
  standardWeeklyHours?: number | null;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
