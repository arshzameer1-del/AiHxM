import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AssignLearningPathRequest, AssignLearningPathResult, LearningPathProgressRow, LearningPathView, MyLearningPathView, UpsertLearningPathRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const day = (v: unknown): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10)) : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Learning paths: an ordered set of courses assigned to people together. Assigning a path enrols the person in every course of it that
 * they are not already taking, so progress is still the ordinary course progress and nothing is tracked twice. Path progress is
 * worked out from the enrolments, never stored.
 */
@Injectable()
export class LearningPathsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, includeInactive = false): Promise<LearningPathView[]> {
    await this.requireModule(claims);
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT id FROM learning_paths WHERE ($1 OR is_active) ORDER BY title", [includeInactive]);
      const out: LearningPathView[] = [];
      for (const row of r.rows) out.push(await this.view(client, row.id));
      return out;
    });
  }

  async get(claims: RequestClaims, id: string): Promise<LearningPathView> {
    await this.requireModule(claims);
    await this.requireView(claims);
    return this.db.withClaims(claims, (client) => this.view(client, id));
  }

  async create(claims: RequestClaims, input: UpsertLearningPathRequest): Promise<LearningPathView> {
    await this.requireModule(claims);
    await this.requireManage(claims);
    const f = this.check(input);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      await this.assertTitleFree(client, f.title, null);
      await this.assertCourses(client, f.courseIds);
      const r = await client.query("INSERT INTO learning_paths (company_id, title, description, is_active, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [companyId, f.title, f.description, input.isActive ?? true, claims.sub]);
      await this.setCourses(client, companyId, r.rows[0].id, f.courseIds);
      await this.audit.record(client, claims, { companyId, action: "learning_path.create", target: r.rows[0].id, metadata: { title: f.title, courses: f.courseIds.length } });
      return this.view(client, r.rows[0].id);
    });
  }

  async update(claims: RequestClaims, id: string, input: UpsertLearningPathRequest): Promise<LearningPathView> {
    await this.requireModule(claims);
    await this.requireManage(claims);
    const f = this.check(input);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const cur = await client.query("SELECT id FROM learning_paths WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rowCount) throw new NotFoundException("Learning path not found");
      await this.assertTitleFree(client, f.title, id);
      await this.assertCourses(client, f.courseIds);
      await client.query("UPDATE learning_paths SET title=$2, description=$3, is_active=COALESCE($4, is_active), updated_at=now() WHERE id=$1", [id, f.title, f.description, input.isActive ?? null]);
      await this.setCourses(client, companyId, id, f.courseIds);
      await this.audit.record(client, claims, { companyId, action: "learning_path.update", target: id });
      return this.view(client, id);
    });
  }

  /** Enrols each person in the path's courses. People already on the path are skipped; courses they already take keep their progress. */
  async assign(claims: RequestClaims, id: string, input: AssignLearningPathRequest): Promise<AssignLearningPathResult> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "course_enrollment.manage.all"))) throw new ForbiddenException("Not permitted to assign learning paths");
    const ids = Array.from(new Set(input.employeeIds ?? []));
    if (ids.length === 0 || ids.length > 500) throw new BadRequestException("Choose between 1 and 500 employees");
    if (input.dueDate && !DATE_RE.test(input.dueDate)) throw new BadRequestException("Enter a valid due date");
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const p = await client.query("SELECT id, is_active FROM learning_paths WHERE id = $1", [id]);
      if (!p.rowCount) throw new NotFoundException("Learning path not found");
      if (!p.rows[0].is_active) throw new ConflictException("This learning path is switched off");
      const courses = await client.query("SELECT pc.course_id FROM learning_path_courses pc JOIN courses c ON c.id = pc.course_id WHERE pc.path_id = $1 AND c.is_active ORDER BY pc.position", [id]);
      if (!courses.rowCount) throw new ConflictException("This path has no active courses");
      const emps = await client.query("SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND employment_status = 'active'", [ids]);
      if (emps.rowCount !== ids.length) throw new BadRequestException("Some of the chosen people were not found or are not active");
      let assigned = 0;
      let already = 0;
      let enrolled = 0;
      for (const e of ids) {
        const a = await client.query("INSERT INTO learning_path_assignments (company_id, path_id, employee_id, due_date, assigned_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (path_id, employee_id) DO NOTHING RETURNING id", [companyId, id, e, input.dueDate ?? null, claims.sub]);
        if (!a.rowCount) { already++; continue; }
        assigned++;
        for (const c of courses.rows) {
          const r = await client.query(
            "INSERT INTO course_enrollments (company_id, employee_id, course_id, due_date, assigned_by_user_account_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (employee_id, course_id) DO NOTHING",
            [companyId, e, c.course_id, input.dueDate ?? null, claims.sub]
          );
          enrolled += r.rowCount ?? 0;
        }
      }
      await this.audit.record(client, claims, { companyId, action: "learning_path.assign", target: id, metadata: { assigned, already, enrolled } });
      return { assigned, alreadyAssigned: already, enrollmentsCreated: enrolled };
    });
  }

  /** HR: how everyone assigned to a path is getting on. */
  async progress(claims: RequestClaims, id: string): Promise<LearningPathProgressRow[]> {
    await this.requireModule(claims);
    // everyone may browse the catalogue (course.view.all), but how other people are getting on is for HR
    if (!(await this.rbac.can(claims, "course_enrollment.manage.all"))) throw new ForbiddenException("Not permitted to see how people are progressing");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT a.employee_id, e.employee_number, trim(concat_ws(' ', e.first_name, e.last_name)) AS name, a.due_date,
                count(pc.course_id)::int AS total, count(ce.id) FILTER (WHERE ce.status = 'completed')::int AS done
           FROM learning_path_assignments a
           JOIN employees e ON e.id = a.employee_id
           JOIN learning_path_courses pc ON pc.path_id = a.path_id
           LEFT JOIN course_enrollments ce ON ce.employee_id = a.employee_id AND ce.course_id = pc.course_id
          WHERE a.path_id = $1 GROUP BY a.employee_id, e.employee_number, e.first_name, e.last_name, a.due_date ORDER BY e.employee_number`,
        [id]
      );
      return r.rows.map((x) => ({ employeeId: x.employee_id, employeeName: x.name, employeeNumber: x.employee_number, dueDate: day(x.due_date), completedCourses: x.done, totalCourses: x.total }));
    });
  }

  /** The paths assigned to the caller, with where they are in each. */
  async mine(claims: RequestClaims): Promise<MyLearningPathView[]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "course_enrollment.manage.self", { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted to see learning paths");
    return this.db.withClaims(claims, async (client) => {
      const paths = await client.query(
        `SELECT p.id, p.title, p.description, a.due_date, a.employee_id FROM learning_path_assignments a
           JOIN learning_paths p ON p.id = a.path_id JOIN employees e ON e.id = a.employee_id
          WHERE e.user_account_id = $1 ORDER BY a.assigned_at DESC`,
        [claims.sub]
      );
      const out: MyLearningPathView[] = [];
      for (const p of paths.rows) {
        const cs = await client.query(
          `SELECT pc.course_id, pc.position, c.title, ce.id AS enrollment_id, ce.status, ce.progress_percent,
                  EXISTS (SELECT 1 FROM course_exams x WHERE x.course_id = c.id AND x.is_active) AS has_exam
             FROM learning_path_courses pc JOIN courses c ON c.id = pc.course_id
             LEFT JOIN course_enrollments ce ON ce.course_id = pc.course_id AND ce.employee_id = $2
            WHERE pc.path_id = $1 ORDER BY pc.position`,
          [p.id, p.employee_id]
        );
        const courses = cs.rows.map((c) => ({ courseId: c.course_id, title: c.title, position: c.position, enrollmentId: c.enrollment_id ?? null, status: (c.status ?? "not_enrolled") as MyLearningPathView["courses"][number]["status"], progressPercent: c.progress_percent ?? 0, hasExam: c.has_exam }));
        out.push({ pathId: p.id, title: p.title, description: p.description ?? null, dueDate: day(p.due_date), completedCourses: courses.filter((c) => c.status === "completed").length, totalCourses: courses.length, courses });
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ internals

  private check(i: UpsertLearningPathRequest) {
    const title = (i.title ?? "").trim();
    if (!title || title.length > 160) throw new BadRequestException("Enter a title of up to 160 characters");
    const courseIds = Array.isArray(i.courseIds) ? i.courseIds : [];
    if (courseIds.length === 0 || courseIds.length > 30) throw new BadRequestException("A learning path needs between 1 and 30 courses");
    if (new Set(courseIds).size !== courseIds.length) throw new BadRequestException("A course can appear only once in a path");
    return { title, description: i.description?.trim().slice(0, 2000) || null, courseIds };
  }

  private async assertTitleFree(client: PoolClient, title: string, exceptId: string | null): Promise<void> {
    const r = await client.query("SELECT 1 FROM learning_paths WHERE lower(title) = lower($1) AND ($2::uuid IS NULL OR id <> $2)", [title, exceptId]);
    if (r.rowCount) throw new ConflictException("A learning path with that title already exists");
  }

  private async assertCourses(client: PoolClient, ids: string[]): Promise<void> {
    const r = await client.query("SELECT id FROM courses WHERE id = ANY($1::uuid[]) AND is_active", [ids]);
    if (r.rowCount !== ids.length) throw new BadRequestException("Some of the chosen courses were not found or are switched off");
  }

  private async setCourses(client: PoolClient, companyId: string, pathId: string, courseIds: string[]): Promise<void> {
    await client.query("DELETE FROM learning_path_courses WHERE path_id = $1", [pathId]);
    for (let i = 0; i < courseIds.length; i++) {
      await client.query("INSERT INTO learning_path_courses (company_id, path_id, course_id, position) VALUES ($1,$2,$3,$4)", [companyId, pathId, courseIds[i], i + 1]);
    }
  }

  private async view(client: PoolClient, id: string): Promise<LearningPathView> {
    const p = await client.query("SELECT * FROM learning_paths WHERE id = $1", [id]);
    if (!p.rowCount) throw new NotFoundException("Learning path not found");
    const c = await client.query(
      `SELECT pc.course_id, pc.position, c.title, c.duration_minutes, EXISTS (SELECT 1 FROM course_exams x WHERE x.course_id = c.id AND x.is_active) AS has_exam
         FROM learning_path_courses pc JOIN courses c ON c.id = pc.course_id WHERE pc.path_id = $1 ORDER BY pc.position`,
      [id]
    );
    const n = await client.query("SELECT count(*)::int AS n FROM learning_path_assignments WHERE path_id = $1", [id]);
    const courses = c.rows.map((x) => ({ courseId: x.course_id, title: x.title, durationMinutes: x.duration_minutes, position: x.position, hasExam: x.has_exam }));
    return { id, title: p.rows[0].title, description: p.rows[0].description ?? null, isActive: p.rows[0].is_active, courses, assignedCount: n.rows[0].n, totalMinutes: courses.reduce((a, x) => a + x.durationMinutes, 0) };
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "learning"))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.rbac.can(claims, "course.manage.all"))) throw new ForbiddenException("Not permitted to manage learning paths");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.rbac.can(claims, "course.view.all"))) throw new ForbiddenException("Not permitted to see learning paths");
  }
}
