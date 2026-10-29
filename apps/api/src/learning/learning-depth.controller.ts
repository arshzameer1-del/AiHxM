import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CourseExamsService } from "./course-exams.service";
import { LearningPathsService } from "./learning-paths.service";

class PathDto {
  @IsString() @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsUUID(undefined, { each: true }) courseIds!: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class AssignPathDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) employeeIds!: string[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate?: string | null;
}
class QuestionDto {
  @IsString() @MaxLength(1000) prompt!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(6) @IsString({ each: true }) options!: string[];
  @IsInt() @Min(0) @Max(5) correctIndex!: number;
}
class ExamDto {
  @IsString() @MaxLength(160) title!: string;
  @IsInt() @Min(1) @Max(100) passMarkPct!: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) maxAttempts?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions!: QuestionDto[];
}
class AnswersDto {
  @IsArray() @ArrayMaxSize(50) answers!: Array<number | null>;
}

/** Learning paths, course exams and certificates. Permissions are decided in the services. */
@Controller()
@UseGuards(SessionGuard)
export class LearningDepthController {
  constructor(
    private readonly paths: LearningPathsService,
    private readonly exams: CourseExamsService
  ) {}

  @Get("learning-paths/mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.paths.mine(claims);
  }

  @Get("learning-paths")
  list(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.paths.list(claims, includeInactive === "true");
  }

  @Post("learning-paths")
  create(@CurrentClaims() claims: RequestClaims, @Body() dto: PathDto) {
    return this.paths.create(claims, dto);
  }

  @Get("learning-paths/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.paths.get(claims, id);
  }

  @Put("learning-paths/:id")
  update(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: PathDto) {
    return this.paths.update(claims, id, dto);
  }

  @Post("learning-paths/:id/assign")
  @HttpCode(200)
  assign(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: AssignPathDto) {
    return this.paths.assign(claims, id, dto);
  }

  @Get("learning-paths/:id/progress")
  progress(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.paths.progress(claims, id);
  }

  @Get("courses/:id/exam")
  getExam(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.exams.getForCourse(claims, id).then((e) => e ?? { exam: null });
  }

  @Put("courses/:id/exam")
  saveExam(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: ExamDto) {
    return this.exams.save(claims, id, dto);
  }

  @Delete("courses/:id/exam")
  @HttpCode(204)
  removeExam(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.exams.remove(claims, id);
  }

  @Get("course-enrollments/:id/exam")
  takeExam(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.exams.forTaker(claims, id);
  }

  @Post("course-enrollments/:id/exam")
  @HttpCode(200)
  submitExam(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: AnswersDto) {
    return this.exams.submit(claims, id, dto.answers);
  }

  @Post("course-enrollments/:id/exam/reset")
  @HttpCode(200)
  resetExam(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.exams.resetAttempts(claims, id);
  }

  @Get("course-enrollments/:id/certificate")
  certificate(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.exams.certificate(claims, id);
  }
}
