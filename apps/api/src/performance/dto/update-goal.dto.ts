import { IsIn, IsNumber, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import type { GoalStatus } from "@boostfactor/shared-types";

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

  @IsOptional()
  @IsIn(["active", "completed"])
  status?: GoalStatus;
}
