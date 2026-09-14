import { IsString, MinLength } from "class-validator";

export class SubmitSelfAssessmentDto {
  @IsString()
  @MinLength(1)
  selfAssessment!: string;
}
