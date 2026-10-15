import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, Min, MinLength, ValidateIf } from "class-validator";
import type { UpdateGoalRequest } from "@aihxm/shared-types";

export class UpdateGoalDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  weight?: number;

  /** `overdue` is set by the system, never by hand. */
  @IsOptional()
  @IsIn(["active", "in_progress", "at_risk", "completed", "cancelled"])
  status?: UpdateGoalRequest["status"];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  @Min(0)
  targetValue?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  targetUnit?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  currentValue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  progressPct?: number;

  @IsOptional()
  @IsString()
  note?: string;
}
