import { IsBoolean, IsUUID, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import type { AccrualMethod, LeaveGenderRestriction } from "@aihxm/shared-types";

export class CreateLeaveTypeDto {
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]{1,39}$/)
  code!: string;

  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsBoolean() isPaid?: boolean;
  @IsOptional() @IsBoolean() tracksBalance?: boolean;
  @IsOptional() @IsIn(["upfront", "monthly", "none"]) accrualMethod?: AccrualMethod;
  @IsOptional() @IsBoolean() carryForwardAllowed?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) carryForwardCapDays?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(120) carryForwardExpiryMonths?: number | null;
  @IsOptional() @IsBoolean() encashable?: boolean;
  @IsOptional() @IsBoolean() documentRequired?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) documentRequiredAfterDays?: number;
  @IsOptional() @IsIn(["any", "male", "female"]) genderRestriction?: LeaveGenderRestriction;
  @IsOptional() @IsInt() @Min(0) @Max(600) minServiceMonths?: number;
  @IsOptional() @IsBoolean() halfDayAllowed?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) maxConsecutiveDays?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

/** `code` is immutable. */
export class UpdateLeaveTypeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsBoolean() isPaid?: boolean;
  @IsOptional() @IsBoolean() tracksBalance?: boolean;
  @IsOptional() @IsIn(["upfront", "monthly", "none"]) accrualMethod?: AccrualMethod;
  @IsOptional() @IsBoolean() carryForwardAllowed?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) carryForwardCapDays?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(120) carryForwardExpiryMonths?: number | null;
  @IsOptional() @IsBoolean() encashable?: boolean;
  @IsOptional() @IsBoolean() documentRequired?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) documentRequiredAfterDays?: number;
  @IsOptional() @IsIn(["any", "male", "female"]) genderRestriction?: LeaveGenderRestriction;
  @IsOptional() @IsInt() @Min(0) @Max(600) minServiceMonths?: number;
  @IsOptional() @IsBoolean() halfDayAllowed?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) maxConsecutiveDays?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

export class AdjustLeaveBalanceDto {
  @IsUUID() employeeId!: string;
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) leaveType!: string;
  @IsOptional() @IsInt() @Min(2000) @Max(2200) year?: number;
  @IsNumber({ maxDecimalPlaces: 2 }) days!: number;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class RequestLeaveCancellationDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class DecideLeaveCancellationDto {
  @IsIn(["approved", "declined"]) decision!: "approved" | "declined";
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}
