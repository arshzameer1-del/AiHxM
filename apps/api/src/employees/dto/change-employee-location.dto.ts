import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class ChangeEmployeeLocationDto {
  @IsUUID()
  locationId!: string;

  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
