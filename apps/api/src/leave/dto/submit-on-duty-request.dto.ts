import { IsDateString, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class SubmitOnDutyRequestDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  location?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;
}
