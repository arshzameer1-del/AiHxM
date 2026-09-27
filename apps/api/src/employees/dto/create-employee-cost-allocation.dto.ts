import { IsBoolean, IsNumber, IsOptional, IsUUID, Max, Min } from "class-validator";

export class CreateEmployeeCostAllocationDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  costCenterId!: string;

  @IsNumber()
  @Min(0.01)
  @Max(100)
  allocationPercentage!: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
