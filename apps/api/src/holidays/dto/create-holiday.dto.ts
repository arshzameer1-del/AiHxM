import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from "class-validator";

export class CreateHolidayDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsDateString()
  holidayDate!: string;

  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;

  /** TLM-10 - null / omitted = company-wide. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  calendarId?: string | null;

  @IsOptional()
  @IsBoolean()
  isGazetted?: boolean;

  @IsOptional()
  @IsIn(["fixed", "lunar"])
  dateBasis?: "fixed" | "lunar";

  @IsOptional()
  @IsBoolean()
  isTentative?: boolean;
}
