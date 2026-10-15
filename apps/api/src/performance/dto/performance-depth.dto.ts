import { Type } from "class-transformer";
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, MinLength, ValidateIf, ValidateNested,
} from "class-validator";

const PHASES = ["goal_setting", "self_assessment", "manager_assessment", "calibration", "release"] as const;

export class GoalPlanDto {
  @IsUUID() reviewCycleId!: string;
  @IsUUID() employeeId!: string;
}

export class ReopenGoalPlanDto extends GoalPlanDto {
  @IsString() @MinLength(3) reason!: string;
}

export class EvidenceDto {
  @IsString() @MinLength(1) label!: string;
  @IsString() @MinLength(8) url!: string;
}

export class PhaseDto {
  @IsIn([...PHASES]) phaseKey!: (typeof PHASES)[number];
  @Matches(/^\d{4}-\d{2}-\d{2}$/) startsOn!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) endsOn!: string;
}

export class SetPhasesDto {
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => PhaseDto) phases!: PhaseDto[];
}

export class UpsertCompetencyDto {
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,39}$/) code?: string;
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class RatingInputDto {
  @IsOptional() @IsUUID() goalId?: string;
  @IsOptional() @IsUUID() competencyId?: string;
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() comment?: string;
}

export class SetReviewRatingsDto {
  @IsIn(["self", "manager", "calibration"]) source!: "self" | "manager" | "calibration";
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RatingInputDto) ratings!: RatingInputDto[];
}

export class GiveFeedbackDto {
  @IsUUID() subjectEmployeeId!: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsIn(["continuous", "recognition"]) feedbackType?: "continuous" | "recognition";
  @IsOptional() @IsUUID() goalId?: string;
  @IsOptional() @IsUUID() competencyId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsIn(["subject", "manager_only", "hr_only"]) visibility?: "subject" | "manager_only" | "hr_only";
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => EvidenceDto) evidence?: EvidenceDto[];
}

export class RequestFeedbackDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) raterEmployeeIds!: string[];
  @IsIn(["peer", "upward", "skip_level", "other"]) raterType!: "peer" | "upward" | "skip_level" | "other";
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsBoolean() isAnonymous?: boolean;
}

export class CompetencyRatingDto {
  @IsUUID() competencyId!: string;
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() comment?: string;
}

export class RespondFeedbackDto {
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => CompetencyRatingDto) competencyRatings?: CompetencyRatingDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => EvidenceDto) evidence?: EvidenceDto[];
}

export class DevelopmentItemDto {
  @IsOptional() @IsUUID() competencyId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsIn(["course", "mentoring", "coaching", "project", "stretch_assignment", "reading", "other"]) itemType?: "course" | "mentoring" | "coaching" | "project" | "stretch_assignment" | "reading" | "other";
  @IsString() @MinLength(1) action!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateDevelopmentPlanDto {
  @IsUUID() employeeId!: string;
  @IsString() @MinLength(1) title!: string;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @IsDateString() targetDate?: string;
  @IsOptional() @IsUUID() reviewCycleId?: string;
  @IsOptional() @IsUUID() reviewId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => DevelopmentItemDto) items?: DevelopmentItemDto[];
}

export class UpdateDevelopmentPlanDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() targetDate?: string | null;
  @IsOptional() @IsIn(["draft", "active", "completed", "cancelled"]) status?: "draft" | "active" | "completed" | "cancelled";
}

export class UpdateDevelopmentItemDto {
  @IsOptional() @IsUUID() competencyId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsIn(["course", "mentoring", "coaching", "project", "stretch_assignment", "reading", "other"]) itemType?: "course" | "mentoring" | "coaching" | "project" | "stretch_assignment" | "reading" | "other";
  @IsOptional() @IsString() @MinLength(1) action?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsIn(["not_started", "in_progress", "done"]) status?: "not_started" | "in_progress" | "done";
}

export class UpdatePerformanceSettingsDto {
  @IsOptional() @IsInt() @Min(2) @Max(20) minRatersForAnonymity?: number | null;
}
