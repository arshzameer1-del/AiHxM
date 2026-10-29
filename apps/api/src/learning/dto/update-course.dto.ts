import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min, MinLength } from "class-validator";
import type { CourseCategory } from "@aihxm/shared-types";

const COURSE_CATEGORIES: CourseCategory[] = ["compliance", "technical", "soft_skills", "leadership", "other"];

/** Every field is optional: only what is sent is changed. */
export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsIn(COURSE_CATEGORIES)
  category?: CourseCategory;

  @IsOptional()
  @IsInt()
  @IsPositive()
  durationMinutes?: number;

  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999)
  costAmount?: number | null;
}
