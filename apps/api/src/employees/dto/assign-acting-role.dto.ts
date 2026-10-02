import { IsDateString, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class AssignActingRoleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  designation!: string;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  department?: string;

  // Cross-module integration audit Item 2 (2026-10-01) — optional
  // Position being acted in (RECORDED on the `acting` assignment slot,
  // never occupied — the substantive incumbent usually still holds it) and
  // optional supervisor for the acting period (an `acting`
  // org_relationships row).
  @IsOptional()
  @IsUUID()
  positionId?: string;

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
