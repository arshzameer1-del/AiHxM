import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";

export class CreateLeavePolicyDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  annualLeaveDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  casualLeaveDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sickLeaveDays?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
