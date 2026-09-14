import { IsInt, IsString, Max, Min, MinLength } from "class-validator";

export class SubmitManagerAssessmentDto {
  @IsString()
  @MinLength(1)
  managerAssessment!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  managerRating!: number;
}
