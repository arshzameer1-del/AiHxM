import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class UpsertPositionBudgetDto {
  @IsNumber()
  @Min(0)
  plannedHeadcount!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  budgetAmount?: number | null;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreatePositionRelationshipDto {
  @IsUUID()
  relatedPositionId!: string;

  @IsIn(["reports_to", "dotted_line"])
  relationshipType!: "reports_to" | "dotted_line";

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class PositionPlanningSummaryQueryDto {
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  fiscalYear?: number;
}

export class UnassignPositionDto {
  /** ORG-02: for a multi-incumbent position, end only this employee's slot.
   * Omitted = end every incumbent (whole-seat vacate, the original behavior). */
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
