import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class SubmitOvertimeClaimDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  workDate!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsIn(["pay", "comp_off"])
  payoutMode?: "pay" | "comp_off";
}

export class CreateOvertimeAuthorizationDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  workDate!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxMinutes?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
