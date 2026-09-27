import { IsOptional, IsString, MaxLength } from "class-validator";

export class CreateHrReferenceCatalogItemDto {
  @IsString()
  @MaxLength(100)
  catalogType!: string;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsString()
  @MaxLength(255)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
