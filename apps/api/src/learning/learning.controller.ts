import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CoursesService } from "./courses.service";
import { CourseEnrollmentsService } from "./course-enrollments.service";
import { CreateCourseDto } from "./dto/create-course.dto";
import { EnrollInCourseDto } from "./dto/enroll-in-course.dto";
import { UpdateCourseEnrollmentProgressDto } from "./dto/update-progress.dto";

/**
 * Any real session can call these (SessionGuard) — CoursesService's/
 * CourseEnrollmentsService's own entitlement + permission checks decide
 * who succeeds, same split every module since Phase 4 has used.
 */
@Controller()
@UseGuards(SessionGuard)
export class LearningController {
  constructor(
    private readonly courses: CoursesService,
    private readonly enrollments: CourseEnrollmentsService
  ) {}

  @Post("courses")
  createCourse(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateCourseDto) {
    return this.courses.create(claims, dto);
  }

  @Get("courses")
  listCourses(@CurrentClaims() claims: RequestClaims, @Query("includeInactive") includeInactive?: string) {
    return this.courses.list(claims, includeInactive === "true");
  }

  @Get("courses/:id")
  getCourse(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.courses.get(claims, id);
  }

  @Patch("courses/:id/active")
  setCourseActive(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: { isActive: boolean }) {
    return this.courses.setActive(claims, id, dto.isActive);
  }

  @Post("course-enrollments")
  enroll(@CurrentClaims() claims: RequestClaims, @Body() dto: EnrollInCourseDto) {
    return this.enrollments.enroll(claims, dto);
  }

  @Get("course-enrollments")
  listEnrollments(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.enrollments.listEnrollments(claims, { employeeId });
  }

  @Get("course-enrollments/:id")
  getEnrollment(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.enrollments.getEnrollment(claims, id);
  }

  @Patch("course-enrollments/:id/progress")
  updateProgress(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Body() dto: UpdateCourseEnrollmentProgressDto
  ) {
    return this.enrollments.updateProgress(claims, id, dto.progressPercent);
  }

  @Post("course-enrollments/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.enrollments.cancel(claims, id);
  }
}
