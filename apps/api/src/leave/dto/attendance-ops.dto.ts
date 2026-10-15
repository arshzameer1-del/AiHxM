import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import type { AttendanceDailyStatus, AttendanceDeviceType } from "@aihxm/shared-types";

const DAY_STATUSES = ["present", "absent", "late", "early_departure", "late_and_early", "half_day", "on_leave", "on_duty", "holiday", "rest_day", "no_schedule"];

export class EvaluateAttendanceDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

export class OverrideAttendanceDayDto {
  @IsUUID() employeeId!: string;
  @IsDateString() workDate!: string;
  @IsIn(DAY_STATUSES) status!: AttendanceDailyStatus;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class CreateAttendanceDeviceDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsIn(["biometric", "face", "card", "mobile", "kiosk"]) deviceType?: AttendanceDeviceType;
  @IsOptional() @IsString() @MaxLength(80) vendor?: string;
  @IsOptional() @IsString() @MaxLength(80) serialNumber?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}

export class UpdateAttendanceDeviceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsIn(["biometric", "face", "card", "mobile", "kiosk"]) deviceType?: AttendanceDeviceType;
  @IsOptional() @IsString() @MaxLength(80) vendor?: string;
  @IsOptional() @IsString() @MaxLength(80) serialNumber?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class EnrollDeviceUserDto {
  @IsUUID() employeeId!: string;
  @IsString() @MinLength(1) @MaxLength(80) deviceUserId!: string;
}

export class DevicePunchDto {
  @IsString() @MinLength(1) @MaxLength(80) deviceUserId!: string;
  @IsDateString() punchedAt!: string;
  @IsOptional() @IsIn(["in", "out"]) direction?: "in" | "out";
  @IsOptional() @IsString() @MaxLength(120) externalId?: string;
}

export class IngestPunchesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => DevicePunchDto)
  punches!: DevicePunchDto[];
}

export class TimesheetEntryDto {
  @IsDateString() workDate!: string;
  @IsInt() @Min(1) @Max(1440) minutes!: number;
  @IsOptional() @IsUUID() costCenterId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) taskRef?: string | null;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
}

export class SaveTimesheetEntriesDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => TimesheetEntryDto)
  entries!: TimesheetEntryDto[];
}

export class DecideTimesheetDto {
  @IsIn(["approved", "rejected"]) decision!: "approved" | "rejected";
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}
