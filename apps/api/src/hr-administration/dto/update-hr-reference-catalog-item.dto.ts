import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateHrReferenceCatalogItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
