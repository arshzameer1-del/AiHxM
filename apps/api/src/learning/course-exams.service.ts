import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CertificateView, CourseExamAdminView, ExamForTakerView, ExamQuestionInput, ExamResultView, SaveCourseExamRequest } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const day = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10));

/** Marks answers against the answer key. Unanswered (null) counts as wrong. */
export function scoreExam(correct: number[], answers: Array<number | null>): { correctCount: number; scorePct: number } {
  const correctCount = correct.reduce((n, c, i) => n + (answers[i] === c ? 1 : 0), 0);
  return { correctCount, scorePct: correct.length === 0 ? 0 : Math.round((correctCount / correct.length) * 10000) / 100 };
}

/**
 * Course exams. A course with an active exam cannot be completed by moving a progress bar: the person passes the exam, and that
 * completes the course (see CourseEnrollmentsService.updateProgress). The answer key never leaves the server for a test-taker, and a
 * result says how many were right, not which.
 */
@Injectable()
export class CourseExamsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------------ HR: author

  async getForCourse(claims: RequestClaims, courseId: string): Promise<CourseExamAdminView | null> {
    await this.requireModule(claims);
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const e = await client.query("SELECT * FROM course_exams WHERE course_id = $1", [courseId]);
      if (!e.rowCount) return null;
      const q = await client.query("SELECT prompt, options, correct_index FROM exam_questions WHERE exam_id = $1 ORDER BY position", [e.rows[0].id]);
      const a = await client.query("SELECT count(*)::int AS n FROM exam_attempts WHERE exam_id = $1", [e.rows[0].id]);
      return { courseId, title: e.rows[0].title, passMarkPct: e.rows[0].pass_mark_pct, maxAttempts: e.rows[0].max_attempts ?? null, isActive: e.rows[0].is_active, attemptCount: a.rows[0].n, questions: q.rows.map((x) => ({ prompt: x.prompt, options: x.options, correctIndex: x.correct_index })) };
    });
  }

  async save(claims: RequestClaims, courseId: string, input: SaveCourseExamRequest): Promise<CourseExamAdminView> {
    await this.requireModule(claims);
    await this.requireManage(claims);
    const title = (input.title ?? "").trim();
    if (!title || title.length > 160) throw new BadRequestException("Enter an exam title of up to 160 characters");
    if (!Number.isInteger(input.passMarkPct) || input.passMarkPct < 1 || input.passMarkPct > 100) throw new BadRequestException("The pass mark must be between 1 and 100 percent");
    if (input.maxAttempts !== null && input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20)) throw new BadRequestException("Attempts must be between 1 and 20, or left empty for no limit");
    this.checkQuestions(input.questions);
    await this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const c = await client.query("SELECT 1 FROM courses WHERE id = $1", [courseId]);
      if (!c.rowCount) throw new NotFoundException("Course not found");
      const ex = await client.query(
        `INSERT INTO course_exams (company_id, course_id, title, pass_mark_pct, max_attempts, is_active) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (course_id) DO UPDATE SET title = EXCLUDED.title, pass_mark_pct = EXCLUDED.pass_mark_pct, max_attempts = EXCLUDED.max_attempts, is_active = EXCLUDED.is_active, updated_at = now()
         RETURNING id`,
        [companyId, courseId, title, input.passMarkPct, input.maxAttempts ?? null, input.isActive ?? true]
      );
      await client.query("DELETE FROM exam_questions WHERE exam_id = $1", [ex.rows[0].id]);
      for (let i = 0; i < input.questions.length; i++) {
        const q = input.questions[i];
        await client.query("INSERT INTO exam_questions (company_id, exam_id, position, prompt, options, correct_index) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [companyId, ex.rows[0].id, i + 1, q.prompt.trim(), JSON.stringify(q.options.map((o) => o.trim())), q.correctIndex]);
      }
      await this.audit.record(client, claims, { companyId, action: "course_exam.save", target: ex.rows[0].id, metadata: { courseId, questions: input.questions.length, passMarkPct: input.passMarkPct } });
    });
    return (await this.getForCourse(claims, courseId)) as CourseExamAdminView;
  }

  async remove(claims: RequestClaims, courseId: string): Promise<void> {
    await this.requireModule(claims);
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM course_exams WHERE course_id = $1 RETURNING id", [courseId]);
      if (!r.rowCount) throw new NotFoundException("This course has no exam");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "course_exam.remove", target: r.rows[0].id, metadata: { courseId } });
    });
  }

  // ------------------------------------------------------------------ the employee

  async forTaker(claims: RequestClaims, enrollmentId: string): Promise<ExamForTakerView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const enr = await this.ownEnrollment(client, claims, enrollmentId);
      const exam = await this.activeExam(client, enr.course_id);
      const q = await client.query("SELECT position, prompt, options FROM exam_questions WHERE exam_id = $1 ORDER BY position", [exam.id]);
      const stat = await this.attemptStats(client, exam.id, enrollmentId);
      return {
        examId: exam.id, enrollmentId, title: exam.title, courseTitle: enr.course_title, passMarkPct: exam.pass_mark_pct, attemptsUsed: stat.used,
        attemptsLeft: exam.max_attempts === null ? null : Math.max(0, exam.max_attempts - stat.used), passed: stat.passed, bestScorePct: stat.best,
        questions: q.rows.map((x) => ({ position: x.position, prompt: x.prompt, options: x.options })),
      };
    });
  }

  async submit(claims: RequestClaims, enrollmentId: string, answers: Array<number | null>): Promise<ExamResultView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const enr = await this.ownEnrollment(client, claims, enrollmentId, true);
      const exam = await this.activeExam(client, enr.course_id);
      const q = await client.query("SELECT correct_index, jsonb_array_length(options) AS n FROM exam_questions WHERE exam_id = $1 ORDER BY position", [exam.id]);
      if (!Array.isArray(answers) || answers.length !== q.rowCount) throw new BadRequestException("Answer every question");
      answers.forEach((a, i) => {
        if (a !== null && (!Number.isInteger(a) || a < 0 || a >= q.rows[i].n)) throw new BadRequestException("One of the answers is not a valid choice");
      });
      const stat = await this.attemptStats(client, exam.id, enrollmentId);
      if (stat.passed) throw new ConflictException("You have already passed this exam");
      if (exam.max_attempts !== null && stat.used >= exam.max_attempts) throw new ConflictException("You have used all your attempts. Ask HR for another chance");
      const { correctCount, scorePct } = scoreExam(q.rows.map((x) => x.correct_index), answers);
      const passed = scorePct >= exam.pass_mark_pct;
      await client.query(
        "INSERT INTO exam_attempts (company_id, exam_id, enrollment_id, employee_id, answers, correct_count, question_count, score_pct, passed) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
        [enr.company_id, exam.id, enrollmentId, enr.employee_id, JSON.stringify(answers), correctCount, q.rowCount, scorePct, passed]
      );
      if (passed) {
        await client.query(
          "UPDATE course_enrollments SET progress_percent = 100, status = 'completed', started_at = COALESCE(started_at, now()), completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1",
          [enrollmentId]
        );
      }
      await this.audit.record(client, claims, { companyId: enr.company_id, action: "course_exam.attempt", target: enrollmentId, metadata: { scorePct, passed } });
      return { scorePct, correctCount, questionCount: q.rowCount ?? 0, passed, passMarkPct: exam.pass_mark_pct, attemptsLeft: exam.max_attempts === null ? null : Math.max(0, exam.max_attempts - stat.used - 1), enrollmentCompleted: passed };
    });
  }

  /** HR gives someone more attempts by clearing their failed ones (a passed attempt is never cleared). */
  async resetAttempts(claims: RequestClaims, enrollmentId: string): Promise<{ cleared: number }> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "course_enrollment.manage.all"))) throw new ForbiddenException("Not permitted to reset exam attempts");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM exam_attempts WHERE enrollment_id = $1 AND NOT passed RETURNING id", [enrollmentId]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "course_exam.reset", target: enrollmentId, metadata: { cleared: r.rowCount } });
      return { cleared: r.rowCount ?? 0 };
    });
  }

  /** The certificate of a completed course: the person themselves or HR. */
  async certificate(claims: RequestClaims, enrollmentId: string): Promise<CertificateView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT ce.id, ce.status, ce.completed_at, ce.employee_id, c.title AS course_title, e.user_account_id, e.employee_number, trim(concat_ws(' ', e.first_name, e.last_name)) AS name, co.name AS company_name,
                (SELECT max(a.score_pct) FROM exam_attempts a WHERE a.enrollment_id = ce.id AND a.passed) AS score
           FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id JOIN employees e ON e.id = ce.employee_id JOIN companies co ON co.id = ce.company_id WHERE ce.id = $1`,
        [enrollmentId]
      );
      if (!r.rowCount) throw new NotFoundException("Enrollment not found");
      const x = r.rows[0];
      const own = x.user_account_id === claims.sub && (await this.rbac.can(claims, "course_enrollment.manage.self", { ownerId: x.user_account_id }));
      if (!own && !(await this.rbac.can(claims, "course_enrollment.manage.all"))) throw new ForbiddenException("Not permitted to see this certificate");
      if (x.status !== "completed" || !x.completed_at) throw new ConflictException("A certificate is issued once the course is completed");
      const completedOn = day(x.completed_at);
      return { certificateNo: `CERT-${completedOn.slice(0, 4)}-${String(x.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`, employeeName: x.name, employeeNumber: x.employee_number, courseTitle: x.course_title, companyName: x.company_name, completedOn, scorePct: x.score === null ? null : Number(x.score) };
    });
  }

  // ------------------------------------------------------------------ internals

  private checkQuestions(qs: ExamQuestionInput[]): void {
    if (!Array.isArray(qs) || qs.length === 0 || qs.length > 50) throw new BadRequestException("An exam needs between 1 and 50 questions");
    qs.forEach((q, i) => {
      const n = i + 1;
      if (!q.prompt?.trim() || q.prompt.length > 1000) throw new BadRequestException(`Question ${n} needs a question of up to 1000 characters`);
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw new BadRequestException(`Question ${n} needs between 2 and 6 choices`);
      if (q.options.some((o) => !o?.trim() || o.length > 300)) throw new BadRequestException(`Question ${n} has an empty or very long choice`);
      if (new Set(q.options.map((o) => o.trim().toLowerCase())).size !== q.options.length) throw new BadRequestException(`Question ${n} has two identical choices`);
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) throw new BadRequestException(`Question ${n}: mark which choice is correct`);
    });
  }

  private async ownEnrollment(client: PoolClient, claims: RequestClaims, enrollmentId: string, forAttempt = false) {
    const r = await client.query(
      `SELECT ce.*, c.title AS course_title, e.user_account_id FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id JOIN employees e ON e.id = ce.employee_id WHERE ce.id = $1`,
      [enrollmentId]
    );
    if (!r.rowCount) throw new NotFoundException("Enrollment not found");
    const x = r.rows[0];
    if (x.user_account_id !== claims.sub || !(await this.rbac.can(claims, "course_enrollment.manage.self", { ownerId: x.user_account_id }))) throw new ForbiddenException("This exam belongs to someone else");
    if (forAttempt && x.status === "completed") throw new ConflictException("This course is already completed");
    return x;
  }

  private async activeExam(client: PoolClient, courseId: string) {
    const e = await client.query("SELECT * FROM course_exams WHERE course_id = $1 AND is_active", [courseId]);
    if (!e.rowCount) throw new NotFoundException("This course has no exam");
    return e.rows[0];
  }

  private async attemptStats(client: PoolClient, examId: string, enrollmentId: string) {
    const r = await client.query("SELECT count(*)::int AS used, bool_or(passed) AS passed, max(score_pct) AS best FROM exam_attempts WHERE exam_id = $1 AND enrollment_id = $2", [examId, enrollmentId]);
    return { used: r.rows[0].used as number, passed: r.rows[0].passed === true, best: r.rows[0].best === null ? null : Number(r.rows[0].best) };
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "learning"))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.rbac.can(claims, "course.manage.all"))) throw new ForbiddenException("Not permitted to manage course exams");
  }
}
