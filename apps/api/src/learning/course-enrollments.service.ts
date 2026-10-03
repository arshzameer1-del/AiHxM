import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CourseEnrollmentView, CourseView, EnrollInCourseRequest } from "@aihxm/shared-types";

const LEARNING_MODULE_KEY = "learning" as const;

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  manager_id: string | null;
  manager_user_account_id: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCourse(row: any): CourseView {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    description: row.description,
    category: row.category,
    durationMinutes: row.duration_minutes,
    isActive: row.is_active,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Maps a raw `course_enrollments` row (joined with its `courses` row,
 * aliased `course_*`) into the richer view type. `status` here is the
 * DERIVED value (0116_learning_and_development.sql's own header comment
 * on why "overdue" is never stored): a row whose raw status isn't
 * `completed` and whose `due_date` has passed reports as `overdue`
 * regardless of what's actually in the `status` column, same spirit as
 * `WorkScheduleResolutionService`'s attendance-status derivation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEnrollment(row: any, employeeUserAccountId: string | null): CourseEnrollmentView {
  const dueDate = row.due_date ? toIsoDate(row.due_date) : null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const status = row.status !== "completed" && dueDate !== null && dueDate < todayIso ? "overdue" : row.status;

  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    courseId: row.course_id,
    course: rowToCourse({
      id: row.course_id,
      company_id: row.company_id,
      title: row.course_title,
      description: row.course_description,
      category: row.course_category,
      duration_minutes: row.course_duration_minutes,
      is_active: row.course_is_active,
      created_at: row.course_created_at,
      updated_at: row.course_updated_at,
    }),
    status,
    progressPercent: row.progress_percent,
    dueDate,
    isOnBehalf:
      employeeUserAccountId !== null &&
      row.assigned_by_user_account_id !== null &&
      row.assigned_by_user_account_id !== employeeUserAccountId,
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const ENROLLMENT_SELECT = `
  SELECT ce.*,
         c.title AS course_title, c.description AS course_description, c.category AS course_category,
         c.duration_minutes AS course_duration_minutes, c.is_active AS course_is_active,
         c.created_at AS course_created_at, c.updated_at AS course_updated_at,
         e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
  FROM course_enrollments ce
  JOIN courses c ON c.id = ce.course_id
  JOIN employees e ON e.id = ce.employee_id
  LEFT JOIN employees mgr ON mgr.id = e.manager_id
`;

/**
 * Learning & Development's lifecycle object — Part 2 category 7. Unlike
 * Leave/Expense Management, this is deliberately NOT routed through
 * WorkflowService: the spec for this category describes no approval step
 * ("Completion updates learning records through the learning service"),
 * so enrolling and updating progress are just ordinary writes, gated by
 * ownership (self) or `course_enrollment.manage.all` (HR On-Behalf), the
 * same ownerId-check shape every self-service action in this codebase
 * uses — see LeaveRequestsService.submit()'s identical pattern.
 */
@Injectable()
export class CourseEnrollmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async enroll(claims: RequestClaims, input: EnrollInCourseRequest): Promise<CourseEnrollmentView> {
    await this.requireLearningModule(claims);

    const employee = await this.db.withClaims(claims, async (client) => this.loadEmployee(client, input.employeeId));
    if (!employee) throw new NotFoundException("Employee not found");

    const isOnBehalf = employee.user_account_id !== claims.sub;
    const [canSelf, canManageAll] = await Promise.all([
      !isOnBehalf
        ? this.rbac.can(claims, "course_enrollment.manage.self", { ownerId: employee.user_account_id ?? undefined })
        : Promise.resolve(false),
      this.rbac.can(claims, "course_enrollment.manage.all"),
    ]);
    if (!canSelf && !canManageAll) {
      throw new ForbiddenException("Not permitted to enroll this employee in a course");
    }

    return this.db.withClaims(claims, async (client) => {
      const course = await client.query(`SELECT id, company_id, is_active FROM courses WHERE id = $1`, [input.courseId]);
      if (course.rowCount === 0) throw new NotFoundException("Course not found");
      if (!course.rows[0].is_active) {
        throw new BadRequestException("This course is no longer active");
      }

      const existing = await client.query(
        `SELECT id FROM course_enrollments WHERE employee_id = $1 AND course_id = $2`,
        [input.employeeId, input.courseId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException("This employee is already enrolled in this course");
      }

      const insertResult = await client.query(
        `INSERT INTO course_enrollments (company_id, employee_id, course_id, due_date, assigned_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [employee.company_id, input.employeeId, input.courseId, input.dueDate ?? null, isOnBehalf ? claims.sub : null]
      );
      const id = insertResult.rows[0].id;

      await this.audit.record(client, claims, {
        companyId: employee.company_id,
        action: "course_enrollment.enroll",
        target: id,
        metadata: { courseId: input.courseId, isOnBehalf },
      });

      const row = await client.query(`${ENROLLMENT_SELECT} WHERE ce.id = $1`, [id]);
      return rowToEnrollment(row.rows[0], employee.user_account_id);
    });
  }

  /**
   * Self-only — same `manage.self` ownership gate as `enroll()`. Moves
   * the raw status forward: 0 -> 100 progress sets `started_at` the
   * first time progress leaves 0, and reaching 100 marks `completed`
   * (with `completed_at`) regardless of what the raw status was before —
   * there's no separate "mark complete" action, reaching 100% IS
   * completion.
   */
  async updateProgress(claims: RequestClaims, id: string, progressPercent: number): Promise<CourseEnrollmentView> {
    await this.requireLearningModule(claims);

    const { row, employee } = await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`${ENROLLMENT_SELECT} WHERE ce.id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Enrollment not found");
      const r = result.rows[0];
      const emp = await this.loadEmployee(client, r.employee_id);
      return { row: r, employee: emp };
    });
    if (!employee) throw new NotFoundException("Employee not found");

    if (!(await this.rbac.can(claims, "course_enrollment.manage.self", { ownerId: employee.user_account_id ?? undefined }))) {
      throw new ForbiddenException("Not permitted to update this enrollment's progress");
    }
    if (row.status === "completed") {
      throw new BadRequestException("This course is already completed");
    }

    return this.db.withClaims(claims, async (client) => {
      const newStatus = progressPercent >= 100 ? "completed" : progressPercent > 0 ? "in_progress" : row.status;
      const updateResult = await client.query(
        `UPDATE course_enrollments
         SET progress_percent = $2::int,
             status = $3,
             started_at = COALESCE(started_at, CASE WHEN $2::int > 0 THEN now() ELSE NULL END),
             completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
             updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [id, progressPercent, newStatus]
      );

      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: "course_enrollment.update_progress",
        target: id,
        metadata: { progressPercent, newStatus },
      });

      const refreshed = await client.query(`${ENROLLMENT_SELECT} WHERE ce.id = $1`, [updateResult.rows[0].id]);
      return rowToEnrollment(refreshed.rows[0], employee.user_account_id);
    });
  }

  async cancel(claims: RequestClaims, id: string): Promise<void> {
    await this.requireLearningModule(claims);
    // manage.all-only — same posture as LeaveRequestsService.cancel()/
    // ExpenseClaimsService.cancel(): a self-unenroll path is a reasonable
    // future addition, not built here since it isn't asked for yet.
    if (!(await this.rbac.can(claims, "course_enrollment.manage.all"))) {
      throw new ForbiddenException("Not permitted to cancel course enrollments");
    }
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query(`DELETE FROM course_enrollments WHERE id = $1 RETURNING id`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Enrollment not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "course_enrollment.cancel",
        target: id,
      });
    });
  }

  async getEnrollment(claims: RequestClaims, id: string): Promise<CourseEnrollmentView> {
    await this.requireLearningModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`${ENROLLMENT_SELECT} WHERE ce.id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Enrollment not found");
      const row = result.rows[0];
      const visible = await this.isVisible(claims, row.employee_user_account_id, row.manager_user_account_id);
      if (!visible) throw new NotFoundException("Enrollment not found");
      return rowToEnrollment(row, row.employee_user_account_id);
    });
  }

  async listEnrollments(claims: RequestClaims, filter?: { employeeId?: string }): Promise<CourseEnrollmentView[]> {
    await this.requireLearningModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const scope = await this.rbac.resolveViewScope(claims, "course_enrollment.view");
      const result = await client.query(
        `${ENROLLMENT_SELECT} WHERE ($1::uuid IS NULL OR ce.employee_id = $1) ORDER BY ce.created_at DESC`,
        [filter?.employeeId ?? null]
      );
      return result.rows
        .filter(
          (row) =>
            scope.hasAll ||
            (scope.hasSelf && row.employee_user_account_id === claims.sub) ||
            (scope.hasTeam && row.manager_user_account_id === claims.sub)
        )
        .map((row) => rowToEnrollment(row, row.employee_user_account_id));
    });
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async requireLearningModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEARNING_MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async isVisible(claims: RequestClaims, ownerId: string | null, teamOwnerId: string | null): Promise<boolean> {
    const scope = await this.rbac.resolveViewScope(claims, "course_enrollment.view");
    return (
      scope.hasAll ||
      (scope.hasSelf && Boolean(ownerId) && ownerId === claims.sub) ||
      (scope.hasTeam && Boolean(teamOwnerId) && teamOwnerId === claims.sub)
    );
  }

  private async loadEmployee(
    client: PoolClient,
    employeeId: string
  ): Promise<(EmployeeRow & { manager_user_account_id: string | null }) | null> {
    const result = await client.query(
      `SELECT e.*, mgr.user_account_id AS manager_user_account_id
       FROM employees e
       LEFT JOIN employees mgr ON mgr.id = e.manager_id
       WHERE e.id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0];
  }
}
