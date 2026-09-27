import { IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class PromoteEmployeeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  designation!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  salaryBand?: string;

  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
