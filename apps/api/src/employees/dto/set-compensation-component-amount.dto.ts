import { IsNumber, IsUUID, Min } from "class-validator";

/** One entry in `SetEmployeeCompensationComponentsDto.components` — see
 * EmployeeGroupConditionDto for the precedent of a shared nested-array
 * item DTO in this codebase. */
export class SetCompensationComponentAmountDto {
  @IsUUID()
  componentId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;
}
