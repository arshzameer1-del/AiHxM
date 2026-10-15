import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches } from "class-validator";
import type { LeaveDayPart, LeaveType } from "@aihxm/shared-types";

export class SubmitLeaveRequestDto {
  @IsUUID()
  employeeId!: string;

  /** A leave type code from the tenant's catalogue (`GET /leave-types`). */
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  leaveType!: LeaveType;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsIn(["full", "first_half", "second_half"])
  dayPart?: LeaveDayPart;

  @IsOptional()
  @IsUUID()
  attachmentDocumentId?: string;

  @IsOptional()
  @IsUUID()
  delegateEmployeeId?: string;
}
