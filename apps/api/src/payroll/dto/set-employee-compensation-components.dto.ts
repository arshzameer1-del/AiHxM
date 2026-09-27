import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsDateString, IsUUID, ValidateNested } from "class-validator";
import { SetCompensationComponentAmountDto } from "./set-compensation-component-amount.dto";

export class SetEmployeeCompensationComponentsDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SetCompensationComponentAmountDto)
  components!: SetCompensationComponentAmountDto[];
}
