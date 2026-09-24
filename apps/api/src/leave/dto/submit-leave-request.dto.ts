import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from "class-validator";
import type { LeaveType } from "@aihxm/shared-types";

export class SubmitLeaveRequestDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(["annual", "casual", "sick", "unpaid"])
  leaveType!: LeaveType;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
