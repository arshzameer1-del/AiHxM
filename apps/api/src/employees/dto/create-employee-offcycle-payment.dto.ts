import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from "class-validator";

export class CreateEmployeeOffCyclePaymentDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  payrollRunId!: string;

  @IsIn(["earning", "deduction"])
  paymentType!: "earning" | "deduction";

  @IsString()
  @MinLength(1)
  label!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;
}
