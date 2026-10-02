import { IsString, MinLength } from "class-validator";

/** Section 36's own "capture reason" requirement — unlike an approval
 * decision's optional `comment`, this is mandatory: `PayrollService.reverseRun()`
 * rejects an empty/whitespace-only reason with a 400 regardless of what
 * class-validator alone would let through. */
export class ReversePayrollRunDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
