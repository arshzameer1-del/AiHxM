import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min, MinLength } from "class-validator";

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

  /** Either this or installmentsCount (PAY-13). */
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  installmentAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  installmentsCount?: number;

  @IsDateString()
  issuedDate!: string;

  @IsOptional()
  @IsDateString()
  deductionStartDate?: string;

  @IsOptional()
  @IsUUID()
  loanTypeId?: string;

  @IsOptional()
  @IsUUID()
  guarantorEmployeeId?: string;
}

export class CancelEmployeeLoanDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;
}

export class UpsertLoanTypeDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsIn(["loan", "salary_advance"]) kind?: "loan" | "salary_advance";
  @IsOptional() @IsNumber() maxInstallmentPercent?: number | null;
  @IsOptional() @IsNumber() maxPrincipalMultiple?: number | null;
  @IsOptional() @IsInt() maxInstallments?: number | null;
  @IsOptional() @IsBoolean() requiresGuarantor?: boolean;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class HoldEmployeeLoanDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}

export class ResumeEmployeeLoanDto {
  @IsOptional()
  @IsDateString()
  resumeFrom?: string;
}

export class SkipLoanInstallmentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  installmentNos!: number[];

  @IsString()
  @MinLength(3)
  reason!: string;
}

export class SettleEmployeeLoanDto {
  @IsIn(["payroll", "cash", "withdraw"])
  mode!: "payroll" | "cash" | "withdraw";

  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @IsOptional() @IsDateString() receivedOn?: string;
  @IsOptional() @IsString() reference?: string;
}

export class GenerateLoanScheduleDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;
}
