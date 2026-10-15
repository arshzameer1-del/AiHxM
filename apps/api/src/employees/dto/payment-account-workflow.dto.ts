import { IsIn, IsString, MaxLength, MinLength } from "class-validator";
import type { EmployeePaymentVerificationStatus } from "@aihxm/shared-types";

export class RejectEmployeePaymentAccountDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class VerifyEmployeePaymentAccountDto {
  @IsIn(["unverified", "verified", "failed"] satisfies EmployeePaymentVerificationStatus[])
  status!: EmployeePaymentVerificationStatus;
}
