import { IsBoolean, IsOptional, IsString, MinLength } from "class-validator";

export class CreateCompensationComponentDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;
}
