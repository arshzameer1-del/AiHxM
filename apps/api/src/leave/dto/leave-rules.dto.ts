import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import type {
  LeaveBreakTreatment,
  LeaveFrequencyPeriod,
  LeaveRuleConditionGroup,
  LeaveSameDayPolicy,
  LeaveSelectionMethod,
  LeaveValidationRuleParams,
  LeaveValidationSeverity,
  LeaveValidationType,
} from "@aihxm/shared-types";
import { VALIDATION_TYPES } from "../leave-validation.catalog";
import { SubmitLeaveRequestDto } from "./submit-leave-request.dto";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** BACKLOG58: the timing rules of a leave type (or of one policy's override of them). Every field is optional; null clears a limit. */
export class SetLeaveDurationSettingsDto {
  @IsOptional() @IsIn(["employee_selected", "fixed_window"]) selectionMethod?: LeaveSelectionMethod;
  @IsOptional() @Matches(TIME) earliestStartTime?: string | null;
  @IsOptional() @Matches(TIME) latestEndTime?: string | null;
  @IsOptional() @Matches(TIME) fixedStartTime?: string | null;
  @IsOptional() @Matches(TIME) fixedEndTime?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(1440) minDurationMinutes?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1440) maxDurationMinutes?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(720) incrementMinutes?: number | null;
  @IsOptional() @IsIn(["exclude_all", "exclude_unpaid", "include"]) breakTreatment?: LeaveBreakTreatment;
  @IsOptional() @IsBoolean() validateAgainstSchedule?: boolean;
  @IsOptional() @IsBoolean() allowOvernight?: boolean;
  @IsOptional() @IsIn(["unrestricted", "same_day_only", "future_only"]) sameDayPolicy?: LeaveSameDayPolicy;
  @IsOptional() @IsInt() @Min(0) @Max(525600) minNoticeMinutes?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(3650) backdateDaysAllowed?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1440) dailyLimitMinutes?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(44640) monthlyLimitMinutes?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000) frequencyMaxRequests?: number | null;
  @IsOptional() @IsIn(["day", "week", "month", "year"]) frequencyPeriod?: LeaveFrequencyPeriod | null;
  @IsOptional() @IsInt() @Min(1) @Max(1440) dayEquivalentMinutes?: number | null;
  @IsOptional() @IsString() @MaxLength(120) workflowTemplateKey?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SaveLeaveValidationRuleDto {
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsIn(VALIDATION_TYPES) validationType?: LeaveValidationType;
  @IsOptional() @IsArray() @IsString({ each: true }) leaveTypes?: string[];
  @IsOptional() @IsArray() @IsUUID("all", { each: true }) policyIds?: string[];
  @IsOptional() @IsArray() @IsUUID("all", { each: true }) employeeGroupIds?: string[];
  @IsOptional() @IsIn(["block", "warning", "info"]) severity?: LeaveValidationSeverity;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
  @IsOptional() @IsObject() messages?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(2000) adminExplanation?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(100000) priority?: number;
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() allowProceed?: boolean;
  @IsOptional() @IsObject() conditions?: LeaveRuleConditionGroup | null;
  @IsOptional() @IsObject() params?: LeaveValidationRuleParams;
}

export class LeaveRulePreviewDto {
  @ValidateNested() @Type(() => SaveLeaveValidationRuleDto) rule!: SaveLeaveValidationRuleDto;
  @ValidateNested() @Type(() => SubmitLeaveRequestDto) request!: SubmitLeaveRequestDto;
}
