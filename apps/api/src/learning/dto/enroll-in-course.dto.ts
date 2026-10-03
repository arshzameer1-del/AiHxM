import { IsDateString, IsOptional, IsUUID } from "class-validator";

export class EnrollInCourseDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  courseId!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
