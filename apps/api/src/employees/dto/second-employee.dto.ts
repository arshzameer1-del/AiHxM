import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class SecondEmployeeDto {
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  designation?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  // Cross-module integration audit Item 2 (2026-10-01) — optional host-
  // side supervisor for the secondment. When given, a `temporary`
  // org_relationships row is created (the relationship vocabulary has no
  // `secondment` type; `temporary` is its closest match). The
  // `secondment` employee_org_assignments slot is created either way.
  @IsOptional()
  @IsUUID()
  managerEmployeeId?: string;

  @IsDateString()
  effectiveDate!: string;

  @IsDateString()
  endDate!: string;

  // Cross-module integration audit Item 4 (2026-10-01) — optional code from
  // this transaction's `lifecycle_reason:*` HR Administration catalog
  // (LIFECYCLE_EVENT_REASON_CATALOG). Without this declaration the global
  // ValidationPipe's `forbidNonWhitelisted` rejected any request carrying
  // it, so the service's catalog validation was unreachable over HTTP.
  // Optional: callers that omit it behave exactly as before.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reasonCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
