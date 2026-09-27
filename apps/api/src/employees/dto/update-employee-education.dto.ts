import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateEmployeeEducationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  degreeTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  institution?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fieldOfStudy?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  grade?: string;
}
