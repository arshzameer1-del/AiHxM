import { IsIn, IsInt, IsOptional, IsPositive, IsString, MinLength } from "class-validator";
import type { CourseCategory } from "@aihxm/shared-types";

const COURSE_CATEGORIES: CourseCategory[] = ["compliance", "technical", "soft_skills", "leadership", "other"];

export class CreateCourseDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn(COURSE_CATEGORIES)
  category!: CourseCategory;

  @IsInt()
  @IsPositive()
  durationMinutes!: number;
}
