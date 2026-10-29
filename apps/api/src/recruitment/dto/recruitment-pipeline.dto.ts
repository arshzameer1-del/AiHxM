import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

const INTERVIEW_TYPES = ["phone", "video", "onsite", "technical", "hr", "panel", "other"] as const;
const CHECK_TYPES = ["reference", "education", "employment_history", "identity", "criminal_record", "medical", "other"] as const;
const CHECK_STATUSES = ["requested", "in_progress", "passed", "failed", "waived"] as const;
const EVENT_TYPES = ["career_fair", "campus_drive", "walk_in_drive", "interview_day", "info_session", "job_posting", "other"] as const;

export class ScheduleInterviewDto {
  @IsUUID() applicationId!: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) roundNo?: number;
  @IsOptional() @IsIn([...INTERVIEW_TYPES]) interviewType?: (typeof INTERVIEW_TYPES)[number];
  @IsDateString() scheduledStart!: string;
  @IsDateString() scheduledEnd!: string;
  @IsOptional() @IsString() locationText?: string;
  @IsOptional() @IsUrl({ require_tld: false }) meetingLink?: string;
  @IsArray() @ArrayMaxSize(12) @IsUUID(undefined, { each: true }) interviewerEmployeeIds!: string[];
  @IsOptional() @IsString() notes?: string;
}

export class UpdateInterviewDto {
  @IsOptional() @IsDateString() scheduledStart?: string;
  @IsOptional() @IsDateString() scheduledEnd?: string;
  @IsOptional() @IsIn([...INTERVIEW_TYPES]) interviewType?: (typeof INTERVIEW_TYPES)[number];
  @IsOptional() @IsString() locationText?: string;
  @IsOptional() @IsString() meetingLink?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsUUID(undefined, { each: true }) interviewerEmployeeIds?: string[];
  @IsOptional() @IsIn(["scheduled", "completed", "cancelled", "no_show"]) status?: "scheduled" | "completed" | "cancelled" | "no_show";
  @IsOptional() @IsString() cancelReason?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ScorecardEntryDto {
  @IsString() @MinLength(1) criterion!: string;
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() comment?: string;
}

export class SubmitInterviewFeedbackDto {
  @IsInt() @Min(1) @Max(5) overallRating!: number;
  @IsIn(["strong_yes", "yes", "no", "strong_no"]) recommendation!: "strong_yes" | "yes" | "no" | "strong_no";
  @IsOptional() @IsString() strengths?: string;
  @IsOptional() @IsString() concerns?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ScorecardEntryDto) scorecard?: ScorecardEntryDto[];
  @IsOptional() @IsUUID() employeeId?: string;
}

export class CreatePreEmploymentCheckDto {
  @IsUUID() applicationId!: string;
  @IsIn([...CHECK_TYPES]) checkType!: (typeof CHECK_TYPES)[number];
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
}

export class UpdatePreEmploymentCheckDto {
  @IsOptional() @IsIn([...CHECK_STATUSES]) status?: (typeof CHECK_STATUSES)[number];
  @IsOptional() @IsString() resultNote?: string;
  @IsOptional() @IsBoolean() isRequired?: boolean;
}

export class UpsertRecruitmentEventDto {
  @IsString() @MinLength(1) title!: string;
  @IsOptional() @IsIn([...EVENT_TYPES]) eventType?: (typeof EVENT_TYPES)[number];
  @IsDateString() startsAt!: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() locationText?: string;
  @IsOptional() @IsUUID() requisitionId?: string;
  @IsOptional() @IsInt() @Min(1) capacity?: number;
  @IsOptional() @IsIn(["planned", "completed", "cancelled"]) status?: "planned" | "completed" | "cancelled";
  @IsOptional() @IsString() notes?: string;
}

export class EventAttendeeDto {
  @IsUUID() candidateId!: string;
}

export class EventAttendanceDto {
  @IsBoolean() attended!: boolean;
}

export class UpdateRecruitmentSettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(240) candidateRetentionMonths?: number | null;
  @IsOptional() @IsBoolean() consentRequired?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(365) offerValidityDays?: number | null;
  @IsOptional() @IsString() offerLetterTemplateKey?: string | null;
  @IsOptional() @IsBoolean() careersEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) careersIntro?: string | null;
  @IsOptional() @IsBoolean() sendApplicationReceipt?: boolean;
  @IsOptional() @IsBoolean() sendInterviewEmails?: boolean;
  @IsOptional() @IsBoolean() sendRejectionEmails?: boolean;
}

export class UploadCandidateDocumentDto {
  @IsOptional() @IsIn(["resume", "cover_letter", "identity", "certificate", "reference", "other"]) docType?: string;
}

