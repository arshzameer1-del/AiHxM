import { ArrayMinSize, IsArray, IsIn } from "class-validator";
import type { DisbursementFieldKey } from "@aihxm/shared-types";

// Kept in sync with PayrollService's own DISBURSEMENT_FIELD_KEYS constant —
// the service re-validates this list too (the real guard, same "DTO at the
// HTTP boundary, service at the call boundary" doubling every other Payroll
// DTO in this directory already does), so this is a fast, friendly 400 for
// the common typo case, not the only check.
const DISBURSEMENT_FIELD_KEYS: DisbursementFieldKey[] = [
  "employeeNumber",
  "employeeName",
  "cnic",
  "paymentMethod",
  "bankName",
  "accountTitle",
  "accountNumber",
  "iban",
  "branchCode",
  "bankAccountNumber",
  "netPay",
];

export class UpdatePayrollDisbursementSettingsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(DISBURSEMENT_FIELD_KEYS, { each: true })
  columns!: DisbursementFieldKey[];
}
