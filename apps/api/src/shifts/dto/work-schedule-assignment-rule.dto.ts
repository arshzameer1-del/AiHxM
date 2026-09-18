import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import type { WorkScheduleRuleExpression } from "@boostfactor/shared-types";

// `conditionExpression` is validated for SHAPE by RulesEngine.validate()
// inside ShiftsService.createAssignmentRule/updateAssignmentRule (see
// that service's own validateExpression() — reusing the engine's own
// validation rather than re-implementing an equivalent class-validator
// tree for a recursive all/any/not structure, matching Section 15's
// "use the existing Rules Engine" instruction).
export class CreateWorkScheduleAssignmentRuleDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsObject()
  conditionExpression!: WorkScheduleRuleExpression;

  @IsUUID()
  scheduleId!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateWorkScheduleAssignmentRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsObject()
  conditionExpression?: WorkScheduleRuleExpression;

  @IsOptional()
  @IsUUID()
  scheduleId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
