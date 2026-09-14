import { IsDateString, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class CreateReviewCycleDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  @IsOptional()
  @IsUUID()
  participantGroupId?: string;
}
