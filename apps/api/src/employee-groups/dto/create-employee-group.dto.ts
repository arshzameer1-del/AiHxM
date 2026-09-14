import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
import { EmployeeGroupConditionDto } from "./employee-group-condition.dto";

export class CreateEmployeeGroupDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EmployeeGroupConditionDto)
  conditions!: EmployeeGroupConditionDto[];
}
