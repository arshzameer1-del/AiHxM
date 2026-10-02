import { IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength, IsUUID } from "class-validator";

export class PromoteEmployeeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  designation!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  salaryBand?: string;

  // Cross-module integration audit Item 2 (2026-10-01) — optional new
  // Position. When given, the employee is moved into this (vacant) seat
  // through OrgOccupancyService in the same transaction: the old seat is
  // vacated, the new one filled, and the primary org assignment replaced.
  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsDateString()
  effectiveDate!: string;

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
