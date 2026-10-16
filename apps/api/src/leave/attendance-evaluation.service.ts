import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { WorkProfileService } from "./work-profile.service";
import type {
  AttendanceDailyResultView,
  AttendanceDailyStatus,
  AttendancePeriodSummary,
  EvaluateAttendanceRequest,
  OverrideAttendanceDayRequest,
  ResolvedWorkScheduleView,
  TeamAttendanceMember,
  TeamAttendanceView,
} from "@aihxm/shared-types";

const MODULE_KEY = "leave" as const;
const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "attendance-evaluation-job" };
const DEFAULT_TZ = "Asia/Karachi";
const MAX_RANGE_DAYS = 62;

const DAY_STATUSES: AttendanceDailyStatus[] = [
  "present", "absent", "late", "early_departure", "late_and_early", "half_day", "on_leave", "on_duty", "holiday", "rest_day", "no_schedule",
];

/** Local clock minutes (0..1439) and calendar date of an instant in a time zone. */
export function localParts(at: Date, tz: string): { date: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function hhmm(value: string | null | undefined): number | null {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Scheduled working minutes of a resolved day (unpaid breaks removed). */
export function scheduledMinutesOf(day: ResolvedWorkScheduleView): number {
  if (!day.isWorking || day.isMandatoryHoliday) return 0;
  const start = hhmm(day.startTime);
  const end = hhmm(day.endTime);
  if (start === null || end === null) return 0;
  let span = end - start;
  if (day.crossesMidnight || span < 0) span += 1440;
  const unpaid = day.breaks
    .filter((b) => !b.isPaid)
    .reduce((sum, b) => {
      const bs = hhmm(b.startTime);
      const be = hhmm(b.endTime);
      return bs === null || be === null ? sum : sum + Math.max(0, be - bs);
    }, 0);
  return Math.max(0, span - unpaid);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(row: any): AttendanceDailyResultView {
  const iso = (v: unknown) => (v ? ((v as Date).toISOString ? (v as Date).toISOString() : String(v)) : null);
  return {
    id: row.id,
    employeeId: row.employee_id,
    workDate: typeof row.work_date === "string" ? row.work_date : row.work_date.toISOString().slice(0, 10),
    shiftId: row.shift_id,
    scheduleName: row.schedule_name,
    status: row.status,
    scheduledMinutes: row.scheduled_minutes,
    workedMinutes: row.worked_minutes,
    lateMinutes: row.late_minutes,
    earlyLeaveMinutes: row.early_leave_minutes,
    firstInAt: iso(row.first_in_at),
    lastOutAt: iso(row.last_out_at),
    punchCount: row.punch_count,
    leaveRequestId: row.leave_request_id,
    onDutyRequestId: row.on_duty_request_id,
    exceptions: row.exceptions ?? [],
    isOverridden: row.is_overridden,
    overrideReason: row.override_reason,
    evaluatedAt: iso(row.evaluated_at) as string,
  };
}

/**
 * Gap Register TLM-04 - the time-evaluation job.
 *
 * Turns raw punches, the resolved work schedule (shift, weekly pattern, holiday), approved
 * leave and approved on-duty requests into ONE processed row per employee per day
 * (`attendance_daily_results`). Payroll and the ESS attendance view read that row, never the
 * punches. Re-running a day is safe (it recomputes the same row); a day that HR has
 * overridden is left alone.
 *
 * Status precedence: approved full-day leave -> on_leave; no schedule and no punches ->
 * no_schedule; mandatory holiday -> holiday; non-working day -> rest_day; approved on-duty ->
 * on_duty; approved half-day leave -> half_day; no punches -> absent; otherwise present /
 * late / early_departure / late_and_early from the first-in / last-out against the shift
 * start / end and grace minutes (clock times are read in the schedule's own time zone).
 * Punch on a holiday / rest day keeps the holiday / rest_day status and records the worked
 * minutes plus an `unscheduled_work` exception (overtime is claimed separately).
 */
@Injectable()
export class AttendanceEvaluationService {
  private readonly logger = new Logger(AttendanceEvaluationService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly workSchedule: WorkScheduleResolutionService,
    // TLM-08 (Step 8C): optional + appended so positional spec constructions keep working.
    private readonly workProfile?: WorkProfileService
  ) {}

  // ------------------------------------------------------------------ the job

  /** Nightly: re-evaluates the last three days (yesterday plus a late-punch / late-approval lookback). */
  @Cron("0 30 1 * * *")
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await this.run({ from: addDays(today, -3), to: addDays(today, -1) });
      if (r.days > 0) this.logger.log(`Attendance evaluation: ${r.days} employee-day(s) across ${r.companies} tenant(s)`);
    } catch (err) {
      this.logger.warn(`Attendance evaluation sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run(range: { from: string; to: string; companyId?: string; employeeId?: string }): Promise<{ companies: number; days: number }> {
    const companies = await this.db.withClaims(SERVICE, async (client) => {
      const r = await client.query<{ company_id: string }>(
        `SELECT company_id FROM tenant_module_entitlement WHERE module_key = 'leave' AND enabled AND ($1::uuid IS NULL OR company_id = $1)`,
        [range.companyId ?? null]
      );
      return r.rows.map((x) => x.company_id);
    });
    let days = 0;
    for (const companyId of companies) days += await this.evaluateCompany(companyId, range.from, range.to, range.employeeId);
    return { companies: companies.length, days };
  }

  async evaluateCompany(companyId: string, from: string, to: string, employeeId?: string): Promise<number> {
    const claims: RequestClaims = { ...SERVICE, company_id: companyId };
    const employees = await this.db.withClaims(claims, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM employees
          WHERE company_id = $1 AND ($4::uuid IS NULL OR id = $4)
            AND (date_of_joining IS NULL OR date_of_joining <= $3::date)
            AND (termination_date IS NULL OR termination_date >= $2::date)`,
        [companyId, from, to, employeeId ?? null]
      );
      return r.rows.map((x) => x.id);
    });
    let count = 0;
    for (const id of employees) {
      await this.db.withClaims(claims, async (client) => {
        for (let d = from; d <= to; d = addDays(d, 1)) {
          if (await this.evaluateDay(client, companyId, id, d)) count++;
        }
      });
    }
    return count;
  }

  /** Evaluates one employee-day and upserts the result. Returns false when the day is HR-overridden. */
  async evaluateDay(client: PoolClient, companyId: string, employeeId: string, workDate: string): Promise<boolean> {
    const existing = await client.query("SELECT is_overridden FROM attendance_daily_results WHERE employee_id = $1 AND work_date = $2", [employeeId, workDate]);
    if (existing.rows[0]?.is_overridden) return false;

    const sched = await this.workSchedule.resolve(client, employeeId, workDate);
    const tz = sched.timezone ?? DEFAULT_TZ;
    const nowLocal = localParts(new Date(), tz);

    const punches = await client.query(
      `SELECT * FROM attendance_records
        WHERE employee_id = $1 AND COALESCE(work_date, (clock_in_at AT TIME ZONE $3)::date) = $2::date AND approval_state <> 'rejected'
        ORDER BY clock_in_at`,
      [employeeId, workDate, DEFAULT_TZ]
    );
    const leave = await client.query(
      `SELECT id, day_part FROM leave_requests
        WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2::date AND end_date >= $2::date
        ORDER BY (day_part = 'full') DESC, created_at`,
      [employeeId, workDate]
    );
    const fullLeave = leave.rows.find((l) => l.day_part === "full");
    const halfLeave = leave.rows.find((l) => l.day_part !== "full");
    const onDuty = await client.query(
      `SELECT id FROM on_duty_requests WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2::date AND end_date >= $2::date LIMIT 1`,
      [employeeId, workDate]
    );

    // --- worked minutes, first in / last out, exceptions
    const exceptions: string[] = [];
    let worked = 0;
    let firstIn: Date | null = null;
    let lastOut: Date | null = null;
    for (const p of punches.rows) {
      const inAt: Date = p.clock_in_at;
      if (!firstIn || inAt < firstIn) firstIn = inAt;
      if (p.clock_out_at) {
        const outAt: Date = p.clock_out_at;
        worked += Math.max(0, Math.round((outAt.getTime() - inAt.getTime()) / 60000));
        if (!lastOut || outAt > lastOut) lastOut = outAt;
      } else if (workDate === nowLocal.date) {
        worked += Math.max(0, Math.round((Date.now() - inAt.getTime()) / 60000)); // still on shift today
      } else {
        exceptions.push("missing_clock_out");
      }
    }

    const scheduledMinutes = scheduledMinutesOf(sched);
    const hasPunches = punches.rows.length > 0;
    let status: AttendanceDailyStatus;
    let late = 0;
    let early = 0;

    if (fullLeave) {
      status = "on_leave";
    } else if (!sched.hasSchedule && !hasPunches && !sched.isMandatoryHoliday) {
      status = "no_schedule";
    } else if (sched.isMandatoryHoliday) {
      status = "holiday";
      if (hasPunches) exceptions.push("unscheduled_work");
    } else if (!sched.isWorking) {
      status = "rest_day";
      if (hasPunches) exceptions.push("unscheduled_work");
    } else if (onDuty.rowCount) {
      status = "on_duty";
    } else if (halfLeave) {
      status = "half_day";
    } else if (!hasPunches) {
      // TLM-08: who is expected to clock at all depends on the employee's time-recording profile
      const profile = await this.workProfile?.getAsOf(client, employeeId, workDate);
      const mode = profile?.timeRecordingProfile ?? "clock";
      if (mode === "none" || mode === "exception_only") {
        status = "present";
        exceptions.push("time_not_recorded");
      } else if (mode === "timesheet") {
        const ts = await client.query(
          `SELECT COALESCE(SUM(te.minutes), 0)::int AS minutes FROM timesheet_entries te
             JOIN timesheets t ON t.id = te.timesheet_id
            WHERE t.employee_id = $1 AND t.status = 'approved' AND te.work_date = $2::date`,
          [employeeId, workDate]
        );
        if (ts.rows[0].minutes > 0) {
          status = "present";
          worked = ts.rows[0].minutes;
          exceptions.push("from_timesheet");
        } else {
          status = "absent";
        }
      } else {
        status = "absent";
      }
    } else {
      status = "present";
      if (sched.hasSchedule) {
        const startM = hhmm(sched.isFlexible ? (sched.coreStartTime ?? sched.flexibleEndTime) : sched.startTime);
        const endM = hhmm(sched.isFlexible ? sched.coreEndTime : sched.endTime);
        if (firstIn && startM !== null) {
          const inLocal = localParts(firstIn, tz);
          const inMinutes = inLocal.date === workDate ? inLocal.minutes : 0;
          const grace = sched.isFlexible ? 0 : sched.graceMinutesLate;
          if (inMinutes > startM + grace) late = inMinutes - startM;
        }
        if (lastOut && endM !== null) {
          const outLocal = localParts(lastOut, tz);
          let outMinutes = outLocal.minutes;
          if (outLocal.date > workDate) outMinutes += 1440;
          const target = sched.crossesMidnight && endM < (hhmm(sched.startTime) ?? 0) ? endM + 1440 : endM;
          const grace = sched.isFlexible ? 0 : sched.graceMinutesEarly;
          if (outMinutes < target - grace) early = target - outMinutes;
        }
        status = late > 0 && early > 0 ? "late_and_early" : late > 0 ? "late" : early > 0 ? "early_departure" : "present";
      }
    }

    await client.query(
      `INSERT INTO attendance_daily_results
         (company_id, employee_id, work_date, shift_id, schedule_name, status, scheduled_minutes, worked_minutes, late_minutes,
          early_leave_minutes, first_in_at, last_out_at, punch_count, leave_request_id, on_duty_request_id, exceptions, source, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'evaluation',now())
       ON CONFLICT (employee_id, work_date) DO UPDATE SET
         shift_id = EXCLUDED.shift_id, schedule_name = EXCLUDED.schedule_name, status = EXCLUDED.status,
         scheduled_minutes = EXCLUDED.scheduled_minutes, worked_minutes = EXCLUDED.worked_minutes, late_minutes = EXCLUDED.late_minutes,
         early_leave_minutes = EXCLUDED.early_leave_minutes, first_in_at = EXCLUDED.first_in_at, last_out_at = EXCLUDED.last_out_at,
         punch_count = EXCLUDED.punch_count, leave_request_id = EXCLUDED.leave_request_id, on_duty_request_id = EXCLUDED.on_duty_request_id,
         exceptions = EXCLUDED.exceptions, evaluated_at = now()
       WHERE attendance_daily_results.is_overridden = false`,
      [
        companyId, employeeId, workDate, sched.scheduleId, sched.scheduleName, status, scheduledMinutes, worked, late, early,
        firstIn, lastOut, punches.rowCount, (fullLeave ?? halfLeave)?.id ?? null, onDuty.rows[0]?.id ?? null, exceptions,
      ]
    );
    return true;
  }

  // ------------------------------------------------------------------ HTTP-facing

  /** HR re-runs the evaluation for a range (e.g. after correcting punches or approving leave late). */
  async evaluate(claims: RequestClaims, input: EvaluateAttendanceRequest): Promise<{ days: number }> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "attendance.record.all"))) throw new ForbiddenException("Not permitted to run the attendance evaluation");
    if (input.to < input.from) throw new BadRequestException("`to` cannot be before `from`");
    const span = (Date.parse(input.to) - Date.parse(input.from)) / 86400000 + 1;
    if (span > MAX_RANGE_DAYS) throw new BadRequestException(`The evaluation range is limited to ${MAX_RANGE_DAYS} days`);
    const days = await this.evaluateCompany(claims.company_id!, input.from, input.to, input.employeeId);
    await this.db.withClaims(claims, (client) =>
      this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "attendance.evaluate", target: input.employeeId ?? "all", metadata: { from: input.from, to: input.to, days } })
    );
    return { days };
  }

  async list(claims: RequestClaims, filter: { employeeId: string; from: string; to: string }): Promise<AttendanceDailyResultView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.requireAccess(claims, client, filter.employeeId);
      const r = await client.query(
        `SELECT * FROM attendance_daily_results WHERE employee_id = $1 AND work_date BETWEEN $2::date AND $3::date ORDER BY work_date`,
        [filter.employeeId, filter.from, filter.to]
      );
      return r.rows.map(toView);
    });
  }

  /**
   * Team Attendance (parked B1): the people who report to the caller, with their processed-day summary for the window,
   * the status of its last day and whether they are clocked in right now. Same rule as `requireAccess`: a manager reads
   * the attendance of their own reports; nobody else's. A caller with no reports gets an empty list.
   */
  async team(claims: RequestClaims, from: string, to: string): Promise<TeamAttendanceView> {
    await this.requireModule(claims);
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(from) || !day.test(to)) throw new BadRequestException("from and to must be dates (YYYY-MM-DD)");
    if (to < from) throw new BadRequestException("to cannot be before from");
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw new BadRequestException("The window can be at most 93 days");
    return this.db.withClaims(claims, async (client) => {
      const reports = await client.query<{ id: string; first_name: string; last_name: string; employee_number: string }>(
        `SELECT e.id, e.first_name, e.last_name, e.employee_number
           FROM employees e JOIN employees m ON m.id = e.manager_id
          WHERE m.user_account_id = $1 AND e.employment_status <> 'terminated'
          ORDER BY e.first_name, e.last_name LIMIT 200`,
        [claims.sub]
      );
      const members: TeamAttendanceMember[] = [];
      for (const r of reports.rows) {
        const summary = await this.getPeriodSummary(client, r.id, from, to);
        const last = await client.query<{ status: AttendanceDailyStatus }>(
          "SELECT status FROM attendance_daily_results WHERE employee_id = $1 AND work_date = $2::date",
          [r.id, to]
        );
        const open = await client.query<{ clock_in_at: unknown }>(
          "SELECT clock_in_at FROM attendance_records WHERE employee_id = $1 AND clock_out_at IS NULL ORDER BY clock_in_at DESC LIMIT 1",
          [r.id]
        );
        members.push({
          employeeId: r.id,
          employeeName: `${r.first_name} ${r.last_name}`.trim(),
          employeeNumber: r.employee_number,
          lastDayStatus: last.rows[0]?.status ?? null,
          clockedInSince: open.rows[0] ? new Date(open.rows[0].clock_in_at as string | Date).toISOString() : null,
          summary,
        });
      }
      return { from, to, members };
    });
  }

  async summary(claims: RequestClaims, employeeId: string, from: string, to: string): Promise<AttendancePeriodSummary> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.requireAccess(claims, client, employeeId);
      return this.getPeriodSummary(client, employeeId, from, to);
    });
  }

  /** The cross-module read payroll uses: processed days only, no authorization (the caller authorizes). */
  async getPeriodSummary(client: PoolClient, employeeId: string, from: string, to: string): Promise<AttendancePeriodSummary> {
    const r = await client.query(
      `SELECT status, count(*)::int AS days, COALESCE(sum(scheduled_minutes),0)::int AS scheduled, COALESCE(sum(worked_minutes),0)::int AS worked,
              COALESCE(sum(late_minutes),0)::int AS late, COALESCE(sum(early_leave_minutes),0)::int AS early
         FROM attendance_daily_results WHERE employee_id = $1 AND work_date BETWEEN $2::date AND $3::date GROUP BY status`,
      [employeeId, from, to]
    );
    const byStatus: Record<string, number> = Object.fromEntries(DAY_STATUSES.map((s) => [s, 0]));
    const out: AttendancePeriodSummary = { employeeId, from, to, days: 0, byStatus, scheduledMinutes: 0, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0 };
    for (const row of r.rows) {
      byStatus[row.status] = row.days;
      out.days += row.days;
      out.scheduledMinutes += row.scheduled;
      out.workedMinutes += row.worked;
      out.lateMinutes += row.late;
      out.earlyLeaveMinutes += row.early;
    }
    return out;
  }

  async override(claims: RequestClaims, input: OverrideAttendanceDayRequest): Promise<AttendanceDailyResultView> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "attendance.record.all"))) throw new ForbiddenException("Not permitted to override an attendance day");
    if (!input.reason?.trim()) throw new BadRequestException("An override needs a reason");
    if (!DAY_STATUSES.includes(input.status)) throw new BadRequestException(`Unknown status "${input.status}"`);
    return this.db.withClaims(claims, async (client) => {
      const emp = await client.query("SELECT company_id FROM employees WHERE id = $1", [input.employeeId]);
      if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
      // make sure a row exists to override (evaluate it first without clobbering a previous override)
      await this.evaluateDay(client, emp.rows[0].company_id, input.employeeId, input.workDate);
      const r = await client.query(
        `INSERT INTO attendance_daily_results (company_id, employee_id, work_date, status, source, is_overridden, overridden_by_user_account_id, override_reason, overridden_at)
         VALUES ($1,$2,$3,$4,'manual_override',true,$5,$6,now())
         ON CONFLICT (employee_id, work_date) DO UPDATE SET status = EXCLUDED.status, source = 'manual_override', is_overridden = true,
           overridden_by_user_account_id = EXCLUDED.overridden_by_user_account_id, override_reason = EXCLUDED.override_reason, overridden_at = now()
         RETURNING *`,
        [emp.rows[0].company_id, input.employeeId, input.workDate, input.status, claims.sub, input.reason.trim()]
      );
      await this.audit.record(client, claims, {
        companyId: emp.rows[0].company_id,
        action: "attendance.day_override",
        target: r.rows[0].id,
        reason: input.reason.trim(),
        metadata: { employeeId: input.employeeId, workDate: input.workDate, status: input.status },
      });
      return toView(r.rows[0]);
    });
  }

  private async requireAccess(claims: RequestClaims, client: PoolClient, employeeId: string): Promise<void> {
    const emp = await client.query(
      `SELECT e.user_account_id, mgr.user_account_id AS manager_user_account_id
         FROM employees e LEFT JOIN employees mgr ON mgr.id = e.manager_id WHERE e.id = $1`,
      [employeeId]
    );
    if (emp.rowCount === 0) throw new NotFoundException("Employee not found");
    const row = emp.rows[0];
    const canSelf = row.user_account_id === claims.sub && (await this.rbac.can(claims, "attendance.record.self", { ownerId: row.user_account_id }));
    const isManager = Boolean(row.manager_user_account_id) && row.manager_user_account_id === claims.sub;
    if (!canSelf && !isManager && !(await this.rbac.can(claims, "attendance.record.all"))) {
      throw new ForbiddenException("Not permitted to view attendance for this employee");
    }
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }
}
