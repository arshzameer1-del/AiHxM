import { IsBoolean, IsDateString, IsOptional, IsString, MinLength } from "class-validator";

export class CreateHolidayDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsDateString()
  holidayDate!: string;

  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;
}
