import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

export class CreateHolidayCalendarDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  locationIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  orgUnitIds?: string[];
}

export class UpdateHolidayCalendarDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsIn(["active", "archived"])
  status?: "active" | "archived";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  locationIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  orgUnitIds?: string[];
}

export class RollHolidaysForwardDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  fromYear!: number;

  @IsInt()
  @Min(2000)
  @Max(2100)
  toYear!: number;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  calendarId?: string | null;
}
