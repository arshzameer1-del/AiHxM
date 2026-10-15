import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from "class-validator";

export class CreateEmployeeAdditionalPaymentDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(["earning", "deduction"])
  paymentType!: "earning" | "deduction";

  @IsOptional()
  @IsString()
  @MinLength(1)
  label?: string;

  @IsOptional()
  @IsUUID()
  componentId?: string;

  @IsOptional()
  @IsUUID()
  reasonCatalogItemId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reasonNote?: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @IsDateString()
  effectiveDate!: string;
}
