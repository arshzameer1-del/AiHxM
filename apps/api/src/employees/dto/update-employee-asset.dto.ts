import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateEmployeeAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assetTag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
