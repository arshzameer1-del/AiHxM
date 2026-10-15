import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import type { OffboardingReason, OffboardingRehireEligibility, OffboardingExitInterviewStatus } from "@aihxm/shared-types";

const REASONS: OffboardingReason[] = ["resignation", "termination", "retirement", "end_of_contract", "other"];
const ELIGIBILITY: OffboardingRehireEligibility[] = ["eligible", "conditional", "not_eligible"];
const EXIT_STATUS: OffboardingExitInterviewStatus[] = ["not_required", "pending", "completed", "declined"];

export class InitiateOffboardingDto {
  @IsIn(REASONS)
  reason!: OffboardingReason;

  @IsDateString()
  lastWorkingDay!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  /** LIF-05 - code from the lifecycle_reason:termination catalog, carried to the termination event. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reasonCode?: string;

  /** LIF-05 - defaults to the Termination / Exit policy's noticeDays when omitted. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;

  @IsOptional()
  @IsDateString()
  noticeStartDate?: string;

  /** LIF-05 - true opens the exit interview as 'pending' (it then gates completion). */
  @IsOptional()
  @IsBoolean()
  exitInterviewRequired?: boolean;
}

/** LIF-05 / LIF-06 - exit details HR records while the offboarding is open. */
export class UpdateOffboardingExitDto {
  @IsOptional()
  @IsIn(ELIGIBILITY)
  rehireEligibility?: OffboardingRehireEligibility;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rehireEligibilityNote?: string;

  @IsOptional()
  @IsIn(EXIT_STATUS)
  exitInterviewStatus?: OffboardingExitInterviewStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  exitInterviewNotes?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;

  @IsOptional()
  @IsDateString()
  noticeStartDate?: string;
}
