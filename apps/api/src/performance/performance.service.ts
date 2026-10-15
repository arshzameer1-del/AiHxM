import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { assertPhaseOpen, currentPhase, loadPhases, tenantToday, validatePhaseSet } from "./performance-phases";
import type {
  CalibrateReviewRequest,
  CreateGoalRequest,
  GoalEvidenceView,
  GoalPlanRequest,
  GoalPlanView,
  GoalStatus,
  GoalUpdateType,
  GoalUpdateView,
  ReopenGoalPlanRequest,
  ReviewCyclePhaseView,
  ReviewPhaseKey,
  SetReviewCyclePhasesRequest,
  CreateReviewCycleRequest,
  GoalView,
  LaunchReviewCycleResponse,
  RatingDistributionView,
  ReviewCycleView,
  SubmitManagerAssessmentRequest,
  SubmitSelfAssessmentRequest,
  UpdateGoalRequest,
} from "@aihxm/shared-types";

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Evidence is a link people can open, so only http(s) URLs are accepted. */
export function assertEvidenceUrl(url: string): void {
  if (!/^https?:\/\/[^\s]+$/i.test(url?.trim() ?? "")) throw new BadRequestException("Evidence must be a web link starting with http:// or https://");
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
function rowToGoal(row: any, today: string): GoalView {
  const dueDate = row.due_date ? toIsoDate(row.due_date) : null;
  const open = ["active", "in_progress", "at_risk"].includes(row.status);
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
    effectiveStatus: open && dueDate !== null && dueDate < today ? "overdue" : row.status,
    dueDate,
    targetValue: row.target_value === null || row.target_value === undefined ? null : Number(row.target_value),
    targetUnit: row.target_unit ?? null,
    currentValue: row.current_value === null || row.current_value === undefined ? null : Number(row.current_value),
    progressPct: Number(row.progress_pct ?? 0),
    completedAt: toIso(row.completed_at),
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
      const today = await tenantToday(client, claims.company_id);
      const phases = await loadPhases(client, result.rows.map((r) => r.id), today);
      return result.rows.map((r) => {
        const list = phases.get(r.id) ?? [];
        return { ...rowToCycle(r), phases: list, currentPhase: currentPhase(list) };
      });
    });
  }

  async getCycle(claims: RequestClaims, id: string): Promise<ReviewCycleView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM review_cycles WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Review cycle not found");
      return this.cycleWithPhases(client, claims, id);
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

  /** Sum of weights of the employee's non-cancelled goals in the cycle, optionally leaving one goal out. */
  private async weightTotal(client: PoolClient, cycleId: string, employeeId: string, excludeGoalId?: string): Promise<number> {
    const r = await client.query(
      `SELECT COALESCE(SUM(weight), 0) AS total FROM goals
        WHERE review_cycle_id = $1 AND employee_id = $2 AND status <> 'cancelled' AND ($3::uuid IS NULL OR id <> $3)`,
      [cycleId, employeeId, excludeGoalId ?? null]
    );
    return Number(r.rows[0].total);
  }

  private async planStatus(client: PoolClient, cycleId: string, employeeId: string): Promise<"draft" | "finalised"> {
    const r = await client.query(`SELECT status FROM goal_plans WHERE review_cycle_id = $1 AND employee_id = $2`, [cycleId, employeeId]);
    return r.rows[0]?.status ?? "draft";
  }

  private async recordGoalUpdate(
    client: PoolClient,
    claims: RequestClaims,
    goalId: string,
    u: {
      type: GoalUpdateType;
      fromStatus?: string | null;
      toStatus?: string | null;
      progressPct?: number | null;
      currentValue?: number | null;
      note?: string | null;
      changes?: Record<string, unknown>;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO goal_updates (company_id, goal_id, update_type, from_status, to_status, progress_pct, current_value, note, changes, author_user_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        claims.company_id, goalId, u.type, u.fromStatus ?? null, u.toStatus ?? null, u.progressPct ?? null, u.currentValue ?? null, u.note ?? null,
        JSON.stringify(u.changes ?? {}), /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null,
      ]
    );
  }

  async createGoal(claims: RequestClaims, input: CreateGoalRequest): Promise<GoalView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const isHr = await this.rbac.can(claims, HR_MANAGE_PERMISSION);

      const cycle = await client.query("SELECT status FROM review_cycles WHERE id = $1", [input.reviewCycleId]);
      if (cycle.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (cycle.rows[0].status === "closed") {
        throw new BadRequestException("Cannot add a goal to a closed review cycle");
      }
      await assertPhaseOpen(client, claims.company_id, input.reviewCycleId, "goal_setting", isHr);
      if (!isHr && (await this.planStatus(client, input.reviewCycleId, input.employeeId)) === "finalised") {
        throw new BadRequestException("This goal plan is finalised. Ask HR to reopen it before adding goals.");
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
      if (input.weight !== undefined && input.weight !== null) {
        // Serialise concurrent weight edits for the same plan.
        await client.query(`SELECT id FROM goals WHERE review_cycle_id = $1 AND employee_id = $2 FOR UPDATE`, [input.reviewCycleId, input.employeeId]);
        const total = (await this.weightTotal(client, input.reviewCycleId, input.employeeId)) + Number(input.weight);
        if (total > 100.0001) {
          throw new BadRequestException(`Goal weights cannot add up to more than 100 (this would make ${round2(total)}).`);
        }
      }
      if (input.targetValue !== undefined && input.targetValue !== null && Number(input.targetValue) <= 0) {
        throw new BadRequestException("A goal target must be greater than zero");
      }

      const result = await client.query(
        `INSERT INTO goals (company_id, review_cycle_id, employee_id, parent_goal_id, title, description, weight, created_by_user_account_id,
                            due_date, target_value, target_unit, current_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          claims.company_id,
          input.reviewCycleId,
          input.employeeId,
          input.parentGoalId ?? null,
          input.title,
          input.description ?? null,
          input.weight ?? null,
          claims.sub,
          input.dueDate ?? null,
          input.targetValue ?? null,
          input.targetUnit ?? null,
          input.targetValue !== undefined && input.targetValue !== null ? 0 : null,
        ]
      );
      await this.recordGoalUpdate(client, claims, result.rows[0].id, { type: "created", toStatus: "active", progressPct: 0 });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "goal.create",
        target: result.rows[0].id,
      });
      return rowToGoal(result.rows[0], await tenantToday(client, claims.company_id));
    });
  }

  async listGoals(claims: RequestClaims, filter?: { reviewCycleId?: string; employeeId?: string }): Promise<GoalView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const [scope, hasHrAll, result, today] = await Promise.all([
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
        tenantToday(client, claims.company_id),
      ]);
      const hasAll = scope.hasAll || hasHrAll;
      return result.rows
        .filter(
          (row) =>
            hasAll ||
            (scope.hasSelf && row.employee_user_account_id === claims.sub) ||
            (scope.hasTeam && row.manager_user_account_id === claims.sub)
        )
        .map((row) => rowToGoal(row, today));
    });
  }

  async updateGoal(claims: RequestClaims, id: string, patch: UpdateGoalRequest): Promise<GoalView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM goals WHERE id = $1 FOR UPDATE", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Goal not found");
      const before = current.rows[0];

      const employee = await this.loadEmployee(client, before.employee_id);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const isHr = await this.rbac.can(claims, HR_MANAGE_PERMISSION);

      const cycle = await client.query("SELECT status FROM review_cycles WHERE id = $1", [before.review_cycle_id]);
      if (cycle.rows[0]?.status === "closed") throw new BadRequestException("This review cycle is closed; its goals can no longer change");

      // Wording, weight and the due date are goal-setting decisions: they follow the goal-setting window and the plan lock.
      const shapesPlan = patch.title !== undefined || patch.description !== undefined || patch.weight !== undefined || patch.dueDate !== undefined || patch.targetValue !== undefined || patch.targetUnit !== undefined;
      if (shapesPlan) {
        await assertPhaseOpen(client, claims.company_id, before.review_cycle_id, "goal_setting", isHr);
        if (!isHr && (await this.planStatus(client, before.review_cycle_id, before.employee_id)) === "finalised") {
          throw new BadRequestException("This goal plan is finalised. Ask HR to reopen it before changing goals.");
        }
      }
      if (patch.weight !== undefined && patch.weight !== null) {
        await client.query(`SELECT id FROM goals WHERE review_cycle_id = $1 AND employee_id = $2 FOR UPDATE`, [before.review_cycle_id, before.employee_id]);
        const total = (await this.weightTotal(client, before.review_cycle_id, before.employee_id, id)) + Number(patch.weight);
        if (before.status !== "cancelled" && total > 100.0001) {
          throw new BadRequestException(`Goal weights cannot add up to more than 100 (this would make ${round2(total)}).`);
        }
      }
      if (patch.targetValue !== undefined && patch.targetValue !== null && Number(patch.targetValue) <= 0) {
        throw new BadRequestException("A goal target must be greater than zero");
      }
      if (patch.progressPct !== undefined && (patch.progressPct < 0 || patch.progressPct > 100)) {
        throw new BadRequestException("Progress must be between 0 and 100");
      }
      if (patch.currentValue !== undefined && patch.currentValue < 0) throw new BadRequestException("Current value cannot be negative");

      const next = {
        title: patch.title ?? before.title,
        description: patch.description !== undefined ? patch.description : before.description,
        weight: patch.weight !== undefined ? patch.weight : before.weight,
        due_date: patch.dueDate !== undefined ? patch.dueDate : before.due_date,
        target_value: patch.targetValue !== undefined ? patch.targetValue : before.target_value,
        target_unit: patch.targetUnit !== undefined ? patch.targetUnit : before.target_unit,
        current_value: patch.currentValue !== undefined ? patch.currentValue : before.current_value,
      };
      // Progress: an explicit percentage wins; otherwise it follows current/target when both are known.
      let progress = Number(before.progress_pct);
      if (patch.progressPct !== undefined) progress = patch.progressPct;
      else if (patch.currentValue !== undefined && next.target_value) progress = Math.min(100, round2((Number(patch.currentValue) / Number(next.target_value)) * 100));
      else if (patch.targetValue !== undefined && next.target_value && next.current_value !== null && next.current_value !== undefined) {
        progress = Math.min(100, round2((Number(next.current_value) / Number(next.target_value)) * 100));
      }

      let status: GoalStatus = before.status;
      if (patch.status !== undefined) status = patch.status;
      else if (before.status === "overdue" && patch.dueDate && patch.dueDate >= (await tenantToday(client, claims.company_id))) status = progress > 0 ? "in_progress" : "active";
      else if (progress >= 100 && !["completed", "cancelled"].includes(before.status)) status = "completed";
      else if (progress > Number(before.progress_pct) && before.status === "active") status = "in_progress";
      if (before.status === "completed" && status !== "completed" && patch.status === undefined) status = "completed";
      if (status === "completed") progress = 100;

      const result = await client.query(
        `UPDATE goals SET title = $2, description = $3, weight = $4, status = $5, due_date = $6, target_value = $7, target_unit = $8,
                current_value = $9, progress_pct = $10,
                completed_at = CASE WHEN $5 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, next.title, next.description, next.weight, status, next.due_date, next.target_value, next.target_unit, next.current_value, progress]
      );

      // History: one row per kind of change so the timeline reads naturally.
      const changes: Record<string, unknown> = {};
      if (next.title !== before.title) changes.title = { from: before.title, to: next.title };
      if (next.description !== before.description) changes.description = true;
      if (Number(next.weight ?? -1) !== Number(before.weight ?? -1)) changes.weight = { from: before.weight === null ? null : Number(before.weight), to: next.weight };
      if (Object.keys(changes).length > 0) await this.recordGoalUpdate(client, claims, id, { type: changes.weight ? "weight" : "edit", changes, note: patch.note });
      if (String(next.due_date ?? "") !== String(before.due_date ? toIsoDate(before.due_date) : "")) {
        await this.recordGoalUpdate(client, claims, id, {
          type: "due_date", changes: { from: before.due_date ? toIsoDate(before.due_date) : null, to: next.due_date ?? null }, note: patch.note,
        });
      }
      if (progress !== Number(before.progress_pct) || patch.currentValue !== undefined) {
        await this.recordGoalUpdate(client, claims, id, { type: "progress", progressPct: progress, currentValue: next.current_value === null ? null : Number(next.current_value), note: patch.note });
      }
      if (status !== before.status) await this.recordGoalUpdate(client, claims, id, { type: "status", fromStatus: before.status, toStatus: status, note: patch.note });
      if (patch.note && Object.keys(changes).length === 0 && status === before.status && progress === Number(before.progress_pct) && patch.currentValue === undefined) {
        await this.recordGoalUpdate(client, claims, id, { type: "note", note: patch.note });
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "goal.update",
        target: id,
        metadata: { fields: Object.keys(patch), status, progress },
        reason: isHr && shapesPlan ? patch.note ?? null : null,
      });
      return rowToGoal(result.rows[0], await tenantToday(client, claims.company_id));
    });
  }

  async listGoalUpdates(claims: RequestClaims, goalId: string): Promise<GoalUpdateView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const g = await client.query(`SELECT employee_id FROM goals WHERE id = $1`, [goalId]);
      if (g.rowCount === 0) throw new NotFoundException("Goal not found");
      const employee = await this.loadEmployee(client, g.rows[0].employee_id);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const r = await client.query(`SELECT * FROM goal_updates WHERE goal_id = $1 ORDER BY created_at, id`, [goalId]);
      return r.rows.map(
        (u): GoalUpdateView => ({
          id: u.id,
          goalId: u.goal_id,
          updateType: u.update_type,
          fromStatus: u.from_status ?? null,
          toStatus: u.to_status ?? null,
          progressPct: u.progress_pct === null ? null : Number(u.progress_pct),
          currentValue: u.current_value === null ? null : Number(u.current_value),
          note: u.note ?? null,
          changes: u.changes ?? {},
          authorUserAccountId: u.author_user_account_id ?? null,
          createdAt: toIso(u.created_at) as string,
        })
      );
    });
  }

  // --- Goal plans (weights must add up to 100) ----------------------------

  async getGoalPlan(claims: RequestClaims, reviewCycleId: string, employeeId: string): Promise<GoalPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      return this.buildPlanView(client, reviewCycleId, employeeId);
    });
  }

  private async buildPlanView(client: PoolClient, cycleId: string, employeeId: string): Promise<GoalPlanView> {
    const g = await client.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(weight), 0) AS total, bool_and(weight IS NOT NULL) AS all_weighted
         FROM goals WHERE review_cycle_id = $1 AND employee_id = $2 AND status <> 'cancelled'`,
      [cycleId, employeeId]
    );
    const plan = await client.query(`SELECT * FROM goal_plans WHERE review_cycle_id = $1 AND employee_id = $2`, [cycleId, employeeId]);
    const n = Number(g.rows[0].n);
    const total = round2(Number(g.rows[0].total));
    return {
      reviewCycleId: cycleId,
      employeeId,
      status: plan.rows[0]?.status ?? "draft",
      goalCount: n,
      totalWeight: total,
      remainingWeight: round2(100 - total),
      isComplete: n > 0 && g.rows[0].all_weighted === true && Math.abs(total - 100) < 0.005,
      finalisedAt: toIso(plan.rows[0]?.finalised_at),
      reopenedReason: plan.rows[0]?.reopened_reason ?? null,
    };
  }

  /** Locks the plan once every open goal is weighted and the weights add up to exactly 100. */
  async finaliseGoalPlan(claims: RequestClaims, input: GoalPlanRequest): Promise<GoalPlanView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const isHr = await this.rbac.can(claims, HR_MANAGE_PERMISSION);
      const cycle = await client.query("SELECT status FROM review_cycles WHERE id = $1", [input.reviewCycleId]);
      if (cycle.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (cycle.rows[0].status === "closed") throw new BadRequestException("This review cycle is closed");
      await assertPhaseOpen(client, claims.company_id, input.reviewCycleId, "goal_setting", isHr);
      await client.query(`SELECT id FROM goals WHERE review_cycle_id = $1 AND employee_id = $2 FOR UPDATE`, [input.reviewCycleId, input.employeeId]);
      const view = await this.buildPlanView(client, input.reviewCycleId, input.employeeId);
      if (view.goalCount === 0) throw new BadRequestException("Add at least one goal before finalising the plan");
      const unweighted = await client.query(
        `SELECT COUNT(*) AS n FROM goals WHERE review_cycle_id = $1 AND employee_id = $2 AND status <> 'cancelled' AND weight IS NULL`,
        [input.reviewCycleId, input.employeeId]
      );
      if (Number(unweighted.rows[0].n) > 0) throw new BadRequestException("Every goal needs a weight before the plan can be finalised");
      if (Math.abs(view.totalWeight - 100) >= 0.005) {
        throw new BadRequestException(`Goal weights must add up to exactly 100 (currently ${view.totalWeight}).`);
      }
      await client.query(
        `INSERT INTO goal_plans (company_id, review_cycle_id, employee_id, status, finalised_at, finalised_by, reopened_reason, updated_at)
         VALUES ($1, $2, $3, 'finalised', now(), $4, NULL, now())
         ON CONFLICT (review_cycle_id, employee_id) DO UPDATE SET status = 'finalised', finalised_at = now(), finalised_by = $4, reopened_reason = NULL, updated_at = now()`,
        [claims.company_id, input.reviewCycleId, input.employeeId, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "goal_plan.finalise",
        target: `${input.reviewCycleId}:${input.employeeId}`,
        metadata: { goalCount: view.goalCount },
      });
      return this.buildPlanView(client, input.reviewCycleId, input.employeeId);
    });
  }

  /** HR or the employee's manager reopens a finalised plan, with a reason. */
  async reopenGoalPlan(claims: RequestClaims, input: ReopenGoalPlanRequest): Promise<GoalPlanView> {
    await this.requireModule(claims);
    if (!input.reason?.trim()) throw new BadRequestException("A reason is required to reopen a goal plan");
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      const [isHr, isTeam] = await Promise.all([
        this.rbac.can(claims, HR_MANAGE_PERMISSION),
        this.rbac.can(claims, GOAL_TEAM_PERMISSION, { teamOwnerId: employee.manager_user_account_id }),
      ]);
      if (!isHr && !isTeam) throw new ForbiddenException("Only HR or the employee's manager can reopen a goal plan");
      const cycle = await client.query("SELECT status FROM review_cycles WHERE id = $1", [input.reviewCycleId]);
      if (cycle.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (cycle.rows[0].status === "closed") throw new BadRequestException("This review cycle is closed");
      const r = await client.query(
        `UPDATE goal_plans SET status = 'draft', reopened_reason = $3, updated_at = now() WHERE review_cycle_id = $1 AND employee_id = $2 AND status = 'finalised' RETURNING id`,
        [input.reviewCycleId, input.employeeId, input.reason.trim()]
      );
      if (r.rowCount === 0) throw new BadRequestException("This goal plan is not finalised");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "goal_plan.reopen",
        target: `${input.reviewCycleId}:${input.employeeId}`,
        reason: input.reason.trim(),
      });
      return this.buildPlanView(client, input.reviewCycleId, input.employeeId);
    });
  }

  // --- Goal evidence ---------------------------------------------------------

  async addGoalEvidence(claims: RequestClaims, goalId: string, input: { label: string; url: string }): Promise<GoalEvidenceView> {
    await this.requireModule(claims);
    assertEvidenceUrl(input.url);
    return this.db.withClaims(claims, async (client) => {
      const g = await client.query(`SELECT employee_id, review_cycle_id FROM goals WHERE id = $1`, [goalId]);
      if (g.rowCount === 0) throw new NotFoundException("Goal not found");
      const employee = await this.loadEmployee(client, g.rows[0].employee_id);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const r = await client.query(
        `INSERT INTO performance_evidence (company_id, goal_id, label, url, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [claims.company_id, goalId, input.label.trim(), input.url.trim(), claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "goal.evidence_add", target: goalId, metadata: { label: input.label } });
      return { id: r.rows[0].id, goalId, label: r.rows[0].label, url: r.rows[0].url, createdBy: r.rows[0].created_by, createdAt: toIso(r.rows[0].created_at) as string };
    });
  }

  async listGoalEvidence(claims: RequestClaims, goalId: string): Promise<GoalEvidenceView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const g = await client.query(`SELECT employee_id FROM goals WHERE id = $1`, [goalId]);
      if (g.rowCount === 0) throw new NotFoundException("Goal not found");
      const employee = await this.loadEmployee(client, g.rows[0].employee_id);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const r = await client.query(`SELECT * FROM performance_evidence WHERE goal_id = $1 ORDER BY created_at`, [goalId]);
      return r.rows.map((e): GoalEvidenceView => ({ id: e.id, goalId, label: e.label, url: e.url, createdBy: e.created_by ?? null, createdAt: toIso(e.created_at) as string }));
    });
  }

  async removeGoalEvidence(claims: RequestClaims, goalId: string, evidenceId: string): Promise<{ removed: true }> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const g = await client.query(`SELECT employee_id FROM goals WHERE id = $1`, [goalId]);
      if (g.rowCount === 0) throw new NotFoundException("Goal not found");
      const employee = await this.loadEmployee(client, g.rows[0].employee_id);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.requireGoalAccess(claims, employee);
      const r = await client.query(`DELETE FROM performance_evidence WHERE id = $1 AND goal_id = $2`, [evidenceId, goalId]);
      if (r.rowCount === 0) throw new NotFoundException("Evidence not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "goal.evidence_remove", target: goalId, metadata: { evidenceId } });
      return { removed: true as const };
    });
  }

  // --- Cycle phases (TAL-07) ---------------------------------------------------

  async getPhases(claims: RequestClaims, cycleId: string): Promise<{ phases: ReviewCyclePhaseView[]; currentPhase: ReviewPhaseKey | null }> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const c = await client.query(`SELECT 1 FROM review_cycles WHERE id = $1`, [cycleId]);
      if (c.rowCount === 0) throw new NotFoundException("Review cycle not found");
      const today = await tenantToday(client, claims.company_id);
      const phases = (await loadPhases(client, [cycleId], today)).get(cycleId) ?? [];
      return { phases, currentPhase: currentPhase(phases) };
    });
  }

  /** Replaces the cycle's phase windows. HR only; a closed cycle's schedule is frozen. */
  async setPhases(claims: RequestClaims, cycleId: string, input: SetReviewCyclePhasesRequest): Promise<ReviewCycleView> {
    await this.requireHrManage(claims);
    validatePhaseSet(input.phases);
    return this.db.withClaims(claims, async (client) => {
      const c = await client.query(`SELECT status FROM review_cycles WHERE id = $1 FOR UPDATE`, [cycleId]);
      if (c.rowCount === 0) throw new NotFoundException("Review cycle not found");
      if (c.rows[0].status === "closed") throw new BadRequestException("A closed review cycle's schedule cannot change");
      await client.query(`DELETE FROM review_cycle_phases WHERE review_cycle_id = $1`, [cycleId]);
      for (const p of input.phases) {
        await client.query(`INSERT INTO review_cycle_phases (company_id, review_cycle_id, phase_key, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5)`, [
          claims.company_id, cycleId, p.phaseKey, p.startsOn, p.endsOn,
        ]);
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "review_cycle.set_phases",
        target: cycleId,
        metadata: { phases: input.phases },
      });
      return this.cycleWithPhases(client, claims, cycleId);
    });
  }

  private async cycleWithPhases(client: PoolClient, claims: RequestClaims, cycleId: string): Promise<ReviewCycleView> {
    const r = await client.query("SELECT * FROM review_cycles WHERE id = $1", [cycleId]);
    const today = await tenantToday(client, claims.company_id);
    const phases = (await loadPhases(client, [cycleId], today)).get(cycleId) ?? [];
    return { ...rowToCycle(r.rows[0]), phases, currentPhase: currentPhase(phases) };
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
      await assertPhaseOpen(client, claims.company_id, review.review_cycle_id, "self_assessment", await this.rbac.can(claims, HR_MANAGE_PERMISSION));

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
      await assertPhaseOpen(client, claims.company_id, review.review_cycle_id, "manager_assessment", await this.rbac.can(claims, HR_MANAGE_PERMISSION));

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
