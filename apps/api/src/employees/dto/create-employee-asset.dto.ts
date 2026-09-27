import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CreateEmployeeAssetDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @MaxLength(120)
  assetType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  assetTag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsDateString()
  assignedDate?: string;
}
