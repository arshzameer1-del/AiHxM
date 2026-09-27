import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

export class ReactivateEmployeeDto {
  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
