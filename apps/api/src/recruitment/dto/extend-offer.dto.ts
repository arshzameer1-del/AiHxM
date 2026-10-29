import { Type } from "class-transformer";
import { ArrayMaxSize, Max, IsArray, IsDateString, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested } from "class-validator";

export class OfferComponentInputDto {
  @IsUUID()
  componentId!: string;

  @IsNumber()
  @Min(0)
  @Max(100_000_000)
  amount!: number;
}

export class ExtendOfferDto {
  @IsUUID()
  applicationId!: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100_000_000, { message: "salary cannot exceed 100,000,000 a month; check for an extra digit" })
  salary?: number;

  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => OfferComponentInputDto)
  components?: OfferComponentInputDto[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class RescindOfferDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class GenerateOfferLetterDto {
  @IsOptional()
  @IsString()
  templateKey?: string;
}
