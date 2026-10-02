import { IsString, MinLength } from "class-validator";

/** Same "mandatory reason, re-checked by the service regardless of what
 * class-validator alone would let through" discipline as `ReversePayrollRunDto`
 * — see `PayrollService.voidPaymentBatch()`'s own doc comment. */
export class VoidPaymentBatchDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
