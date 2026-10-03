import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { CourseView, CreateCourseRequest } from "@aihxm/shared-types";

const LEARNING_MODULE_KEY = "learning" as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
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
 * The company's own learning catalog — `course.view.all` is granted
 * broadly (hr_admin/line_manager/employee_self_service, same
 * "non-sensitive, company-wide" posture as `holiday.view.all`), so unlike
 * `CourseEnrollmentsService` there's no self/team/all view-scope split
 * here: anyone with a session who holds the module can see every active
 * course. `course.manage.all` (hr_admin only) gates writes.
 */
@Injectable()
export class CoursesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async create(claims: RequestClaims, input: CreateCourseRequest): Promise<CourseView> {
    await this.requireLearningModule(claims);
    if (!(await this.rbac.can(claims, "course.manage.all"))) {
      throw new ForbiddenException("Not permitted to manage the learning catalog");
    }
    if (!claims.company_id) throw new ForbiddenException();

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO courses (company_id, title, description, category, duration_minutes, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [claims.company_id, input.title, input.description ?? null, input.category, input.durationMinutes, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "course.create",
        target: result.rows[0].id,
        metadata: { title: input.title, category: input.category },
      });
      return rowToCourse(result.rows[0]);
    });
  }

  async setActive(claims: RequestClaims, id: string, isActive: boolean): Promise<CourseView> {
    await this.requireLearningModule(claims);
    if (!(await this.rbac.can(claims, "course.manage.all"))) {
      throw new ForbiddenException("Not permitted to manage the learning catalog");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE courses SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, isActive]
      );
      if (result.rowCount === 0) throw new NotFoundException("Course not found");
      await this.audit.record(client, claims, {
        companyId: result.rows[0].company_id,
        action: "course.set_active",
        target: id,
        metadata: { isActive },
      });
      return rowToCourse(result.rows[0]);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<CourseView> {
    await this.requireLearningModule(claims);
    if (!(await this.rbac.can(claims, "course.view.all"))) {
      throw new ForbiddenException("Not permitted to view the learning catalog");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(`SELECT * FROM courses WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundException("Course not found");
      return rowToCourse(result.rows[0]);
    });
  }

  /**
   * `includeInactive` is manage.all-only (an HR Admin managing the
   * catalog needs to see deactivated courses to reactivate them); every
   * other caller always gets the active-only list, same as
   * `UpcomingHolidaysCard`'s own "show what's currently relevant, not the
   * whole archive" posture.
   */
  async list(claims: RequestClaims, includeInactive = false): Promise<CourseView[]> {
    await this.requireLearningModule(claims);
    if (!(await this.rbac.can(claims, "course.view.all"))) {
      throw new ForbiddenException("Not permitted to view the learning catalog");
    }
    const canManage = includeInactive && (await this.rbac.can(claims, "course.manage.all"));
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM courses WHERE company_id = $1 ${canManage ? "" : "AND is_active = true"} ORDER BY title ASC`,
        [claims.company_id]
      );
      return result.rows.map(rowToCourse);
    });
  }

  private async requireLearningModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEARNING_MODULE_KEY))) {
      throw new NotFoundException();
    }
  }
}
