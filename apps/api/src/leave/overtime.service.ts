import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine, toIsoDate } from "../effective-dating/effective-dating.engine";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import type {
  DecideOvertimeClaimRequest,
  OvertimeDayType,
  OvertimePolicyView,
  OvertimeRecordView,
  ResolvedWorkScheduleView,
  SetOvertimePolicyRequest,
  SubmitOvertimeClaimRequest,
} from "@boostfactor/shared-types";

const LEAVE_MODULE_KEY = "leave" as const;

const DEFAULT_POLICY = {
  daily_threshold_minutes: 0,
  rounding_minutes: 1,
  weekday_rate_multiplier: 1.5,
  rest_day_rate_multiplier: 2.0,
  holiday_rate_multiplier: 2.0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value;
}

function minutesFromTimeString(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * `endTime <= startTime` is tolerated as "wraps past midnight" rather
 * than producing a negative/nonsensical span — a best-effort tolerance,
 * NOT the real cross-midnight hour math the Work Schedule architecture's
 * own roadmap entry names as still-deferred scope (WS-010). Every real
 * schedule this increment's own tests and live verification used stays
 * within one calendar day, so this branch is untested defensive code
 * rather than a claimed feature — it exists so a cross-midnight schedule
 * degrades to a plausible number instead of a broken one, until real
 * cross-midnight support lands.
 */
function minutesBetween(startTime: string, endTime: string): number {
  const start = minutesFromTimeString(startTime);
  let end = minutesFromTimeString(endTime);
  if (end <= start) end += 24 * 60;
  return end - start;
}

/**
 * The employee's SCHEDULED minutes for the date, per the already-resolved
 * weekly-pattern-aware schedule — zero for a day the pattern marks off
 * (a rest day's entire worked time is overtime, not "actual minus zero
 * scheduled", handled separately in `computeOvertimeMinutes` below) or
 * for an employee with no schedule fields to compare against.
 */
function computeScheduledMinutes(resolved: ResolvedWorkScheduleView): number {
  if (!resolved.isWorking || !resolved.startTime || !resolved.endTime) return 0;
  let scheduled = minutesBetween(resolved.startTime, resolved.endTime);
  for (const b of resolved.breaks) {
    if (!b.startTime || !b.endTime) continue;
    scheduled -= minutesBetween(b.startTime, b.endTime);
  }
  return Math.max(0, scheduled);
}

/** Rounds DOWN to the nearest policy increment — a defensible default
 * (never over-credit a claim to the rounding increment's benefit) rather
 * than nearest/up, documented here since a real payroll policy would
 * want this stated plainly rather than left to guess at the source. */
function roundDown(minutes: number, incrementMinutes: number): number {
  if (incrementMinutes <= 1) return minutes;
  return Math.floor(minutes / incrementMinutes) * incrementMinutes;
}

type OvertimePolicyRow = {
  id: string;
  company_id: string;
  daily_threshold_minutes: number;
  rounding_minutes: number;
  weekday_rate_multiplier: string;
  rest_day_rate_multiplier: string;
  holiday_rate_multiplier: string;
  effective_from: unknown;
};

function rowToPolicy(row: OvertimePolicyRow): OvertimePolicyView {
  return {
    id: row.id,
    companyId: row.company_id,
    dailyThresholdMinutes: row.daily_threshold_minutes,
    roundingMinutes: row.rounding_minutes,
    weekdayRateMultiplier: Number(row.weekday_rate_multiplier),
    restDayRateMultiplier: Number(row.rest_day_rate_multiplier),
    holidayRateMultiplier: Number(row.holiday_rate_multiplier),
    effectiveFrom: toIsoDate(row.effective_from),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecordView(row: any, employeeUserAccountId: string | null): OvertimeRecordView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    employeeName: `${row.first_name} ${row.last_name}`,
    attendanceRecordId: row.attendance_record_id,
    workDate: toIsoDate(row.work_date),
    scheduledMinutes: row.scheduled_minutes,
    actualMinutes: row.actual_minutes,
    overtimeMinutes: row.overtime_minutes,
    dayType: row.day_type,
    rateMultiplier: Number(row.rate_multiplier),
    reason: row.reason,
    status: row.status,
    isOnBehalf: employeeUserAccountId !== null && row.submitted_by_user_account_id !== employeeUserAccountId,
    decisionComment: row.decision_comment,
    decidedAt: toIso(row.decided_at),
    createdAt: toIso(row.created_at) as string,
  };
}

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  manager_id: string | null;
};

/**
 * Overtime & On-Duty, first increment — see 0038_overtime.sql's header
 * comment for the full scope decision (an Overtime Policy + Overtime
 * Records only; On-Duty requests and any Payroll integration are named,
 * deliberate follow-ons). Colocated inside `leave/` rather than a
 * standalone module, the same reasoning Attendance Corrections used:
 * this is a sub-feature of Attendance (it reads attendance_records and
 * the Work Schedule resolution both already live here), not a separately
 * licensable unit — it reuses the existing `leave` module_catalog key.
 */
@Injectable()
export class OvertimeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    private readonly workSchedule: WorkScheduleResolutionService
  ) {}

  private async loadEmployee(client: PoolClient, employeeId: string): Promise<EmployeeRow> {
    const result = await client.query<EmployeeRow>(
      `SELECT id, company_id, user_account_id, employee_number, first_name, last_name, manager_id
       FROM employees WHERE id = $1`,
      [employeeId]
    );
    if (result.rowCount === 0) throw new NotFoundException("Employee not found");
    return result.rows[0];
  }

  private async managerUserAccountId(client: PoolClient, managerId: string | null): Promise<string | null> {
    if (!managerId) return null;
    const manager = await client.query<{ user_account_id: string | null }>(
      "SELECT user_account_id FROM employees WHERE id = $1",
      [managerId]
    );
    return manager.rows[0]?.user_account_id ?? null;
  }

  /** Lazily seeds a default policy the first time a tenant has none —
   * same pattern PayrollService.loadOrSeedTaxSlabs() already uses. */
  private async loadOrSeedPolicy(client: PoolClient, companyId: string): Promise<OvertimePolicyRow> {
    const current = await this.effectiveDating.getCurrentRow<OvertimePolicyRow>(client, {
      table: "overtime_policies",
      scope: { company_id: companyId },
    });
    if (current) return current;
    const { row } = await this.effectiveDating.applyVersionedRow<OvertimePolicyRow>(client, {
      table: "overtime_policies",
      scope: { company_id: companyId },
      data: DEFAULT_POLICY,
      effectiveFrom: toIsoDate(new Date()),
    });
    return row;
  }

  private async requirePolicyManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, "overtime.policy.manage.all"))) {
      throw new ForbiddenException("Not permitted to manage the overtime policy");
    }
  }

  async getPolicy(claims: RequestClaims): Promise<OvertimePolicyView> {
    await this.requirePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => rowToPolicy(await this.loadOrSeedPolicy(client, claims.company_id!)));
  }

  async setPolicy(claims: RequestClaims, input: SetOvertimePolicyRequest): Promise<OvertimePolicyView> {
    await this.requirePolicyManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadOrSeedPolicy(client, claims.company_id!);
      const { row } = await this.effectiveDating.applyVersionedRow<OvertimePolicyRow>(client, {
        table: "overtime_policies",
        scope: { company_id: claims.company_id! },
        data: {
          daily_threshold_minutes: input.dailyThresholdMinutes ?? current.daily_threshold_minutes,
          rounding_minutes: input.roundingMinutes ?? current.rounding_minutes,
          weekday_rate_multiplier: input.weekdayRateMultiplier ?? current.weekday_rate_multiplier,
          rest_day_rate_multiplier: input.restDayRateMultiplier ?? current.rest_day_rate_multiplier,
          holiday_rate_multiplier: input.holidayRateMultiplier ?? current.holiday_rate_multiplier,
        },
      });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "overtime_policy.set" });
      return rowToPolicy(row);
    });
  }

  /**
   * Sums actual worked minutes across every already-closed
   * attendance_records row on that calendar date (a kiosk/biometric
   * employee can plausibly clock in/out more than once in a day) and
   * links the LAST such record for evidentiary purposes — the FK is
   * singular, so a multi-punch day's claim references the punch that
   * closed the day's work, not every punch that contributed to it.
   */
  private async loadActualMinutes(
    client: PoolClient,
    employeeId: string,
    workDate: string
  ): Promise<{ actualMinutes: number; attendanceRecordId: string | null }> {
    const result = await client.query<{ id: string; clock_in_at: Date; clock_out_at: Date }>(
      `SELECT id, clock_in_at, clock_out_at FROM attendance_records
       WHERE employee_id = $1 AND clock_in_at::date = $2::date AND clock_out_at IS NOT NULL
       ORDER BY clock_in_at ASC`,
      [employeeId, workDate]
    );
    if (result.rowCount === 0) return { actualMinutes: 0, attendanceRecordId: null };
    let totalMinutes = 0;
    for (const row of result.rows) {
      totalMinutes += Math.round((new Date(row.clock_out_at).getTime() - new Date(row.clock_in_at).getTime()) / 60000);
    }
    return { actualMinutes: totalMinutes, attendanceRecordId: result.rows[result.rows.length - 1].id };
  }

  /**
   * Resolves scheduled-vs-actual and the applicable day type/rate for
   * one employee/date — the one place this computation happens, called
   * only from `submit()` below. Throws with a clear, specific reason
   * whenever a claim genuinely can't be computed, rather than silently
   * returning a zero/garbage result (the same "loud failure over quiet
   * wrongness" discipline the Rules Engine's own validate() follows).
   */
  private async computeClaim(
    client: PoolClient,
    employeeId: string,
    companyId: string,
    workDate: string
  ): Promise<{
    scheduledMinutes: number;
    actualMinutes: number;
    overtimeMinutes: number;
    dayType: OvertimeDayType;
    rateMultiplier: number;
    attendanceRecordId: string | null;
  }> {
    const resolved = await this.workSchedule.resolve(client, employeeId, workDate);
    if (!resolved.hasSchedule) {
      throw new BadRequestException(
        "No work schedule is configured for this employee — assign a shift before submitting an overtime claim"
      );
    }

    const { actualMinutes, attendanceRecordId } = await this.loadActualMinutes(client, employeeId, workDate);
    if (actualMinutes === 0) {
      throw new BadRequestException(
        "No completed attendance record (with both a clock-in and clock-out) was found for that date"
      );
    }

    const policy = await this.loadOrSeedPolicy(client, companyId);
    const dayType: OvertimeDayType = resolved.isMandatoryHoliday ? "holiday" : !resolved.isWorking ? "rest_day" : "weekday";
    const scheduledMinutes = computeScheduledMinutes(resolved);
    const rateMultiplier =
      dayType === "holiday"
        ? Number(policy.holiday_rate_multiplier)
        : dayType === "rest_day"
          ? Number(policy.rest_day_rate_multiplier)
          : Number(policy.weekday_rate_multiplier);

    let overtimeMinutes: number;
    if (dayType === "weekday") {
      const extra = Math.max(0, actualMinutes - scheduledMinutes);
      overtimeMinutes = extra >= policy.daily_threshold_minutes ? roundDown(extra, policy.rounding_minutes) : 0;
    } else {
      overtimeMinutes = roundDown(actualMinutes, policy.rounding_minutes);
    }

    if (overtimeMinutes <= 0) {
      throw new BadRequestException("No overtime to claim for this date based on the resolved schedule and policy");
    }

    return { scheduledMinutes, actualMinutes, overtimeMinutes, dayType, rateMultiplier, attendanceRecordId };
  }

  async submit(claims: RequestClaims, input: SubmitOvertimeClaimRequest): Promise<OvertimeRecordView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);

      const isSelf = employee.user_account_id === claims.sub;
      const canSelf = isSelf && (await this.rbac.can(claims, "overtime.request.self", { ownerId: employee.user_account_id }));
      // On-behalf submission reuses the existing "can touch any employee's
      // attendance" authority rather than a new permission — the exact
      // precedent AttendanceCorrectionsService.submit() already set.
      const canOnBehalf = !isSelf && (await this.rbac.can(claims, "attendance.record.all"));
      if (!canSelf && !canOnBehalf) {
        throw new ForbiddenException("Not permitted to submit an overtime claim for this employee");
      }

      const computed = await this.computeClaim(client, employee.id, employee.company_id, input.workDate);

      try {
        const result = await client.query(
          `INSERT INTO overtime_records
             (company_id, employee_id, attendance_record_id, work_date, scheduled_minutes, actual_minutes,
              overtime_minutes, day_type, rate_multiplier, reason, submitted_by_user_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            employee.company_id,
            employee.id,
            computed.attendanceRecordId,
            input.workDate,
            computed.scheduledMinutes,
            computed.actualMinutes,
            computed.overtimeMinutes,
            computed.dayType,
            computed.rateMultiplier,
            input.reason ?? null,
            claims.sub,
          ]
        );

        await this.audit.record(client, claims, {
          companyId: employee.company_id,
          action: "overtime.submit",
          target: result.rows[0].id,
          metadata: { employeeId: employee.id, workDate: input.workDate, overtimeMinutes: computed.overtimeMinutes },
        });

        return rowToRecordView(
          { ...result.rows[0], employee_number: employee.employee_number, first_name: employee.first_name, last_name: employee.last_name },
          employee.user_account_id
        );
      } catch (err) {
        // idx_overtime_records_one_active_per_day — a pending/approved
        // claim already exists for this employee/date, a clean 409
        // instead of a raw constraint-violation 500.
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException("An overtime claim already exists for this employee on that date");
        }
        throw err;
      }
    });
  }

  async listForEmployee(claims: RequestClaims, employeeId: string): Promise<OvertimeRecordView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      const teamOwnerId = await this.managerUserAccountId(client, employee.manager_id);

      const canSelf =
        employee.user_account_id === claims.sub &&
        (await this.rbac.can(claims, "overtime.request.self", { ownerId: employee.user_account_id }));
      const canAll = await this.rbac.can(claims, "overtime.decide.all");
      const canTeam = await this.rbac.can(claims, "overtime.decide.team", { teamOwnerId });
      if (!canSelf && !canAll && !canTeam) {
        throw new ForbiddenException("Not permitted to view this employee's overtime claims");
      }

      const result = await client.query(
        `SELECT ot.*, e.employee_number, e.first_name, e.last_name
         FROM overtime_records ot
         JOIN employees e ON e.id = ot.employee_id
         WHERE ot.employee_id = $1
         ORDER BY ot.work_date DESC`,
        [employeeId]
      );
      return result.rows.map((row) => rowToRecordView(row, employee.user_account_id));
    });
  }

  /** Same shape as AttendanceCorrectionsService.listPendingForDecider(). */
  async listPendingForDecider(claims: RequestClaims): Promise<OvertimeRecordView[]> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    const scope = await this.rbac.resolveViewScope(claims, "overtime.decide");
    if (!scope.hasAll && !scope.hasTeam) return [];

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT ot.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id,
                m.user_account_id AS manager_user_account_id
         FROM overtime_records ot
         JOIN employees e ON e.id = ot.employee_id
         LEFT JOIN employees m ON m.id = e.manager_id
         WHERE ot.company_id = $1 AND ot.status = 'pending'
         ORDER BY ot.created_at ASC`,
        [claims.company_id]
      );

      const visible = scope.hasAll
        ? result.rows
        : result.rows.filter((row) => row.manager_user_account_id === claims.sub);

      return visible.map((row) => rowToRecordView(row, row.employee_user_account_id));
    });
  }

  async decide(claims: RequestClaims, id: string, input: DecideOvertimeClaimRequest): Promise<OvertimeRecordView> {
    if (!(await this.entitlements.isModuleEnabled(claims, LEAVE_MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query(
        `SELECT ot.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS employee_user_account_id, e.manager_id
         FROM overtime_records ot
         JOIN employees e ON e.id = ot.employee_id
         WHERE ot.id = $1`,
        [id]
      );
      if (existing.rowCount === 0) throw new NotFoundException("Overtime claim not found");
      const row = existing.rows[0];
      if (row.status !== "pending") {
        throw new ConflictException("This overtime claim has already been decided");
      }

      const canAll = await this.rbac.can(claims, "overtime.decide.all");
      const teamOwnerId = await this.managerUserAccountId(client, row.manager_id);
      const canTeam = await this.rbac.can(claims, "overtime.decide.team", { teamOwnerId });
      if (!canAll && !canTeam) {
        throw new ForbiddenException("Not permitted to decide this overtime claim");
      }

      const updated = await client.query(
        `UPDATE overtime_records
         SET status = $2, decided_by_user_account_id = $3, decision_comment = $4, decided_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, input.decision, claims.sub, input.comment ?? null]
      );

      await this.audit.record(client, claims, {
        companyId: row.company_id,
        action: `overtime.${input.decision}`,
        target: id,
        metadata: { employeeId: row.employee_id, overtimeMinutes: row.overtime_minutes },
      });

      return rowToRecordView(
        { ...updated.rows[0], employee_number: row.employee_number, first_name: row.first_name, last_name: row.last_name },
        row.employee_user_account_id
      );
    });
  }
}
