import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { EmployeePaymentMethod } from "@aihxm/shared-types";

const PAYMENT_METHODS: EmployeePaymentMethod[] = ["bank_transfer", "cash", "cheque"];

export class CreateEmployeePaymentAccountDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: EmployeePaymentMethod;

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
}

export { PAYMENT_METHODS };
