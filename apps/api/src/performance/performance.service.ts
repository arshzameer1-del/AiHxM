import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import type {
  CalibrateReviewRequest,
  CreateGoalRequest,
  CreateReviewCycleRequest,
  GoalView,
  LaunchReviewCycleResponse,
  RatingDistributionView,
  ReviewCycleView,
  SubmitManagerAssessmentRequest,
  SubmitSelfAssessmentRequest,
  UpdateGoalRequest,
} from "@boostfactor/shared-types";

const MODULE_KEY = "performance" as const;
const OBJECT_KEY = "performance_review";
const REVIEW_VIEW_PERMISSION = "performance_review.view";
const HR_MANAGE_PERMISSION = "performance.manage.all";
const GOAL_SELF_PERMISSION = "performance_goal.manage.self";
const GOAL_TEAM_PERMISSION = "performance_goal.manage.team";
const REVIEW_SUBMIT_SELF_PERMISSION = "performance_review.submit_self.self";
const REVIEW_SUBMIT_MANAGER_PERMISSION = "performance_review.submit_manager.team";

// The sensitive/conditional fields on `performance_review` — see
// 0020_performance_seed.sql for the seeded rules. Absent, not null, for
// a caller none of their roles' field_permission_rules grant visibility
// into yet, the same contract Phase 7 established for CNIC/salary/etc.
const SENSITIVE_FIELDS = ["managerAssessment", "managerRating", "finalRating", "calibrationRating", "calibrationComment"] as const;

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  manager_id: string | null;
  manager_user_account_id: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value === null || value === undefined) return null;
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCycle(row: any): ReviewCycleView {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    participantGroupId: row.participant_group_id,
    status: row.status,
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToGoal(row: any): GoalView {
  return {
    id: row.id,
    companyId: row.company_id,
    reviewCycleId: row.review_cycle_id,
    employeeId: row.employee_id,
    parentGoalId: row.parent_goal_id,
    title: row.title,
    description: row.description,
    weight: row.weight === null ? null : Number(row.weight),
    status: row.status,
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToReview(row: any): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.company_id,
    reviewCycleId: row.review_cycle_id,
    employeeId: row.employee_id,
    status: row.status,
    selfAssessment: row.self_assessment,
    selfAssessmentSubmittedAt: toIso(row.self_assessment_submitted_at),
    managerAssessment: row.manager_assessment,
    managerRating: row.manager_rating === null ? null : Number(row.manager_rating),
    managerAssessmentSubmittedAt: toIso(row.manager_assessment_submitted_at),
    calibrationRating: row.calibration_rating === null ? null : Number(row.calibration_rating),
    calibrationComment: row.calibration_comment,
    calibratedAt: toIso(row.calibrated_at),
    finalRating: row.final_rating === null ? null : Number(row.final_rating),
    releasedAt: toIso(row.released_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Phase 11 (plan doc Section 7): "Review cycles, calibration." Unlike
 * Phase 9/10, nothing here routes through the Phase 6 workflow engine —
 * see 0019_performance.sql's header comment and Decision #11 for why
 * this phase's exit criterion doesn't need a tenant-configurable
 * approval chain anywhere in this object graph. The self/manager/
 * calibration visibility rule instead reuses Phase 4's field-permission
 * engine's CONDITIONAL rule mechanism exactly as Phase 7 first used it
 * for Termination Reason, keyed this time on `performance_reviews.status
 * = 'released'` — a status the object transitions through over its own
 * lifecycle rather than a fixed classification.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly employeeGroups: EmployeeGroupsService
  ) {}

  // --- Review cycles -------------------------------------------------

  async createCycle(claims: RequestClaims, input: CreateReviewCycleRequest): Promise<ReviewCycleView> {
    await this.requireHrManage(claims);
    if (new Date(input.periodEnd) < new Date(input.periodStart)) {
      throw new BadRequestException("periodEnd cannot be before periodStart");
    }
    return this.db.withClaims(claims, async (client) => {
      if (input.participantGroupId) {
        const group = await client.query("SELECT 1 FROM employee_groups WHERE id = $1", [input.participantGroupId]);
        if (group.rowCount === 0) throw new BadRequestException("Employee group not found");
      }
      const result = await client.query(
        `INSERT INTO review_cycles (company_id, name, period_start, period_end, participant_group_id, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [claims.company_id, input.name, input.periodStart, input.periodEnd, input.participantGroupId ?? null, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "review_cycle.create",
        target: result.rows[0].id,
      });
      return rowToCycle(result.rows[0]);
    });
  }

  async listCycles(claims: RequestClaims): Promise<ReviewCycleView[]> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM review_cycles ORDER BY created_at DESC");
      return result.rows.map(rowToCycle);
    });
  }

  async getCycle(claims: RequestClaims, id: string): Promise<ReviewCycleView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM review_cycles WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Review cycle not found");
      return rowToCycle(result.rows[0]);
    });
  }

  /**
   * Resolves the cycle's participant population — the group's currently
   * matching active employees, or every active employee when no group is
   * configured (`EmployeeGroupsService.resolveGroupMembers()`, Phase 11's
   * own new addition to that service) — and creates one `pending`
   * `performance_reviews` row per participant. Idempotent: re-launching
   * an already-active cycle is refused rather than silently duplicating
   * or re-creating review rows for a changed population; a genuine
   * population change after launch is a documented future refinement
   * (see KNOWN_ISSUES.md), not attempted here.
   */
  async launchCycle(claims: RequestClaims, id: string): Promise<LaunchReviewCycleResponse> {
    await this.requireHrManage(claims);
    const cycle = await this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM review_cycles WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Review cycle not found");
      return result.rows[0];
    });
    if (cycle.status !== "draft") {
      throw new BadRequestException(`Cannot launch a review cycle that is already ${cycle.status}`);
    }

    const memberIds = await this.employeeGroups.resolveGroupMembers(claims, cycle.participant_group_id);

    const updated = await this.db.withClaims(claims, async (client) => {
      for (const employeeId of memberIds) {
        await client.query(
          `INSERT INTO performance_reviews (company_id, review_cycle_id, employee_id, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (review_cycle_id, employee_id) DO NOTHING`,
          [claims.company_id, id, employeeId]
        );
      }
      const result = await client.query(
        "UPDATE review_cycles SET status = 'active', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "review_cycle.launch",
        target: id,
        metadata: { participantCount: memberIds.length },
      });
      return result.rows[0];
    });

    return { cycle: rowToCycle(updated), participantCount: memberIds.length };
  }

  async beginCalibration(claims: RequestClaims, id: string): Promise<ReviewCycleView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT status FROM review_cycles WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (current.rows[0].status !== "active") {
        throw new BadRequestException(`Cannot begin calibration on a review cycle that is ${current.rows[0].status}`);
      }
      const result = await client.query(
        "UPDATE review_cycles SET status = 'calibration', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "review_cycle.begin_calibration", target: id });
      return rowToCycle(result.rows[0]);
    });
  }

  /**
   * Closes the cycle: every review that reached at least `completed`
   * (both self- and manager-assessment submitted) is released — its
   * `final_rating` becomes `calibration_rating` when HR adjusted it,
   * otherwise the manager's own `manager_rating` unchanged — and becomes
   * visible to the employee and manager per 0020_performance_seed.sql's
   * field rules. A review still stuck at `pending`/`in_progress` (one or
   * both assessments never submitted) is left alone rather than forced
   * closed with a fabricated rating — a real, documented gap (see
   * KNOWN_ISSUES.md), not silently papered over.
   */
  async closeCycle(claims: RequestClaims, id: string): Promise<{ cycle: ReviewCycleView; releasedCount: number }> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT status FROM review_cycles WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (current.rows[0].status !== "calibration") {
        throw new BadRequestException(`Cannot close a review cycle that is ${current.rows[0].status} — begin calibration first`);
      }

      const release = await client.query(
        `UPDATE performance_reviews
         SET status = 'released',
             final_rating = COALESCE(calibration_rating, manager_rating),
             released_at = now(),
             updated_at = now()
         WHERE review_cycle_id = $1 AND status IN ('completed', 'calibrated')
         RETURNING id`,
        [id]
      );

      const result = await client.query(
        "UPDATE review_cycles SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "review_cycle.close",
        target: id,
        metadata: { releasedCount: release.rowCount ?? 0 },
      });
      return { cycle: rowToCycle(result.rows[0]), releasedCount: release.rowCount ?? 0 };
    });
  }

  // --- Goals -----------------------------------------------------------

  async createGoal(claims: RequestClaims, input: CreateGoalRequest): Promise<GoalView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);

      const cycle = await client.query("SELECT status FROM review_cycles WHERE id = $1", [input.reviewCycleId]);
      if (cycle.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (cycle.rows[0].status === "closed") {
        throw new BadRequestException("Cannot add a goal to a closed review cycle");
      }

      if (input.parentGoalId) {
        const parent = await client.query("SELECT id FROM goals WHERE id = $1 AND review_cycle_id = $2", [
          input.parentGoalId,
          input.reviewCycleId,
        ]);
        if (parent.rowCount === 0) {
          throw new BadRequestException("Parent goal not found in this review cycle");
        }
      }

      const result = await client.query(
        `INSERT INTO goals (company_id, review_cycle_id, employee_id, parent_goal_id, title, description, weight, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          claims.company_id,
          input.reviewCycleId,
          input.employeeId,
          input.parentGoalId ?? null,
          input.title,
          input.description ?? null,
          input.weight ?? null,
          claims.sub,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "goal.create",
        target: result.rows[0].id,
      });
      return rowToGoal(result.rows[0]);
    });
  }

  async listGoals(claims: RequestClaims, filter?: { reviewCycleId?: string; employeeId?: string }): Promise<GoalView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const [scope, hasHrAll, result] = await Promise.all([
        this.rbac.resolveViewScope(claims, "performance_goal.manage"),
        this.rbac.can(claims, HR_MANAGE_PERMISSION),
        client.query(
          `SELECT g.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
           FROM goals g
           JOIN employees e ON e.id = g.employee_id
           LEFT JOIN employees mgr ON mgr.id = e.manager_id
           WHERE ($1::uuid IS NULL OR g.review_cycle_id = $1)
             AND ($2::uuid IS NULL OR g.employee_id = $2)
           ORDER BY g.created_at ASC`,
          [filter?.reviewCycleId ?? null, filter?.employeeId ?? null]
        ),
      ]);
      const hasAll = scope.hasAll || hasHrAll;
      return result.rows
        .filter(
          (row) =>
            hasAll ||
            (scope.hasSelf && row.employee_user_account_id === claims.sub) ||
            (scope.hasTeam && row.manager_user_account_id === claims.sub)
        )
        .map(rowToGoal);
    });
  }

  async updateGoal(claims: RequestClaims, id: string, patch: UpdateGoalRequest): Promise<GoalView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM goals WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Goal not found");
      const before = current.rows[0];

      const employee = await this.loadEmployee(client, before.employee_id);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);

      const result = await client.query(
        `UPDATE goals SET title = $2, description = $3, weight = $4, status = $5, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.title ?? before.title,
          patch.description ?? before.description,
          patch.weight ?? before.weight,
          patch.status ?? before.status,
        ]
      );
      return rowToGoal(result.rows[0]);
    });
  }

  // --- Performance reviews ----------------------------------------------

  async listReviews(claims: RequestClaims, filter?: { reviewCycleId?: string; employeeId?: string }): Promise<Record<string, unknown>[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const [scope, fieldRules, result] = await Promise.all([
        this.rbac.resolveViewScope(claims, REVIEW_VIEW_PERMISSION),
        this.rbac.loadFieldPermissionRules(claims, OBJECT_KEY, SENSITIVE_FIELDS),
        client.query(
          `SELECT pr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
           FROM performance_reviews pr
           JOIN employees e ON e.id = pr.employee_id
           LEFT JOIN employees mgr ON mgr.id = e.manager_id
           WHERE ($1::uuid IS NULL OR pr.review_cycle_id = $1)
             AND ($2::uuid IS NULL OR pr.employee_id = $2)
           ORDER BY pr.created_at ASC`,
          [filter?.reviewCycleId ?? null, filter?.employeeId ?? null]
        ),
      ]);
      const out: Record<string, unknown>[] = [];
      for (const row of result.rows) {
        const review = rowToReview(row);
        const filtered = this.rbac.filterRecordFieldsWithScope(
          scope,
          fieldRules,
          review,
          SENSITIVE_FIELDS,
          row.employee_user_account_id,
          row.manager_user_account_id,
          claims.sub
        );
        if (filtered) out.push(filtered);
      }
      return out;
    });
  }

  async getReview(claims: RequestClaims, id: string): Promise<Record<string, unknown>> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT pr.*, e.user_account_id AS employee_user_account_id, mgr.user_account_id AS manager_user_account_id
         FROM performance_reviews pr
         JOIN employees e ON e.id = pr.employee_id
         LEFT JOIN employees mgr ON mgr.id = e.manager_id
         WHERE pr.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Performance review not found");
      const row = result.rows[0];

      const [scope, fieldRules] = await Promise.all([
        this.rbac.resolveViewScope(claims, REVIEW_VIEW_PERMISSION),
        this.rbac.loadFieldPermissionRules(claims, OBJECT_KEY, SENSITIVE_FIELDS),
      ]);
      const review = rowToReview(row);
      const filtered = this.rbac.filterRecordFieldsWithScope(
        scope,
        fieldRules,
        review,
        SENSITIVE_FIELDS,
        row.employee_user_account_id,
        row.manager_user_account_id,
        claims.sub
      );
      if (!filtered) throw new NotFoundException("Performance review not found");
      return filtered;
    });
  }

  async submitSelfAssessment(claims: RequestClaims, id: string, input: SubmitSelfAssessmentRequest): Promise<Record<string, unknown>> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const { review, employee } = await this.loadReviewWithEmployee(client, id);
      if (!(await this.rbac.can(claims, REVIEW_SUBMIT_SELF_PERMISSION, { ownerId: employee.user_account_id }))) {
        throw new ForbiddenException("Not permitted to submit a self-assessment for this review");
      }
      await this.assertCycleActive(client, review.review_cycle_id);

      const nextStatus = review.manager_assessment_submitted_at ? "completed" : "in_progress";
      const result = await client.query(
        `UPDATE performance_reviews
         SET self_assessment = $2, self_assessment_submitted_at = now(), status = $3, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, input.selfAssessment, nextStatus]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "performance_review.submit_self", target: id });
      return rowToReview(result.rows[0]);
    });
  }

  async submitManagerAssessment(
    claims: RequestClaims,
    id: string,
    input: SubmitManagerAssessmentRequest
  ): Promise<Record<string, unknown>> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const { review, employee } = await this.loadReviewWithEmployee(client, id);
      if (!(await this.rbac.can(claims, REVIEW_SUBMIT_MANAGER_PERMISSION, { teamOwnerId: employee.manager_user_account_id }))) {
        throw new ForbiddenException("Not permitted to submit a manager assessment for this review");
      }
      await this.assertCycleActive(client, review.review_cycle_id);

      const nextStatus = review.self_assessment_submitted_at ? "completed" : "in_progress";
      const result = await client.query(
        `UPDATE performance_reviews
         SET manager_assessment = $2, manager_rating = $3, manager_assessment_submitted_at = now(), status = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, input.managerAssessment, input.managerRating, nextStatus]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "performance_review.submit_manager", target: id });
      return rowToReview(result.rows[0]);
    });
  }

  /**
   * The distribution HR actually looks at before adjusting anything —
   * every review in the cycle that has reached at least `completed`
   * (both assessments in) but isn't released yet, grouped by its current
   * `manager_rating`.
   */
  async getRatingDistribution(claims: RequestClaims, cycleId: string): Promise<RatingDistributionView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const cycle = await client.query("SELECT 1 FROM review_cycles WHERE id = $1", [cycleId]);
      if (cycle.rowCount === 0) throw new NotFoundException("Review cycle not found");

      const result = await client.query<{ manager_rating: number | null; status: string }>(
        `SELECT manager_rating, status FROM performance_reviews
         WHERE review_cycle_id = $1 AND status IN ('completed', 'calibrated')`,
        [cycleId]
      );
      const distribution: Record<string, number> = {};
      let pendingCalibration = 0;
      for (const row of result.rows) {
        if (row.manager_rating !== null) {
          const key = String(row.manager_rating);
          distribution[key] = (distribution[key] ?? 0) + 1;
        }
        if (row.status === "completed") pendingCalibration += 1;
      }
      return { reviewCycleId: cycleId, distribution, totalReviews: result.rowCount ?? 0, pendingCalibration };
    });
  }

  async calibrateReview(claims: RequestClaims, id: string, input: CalibrateReviewRequest): Promise<Record<string, unknown>> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT status FROM performance_reviews WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Performance review not found");
      if (!["completed", "calibrated"].includes(current.rows[0].status)) {
        throw new BadRequestException(
          `Cannot calibrate a review that is still ${current.rows[0].status} — both self- and manager-assessment must be submitted first`
        );
      }
      const result = await client.query(
        `UPDATE performance_reviews
         SET calibration_rating = $2, calibration_comment = $3, calibrated_by_user_account_id = $4, calibrated_at = now(),
             status = 'calibrated', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, input.calibrationRating, input.calibrationComment ?? null, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "performance_review.calibrate",
        target: id,
        metadata: { calibrationRating: input.calibrationRating },
      });
      return rowToReview(result.rows[0]);
    });
  }

  // --- Internals ---------------------------------------------------------

  private async loadEmployee(client: PoolClient, employeeId: string): Promise<EmployeeRow | null> {
    const result = await client.query(
      `SELECT e.id, e.company_id, e.user_account_id, e.manager_id, mgr.user_account_id AS manager_user_account_id
       FROM employees e
       LEFT JOIN employees mgr ON mgr.id = e.manager_id
       WHERE e.id = $1`,
      [employeeId]
    );
    return result.rowCount === 0 ? null : (result.rows[0] as EmployeeRow);
  }

  private async loadReviewWithEmployee(
    client: PoolClient,
    reviewId: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ review: any; employee: EmployeeRow }> {
    const result = await client.query("SELECT * FROM performance_reviews WHERE id = $1", [reviewId]);
    if (result.rowCount === 0) throw new NotFoundException("Performance review not found");
    const review = result.rows[0];
    const employee = await this.loadEmployee(client, review.employee_id);
    if (!employee) throw new NotFoundException("Employee not found");
    return { review, employee };
  }

  private async assertCycleActive(client: PoolClient, cycleId: string): Promise<void> {
    const cycle = await client.query("SELECT status FROM review_cycles WHERE id = $1", [cycleId]);
    if (cycle.rowCount === 0) throw new NotFoundException("Review cycle not found");
    if (cycle.rows[0].status !== "active") {
      throw new BadRequestException(
        `Cannot submit an assessment on a review cycle that is ${cycle.rows[0].status} — assessments are only accepted while the cycle is active`
      );
    }
  }

  private async requireGoalAccess(claims: RequestClaims, employee: EmployeeRow): Promise<void> {
    const [canAll, canSelf, canTeam] = await Promise.all([
      this.rbac.can(claims, HR_MANAGE_PERMISSION),
      this.rbac.can(claims, GOAL_SELF_PERMISSION, { ownerId: employee.user_account_id }),
      this.rbac.can(claims, GOAL_TEAM_PERMISSION, { teamOwnerId: employee.manager_user_account_id }),
    ]);
    if (!canAll && !canSelf && !canTeam) {
      throw new ForbiddenException("Not permitted to manage goals for this employee");
    }
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async requireHrManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, HR_MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage performance cycles");
    }
  }
}
