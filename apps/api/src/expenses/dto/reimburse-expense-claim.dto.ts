import { IsDateString, IsOptional } from "class-validator";

export class ReimburseExpenseClaimDto {
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
