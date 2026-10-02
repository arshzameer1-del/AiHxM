import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, MinLength } from "class-validator";

export class CreateEmployeeLoanDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(["loan", "salary_advance"])
  loanType!: "loan" | "salary_advance";

  @IsOptional()
  @IsString()
  reason?: string;

  @IsNumber()
  @Min(0.01)
  principalAmount!: number;

  @IsNumber()
  @Min(0.01)
  installmentAmount!: number;

  @IsDateString()
  issuedDate!: string;
}

export class CancelEmployeeLoanDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;
}
