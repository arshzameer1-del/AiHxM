import { IsInt, Max, Min } from "class-validator";

export class UpdateCourseEnrollmentProgressDto {
  @IsInt()
  @Min(0)
  @Max(100)
  progressPercent!: number;
}
