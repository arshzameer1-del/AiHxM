import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class PublishConfigurationVersionDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
