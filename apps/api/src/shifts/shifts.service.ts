import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine, RuleEvaluationError } from "../rules-engine/rules-engine.engine";
import type { RuleExpression } from "../rules-engine/rules-engine.engine";
import { EMPLOYEE_CONDITION_FIELD_TO_COLUMN } from "../employees/employee-condition-fields.util";
import type {
  AssignShiftRequest,
  AttendanceStatus,
  CreateShiftRequest,
  CreateWorkScheduleAssignmentRuleRequest,
  SetWeeklyPatternRequest,
  ShiftAssignmentView,
  ShiftView,
  UpdateShiftRequest,
  UpdateWorkScheduleAssignmentRuleRequest,
  WorkScheduleAssignmentRuleView,
  WorkScheduleBreakView,
  WorkScheduleDayView,
} from "@aihxm/shared-types";

// Reuses the `leave` module's entitlement — see 0026_shift_management.sql's
// header comment for why this isn't a separately-licensed module key.
const MODULE_KEY = "leave" as const;
const MANAGE_PERMISSION = "shift.manage.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToShift(row: any): ShiftView {
  return {
    id: row.id,
    name: row.name,
    startTime: row.start_time,
    endTime: row.end_time,
    crossesMidnight: row.crosses_midnight,
    graceMinutesLate: row.grace_minutes_late,
    graceMinutesEarly: row.grace_minutes_early,
    isDefault: row.is_default,
    scheduleType: row.schedule_type,
    timezone: row.timezone,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBreak(row: any): WorkScheduleBreakView {
  return { id: row.id, startTime: row.start_time, endTime: row.end_time, isPaid: row.is_paid };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDay(row: any, breaks: WorkScheduleBreakView[]): WorkScheduleDayView {
  return {
    dayOfWeek: row.day_of_week,
    isWorking: row.is_working,
    startTime: row.start_time,
    endTime: row.end_time,
    isFlexible: row.is_flexible,
    flexibleStartTime: row.flexible_start_time,
    flexibleEndTime: row.flexible_end_time,
    coreStartTime: row.core_start_time,
    coreEndTime: row.core_end_time,
    isHalfDay: row.is_half_day,
    breaks,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignmentRule(row: any): WorkScheduleAssignmentRuleView {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    conditionExpression: row.condition_expression,
    scheduleId: row.shift_id,
    scheduleName: row.shift_name,
    isActive: row.is_active,
  };
}

/** Day-of-week convention shared with Postgres EXTRACT(DOW)/JS Date#getUTCDay(): 0 = Sunday .. 6 = Saturday. Computed off the plain "YYYY-MM-DD" string at UTC midnight so it never drifts with server-local timezone, matching this codebase's "no timezone conversion happens anywhere else" discipline (see ShiftsService's resolveForEmployeeOnDate doc comment). */
export function dayOfWeekForIsoDate(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAssignment(row: any): ShiftAssignmentView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    employeeName: `${row.first_name} ${row.last_name}`,
    shiftId: row.shift_id,
    shiftName: row.shift_name,
    effectiveFrom: row.effective_from instanceof Date ? row.effective_from.toISOString().slice(0, 10) : row.effective_from,
    effectiveTo: row.effective_to
      ? row.effective_to instanceof Date
        ? row.effective_to.toISOString().slice(0, 10)
        : row.effective_to
      : null,
  };
}

/**
 * Shift definitions + effective-dated employee assignments — see
 * 0026_shift_management.sql for the full design reasoning. The one thing
 * every other module in this codebase cares about here is
 * `resolveForEmployeeOnDate()`: it's the one method exported for another
 * module (AttendanceService, `leave/attendance.service.ts`) to call
 * directly rather than going through an HTTP round trip, the same
 * cross-service-call pattern EntitlementsService/RbacService/AuditService
 * already use everywhere. Attendance status is computed there, at read
 * time, from whatever this resolves — never stored back onto
 * attendance_records (see the migration's own comment on why).
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    private readonly rulesEngine: RulesEngine
  ) {}

  private async requireManage(claims: RequestClaims) {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage shifts");
    }
  }

  async createShift(claims: RequestClaims, input: CreateShiftRequest): Promise<ShiftView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM shifts WHERE company_id = $1 AND name = $2", [
        claims.company_id,
        input.name,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`A shift named "${input.name}" already exists`);
      }
      if (input.isDefault) {
        await client.query("UPDATE shifts SET is_default = false WHERE company_id = $1", [claims.company_id]);
      }
      const result = await client.query(
        `INSERT INTO shifts (company_id, name, start_time, end_time, crosses_midnight, grace_minutes_late, grace_minutes_early, is_default, schedule_type, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          claims.company_id,
          input.name,
          input.startTime,
          input.endTime,
          input.crossesMidnight ?? false,
          input.graceMinutesLate ?? 0,
          input.graceMinutesEarly ?? 0,
          input.isDefault ?? false,
          input.scheduleType ?? "fixed",
          input.timezone ?? "Asia/Karachi",
        ]
      );
      const shift = result.rows[0];

      // Every new shift gets an immediate 7-day working-week pattern
      // seeded from its own start/end time — the same non-breaking
      // default 0037_work_schedule.sql's backfill gave every
      // PRE-EXISTING shift, so a caller that never touches the weekly
      // pattern API (today's frontend ShiftsPanel, this file's own
      // pre-2026-09-18 tests) still gets byte-identical resolution
      // behavior. Admins edit this down to a real weekly pattern (e.g.
      // marking Friday/Saturday off) via setWeeklyPattern() below.
      for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
        await client.query(
          `INSERT INTO work_schedule_days (company_id, shift_id, day_of_week, is_working, start_time, end_time)
           VALUES ($1, $2, $3, true, $4, $5)`,
          [claims.company_id, shift.id, dayOfWeek, input.startTime, input.endTime]
        );
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "shift.create",
        target: shift.id,
        metadata: { name: input.name },
      });
      return rowToShift(shift);
    });
  }

  async updateShift(claims: RequestClaims, id: string, input: UpdateShiftRequest): Promise<ShiftView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM shifts WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Shift not found");
      const row = current.rows[0];

      if (input.isDefault) {
        await client.query("UPDATE shifts SET is_default = false WHERE company_id = $1 AND id != $2", [
          claims.company_id,
          id,
        ]);
      }

      const result = await client.query(
        `UPDATE shifts SET
           name = $2, start_time = $3, end_time = $4, crosses_midnight = $5,
           grace_minutes_late = $6, grace_minutes_early = $7, is_default = $8,
           schedule_type = $9, timezone = $10, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          input.name ?? row.name,
          input.startTime ?? row.start_time,
          input.endTime ?? row.end_time,
          input.crossesMidnight ?? row.crosses_midnight,
          input.graceMinutesLate ?? row.grace_minutes_late,
          input.graceMinutesEarly ?? row.grace_minutes_early,
          input.isDefault ?? row.is_default,
          input.scheduleType ?? row.schedule_type,
          input.timezone ?? row.timezone,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "shift.update",
        target: id,
      });
      return rowToShift(result.rows[0]);
    });
  }

  async listShifts(claims: RequestClaims): Promise<ShiftView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM shifts WHERE company_id = $1 ORDER BY name", [
        claims.company_id,
      ]);
      return result.rows.map(rowToShift);
    });
  }

  /** The weekly pattern (Section 7) + per-day configuration (Section 8/9) for one schedule, days 0..6 ordered. */
  async getWeeklyPattern(claims: RequestClaims, shiftId: string): Promise<WorkScheduleDayView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.loadWeeklyPattern(client, shiftId));
  }

  private async loadWeeklyPattern(client: PoolClient, shiftId: string): Promise<WorkScheduleDayView[]> {
    const days = await client.query("SELECT * FROM work_schedule_days WHERE shift_id = $1 ORDER BY day_of_week", [
      shiftId,
    ]);
    if (days.rowCount === 0) throw new NotFoundException("Schedule not found");
    const breaks = await client.query(
      "SELECT * FROM work_schedule_breaks WHERE work_schedule_day_id = ANY($1) ORDER BY start_time",
      [days.rows.map((d) => d.id)]
    );
    return days.rows.map((day) =>
      rowToDay(
        day,
        breaks.rows.filter((b) => b.work_schedule_day_id === day.id).map(rowToBreak)
      )
    );
  }

  /**
   * Replace-all-7-days in one transaction — Section 26's "Copy Week" bulk
   * edit is exactly this shape from the UI's point of view (build the
   * full 7-day array client-side, submit once), so this deliberately
   * doesn't expose granular per-day PATCH endpoints that would need their
   * own partial-update semantics for very little real benefit.
   */
  async setWeeklyPattern(claims: RequestClaims, shiftId: string, input: SetWeeklyPatternRequest): Promise<WorkScheduleDayView[]> {
    await this.requireManage(claims);
    const days = input.days ?? [];
    const seen = new Set<number>();
    for (const day of days) {
      if (day.dayOfWeek < 0 || day.dayOfWeek > 6) {
        throw new BadRequestException(`dayOfWeek must be 0-6, got ${day.dayOfWeek}`);
      }
      if (seen.has(day.dayOfWeek)) {
        throw new BadRequestException(`dayOfWeek ${day.dayOfWeek} was supplied more than once`);
      }
      seen.add(day.dayOfWeek);
      if (day.isWorking && (!day.startTime || !day.endTime)) {
        throw new BadRequestException(`A working day (dayOfWeek ${day.dayOfWeek}) requires startTime and endTime`);
      }
    }
    if (seen.size !== 7) {
      throw new BadRequestException("A weekly pattern must specify exactly one entry for each of the 7 days (0-6)");
    }

    return this.db.withClaims(claims, async (client) => {
      const shift = await client.query("SELECT id FROM shifts WHERE id = $1", [shiftId]);
      if (shift.rowCount === 0) throw new NotFoundException("Schedule not found");

      await client.query("DELETE FROM work_schedule_days WHERE shift_id = $1", [shiftId]);
      for (const day of days) {
        const inserted = await client.query(
          `INSERT INTO work_schedule_days
             (company_id, shift_id, day_of_week, is_working, start_time, end_time, is_flexible, flexible_start_time, flexible_end_time, core_start_time, core_end_time, is_half_day)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [
            claims.company_id,
            shiftId,
            day.dayOfWeek,
            day.isWorking,
            day.startTime ?? null,
            day.endTime ?? null,
            day.isFlexible ?? false,
            day.flexibleStartTime ?? null,
            day.flexibleEndTime ?? null,
            day.coreStartTime ?? null,
            day.coreEndTime ?? null,
            day.isHalfDay ?? false,
          ]
        );
        const dayId = inserted.rows[0].id;
        for (const b of day.breaks ?? []) {
          await client.query(
            `INSERT INTO work_schedule_breaks (company_id, work_schedule_day_id, start_time, end_time, is_paid)
             VALUES ($1, $2, $3, $4, $5)`,
            [claims.company_id, dayId, b.startTime, b.endTime, b.isPaid ?? false]
          );
        }
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "shift.weekly_pattern.set",
        target: shiftId,
      });
      return this.loadWeeklyPattern(client, shiftId);
    });
  }

  private readonly ASSIGNMENT_RULE_ALLOWED_FIELDS = new Set(Object.keys(EMPLOYEE_CONDITION_FIELD_TO_COLUMN));

  async createAssignmentRule(
    claims: RequestClaims,
    input: CreateWorkScheduleAssignmentRuleRequest
  ): Promise<WorkScheduleAssignmentRuleView> {
    await this.requireManage(claims);
    this.validateExpression(input.conditionExpression);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM work_schedule_assignment_rules WHERE company_id = $1 AND name = $2", [
        claims.company_id,
        input.name,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException(`An assignment rule named "${input.name}" already exists`);
      }
      const shift = await client.query("SELECT id, name FROM shifts WHERE id = $1", [input.scheduleId]);
      if (shift.rowCount === 0) throw new NotFoundException("Target schedule not found");

      const result = await client.query(
        `INSERT INTO work_schedule_assignment_rules (company_id, name, priority, condition_expression, shift_id, is_active, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          claims.company_id,
          input.name,
          input.priority ?? 100,
          JSON.stringify(input.conditionExpression),
          input.scheduleId,
          input.isActive ?? true,
          claims.sub,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "work_schedule_assignment_rule.create",
        target: result.rows[0].id,
        metadata: { name: input.name, scheduleId: input.scheduleId },
      });
      return rowToAssignmentRule({ ...result.rows[0], shift_name: shift.rows[0].name });
    });
  }

  async listAssignmentRules(claims: RequestClaims): Promise<WorkScheduleAssignmentRuleView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT r.*, s.name AS shift_name FROM work_schedule_assignment_rules r
         JOIN shifts s ON s.id = r.shift_id
         WHERE r.company_id = $1 ORDER BY r.priority ASC, r.name ASC`,
        [claims.company_id]
      );
      return result.rows.map(rowToAssignmentRule);
    });
  }

  async updateAssignmentRule(
    claims: RequestClaims,
    id: string,
    input: UpdateWorkScheduleAssignmentRuleRequest
  ): Promise<WorkScheduleAssignmentRuleView> {
    await this.requireManage(claims);
    if (input.conditionExpression) this.validateExpression(input.conditionExpression);
    return this.db.withClaims(claims, async (client) => {
      const current = await client.query("SELECT * FROM work_schedule_assignment_rules WHERE id = $1", [id]);
      if (current.rowCount === 0) throw new NotFoundException("Assignment rule not found");
      const row = current.rows[0];

      if (input.scheduleId) {
        const shift = await client.query("SELECT 1 FROM shifts WHERE id = $1", [input.scheduleId]);
        if (shift.rowCount === 0) throw new NotFoundException("Target schedule not found");
      }

      const result = await client.query(
        `UPDATE work_schedule_assignment_rules SET
           name = $2, priority = $3, condition_expression = $4, shift_id = $5, is_active = $6, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          input.name ?? row.name,
          input.priority ?? row.priority,
          JSON.stringify(input.conditionExpression ?? row.condition_expression),
          input.scheduleId ?? row.shift_id,
          input.isActive ?? row.is_active,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "work_schedule_assignment_rule.update",
        target: id,
      });
      const shift = await client.query("SELECT name FROM shifts WHERE id = $1", [result.rows[0].shift_id]);
      return rowToAssignmentRule({ ...result.rows[0], shift_name: shift.rows[0].name });
    });
  }

  async deleteAssignmentRule(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const result = await client.query("DELETE FROM work_schedule_assignment_rules WHERE id = $1", [id]);
      if (result.rowCount === 0) throw new NotFoundException("Assignment rule not found");
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "work_schedule_assignment_rule.delete",
        target: id,
      });
    });
  }

  /** Shape-validates an admin-authored expression before it's ever persisted — the exact check RulesEngine.validate() exists for (see its own doc comment), scoped to the same field vocabulary Employee Groups' conditions already use (Section 15: reuse the existing Rules Engine, don't invent a parallel one). */
  private validateExpression(expression: RuleExpression): void {
    try {
      this.rulesEngine.validate(expression, this.ASSIGNMENT_RULE_ALLOWED_FIELDS);
    } catch (err) {
      if (err instanceof RuleEvaluationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  async assignShift(claims: RequestClaims, input: AssignShiftRequest): Promise<ShiftAssignmentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await client.query(
        "SELECT id, first_name, last_name, employee_number FROM employees WHERE id = $1",
        [input.employeeId]
      );
      if (employee.rowCount === 0) throw new NotFoundException("Employee not found");

      const shift = await client.query("SELECT id, name FROM shifts WHERE id = $1", [input.shiftId]);
      if (shift.rowCount === 0) throw new NotFoundException("Shift not found");

      // Supersession (close-the-open-row-and-insert, with the same-day
      // collapse guard) now lives once, in the shared
      // EffectiveDatingEngine, rather than hand-written here. This also
      // FIXES a latent gap the original hand-written version had: it
      // never guarded against a same-day re-assignment, which would have
      // attempted to close a row at (effectiveFrom - 1 day) even when
      // that produces an invalid effective_to < effective_from range —
      // see the roadmap doc's "Deliberately deferred" note.
      const { row } = await this.effectiveDating.applyVersionedRow(client, {
        table: "shift_assignments",
        scope: { employee_id: input.employeeId },
        extraInsertColumns: { company_id: claims.company_id, created_by_user_account_id: claims.sub },
        data: { shift_id: input.shiftId },
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "shift.assign",
        target: input.employeeId,
        metadata: { shiftId: input.shiftId, effectiveFrom: input.effectiveFrom },
      });

      const emp = employee.rows[0];
      return rowToAssignment({
        ...row,
        first_name: emp.first_name,
        last_name: emp.last_name,
        employee_number: emp.employee_number,
        shift_name: shift.rows[0].name,
      });
    });
  }

  async getAssignmentHistory(claims: RequestClaims, employeeId: string): Promise<ShiftAssignmentView[]> {
    return this.db.withClaims(claims, async (client) => {
      await this.requireViewAccess(claims, client, employeeId);
      const result = await client.query(
        `SELECT sa.*, e.first_name, e.last_name, e.employee_number, s.name AS shift_name
         FROM shift_assignments sa
         JOIN employees e ON e.id = sa.employee_id
         JOIN shifts s ON s.id = sa.shift_id
         WHERE sa.employee_id = $1
         ORDER BY sa.effective_from DESC`,
        [employeeId]
      );
      return result.rows.map(rowToAssignment);
    });
  }

  /** Current shift as of today for a given employee, or null if none assigned. */
  async getCurrentShift(claims: RequestClaims, employeeId: string): Promise<ShiftAssignmentView | null> {
    return this.db.withClaims(claims, async (client) => {
      await this.requireViewAccess(claims, client, employeeId);
      const resolved = await this.resolveForEmployeeOnDate(client, employeeId, new Date().toISOString().slice(0, 10));
      if (!resolved) return null;
      const employee = await client.query("SELECT first_name, last_name, employee_number FROM employees WHERE id = $1", [
        employeeId,
      ]);
      const emp = employee.rows[0];
      return rowToAssignment({
        id: resolved.assignmentId,
        employee_id: employeeId,
        first_name: emp.first_name,
        last_name: emp.last_name,
        employee_number: emp.employee_number,
        shift_id: resolved.shiftId,
        shift_name: resolved.shiftName,
        effective_from: resolved.effectiveFrom,
        effective_to: resolved.effectiveTo,
      });
    });
  }

  /**
   * Not `private` — WorkScheduleResolutionService (work-schedule-
   * resolution.service.ts) is a second real consumer of this exact
   * self/team/all check (it needs to authorize `GET .../work-schedule`
   * the same way `getCurrentShift`/`getAssignmentHistory` already do),
   * and duplicating it there would be exactly the kind of drift risk
   * this codebase's other extractions (checklist-access.util.ts,
   * employee-condition-fields.util.ts) already exist to avoid.
   */
  async requireViewAccess(claims: RequestClaims, client: PoolClient, employeeId: string) {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    const employee = await client.query<{ user_account_id: string | null; manager_id: string | null }>(
      "SELECT user_account_id, manager_id FROM employees WHERE id = $1",
      [employeeId]
    );
    if (employee.rowCount === 0) throw new NotFoundException("Employee not found");
    const { user_account_id, manager_id } = employee.rows[0];

    const canAll = await this.rbac.can(claims, MANAGE_PERMISSION);
    if (canAll) return;
    const canSelf = await this.rbac.can(claims, "shift.view.self", { ownerId: user_account_id });
    if (canSelf) return;

    let teamOwnerId: string | null = null;
    if (manager_id) {
      const manager = await client.query<{ user_account_id: string | null }>(
        "SELECT user_account_id FROM employees WHERE id = $1",
        [manager_id]
      );
      teamOwnerId = manager.rows[0]?.user_account_id ?? null;
    }
    const canTeam = await this.rbac.can(claims, "shift.view.team", { teamOwnerId });
    if (canTeam) return;

    throw new ForbiddenException("Not permitted to view this employee's shift");
  }

  /**
   * The cross-module entry point AttendanceService calls to resolve
   * on-time/late/early-departure for a punch. Deliberately takes a
   * `client` already inside the caller's own `withClaims` transaction
   * rather than opening its own — RLS has already scoped that client to
   * the right tenant, and a second `withClaims` call here would just
   * re-set the same session variable pointlessly.
   */
  async resolveForEmployeeOnDate(
    client: PoolClient,
    employeeId: string,
    dateIso: string
  ): Promise<{
    assignmentId: string;
    companyId: string;
    shiftId: string;
    shiftName: string;
    scheduleType: string;
    timezone: string;
    startTime: string;
    endTime: string;
    crossesMidnight: boolean;
    graceMinutesLate: number;
    graceMinutesEarly: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    assignmentSource: "individual" | "temporary" | "rule" | "default";
    assignmentRuleName: string | null;
  } | null> {
    const assigned = await client.query(
      `SELECT sa.id AS assignment_id, sa.effective_from AS assignment_effective_from,
              sa.effective_to AS assignment_effective_to, s.*
       FROM shift_assignments sa
       JOIN shifts s ON s.id = sa.shift_id
       WHERE sa.employee_id = $1
         AND sa.effective_from <= $2::date
         AND (sa.effective_to IS NULL OR sa.effective_to >= $2::date)
       ORDER BY sa.effective_from DESC
       LIMIT 1`,
      [employeeId, dateIso]
    );
    let row = assigned.rows[0];
    let assignmentId: string | undefined = row?.assignment_id;
    // sa.effective_from/effective_to come back as Date objects from `pg`
    // (the column is `date`), same as everywhere else in this file
    // (rowToAssignment does the identical dance) — must be re-stringified
    // to YYYY-MM-DD rather than handed to callers as a Date or left
    // undefined, which previously made this silently fall back to
    // "today" for every real (non-default-fallback) assignment.
    let effectiveFrom: string | undefined = row?.assignment_effective_from
      ? row.assignment_effective_from instanceof Date
        ? row.assignment_effective_from.toISOString().slice(0, 10)
        : row.assignment_effective_from
      : undefined;
    let effectiveTo: string | null = row?.assignment_effective_to
      ? row.assignment_effective_to instanceof Date
        ? row.assignment_effective_to.toISOString().slice(0, 10)
        : row.assignment_effective_to
      : null;
    let assignmentSource: "individual" | "temporary" | "rule" | "default" = row
      ? effectiveTo
        ? "temporary"
        : "individual"
      : "default";
    let assignmentRuleName: string | null = null;

    // Need the employee's company + rule-matchable attributes regardless
    // of which branch runs below (Section 15's rule tier, and Section
    // 14's "individual direct assignment beats a rule" precedence — a
    // direct assignment row above already short-circuits this).
    const employeeRow = await client.query<Record<string, unknown>>(
      `SELECT company_id, department, location, designation, employment_type, employment_status
       FROM employees WHERE id = $1`,
      [employeeId]
    );
    if (employeeRow.rowCount === 0) return null;
    const companyId = employeeRow.rows[0].company_id as string;

    if (!row) {
      // No explicit (individual/temporary) assignment covers this date —
      // Section 14's precedence: try the company's configurable
      // assignment RULES next (Section 15), ordered by admin-set priority
      // ascending, then by specificity (more leaf conditions wins,
      // matching EmployeeGroupsService.resolvePolicyInternal()'s own
      // tie-break) — only THEN fall back to the company default shift.
      const context: Record<string, unknown> = {};
      for (const [apiField, column] of Object.entries(EMPLOYEE_CONDITION_FIELD_TO_COLUMN)) {
        context[apiField] = employeeRow.rows[0][column];
      }

      const rules = await client.query(
        `SELECT r.id AS rule_id, r.name AS rule_name, r.priority, r.condition_expression,
                s.id AS shift_row_id, s.name, s.schedule_type, s.timezone, s.start_time, s.end_time,
                s.crosses_midnight, s.grace_minutes_late, s.grace_minutes_early
         FROM work_schedule_assignment_rules r
         JOIN shifts s ON s.id = r.shift_id
         WHERE r.company_id = $1 AND r.is_active
         ORDER BY r.priority ASC, r.name ASC`,
        [companyId]
      );
      const matches = rules.rows.filter((r) => {
        try {
          return this.rulesEngine.evaluate(r.condition_expression, context);
        } catch {
          // A malformed/incompatible rule falls through rather than
          // breaking attendance/leave resolution for everyone — a
          // deliberate safety choice given the stakes of this being a
          // live resolution path, not just a config-validation path
          // (which DOES reject malformed expressions loudly — see
          // validateExpression() above).
          return false;
        }
      });
      if (matches.length > 0) {
        // Specificity tie-break within the same priority tier: more
        // conditions = more specific = wins, same convention Employee
        // Groups already uses.
        matches.sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return countConditions(b.condition_expression) - countConditions(a.condition_expression);
        });
        row = matches[0];
        assignmentId = "rule";
        assignmentSource = "rule";
        assignmentRuleName = matches[0].rule_name;
        effectiveFrom = dateIso;
        effectiveTo = null;
      }
    }

    if (!row) {
      // Still nothing — fall back to the company's default shift, if one
      // exists (same "is_default" shape leave_policies already uses for
      // the tenant-wide fallback).
      const fallback = await client.query("SELECT * FROM shifts WHERE company_id = $1 AND is_default LIMIT 1", [
        companyId,
      ]);
      if (fallback.rowCount === 0) return null;
      row = fallback.rows[0];
      assignmentId = "default";
      assignmentSource = "default";
    }

    return {
      assignmentId: assignmentId ?? "default",
      companyId,
      shiftId: row.shift_row_id ?? row.id ?? row.shift_id,
      shiftName: row.name,
      scheduleType: row.schedule_type,
      timezone: row.timezone,
      startTime: row.start_time,
      endTime: row.end_time,
      crossesMidnight: row.crosses_midnight,
      graceMinutesLate: row.grace_minutes_late,
      graceMinutesEarly: row.grace_minutes_early,
      effectiveFrom: effectiveFrom ?? dateIso,
      effectiveTo,
      assignmentSource,
      assignmentRuleName,
    };
  }
}

/** Leaf-condition count for a RuleExpression tree — the same specificity signal EmployeeGroupsService.resolvePolicyInternal() uses (there, "number of conditions on the group"; here, the equivalent count over an arbitrary all/any/not tree). */
function countConditions(expr: RuleExpression): number {
  if ("all" in expr) return expr.all.reduce((sum, e) => sum + countConditions(e), 0);
  if ("any" in expr) return expr.any.reduce((sum, e) => sum + countConditions(e), 0);
  if ("not" in expr) return countConditions(expr.not);
  return 1;
}

/**
 * Pure function so AttendanceService (and this service's own tests) can
 * compute a status without a database round trip once the shift is
 * already resolved. `clockInAt`/`clockOutAt` are full timestamps;
 * `shift.startTime`/`endTime` are "HH:MM[:SS]" local time-of-day strings
 * — compared purely on the clock, matching every existing date/time field
 * in this schema (no timezone conversion happens anywhere else either).
 */
export function computeAttendanceStatus(
  clockInAt: Date,
  clockOutAt: Date | null,
  shift: { startTime: string; graceMinutesLate: number; endTime: string; graceMinutesEarly: number } | null
): AttendanceStatus {
  if (!shift) return "no_shift_assigned";

  const clockInMinutes = clockInAt.getHours() * 60 + clockInAt.getMinutes();
  const [startH, startM] = shift.startTime.split(":").map(Number);
  const shiftStartMinutes = startH * 60 + startM;
  if (clockInMinutes > shiftStartMinutes + shift.graceMinutesLate) {
    return "late";
  }

  if (clockOutAt) {
    const clockOutMinutes = clockOutAt.getHours() * 60 + clockOutAt.getMinutes();
    const [endH, endM] = shift.endTime.split(":").map(Number);
    const shiftEndMinutes = endH * 60 + endM;
    if (clockOutMinutes < shiftEndMinutes - shift.graceMinutesEarly) {
      return "early_departure";
    }
  }

  return "on_time";
}
