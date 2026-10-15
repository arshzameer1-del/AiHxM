import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateConfigurationVersionDto {
  @IsString()
  @MaxLength(100)
  domain!: string;

  @IsOptional()
  @IsObject()
  snapshot?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changeReason?: string;
}
