import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from "class-validator";

export class UpdateCompensationComponentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
