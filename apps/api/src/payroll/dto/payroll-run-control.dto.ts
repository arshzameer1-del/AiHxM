import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

export class PayrollRunReasonDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class ClosePayrollRunDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SetPayrollOverrideDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(["incomeTaxMonthly", "eobiEmployeeContribution", "eobiEmployerContribution", "socialSecurityEmployerContribution"])
  field!: "incomeTaxMonthly" | "eobiEmployeeContribution" | "eobiEmployerContribution" | "socialSecurityEmployerContribution";

  @IsNumber({ maxDecimalPlaces: 2 })
  value!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class ResolvePayrollExceptionDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note!: string;
}

export class DetectPayrollRetroDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("all", { each: true })
  employeeIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  lookbackMonths?: number;
}

export class IncludePayrollRetroDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID("all", { each: true })
  retroResultIds?: string[];
}
