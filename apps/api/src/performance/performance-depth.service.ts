import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  CompetencyView,
  CreateDevelopmentPlanRequest,
  DevelopmentItemInput,
  DevelopmentPlanItemView,
  DevelopmentPlanView,
  FeedbackEvidenceInput,
  FeedbackRequestView,
  FeedbackView,
  GiveFeedbackRequest,
  PerformanceSettingsView,
  RatingSource,
  RequestFeedbackRequest,
  RespondFeedbackRequest,
  ReviewRatingView,
  ReviewScorecardView,
  ScorecardCompetencyLine,
  ScorecardGoalLine,
  SetReviewRatingsRequest,
  UpdateDevelopmentItemRequest,
  UpdateDevelopmentPlanRequest,
  UpsertCompetencyRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { assertPhaseOpen } from "./performance-phases";
import { assertEvidenceUrl } from "./performance.service";

const MODULE_KEY = "performance" as const;
const HR_MANAGE = "performance.manage.all";
const VIEW_ALL = "performance_review.view.all";
const GOAL_SELF = "performance_goal.manage.self";
const GOAL_TEAM = "performance_goal.manage.team";
const SUBMIT_SELF = "performance_review.submit_self.self";
const SUBMIT_MANAGER = "performance_review.submit_manager.team";
const GIVE_FEEDBACK = "performance_feedback.give";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toIso = (v: any): string | null => (v === null || v === undefined ? null : v?.toISOString ? v.toISOString() : v);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toDate = (v: any): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const round2 = (n: number) => Math.round(n * 100) / 100;
const NON_SELF_SOURCES: RatingSource[] = ["manager", "peer", "upward", "skip_level"];
const MULTI_RATER_SOURCES: RatingSource[] = ["peer", "upward", "skip_level"];

type SubjectRow = { id: string; user_account_id: string | null; manager_id: string | null; manager_user_account_id: string | null; full_name: string };
type Relation = { isHr: boolean; isSelf: boolean; isManager: boolean; manageAll: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCompetency(r: any): CompetencyView {
  return { id: r.id, code: r.code, name: r.name, description: r.description ?? null, category: r.category ?? null, isActive: r.is_active };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRequest(r: any): FeedbackRequestView {
  return {
    id: r.id,
    reviewId: r.review_id,
    subjectEmployeeId: r.subject_employee_id,
    raterEmployeeId: r.rater_employee_id,
    raterType: r.rater_type,
    status: r.status,
    isAnonymous: r.is_anonymous,
    dueDate: toDate(r.due_date),
    requestedAt: toIso(r.requested_at) as string,
    respondedAt: toIso(r.responded_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToItem(r: any): DevelopmentPlanItemView {
  return {
    id: r.id,
    planId: r.plan_id,
    competencyId: r.competency_id ?? null,
    courseId: r.course_id ?? null,
    itemType: r.item_type,
    action: r.action,
    dueDate: toDate(r.due_date),
    status: r.status,
    notes: r.notes ?? null,
    completedAt: toIso(r.completed_at),
  };
}

/**
 * Step 11B (TAL-06): competencies, goal- and competency-level ratings, continuous and multi-rater (360) feedback with
 * evidence links, development plans and the one tenant setting those need (minimum raters before anonymous 360 results
 * are shown). Permissions are the module's existing keys (performance.manage.all, performance_goal.manage.self/team,
 * performance_review.view.* and submit_*) plus one new key, performance_feedback.give, for giving feedback.
 * Calibration is never shown to the employee: calibration-source ratings are filtered out of every employee-facing read.
 */
@Injectable()
export class PerformanceDepthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // --- settings and competencies ------------------------------------------------------

  async getSettings(claims: RequestClaims): Promise<PerformanceSettingsView> {
    await this.requireHr(claims);
    return this.db.withClaims(claims, (client) => this.loadSettings(client, claims.company_id as string));
  }

  async updateSettings(claims: RequestClaims, input: { minRatersForAnonymity?: number | null }): Promise<PerformanceSettingsView> {
    await this.requireHr(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const before = await this.loadSettings(client, companyId);
      const next = input.minRatersForAnonymity === undefined ? before.minRatersForAnonymity : input.minRatersForAnonymity;
      if (next !== null && (!Number.isInteger(next) || next < 2 || next > 20)) throw new BadRequestException("The minimum number of raters must be a whole number from 2 to 20, or empty");
      await client.query(
        `INSERT INTO performance_settings (company_id, min_raters_for_anonymity, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (company_id) DO UPDATE SET min_raters_for_anonymity = EXCLUDED.min_raters_for_anonymity, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, next, claims.sub]
      );
      await this.audit.record(client, claims, { companyId, action: "performance.settings_update", target: companyId, before: { ...before }, after: { minRatersForAnonymity: next } });
      return { minRatersForAnonymity: next };
    });
  }

  private async loadSettings(client: PoolClient, companyId: string): Promise<PerformanceSettingsView> {
    const r = await client.query(`SELECT min_raters_for_anonymity FROM performance_settings WHERE company_id = $1`, [companyId]);
    return { minRatersForAnonymity: r.rows[0]?.min_raters_for_anonymity ?? null };
  }

  async listCompetencies(claims: RequestClaims, includeInactive = false): Promise<CompetencyView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(`SELECT * FROM competencies WHERE ($1::boolean OR is_active) ORDER BY category NULLS LAST, name`, [includeInactive]);
      return r.rows.map(rowToCompetency);
    });
  }

  async createCompetency(claims: RequestClaims, input: UpsertCompetencyRequest): Promise<CompetencyView> {
    await this.requireHr(claims);
    const code = input.code ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(code)) throw new BadRequestException("Competency code must start with a letter and use lowercase letters, digits or underscores");
    return this.db.withClaims(claims, async (client) => {
      const dup = await client.query(`SELECT 1 FROM competencies WHERE code = $1`, [code]);
      if ((dup.rowCount ?? 0) > 0) throw new ConflictException(`A competency with code "${code}" already exists`);
      const r = await client.query(
        `INSERT INTO competencies (company_id, code, name, description, category, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [claims.company_id, code, input.name.trim(), input.description ?? null, input.category ?? null, input.isActive ?? true]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "competency.create", target: r.rows[0].id, metadata: { code } });
      return rowToCompetency(r.rows[0]);
    });
  }

  async updateCompetency(claims: RequestClaims, id: string, input: UpsertCompetencyRequest): Promise<CompetencyView> {
    await this.requireHr(claims);
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query(`SELECT * FROM competencies WHERE id = $1 FOR UPDATE`, [id]);
      if (cur.rowCount === 0) throw new NotFoundException("Competency not found");
      const r = await client.query(
        `UPDATE competencies SET name = $2, description = $3, category = $4, is_active = $5 WHERE id = $1 RETURNING *`,
        [id, input.name?.trim() || cur.rows[0].name, input.description !== undefined ? input.description : cur.rows[0].description,
          input.category !== undefined ? input.category : cur.rows[0].category, input.isActive ?? cur.rows[0].is_active]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "competency.update", target: id });
      return rowToCompetency(r.rows[0]);
    });
  }

  // --- ratings and scorecard ----------------------------------------------------------------

  private async loadReview(client: PoolClient, reviewId: string) {
    const r = await client.query(
      `SELECT pr.*, rc.status AS cycle_status, e.user_account_id AS employee_user_account_id, e.manager_id,
              mgr.user_account_id AS manager_user_account_id, (e.first_name || ' ' || e.last_name) AS full_name
         FROM performance_reviews pr
         JOIN review_cycles rc ON rc.id = pr.review_cycle_id
         JOIN employees e ON e.id = pr.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
        WHERE pr.id = $1`,
      [reviewId]
    );
    if (r.rowCount === 0) throw new NotFoundException("Performance review not found");
    return r.rows[0];
  }

  private async relation(claims: RequestClaims, ownerUser: string | null, managerUser: string | null): Promise<Relation> {
    const [manageAll, viewAll] = await Promise.all([this.rbac.can(claims, HR_MANAGE), this.rbac.can(claims, VIEW_ALL)]);
    return { isHr: manageAll || viewAll, manageAll, isSelf: ownerUser !== null && ownerUser === claims.sub, isManager: managerUser !== null && managerUser === claims.sub };
  }

  /** Writes the caller's own ratings (replacing earlier ones for the same goal / competency). */
  async setRatings(claims: RequestClaims, reviewId: string, input: SetReviewRatingsRequest): Promise<ReviewRatingView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const review = await this.loadReview(client, reviewId);
      if (review.status === "released") throw new BadRequestException("This review has been released and can no longer change");
      const manageAll = await this.rbac.can(claims, HR_MANAGE);
      if (input.source === "self") {
        if (!(await this.rbac.can(claims, SUBMIT_SELF, { ownerId: review.employee_user_account_id }))) throw new ForbiddenException("Only the employee can rate themselves");
        if (review.cycle_status !== "active") throw new BadRequestException(`Ratings are only accepted while the cycle is active (it is ${review.cycle_status})`);
        await assertPhaseOpen(client, claims.company_id, review.review_cycle_id, "self_assessment", manageAll);
      } else if (input.source === "manager") {
        if (!(await this.rbac.can(claims, SUBMIT_MANAGER, { teamOwnerId: review.manager_user_account_id }))) throw new ForbiddenException("Only the employee's manager can give manager ratings");
        if (review.cycle_status !== "active") throw new BadRequestException(`Ratings are only accepted while the cycle is active (it is ${review.cycle_status})`);
        await assertPhaseOpen(client, claims.company_id, review.review_cycle_id, "manager_assessment", manageAll);
      } else {
        if (!manageAll) throw new ForbiddenException("Only HR can record calibration ratings");
        if (!["active", "calibration"].includes(review.cycle_status)) throw new BadRequestException(`Calibration ratings need an active or calibrating cycle (it is ${review.cycle_status})`);
      }
      const seen = new Set<string>();
      for (const item of input.ratings) {
        if (Boolean(item.goalId) === Boolean(item.competencyId)) throw new BadRequestException("Each rating is for either a goal or a competency");
        const key = item.goalId ?? item.competencyId!;
        if (seen.has(key)) throw new BadRequestException("A goal or competency can be rated only once per submission");
        seen.add(key);
        if (!Number.isInteger(item.rating) || item.rating < 1 || item.rating > 5) throw new BadRequestException("Ratings are whole numbers from 1 to 5");
        if (item.goalId) {
          const g = await client.query(`SELECT 1 FROM goals WHERE id = $1 AND employee_id = $2 AND review_cycle_id = $3 AND status <> 'cancelled'`, [item.goalId, review.employee_id, review.review_cycle_id]);
          if (g.rowCount === 0) throw new BadRequestException("That goal does not belong to this review");
        } else {
          const c = await client.query(`SELECT 1 FROM competencies WHERE id = $1 AND is_active`, [item.competencyId]);
          if (c.rowCount === 0) throw new BadRequestException("That competency does not exist or is not active");
        }
        if (item.goalId) {
          await client.query(
            `INSERT INTO review_ratings (company_id, review_id, source, rater_user_account_id, goal_id, rating, comment)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (review_id, source, rater_user_account_id, goal_id) WHERE goal_id IS NOT NULL
             DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`,
            [claims.company_id, reviewId, input.source, claims.sub, item.goalId, item.rating, item.comment ?? null]
          );
        } else {
          await client.query(
            `INSERT INTO review_ratings (company_id, review_id, source, rater_user_account_id, competency_id, rating, comment)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (review_id, source, rater_user_account_id, competency_id) WHERE competency_id IS NOT NULL
             DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`,
            [claims.company_id, reviewId, input.source, claims.sub, item.competencyId, item.rating, item.comment ?? null]
          );
        }
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "review_rating.set", target: reviewId, metadata: { source: input.source, count: input.ratings.length } });
      const mine = await client.query(`SELECT * FROM review_ratings WHERE review_id = $1 AND source = $2 AND rater_user_account_id = $3 ORDER BY created_at`, [reviewId, input.source, claims.sub]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return mine.rows.map((r: any): ReviewRatingView => ({ id: r.id, reviewId, source: r.source, goalId: r.goal_id, competencyId: r.competency_id, rating: r.rating, comment: r.comment ?? null, raterUserAccountId: r.rater_user_account_id, createdAt: toIso(r.created_at) as string }));
    });
  }

  /**
   * Who sees which ratings. HR: everything. The employee's manager: self, manager and (threshold permitting) multi-rater
   * input; calibration only once released. The employee: their own ratings; manager and multi-rater input only after
   * release; calibration never.
   */
  async getScorecard(claims: RequestClaims, reviewId: string): Promise<ReviewScorecardView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const review = await this.loadReview(client, reviewId);
      const rel = await this.relation(claims, review.employee_user_account_id, review.manager_user_account_id);
      if (!rel.isHr && !rel.isSelf && !rel.isManager) throw new NotFoundException("Performance review not found");
      const released = review.status === "released";
      const settings = await this.loadSettings(client, claims.company_id as string);

      const visible = new Set<RatingSource>();
      if (rel.isHr) (["self", "manager", "peer", "upward", "skip_level", "calibration"] as RatingSource[]).forEach((s) => visible.add(s));
      else if (rel.isManager) {
        (["self", "manager"] as RatingSource[]).forEach((s) => visible.add(s));
        MULTI_RATER_SOURCES.forEach((s) => visible.add(s));
        if (released) visible.add("calibration");
      } else {
        visible.add("self");
        if (released) NON_SELF_SOURCES.forEach((s) => visible.add(s));
      }

      const ratingRows = (await client.query(`SELECT * FROM review_ratings WHERE review_id = $1`, [reviewId])).rows;
      // multi-rater anonymity threshold (HR is exempt)
      let withheld = 0;
      if (!rel.isHr && settings.minRatersForAnonymity) {
        for (const src of MULTI_RATER_SOURCES) {
          const raters = new Set(ratingRows.filter((r) => r.source === src).map((r) => r.rater_user_account_id));
          if (raters.size > 0 && raters.size < settings.minRatersForAnonymity) {
            withheld += raters.size;
            visible.delete(src);
          }
        }
      }

      const goals = (
        await client.query(
          `SELECT id, title, weight, progress_pct, status FROM goals WHERE review_cycle_id = $1 AND employee_id = $2 AND status <> 'cancelled' ORDER BY created_at`,
          [review.review_cycle_id, review.employee_id]
        )
      ).rows;
      const goalLines: ScorecardGoalLine[] = goals.map((g) => {
        const ratings: Partial<Record<RatingSource, number>> = {};
        for (const src of visible) {
          const list = ratingRows.filter((r) => r.goal_id === g.id && r.source === src).map((r) => Number(r.rating));
          if (list.length > 0) ratings[src] = round2(list.reduce((a, b) => a + b, 0) / list.length);
        }
        return { goalId: g.id, title: g.title, weight: g.weight === null ? null : Number(g.weight), progressPct: Number(g.progress_pct), status: g.status, ratings };
      });
      const comps = (await client.query(`SELECT id, name FROM competencies WHERE id = ANY($1::uuid[])`, [[...new Set(ratingRows.filter((r) => r.competency_id).map((r) => r.competency_id))]])).rows;
      const competencyLines: ScorecardCompetencyLine[] = comps.map((c) => {
        const ratings: ScorecardCompetencyLine["ratings"] = {};
        for (const src of visible) {
          const list = ratingRows.filter((r) => r.competency_id === c.id && r.source === src).map((r) => Number(r.rating));
          if (list.length > 0) ratings[src] = { average: round2(list.reduce((a, b) => a + b, 0) / list.length), count: list.length };
        }
        return { competencyId: c.id, name: c.name, ratings };
      }).filter((c) => Object.keys(c.ratings).length > 0);

      const weightedGoalScore: ReviewScorecardView["weightedGoalScore"] = {};
      for (const src of visible) {
        const rated = goalLines.filter((g) => g.weight !== null && g.ratings[src] !== undefined);
        const totalWeight = rated.reduce((a, g) => a + (g.weight as number), 0);
        if (totalWeight > 0) weightedGoalScore[src] = round2(rated.reduce((a, g) => a + (g.weight as number) * (g.ratings[src] as number), 0) / totalWeight);
      }
      return { reviewId, goals: goalLines, competencies: competencyLines, weightedGoalScore, withheldAnonymousCount: withheld };
    });
  }

  // --- feedback ------------------------------------------------------------------------------------

  private async loadSubject(client: PoolClient, employeeId: string): Promise<SubjectRow> {
    const r = await client.query(
      `SELECT e.id, e.user_account_id, e.manager_id, mgr.user_account_id AS manager_user_account_id, (e.first_name || ' ' || e.last_name) AS full_name
         FROM employees e LEFT JOIN employees mgr ON mgr.id = e.manager_id WHERE e.id = $1 AND e.employment_status <> 'terminated'`,
      [employeeId]
    );
    if (r.rowCount === 0) throw new NotFoundException("Employee not found");
    return r.rows[0];
  }

  private async ownEmployeeId(client: PoolClient, claims: RequestClaims): Promise<string | null> {
    const r = await client.query(`SELECT id FROM employees WHERE user_account_id = $1 LIMIT 1`, [claims.sub]);
    return r.rows[0]?.id ?? null;
  }

  private async addEvidence(client: PoolClient, claims: RequestClaims, feedbackId: string, evidence: FeedbackEvidenceInput[] | undefined): Promise<void> {
    for (const e of evidence ?? []) {
      assertEvidenceUrl(e.url);
      await client.query(`INSERT INTO performance_evidence (company_id, feedback_id, label, url, created_by) VALUES ($1, $2, $3, $4, $5)`, [
        claims.company_id, feedbackId, e.label.trim(), e.url.trim(), claims.sub,
      ]);
    }
  }

  async giveFeedback(claims: RequestClaims, input: GiveFeedbackRequest): Promise<FeedbackView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, GIVE_FEEDBACK))) throw new ForbiddenException("Not permitted to give feedback");
    if (input.rating !== undefined && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) throw new BadRequestException("Ratings are whole numbers from 1 to 5");
    return this.db.withClaims(claims, async (client) => {
      const subject = await this.loadSubject(client, input.subjectEmployeeId);
      if (subject.user_account_id === claims.sub) throw new BadRequestException("You cannot give feedback to yourself");
      if (input.goalId) {
        const g = await client.query(`SELECT 1 FROM goals WHERE id = $1 AND employee_id = $2`, [input.goalId, subject.id]);
        if (g.rowCount === 0) throw new BadRequestException("That goal does not belong to this employee");
      }
      if (input.competencyId) {
        const c = await client.query(`SELECT 1 FROM competencies WHERE id = $1`, [input.competencyId]);
        if (c.rowCount === 0) throw new BadRequestException("Competency not found");
      }
      for (const e of input.evidence ?? []) assertEvidenceUrl(e.url);
      const author = await this.ownEmployeeId(client, claims);
      const r = await client.query(
        `INSERT INTO feedback (company_id, subject_employee_id, author_user_account_id, author_employee_id, feedback_type, goal_id, competency_id, body, rating, visibility)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [claims.company_id, subject.id, claims.sub, author, input.feedbackType ?? "continuous", input.goalId ?? null, input.competencyId ?? null,
          input.body.trim(), input.rating ?? null, input.visibility ?? "subject"]
      );
      await this.addEvidence(client, claims, r.rows[0].id, input.evidence);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "feedback.give", target: r.rows[0].id, metadata: { subjectEmployeeId: subject.id, visibility: r.rows[0].visibility } });
      return (await this.shapeFeedback(client, [r.rows[0]], { isHr: true, isSelf: false, isManager: false, manageAll: true }, false))[0];
    });
  }

  private async shapeFeedback(client: PoolClient, rows: Array<Record<string, unknown>>, rel: Relation, hideAnonymousAuthor = true): Promise<FeedbackView[]> {
    if (rows.length === 0) return [];
    const ev = await client.query(`SELECT id, feedback_id, label, url FROM performance_evidence WHERE feedback_id = ANY($1::uuid[]) ORDER BY created_at`, [rows.map((r) => r.id)]);
    return rows.map((r) => {
      const anonymous = Boolean(r.is_anonymous);
      const view: FeedbackView = {
        id: r.id as string,
        subjectEmployeeId: r.subject_employee_id as string,
        feedbackType: r.feedback_type as FeedbackView["feedbackType"],
        reviewId: (r.review_id as string | null) ?? null,
        goalId: (r.goal_id as string | null) ?? null,
        competencyId: (r.competency_id as string | null) ?? null,
        body: r.body as string,
        rating: (r.rating as number | null) ?? null,
        visibility: r.visibility as FeedbackView["visibility"],
        isAnonymous: anonymous,
        evidence: ev.rows.filter((e) => e.feedback_id === r.id).map((e) => ({ id: e.id, label: e.label, url: e.url })),
        createdAt: toIso(r.created_at) as string,
      };
      if (!anonymous || rel.isHr || !hideAnonymousAuthor) view.authorEmployeeId = (r.author_employee_id as string | null) ?? null;
      return view;
    });
  }

  /** Feedback about an employee, filtered by who is asking (see the visibility column and the anonymity threshold). */
  async listFeedbackAbout(claims: RequestClaims, subjectEmployeeId: string): Promise<{ items: FeedbackView[]; withheldAnonymousCount: number }> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const subject = await this.loadSubject(client, subjectEmployeeId);
      const rel = await this.relation(claims, subject.user_account_id, subject.manager_user_account_id);
      if (!rel.isHr && !rel.isSelf && !rel.isManager) throw new ForbiddenException("Not permitted to see feedback about this employee");
      const rows = (await client.query(
        `SELECT f.*, pr.status AS review_status FROM feedback f LEFT JOIN performance_reviews pr ON pr.id = f.review_id
          WHERE f.subject_employee_id = $1 ORDER BY f.created_at DESC`,
        [subjectEmployeeId]
      )).rows;
      const settings = await this.loadSettings(client, claims.company_id as string);
      let allowed = rows.filter((r) => {
        if (rel.isHr) return true;
        if (r.visibility === "hr_only") return false;
        if (rel.isManager) return true;
        // the employee: nothing marked manager-only; review-linked input only after release
        if (r.visibility !== "subject") return false;
        return r.review_id === null || r.review_status === "released";
      });
      let withheld = 0;
      if (!rel.isHr && settings.minRatersForAnonymity) {
        const byReview = new Map<string, number>();
        for (const r of allowed) if (r.review_id && r.is_anonymous) byReview.set(r.review_id, (byReview.get(r.review_id) ?? 0) + 1);
        allowed = allowed.filter((r) => {
          if (r.review_id && r.is_anonymous && (byReview.get(r.review_id) ?? 0) < settings.minRatersForAnonymity!) {
            withheld += 1;
            return false;
          }
          return true;
        });
      }
      return { items: await this.shapeFeedback(client, allowed, rel), withheldAnonymousCount: withheld };
    });
  }

  async listFeedbackGiven(claims: RequestClaims): Promise<FeedbackView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const rows = (await client.query(`SELECT * FROM feedback WHERE author_user_account_id = $1 ORDER BY created_at DESC`, [claims.sub])).rows;
      return this.shapeFeedback(client, rows, { isHr: true, isSelf: false, isManager: false, manageAll: false }, false);
    });
  }

  // --- multi-rater requests ----------------------------------------------------------------------------------

  async requestFeedback(claims: RequestClaims, reviewId: string, input: RequestFeedbackRequest): Promise<FeedbackRequestView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const review = await this.loadReview(client, reviewId);
      const rel = await this.relation(claims, review.employee_user_account_id, review.manager_user_account_id);
      if (!rel.manageAll && !rel.isManager) throw new ForbiddenException("Only HR or the employee's manager can ask for feedback");
      if (review.cycle_status !== "active") throw new BadRequestException(`Feedback can only be requested while the cycle is active (it is ${review.cycle_status})`);
      const ids = [...new Set(input.raterEmployeeIds)];
      if (ids.includes(review.employee_id)) throw new BadRequestException("The employee cannot be asked to give feedback on themselves");
      const found = await client.query(`SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND employment_status <> 'terminated'`, [ids]);
      if (found.rowCount !== ids.length) throw new BadRequestException("Every rater must be a current employee of this company");
      const already = await client.query(`SELECT rater_employee_id FROM feedback_requests WHERE review_id = $1 AND rater_employee_id = ANY($2::uuid[]) AND status <> 'cancelled'`, [reviewId, ids]);
      if ((already.rowCount ?? 0) > 0) throw new ConflictException("One or more of these people were already asked for feedback on this review");
      const out: FeedbackRequestView[] = [];
      for (const raterId of ids) {
        const r = await client.query(
          `INSERT INTO feedback_requests (company_id, review_id, subject_employee_id, rater_employee_id, rater_type, is_anonymous, due_date, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (review_id, rater_employee_id) DO UPDATE SET status = 'requested', rater_type = EXCLUDED.rater_type, is_anonymous = EXCLUDED.is_anonymous,
             due_date = EXCLUDED.due_date, requested_by = EXCLUDED.requested_by, requested_at = now(), responded_at = NULL
           RETURNING *`,
          [claims.company_id, reviewId, review.employee_id, raterId, input.raterType, input.isAnonymous ?? true, input.dueDate ?? null, claims.sub]
        );
        out.push(rowToRequest(r.rows[0]));
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "feedback_request.create", target: reviewId, metadata: { raters: ids.length, raterType: input.raterType } });
      return out;
    });
  }

  async listRequestsForReview(claims: RequestClaims, reviewId: string): Promise<FeedbackRequestView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const review = await this.loadReview(client, reviewId);
      const rel = await this.relation(claims, review.employee_user_account_id, review.manager_user_account_id);
      if (!rel.isHr && !rel.isManager) throw new ForbiddenException("Not permitted to see feedback requests for this review");
      const r = await client.query(`SELECT * FROM feedback_requests WHERE review_id = $1 ORDER BY requested_at`, [reviewId]);
      return r.rows.map(rowToRequest);
    });
  }

  async listMyRequests(claims: RequestClaims): Promise<Array<FeedbackRequestView & { subjectName: string }>> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const me = await this.ownEmployeeId(client, claims);
      if (!me) return [];
      const r = await client.query(
        `SELECT fr.*, (e.first_name || ' ' || e.last_name) AS subject_name FROM feedback_requests fr
           JOIN employees e ON e.id = fr.subject_employee_id
          WHERE fr.rater_employee_id = $1 AND fr.status = 'requested' ORDER BY fr.due_date NULLS LAST, fr.requested_at`,
        [me]
      );
      return r.rows.map((x) => ({ ...rowToRequest(x), subjectName: x.subject_name }));
    });
  }

  private async loadMyRequest(client: PoolClient, claims: RequestClaims, requestId: string) {
    const r = await client.query(
      `SELECT fr.*, rater.user_account_id AS rater_user, rc.status AS cycle_status, pr.review_cycle_id
         FROM feedback_requests fr
         JOIN employees rater ON rater.id = fr.rater_employee_id
         JOIN performance_reviews pr ON pr.id = fr.review_id
         JOIN review_cycles rc ON rc.id = pr.review_cycle_id
        WHERE fr.id = $1 FOR UPDATE OF fr`,
      [requestId]
    );
    if (r.rowCount === 0) throw new NotFoundException("Feedback request not found");
    if (r.rows[0].rater_user !== claims.sub) throw new NotFoundException("Feedback request not found");
    return r.rows[0];
  }

  async respondToRequest(claims: RequestClaims, requestId: string, input: RespondFeedbackRequest): Promise<FeedbackView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, GIVE_FEEDBACK))) throw new ForbiddenException("Not permitted to give feedback");
    if (input.rating !== undefined && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) throw new BadRequestException("Ratings are whole numbers from 1 to 5");
    return this.db.withClaims(claims, async (client) => {
      const req = await this.loadMyRequest(client, claims, requestId);
      if (req.status !== "requested") throw new BadRequestException(`This request is already ${req.status}`);
      if (req.cycle_status !== "active") throw new BadRequestException(`The review cycle is ${req.cycle_status}; feedback is no longer being collected`);
      const hr = await this.rbac.can(claims, HR_MANAGE);
      await assertPhaseOpen(client, claims.company_id, req.review_cycle_id, "manager_assessment", hr);
      const source: RatingSource = req.rater_type === "other" ? "peer" : req.rater_type;
      for (const cr of input.competencyRatings ?? []) {
        if (!Number.isInteger(cr.rating) || cr.rating < 1 || cr.rating > 5) throw new BadRequestException("Ratings are whole numbers from 1 to 5");
        const c = await client.query(`SELECT 1 FROM competencies WHERE id = $1 AND is_active`, [cr.competencyId]);
        if (c.rowCount === 0) throw new BadRequestException("That competency does not exist or is not active");
      }
      for (const e of input.evidence ?? []) assertEvidenceUrl(e.url);
      const f = await client.query(
        `INSERT INTO feedback (company_id, subject_employee_id, author_user_account_id, author_employee_id, feedback_type, review_id, request_id, body, rating, visibility, is_anonymous)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'subject', $10) RETURNING *`,
        [claims.company_id, req.subject_employee_id, claims.sub, req.rater_employee_id, source, req.review_id, requestId, input.body.trim(), input.rating ?? null, req.is_anonymous]
      );
      for (const cr of input.competencyRatings ?? []) {
        await client.query(
          `INSERT INTO review_ratings (company_id, review_id, source, rater_user_account_id, competency_id, rating, comment) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (review_id, source, rater_user_account_id, competency_id) WHERE competency_id IS NOT NULL DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`,
          [claims.company_id, req.review_id, source, claims.sub, cr.competencyId, cr.rating, cr.comment ?? null]
        );
      }
      await this.addEvidence(client, claims, f.rows[0].id, input.evidence);
      await client.query(`UPDATE feedback_requests SET status = 'submitted', responded_at = now() WHERE id = $1`, [requestId]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "feedback_request.respond", target: requestId, metadata: { reviewId: req.review_id, anonymous: req.is_anonymous } });
      return (await this.shapeFeedback(client, [f.rows[0]], { isHr: false, isSelf: false, isManager: false, manageAll: false }, false))[0];
    });
  }

  async declineRequest(claims: RequestClaims, requestId: string): Promise<FeedbackRequestView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const req = await this.loadMyRequest(client, claims, requestId);
      if (req.status !== "requested") throw new BadRequestException(`This request is already ${req.status}`);
      const r = await client.query(`UPDATE feedback_requests SET status = 'declined', responded_at = now() WHERE id = $1 RETURNING *`, [requestId]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "feedback_request.decline", target: requestId });
      return rowToRequest(r.rows[0]);
    });
  }

  async cancelRequest(claims: RequestClaims, requestId: string): Promise<FeedbackRequestView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT fr.*, e.user_account_id AS subject_user, mgr.user_account_id AS manager_user FROM feedback_requests fr
           JOIN employees e ON e.id = fr.subject_employee_id LEFT JOIN employees mgr ON mgr.id = e.manager_id WHERE fr.id = $1 FOR UPDATE OF fr`,
        [requestId]
      );
      if (r.rowCount === 0) throw new NotFoundException("Feedback request not found");
      const rel = await this.relation(claims, r.rows[0].subject_user, r.rows[0].manager_user);
      if (!rel.manageAll && !rel.isManager) throw new ForbiddenException("Only HR or the employee's manager can cancel a feedback request");
      if (r.rows[0].status !== "requested") throw new BadRequestException(`This request is already ${r.rows[0].status}`);
      const u = await client.query(`UPDATE feedback_requests SET status = 'cancelled', responded_at = now() WHERE id = $1 RETURNING *`, [requestId]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "feedback_request.cancel", target: requestId });
      return rowToRequest(u.rows[0]);
    });
  }

  // --- development plans --------------------------------------------------------------------------------------------------

  private async planAccess(claims: RequestClaims, subject: SubjectRow): Promise<{ manageAll: boolean }> {
    const [manageAll, self, team] = await Promise.all([
      this.rbac.can(claims, HR_MANAGE),
      this.rbac.can(claims, GOAL_SELF, { ownerId: subject.user_account_id }),
      this.rbac.can(claims, GOAL_TEAM, { teamOwnerId: subject.manager_user_account_id }),
    ]);
    if (!manageAll && !self && !team) throw new ForbiddenException("Not permitted to manage development plans for this employee");
    return { manageAll };
  }

  private async loadPlan(client: PoolClient, planId: string): Promise<DevelopmentPlanView> {
    const p = await client.query(`SELECT * FROM development_plans WHERE id = $1`, [planId]);
    if (p.rowCount === 0) throw new NotFoundException("Development plan not found");
    return this.planView(client, p.rows[0]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async planView(client: PoolClient, p: any): Promise<DevelopmentPlanView> {
    const items = await client.query(`SELECT * FROM development_plan_items WHERE plan_id = $1 ORDER BY created_at`, [p.id]);
    return {
      id: p.id, employeeId: p.employee_id, reviewCycleId: p.review_cycle_id ?? null, reviewId: p.review_id ?? null, title: p.title, objective: p.objective ?? null,
      status: p.status, targetDate: toDate(p.target_date), items: items.rows.map(rowToItem), createdAt: toIso(p.created_at) as string, updatedAt: toIso(p.updated_at) as string,
    };
  }

  private async validateItem(client: PoolClient, item: DevelopmentItemInput): Promise<void> {
    if (item.competencyId) {
      const c = await client.query(`SELECT 1 FROM competencies WHERE id = $1`, [item.competencyId]);
      if (c.rowCount === 0) throw new BadRequestException("Competency not found");
    }
    if (item.courseId) {
      const c = await client.query(`SELECT 1 FROM courses WHERE id = $1`, [item.courseId]);
      if (c.rowCount === 0) throw new BadRequestException("Course not found");
    }
  }

  async createPlan(claims: RequestClaims, input: CreateDevelopmentPlanRequest): Promise<DevelopmentPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const subject = await this.loadSubject(client, input.employeeId);
      await this.planAccess(claims, subject);
      if (input.reviewId) {
        const r = await client.query(`SELECT 1 FROM performance_reviews WHERE id = $1 AND employee_id = $2`, [input.reviewId, subject.id]);
        if (r.rowCount === 0) throw new BadRequestException("That review does not belong to this employee");
      }
      for (const it of input.items ?? []) await this.validateItem(client, it);
      const p = await client.query(
        `INSERT INTO development_plans (company_id, employee_id, review_cycle_id, review_id, title, objective, target_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, subject.id, input.reviewCycleId ?? null, input.reviewId ?? null, input.title.trim(), input.objective ?? null, input.targetDate ?? null, claims.sub]
      );
      for (const it of input.items ?? []) {
        await client.query(
          `INSERT INTO development_plan_items (company_id, plan_id, competency_id, course_id, item_type, action, due_date, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [claims.company_id, p.rows[0].id, it.competencyId ?? null, it.courseId ?? null, it.itemType ?? (it.courseId ? "course" : "other"), it.action.trim(), it.dueDate ?? null, it.notes ?? null]
        );
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "development_plan.create", target: p.rows[0].id, metadata: { employeeId: subject.id } });
      return this.planView(client, p.rows[0]);
    });
  }

  async listPlans(claims: RequestClaims, employeeId?: string): Promise<DevelopmentPlanView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const [scope, manageAll] = await Promise.all([this.rbac.resolveViewScope(claims, "performance_goal.manage"), this.rbac.can(claims, HR_MANAGE)]);
      const rows = (await client.query(
        `SELECT p.*, e.user_account_id AS owner_user, mgr.user_account_id AS manager_user FROM development_plans p
           JOIN employees e ON e.id = p.employee_id LEFT JOIN employees mgr ON mgr.id = e.manager_id
          WHERE ($1::uuid IS NULL OR p.employee_id = $1) ORDER BY p.created_at DESC`,
        [employeeId ?? null]
      )).rows;
      const out: DevelopmentPlanView[] = [];
      for (const p of rows) {
        if (manageAll || scope.hasAll || (scope.hasSelf && p.owner_user === claims.sub) || (scope.hasTeam && p.manager_user === claims.sub)) out.push(await this.planView(client, p));
      }
      return out;
    });
  }

  async getPlan(claims: RequestClaims, id: string): Promise<DevelopmentPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const plan = await this.loadPlan(client, id);
      await this.planAccess(claims, await this.loadSubject(client, plan.employeeId));
      return plan;
    });
  }

  async updatePlan(claims: RequestClaims, id: string, input: UpdateDevelopmentPlanRequest): Promise<DevelopmentPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const plan = await this.loadPlan(client, id);
      await this.planAccess(claims, await this.loadSubject(client, plan.employeeId));
      const status = input.status ?? plan.status;
      if (status !== plan.status) {
        if (["completed", "cancelled"].includes(plan.status)) throw new BadRequestException(`This plan is ${plan.status} and cannot change status`);
        if (status === "active" && plan.items.length === 0) throw new BadRequestException("Add at least one development action before activating the plan");
        if (status === "completed" && plan.items.some((i) => i.status !== "done")) throw new BadRequestException("Every action must be done before the plan can be completed");
      }
      await client.query(`UPDATE development_plans SET title = $2, objective = $3, target_date = $4, status = $5, updated_at = now() WHERE id = $1`, [
        id, input.title?.trim() || plan.title, input.objective !== undefined ? input.objective : plan.objective, input.targetDate !== undefined ? input.targetDate : plan.targetDate, status,
      ]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "development_plan.update", target: id, metadata: { status } });
      return this.loadPlan(client, id);
    });
  }

  async addPlanItem(claims: RequestClaims, planId: string, input: DevelopmentItemInput): Promise<DevelopmentPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const plan = await this.loadPlan(client, planId);
      await this.planAccess(claims, await this.loadSubject(client, plan.employeeId));
      if (["completed", "cancelled"].includes(plan.status)) throw new BadRequestException(`This plan is ${plan.status}`);
      await this.validateItem(client, input);
      await client.query(
        `INSERT INTO development_plan_items (company_id, plan_id, competency_id, course_id, item_type, action, due_date, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [claims.company_id, planId, input.competencyId ?? null, input.courseId ?? null, input.itemType ?? (input.courseId ? "course" : "other"), input.action.trim(), input.dueDate ?? null, input.notes ?? null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "development_plan.add_item", target: planId });
      return this.loadPlan(client, planId);
    });
  }

  async updatePlanItem(claims: RequestClaims, itemId: string, input: UpdateDevelopmentItemRequest): Promise<DevelopmentPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const it = await client.query(`SELECT * FROM development_plan_items WHERE id = $1 FOR UPDATE`, [itemId]);
      if (it.rowCount === 0) throw new NotFoundException("Development action not found");
      const plan = await this.loadPlan(client, it.rows[0].plan_id);
      await this.planAccess(claims, await this.loadSubject(client, plan.employeeId));
      if (["completed", "cancelled"].includes(plan.status)) throw new BadRequestException(`This plan is ${plan.status}`);
      await this.validateItem(client, input as DevelopmentItemInput);
      const cur = it.rows[0];
      const status = input.status ?? cur.status;
      await client.query(
        `UPDATE development_plan_items SET competency_id = $2, course_id = $3, item_type = $4, action = $5, due_date = $6, notes = $7, status = $8,
                completed_at = CASE WHEN $8 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END WHERE id = $1`,
        [itemId, input.competencyId ?? cur.competency_id, input.courseId ?? cur.course_id, input.itemType ?? cur.item_type, input.action?.trim() || cur.action,
          input.dueDate ?? cur.due_date, input.notes !== undefined ? input.notes : cur.notes, status]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "development_plan.update_item", target: itemId, metadata: { status } });
      return this.loadPlan(client, plan.id);
    });
  }

  async removePlanItem(claims: RequestClaims, itemId: string): Promise<DevelopmentPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const it = await client.query(`SELECT plan_id FROM development_plan_items WHERE id = $1`, [itemId]);
      if (it.rowCount === 0) throw new NotFoundException("Development action not found");
      const plan = await this.loadPlan(client, it.rows[0].plan_id);
      await this.planAccess(claims, await this.loadSubject(client, plan.employeeId));
      if (["completed", "cancelled"].includes(plan.status)) throw new BadRequestException(`This plan is ${plan.status}`);
      await client.query(`DELETE FROM development_plan_items WHERE id = $1`, [itemId]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "development_plan.remove_item", target: itemId });
      return this.loadPlan(client, plan.id);
    });
  }

  // -------------------------------------------------------------------------------------------------------------------------------

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireHr(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, HR_MANAGE))) throw new ForbiddenException("Not permitted to manage performance settings");
  }
}
