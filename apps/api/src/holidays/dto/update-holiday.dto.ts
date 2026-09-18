import { IsBoolean, IsDateString, IsOptional, IsString, MinLength } from "class-validator";

export class UpdateHolidayDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsDateString()
  holidayDate?: string;

  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;
}
