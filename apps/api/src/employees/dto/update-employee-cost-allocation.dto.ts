import { IsBoolean, IsNumber, IsOptional, Max, Min } from "class-validator";

export class UpdateEmployeeCostAllocationDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  allocationPercentage?: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
