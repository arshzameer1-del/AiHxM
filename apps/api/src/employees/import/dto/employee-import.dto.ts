import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class DryRunEmployeeImportDto {
  @IsString()
  @MinLength(1)
  csv!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  /** import only the valid rows when some rows are invalid */
  @IsOptional()
  @IsBoolean()
  allowPartial?: boolean;
}
