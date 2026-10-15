import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches } from "class-validator";
import type { LeaveDayPart, LeaveType } from "@aihxm/shared-types";

/** LV-UP: every field is optional; a field that is left out keeps its current value. `delegateEmployeeId: null` clears the relief person. */
export class UpdateLeaveRequestDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  leaveType?: LeaveType;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  reason?: string | null;

  @IsOptional()
  @IsIn(["full", "first_half", "second_half"])
  dayPart?: LeaveDayPart;

  @IsOptional()
  @IsUUID()
  delegateEmployeeId?: string | null;
}
