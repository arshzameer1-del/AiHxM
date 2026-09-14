import { IsIn, IsLatitude, IsLongitude, IsOptional, IsString, MinLength } from "class-validator";
import type { AttendanceSource } from "@boostfactor/shared-types";

export class ClockInDto {
  // employee_number, deliberately not the internal UUID — plan doc
  // Section 5's rule that any external interface (a biometric device, a
  // kiosk) speaks the number it scanned, never the internal id. See
  // 0015_leave_attendance.sql's header comment.
  @IsString()
  @MinLength(1)
  employeeNumber!: string;

  @IsIn(["biometric", "gps", "manual"])
  source!: AttendanceSource;

  @IsOptional()
  @IsLatitude()
  gpsLat?: number;

  @IsOptional()
  @IsLongitude()
  gpsLng?: number;
}
