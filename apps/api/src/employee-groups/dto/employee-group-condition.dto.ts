import { IsIn, IsString, MinLength } from "class-validator";
import type { EmployeeGroupConditionField } from "@aihxm/shared-types";

const CONDITION_FIELDS: EmployeeGroupConditionField[] = [
  "department",
  "location",
  "designation",
  "employmentType",
  "employmentStatus",
];

/** Shared by create/update — kept as its own class so @ValidateNested/@Type
 * can validate each entry of a group's `conditions` array, the same
 * pattern WorkflowStepConfigDto's own nested approvers array uses. */
export class EmployeeGroupConditionDto {
  @IsIn(CONDITION_FIELDS)
  field!: EmployeeGroupConditionField;

  @IsString()
  @MinLength(1)
  equals!: string;
}
