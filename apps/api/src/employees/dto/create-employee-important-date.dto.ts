import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { EmployeeImportantDateType } from "@aihxm/shared-types";

const IMPORTANT_DATE_TYPES: EmployeeImportantDateType[] = [
  "joining",
  "confirmation",
  "probation_end",
  "contract_end",
  "document_expiry",
];

export class CreateEmployeeImportantDateDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(IMPORTANT_DATE_TYPES)
  dateType!: EmployeeImportantDateType;

  @IsDateString()
  dateValue!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;
}

export { IMPORTANT_DATE_TYPES };
