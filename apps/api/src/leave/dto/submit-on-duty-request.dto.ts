import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

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
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;

  @IsOptional()
  @IsIn(["on_duty", "work_from_home"])
  dutyType?: "on_duty" | "work_from_home";
}
