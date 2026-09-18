import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export class WeeklyPatternBreakDto {
  @IsString()
  @Matches(TIME_PATTERN)
  startTime!: string;

  @IsString()
  @Matches(TIME_PATTERN)
  endTime!: string;

  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;
}

export class WeeklyPatternDayDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsBoolean()
  isWorking!: boolean;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  endTime?: string;

  @IsOptional()
  @IsBoolean()
  isFlexible?: boolean;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  flexibleStartTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  flexibleEndTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  coreStartTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  coreEndTime?: string;

  @IsOptional()
  @IsBoolean()
  isHalfDay?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyPatternBreakDto)
  breaks?: WeeklyPatternBreakDto[];
}

/** Section 26's "Copy Week" bulk edit: replace-all-7-days in one call — see ShiftsService.setWeeklyPattern's own doc comment for why this isn't 7 granular PATCH endpoints. */
export class SetWeeklyPatternDto {
  @IsArray()
  @ArrayMinSize(7)
  @ValidateNested({ each: true })
  @Type(() => WeeklyPatternDayDto)
  days!: WeeklyPatternDayDto[];
}
