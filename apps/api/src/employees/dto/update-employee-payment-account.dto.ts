import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import type { EmployeePaymentMethod } from "@aihxm/shared-types";

const PAYMENT_METHODS: EmployeePaymentMethod[] = ["bank_transfer", "cash", "cheque"];

export class UpdateEmployeePaymentAccountDto {
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: EmployeePaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  accountTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(34)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  branchCode?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  priority?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  splitPercent?: number;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  bankKey?: string;

  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  bankCountry?: string;
}
