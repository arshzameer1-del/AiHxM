import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateEmployeeContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  value?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
