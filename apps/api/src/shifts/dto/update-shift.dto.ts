import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Min, MinLength } from "class-validator";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const SCHEDULE_TYPES = ["fixed", "flexible", "shift", "rotating", "individual"] as const;

export class UpdateShiftDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: "startTime must be HH:MM or HH:MM:SS, 24-hour" })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: "endTime must be HH:MM or HH:MM:SS, 24-hour" })
  endTime?: string;

  @IsOptional()
  @IsBoolean()
  crossesMidnight?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  graceMinutesLate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  graceMinutesEarly?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsIn(SCHEDULE_TYPES)
  scheduleType?: (typeof SCHEDULE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  timezone?: string;
}
