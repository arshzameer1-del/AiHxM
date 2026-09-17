import { IsNumber, IsOptional, Min } from "class-validator";

/** One bracket in a `SetTaxSlabsDto.slabs` array — see
 * EmployeeGroupConditionDto for the precedent of a shared nested-array
 * item DTO in this codebase. */
export class TaxSlabDto {
  @IsNumber()
  @Min(0)
  minAnnualIncome!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAnnualIncome?: number | null;

  @IsNumber()
  @Min(0)
  baseTax!: number;

  @IsNumber()
  @Min(0)
  ratePercent!: number;
}
