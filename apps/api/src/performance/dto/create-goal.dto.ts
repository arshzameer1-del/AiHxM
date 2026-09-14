import { IsNumber, IsOptional, IsString, IsUUID, Max, Min, MinLength } from "class-validator";

export class CreateGoalDto {
  @IsUUID()
  reviewCycleId!: string;

  @IsUUID()
  employeeId!: string;

  @IsOptional()
  @IsUUID()
  parentGoalId?: string;

  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  weight?: number;
}
