import { Module } from "@nestjs/common";
import { LearningController } from "./learning.controller";
import { CoursesService } from "./courses.service";
import { CourseEnrollmentsService } from "./course-enrollments.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";

// No WorkflowModule import — Learning & Development deliberately doesn't
// route through the approval engine (course-enrollments.service.ts's own
// doc comment on why).
@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [LearningController],
  providers: [CoursesService, CourseEnrollmentsService],
  exports: [CoursesService, CourseEnrollmentsService],
})
export class LearningModule {}
