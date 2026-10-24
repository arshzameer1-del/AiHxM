import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches } from "class-validator";
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
  @IsIn(["full", "first_half", "second_half", "hours"])
  dayPart?: LeaveDayPart;

  @IsOptional()
  @IsUUID()
  delegateEmployeeId?: string | null;

  /** BACKLOG58: the supporting document; `null` removes it. */
  @IsOptional()
  @IsUUID()
  attachmentDocumentId?: string | null;

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
}
