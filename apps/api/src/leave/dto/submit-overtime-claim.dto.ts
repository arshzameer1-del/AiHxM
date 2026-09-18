import { IsDateString, IsOptional, IsString, IsUUID } from "class-validator";

export class SubmitOvertimeClaimDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  workDate!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
