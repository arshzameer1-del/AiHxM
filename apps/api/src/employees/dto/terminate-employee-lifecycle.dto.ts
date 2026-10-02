import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * The explicit-lifecycle-surface counterpart of setting
 * `employmentStatus: "terminated"` via `EmployeesService.update()` — see
 * `EmployeeLifecycleService.terminate()`'s own doc comment for why both
 * paths exist. Named with the `-lifecycle` suffix only to avoid a filename
 * collision with `UpdateEmployeeDto`'s own termination fields; there is no
 * behavioral difference in what "terminate" means between the two.
 */
export class TerminateEmployeeLifecycleDto {
  @IsDateString()
  terminationDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  terminationReason?: string;

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
