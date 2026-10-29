import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  CreateKeyResultRequest, GoalAlignmentNode, GoalStatus, KeyResultCheckInRequest, KeyResultView, KeyResultsResultView, UpdateKeyResultRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { assertPhaseOpen } from "./performance-phases";

const MODULE_KEY = "performance" as const;
const HR_MANAGE_PERMISSION = "performance.manage.all";
const GOAL_SELF_PERMISSION = "performance_goal.manage.self";
const GOAL_TEAM_PERMISSION = "performance_goal.manage.team";
const MAX_KEY_RESULTS = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** How far `current` has moved from `start` towards `target`, as 0-100. Works for targets below the start (cut costs from 90 to 60). */
export function keyResultProgress(start: number, target: number, current: number): number {
  if (target === start) return 0;
  return Math.max(0, Math.min(100, round2(((current - start) / (target - start)) * 100)));
}

/** Weighted average of key result progress. */
export function rollUp(rows: Array<{ progress: number; weight: number }>): number {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (rows.length === 0 || total <= 0) return 0;
  return round2(rows.reduce((s, r) => s + r.progress * r.weight, 0) / total);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function toView(r: Row): KeyResultView {
  return {
    id: r.id, goalId: r.goal_id, title: r.title, startValue: Number(r.start_value), targetValue: Number(r.target_value), currentValue: Number(r.current_value),
    unit: r.unit ?? null, weight: Number(r.weight), progressPct: Number(r.progress_pct), updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * OKR key results under a goal. Who may read or change them is exactly who may manage the goal. Adding, removing or re-weighting a key
 * result shapes the goal plan, so it follows the goal-setting window and the plan lock; a check-in is just progress and is allowed any time
 * the cycle is open.
 */
@Injectable()
export class KeyResultsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, goalId: string): Promise<KeyResultsResultView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const goal = await this.loadGoal(client, goalId);
      await this.requireAccess(claims, goal);
      return this.snapshot(client, goal);
    });
  }

  async create(claims: RequestClaims, goalId: string, input: CreateKeyResultRequest): Promise<KeyResultsResultView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const goal = await this.loadGoal(client, goalId, true);
      const isHr = await this.requireAccess(claims, goal);
      await this.requireShapable(client, claims, goal, isHr);
      const title = this.checkTitle(input.title);
      const start = input.startValue ?? 0;
      this.checkNumbers(start, input.targetValue);
      const weight = this.checkWeight(input.weight ?? 1);
      const unit = this.checkUnit(input.unit);
      const count = Number((await client.query("SELECT count(*)::int AS n FROM goal_key_results WHERE goal_id = $1", [goalId])).rows[0].n);
      if (count >= MAX_KEY_RESULTS) throw new BadRequestException(`A goal can have up to ${MAX_KEY_RESULTS} key results`);
      const r = await client.query(
        `INSERT INTO goal_key_results (company_id, goal_id, title, start_value, target_value, current_value, unit, weight, progress_pct, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $4, $6, $7, 0, $8, $9) RETURNING id`,
        [claims.company_id, goalId, title, start, input.targetValue, unit, weight, count, /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "goal.key_result_add", target: goalId, metadata: { keyResultId: r.rows[0].id, title } });
      await this.applyRollUp(client, claims, goal, `Key result added: ${title}`);
      return this.snapshot(client, await this.loadGoal(client, goalId));
    });
  }

  async update(claims: RequestClaims, id: string, patch: UpdateKeyResultRequest): Promise<KeyResultsResultView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const kr = await this.loadKeyResult(client, id);
      const goal = await this.loadGoal(client, kr.goal_id, true);
      const isHr = await this.requireAccess(claims, goal);
      await this.requireShapable(client, claims, goal, isHr);
      const title = patch.title !== undefined ? this.checkTitle(patch.title) : kr.title;
      const start = patch.startValue !== undefined ? patch.startValue : Number(kr.start_value);
      const target = patch.targetValue !== undefined ? patch.targetValue : Number(kr.target_value);
      this.checkNumbers(start, target);
      const weight = patch.weight !== undefined ? this.checkWeight(patch.weight) : Number(kr.weight);
      const unit = patch.unit !== undefined ? this.checkUnit(patch.unit) : kr.unit;
      const progress = keyResultProgress(start, target, Number(kr.current_value));
      await client.query(
        `UPDATE goal_key_results SET title = $2, start_value = $3, target_value = $4, unit = $5, weight = $6, progress_pct = $7, updated_at = now() WHERE id = $1`,
        [id, title, start, target, unit, weight, progress]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "goal.key_result_update", target: kr.goal_id, metadata: { keyResultId: id, fields: Object.keys(patch) } });
      await this.applyRollUp(client, claims, goal, `Key result changed: ${title}`);
      return this.snapshot(client, await this.loadGoal(client, kr.goal_id));
    });
  }

  async checkIn(claims: RequestClaims, id: string, input: KeyResultCheckInRequest): Promise<KeyResultsResultView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const kr = await this.loadKeyResult(client, id);
      const goal = await this.loadGoal(client, kr.goal_id, true);
      await this.requireAccess(claims, goal);
      this.requireOpen(goal);
      if (!Number.isFinite(input.currentValue)) throw new BadRequestException("Enter the current value as a number");
      const progress = keyResultProgress(Number(kr.start_value), Number(kr.target_value), input.currentValue);
      await client.query("UPDATE goal_key_results SET current_value = $2, progress_pct = $3, updated_at = now() WHERE id = $1", [id, input.currentValue, progress]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: "goal.key_result_checkin", target: kr.goal_id,
        metadata: { keyResultId: id, from: Number(kr.current_value), to: input.currentValue },
      });
      await this.applyRollUp(client, claims, goal, input.note?.trim() || null, {
        keyResult: { id, title: kr.title, from: Number(kr.current_value), to: input.currentValue, unit: kr.unit },
      });
      return this.snapshot(client, await this.loadGoal(client, kr.goal_id));
    });
  }

  async remove(claims: RequestClaims, id: string): Promise<KeyResultsResultView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const kr = await this.loadKeyResult(client, id);
      const goal = await this.loadGoal(client, kr.goal_id, true);
      const isHr = await this.requireAccess(claims, goal);
      await this.requireShapable(client, claims, goal, isHr);
      await client.query("DELETE FROM goal_key_results WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "goal.key_result_remove", target: kr.goal_id, metadata: { keyResultId: id, title: kr.title } });
      await this.applyRollUp(client, claims, goal, `Key result removed: ${kr.title}`);
      return this.snapshot(client, await this.loadGoal(client, kr.goal_id));
    });
  }

  /** The goals of a cycle laid out as a tree. Parents the reader cannot open are shown as context only (title, owner, progress). */
  async alignment(claims: RequestClaims, reviewCycleId: string): Promise<GoalAlignmentNode[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const [scope, hasHrAll] = await Promise.all([this.rbac.resolveViewScope(claims, "performance_goal.manage"), this.rbac.can(claims, HR_MANAGE_PERMISSION)]);
      const r = await client.query(
        `SELECT g.id, g.parent_goal_id, g.title, g.employee_id, g.progress_pct, g.status, e.user_account_id AS owner_user, mgr.user_account_id AS manager_user,
                trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name,
                (SELECT count(*)::int FROM goal_key_results k WHERE k.goal_id = g.id) AS kr_count
           FROM goals g JOIN employees e ON e.id = g.employee_id LEFT JOIN employees mgr ON mgr.id = e.manager_id
          WHERE g.review_cycle_id = $1 AND g.status <> 'cancelled'
          ORDER BY g.created_at`,
        [reviewCycleId]
      );
      const hasAll = scope.hasAll || hasHrAll;
      const visible = new Set<string>();
      for (const x of r.rows) {
        if (hasAll || (scope.hasSelf && x.owner_user === claims.sub) || (scope.hasTeam && x.manager_user === claims.sub)) visible.add(x.id);
      }
      const byId = new Map<string, Row>(r.rows.map((x) => [x.id, x]));
      const keep = new Set(visible);
      for (const id of visible) {
        let p = byId.get(id)?.parent_goal_id as string | null | undefined;
        let hops = 0;
        while (p && byId.has(p) && !keep.has(p) && hops++ < 20) {
          keep.add(p);
          p = byId.get(p)?.parent_goal_id;
        }
      }
      return r.rows
        .filter((x) => keep.has(x.id))
        .map((x) => ({
          goalId: x.id, parentGoalId: x.parent_goal_id && keep.has(x.parent_goal_id) ? x.parent_goal_id : null, title: x.title, employeeId: x.employee_id,
          employeeName: x.employee_name, progressPct: Number(x.progress_pct), status: x.status as GoalStatus, keyResultCount: x.kr_count, isContext: !visible.has(x.id),
        }));
    });
  }

  // ------------------------------------------------------------------ internals

  private async snapshot(client: PoolClient, goal: Row): Promise<KeyResultsResultView> {
    const r = await client.query("SELECT * FROM goal_key_results WHERE goal_id = $1 ORDER BY position, created_at", [goal.id]);
    return { keyResults: r.rows.map(toView), goalProgressPct: Number(goal.progress_pct), goalStatus: goal.status };
  }

  /** Recomputes the goal's progress from its key results and writes one history line. No key results left: the goal keeps its own progress. */
  private async applyRollUp(client: PoolClient, claims: RequestClaims, goal: Row, note: string | null, changes: Record<string, unknown> = {}): Promise<void> {
    const r = await client.query("SELECT progress_pct, weight FROM goal_key_results WHERE goal_id = $1", [goal.id]);
    if (r.rowCount === 0) {
      await this.history(client, claims, goal.id, { type: "note", note, changes });
      return;
    }
    const progress = rollUp(r.rows.map((x) => ({ progress: Number(x.progress_pct), weight: Number(x.weight) })));
    let status: GoalStatus = goal.status;
    if (progress >= 100 && !["completed", "cancelled"].includes(status)) status = "completed";
    else if (progress > 0 && status === "active") status = "in_progress";
    await client.query(
      `UPDATE goals SET progress_pct = $2, status = $3, completed_at = CASE WHEN $3 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
      [goal.id, progress, status]
    );
    await this.history(client, claims, goal.id, { type: "progress", progressPct: progress, note, changes });
    if (status !== goal.status) await this.history(client, claims, goal.id, { type: "status", fromStatus: goal.status, toStatus: status, note: "From key results" });
  }

  private async history(
    client: PoolClient, claims: RequestClaims, goalId: string,
    u: { type: string; fromStatus?: string; toStatus?: string; progressPct?: number; note?: string | null; changes?: Record<string, unknown> }
  ): Promise<void> {
    await client.query(
      `INSERT INTO goal_updates (company_id, goal_id, update_type, from_status, to_status, progress_pct, note, changes, author_user_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [claims.company_id, goalId, u.type, u.fromStatus ?? null, u.toStatus ?? null, u.progressPct ?? null, u.note ?? null, JSON.stringify(u.changes ?? {}), /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null]
    );
  }

  private async loadGoal(client: PoolClient, goalId: string, lock = false): Promise<Row> {
    const r = await client.query(
      `SELECT g.*, e.user_account_id AS owner_user, mgr.user_account_id AS manager_user, (SELECT status FROM review_cycles c WHERE c.id = g.review_cycle_id) AS cycle_status
         FROM goals g JOIN employees e ON e.id = g.employee_id LEFT JOIN employees mgr ON mgr.id = e.manager_id
        WHERE g.id = $1 ${lock ? "FOR UPDATE OF g" : ""}`,
      [goalId]
    );
    if (!r.rowCount) throw new NotFoundException("Goal not found");
    return r.rows[0];
  }

  private async loadKeyResult(client: PoolClient, id: string): Promise<Row> {
    const r = await client.query("SELECT * FROM goal_key_results WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Key result not found");
    return r.rows[0];
  }

  /** Same people as the goal itself; returns whether the caller is HR. */
  private async requireAccess(claims: RequestClaims, goal: Row): Promise<boolean> {
    const [canAll, canSelf, canTeam] = await Promise.all([
      this.rbac.can(claims, HR_MANAGE_PERMISSION),
      this.rbac.can(claims, GOAL_SELF_PERMISSION, { ownerId: goal.owner_user }),
      this.rbac.can(claims, GOAL_TEAM_PERMISSION, { teamOwnerId: goal.manager_user }),
    ]);
    if (!canAll && !canSelf && !canTeam) throw new ForbiddenException("Not permitted to manage goals for this employee");
    return canAll;
  }

  private requireOpen(goal: Row): void {
    if (goal.cycle_status === "closed") throw new BadRequestException("This review cycle is closed; its goals can no longer change");
    if (goal.status === "cancelled") throw new BadRequestException("This goal is cancelled");
    if (goal.status === "completed") throw new BadRequestException("This goal is completed. Reopen it before changing its key results.");
  }

  private async requireShapable(client: PoolClient, claims: RequestClaims, goal: Row, isHr: boolean): Promise<void> {
    this.requireOpen(goal);
    await assertPhaseOpen(client, claims.company_id, goal.review_cycle_id, "goal_setting", isHr);
    if (!isHr) {
      const p = await client.query("SELECT status FROM goal_plans WHERE review_cycle_id = $1 AND employee_id = $2", [goal.review_cycle_id, goal.employee_id]);
      if (p.rows[0]?.status === "finalised") throw new BadRequestException("This goal plan is finalised. Ask HR to reopen it before changing key results.");
    }
  }

  private checkTitle(t: string): string {
    const title = (t ?? "").trim();
    if (!title || title.length > 200) throw new BadRequestException("A key result needs a title of up to 200 characters");
    return title;
  }

  private checkNumbers(start: number, target: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(target)) throw new BadRequestException("Start and target must be numbers");
    if (start === target) throw new BadRequestException("The target must be different from the starting value");
    if (Math.abs(start) > 1e11 || Math.abs(target) > 1e11) throw new BadRequestException("Start and target are too large");
  }

  private checkWeight(w: number): number {
    if (!Number.isFinite(w) || w <= 0 || w > 100) throw new BadRequestException("Weight must be greater than 0 and at most 100");
    return round2(w);
  }

  private checkUnit(u: string | null | undefined): string | null {
    const unit = (u ?? "").trim();
    if (unit.length > 40) throw new BadRequestException("Unit is up to 40 characters");
    return unit || null;
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }
}
