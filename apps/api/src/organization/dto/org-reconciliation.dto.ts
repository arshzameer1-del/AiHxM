import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

/** `POST /organization/legacy-reconciliation/backfill` - dryRun defaults to true. */
export class RunBackfillDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(["department", "location", "manager", "designation"], { each: true })
  gapTypes?: Array<"department" | "location" | "manager" | "designation">;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}

/** `POST /organization/legacy-reconciliation/drift/repair` - dryRun defaults to true. */
export class RunDriftRepairDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsIn(["assignment", "employee"])
  prefer?: "assignment" | "employee";

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}
