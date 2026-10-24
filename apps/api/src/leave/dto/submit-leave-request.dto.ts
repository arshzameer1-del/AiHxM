import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches } from "class-validator";
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
  @IsIn(["full", "first_half", "second_half", "hours"])
  dayPart?: LeaveDayPart;

  @IsOptional()
  @IsUUID()
  attachmentDocumentId?: string;

  @IsOptional()
  @IsUUID()
  delegateEmployeeId?: string;

  /** BACKLOG58: a request by hours is on `startDate` between these local times. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "startTime must be HH:MM" })
  startTime?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "endTime must be HH:MM" })
  endTime?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  acknowledgedWarnings?: string[];

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Za-z]{2})?$/)
  locale?: string;

  /** Validation only: the pending request being edited, so it is not counted against itself. */
  @IsOptional()
  @IsUUID()
  excludeRequestId?: string;
}
