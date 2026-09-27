import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateEmployeeImportantDateDto {
  @IsOptional()
  @IsDateString()
  dateValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;
}
