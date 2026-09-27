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

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
