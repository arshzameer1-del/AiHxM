import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class CalibrateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  calibrationRating!: number;

  @IsOptional()
  @IsString()
  calibrationComment?: string;
}
