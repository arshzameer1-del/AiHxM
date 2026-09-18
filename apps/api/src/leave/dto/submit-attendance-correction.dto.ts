import { IsDateString, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class SubmitAttendanceCorrectionDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  requestedDate!: string;

  @IsOptional()
  @IsDateString()
  requestedClockIn?: string;

  @IsOptional()
  @IsDateString()
  requestedClockOut?: string;

  @IsString()
  @MinLength(3)
  reason!: string;

  @IsOptional()
  @IsUUID()
  attendanceRecordId?: string;
}
