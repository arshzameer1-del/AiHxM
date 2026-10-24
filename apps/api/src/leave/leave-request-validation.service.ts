import { BadRequestException, ConflictException, HttpException, Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { WorkflowService } from "../workflow/workflow.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { LeaveDurationSettingsService } from "./leave-duration-settings.service";
import { LeaveValidationRulesService } from "./leave-validation-rules.service";
import { resolveEntitlement } from "./leave-entitlements.repo";
import { evaluateValidation, type BalanceFacts, type ValidationFacts } from "./leave-validation.engine";
import {
  DEFAULT_LEAVE_TIME_ZONE,
  FALLBACK_DAY_MINUTES,
  addDaysIso,
  calculateTimedLeave,
  localParts,
  parseClock,
  periodEnd,
  periodStart,
  scheduledDayMinutes,
  toBalanceUnits,
  zonedWallClockToInstant,
  type TimedLeaveCalculation,
} from "./leave-time";
import type {
  AccrualMethod,
  LeaveBalanceUnit,
  LeaveDurationSettingsView,
  LeaveTypeView,
  LeaveValidationResult,
  LeaveValidationRuleView,
  ResolvedWorkScheduleView,
} from "@aihxm/shared-types";

const WORKFLOW_TEMPLATE_KEY = "leave_request";
const WORKFLOW_OBJECT_KEY = "leave_request";
const MAX_RANGE_DAYS = 366;
const LOCK_TIMEOUT = "5s";

export type ValidationEmployee = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  department: string | null;
  org_unit_id?: string | null;
  gender?: string | null;
  employment_type?: string | null;
  date_of_joining?: string | Date | null;
};

export type ValidationInput = {
  startDate: string;
  endDate: string;
  dayPart: "full" | "first_half" | "second_half" | "hours";
  startTime?: string | null;
  endTime?: string | null;
  reason?: string | null;
  attachmentDocumentId?: string | null;
  delegateEmployeeId?: string | null;
  acknowledgedWarnings?: string[];
  locale?: string;
};

/** Everything the request row is written with once validation passes. */
export type PricedRequest = {
  /** Working days the request charges (a timed request: its day equivalent, never 0). Written to days_requested. */
  daysRequested: number;
  balanceUnits: number;
  balanceUnit: LeaveBalanceUnit;
  timed: TimedLeaveCalculation | null;
  settings: LeaveDurationSettingsView;
  policyId: string | null;
  templateKey: string;
  year: number;
  /** The facts and outcome this request was accepted under; stored on the row so later rule changes never rewrite it. */
  snapshot: Record<string, unknown>;
};

export type EvaluatedRequest = { result: LeaveValidationResult; priced: PricedRequest | null };

/** What the response body of a refused request carries: a readable `message` (the first blocking one) plus the full validation result. */
function validationBody(validation: LeaveValidationResult, statusCode: number, error: string) {
  const blocking = validation.blocking[0];
  const warning = validation.warnings.find((w) => !validation.acknowledged.includes(w.ruleCode));
  return {
    statusCode,
    error,
    code: blocking ? "LEAVE_VALIDATION_FAILED" : "LEAVE_WARNINGS_UNACKNOWLEDGED",
    message: blocking?.message ?? warning?.message ?? "The leave request could not be validated",
    validation,
  };
}

/** A 400 carrying the full validation result next to a readable message. */
export class LeaveValidationException extends BadRequestException {
  constructor(public readonly validation: LeaveValidationResult) {
    super(validationBody(validation, 400, "Bad Request"));
  }
}

/** A 409: a double booking, or a warning the employee has not confirmed yet. */
export class LeaveValidationConflictException extends ConflictException {
  constructor(public readonly validation: LeaveValidationResult) {
    super(validationBody(validation, 409, "Conflict"));
  }
}

export function leaveValidationError(validation: LeaveValidationResult): HttpException {
  const conflict = validation.blocking.length > 0 ? validation.blocking.some((b) => b.code === "overlaps_existing_request") : true;
  return conflict ? new LeaveValidationConflictException(validation) : new LeaveValidationException(validation);
}

const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * BACKLOG58 - one pipeline for "is this leave request acceptable, and what does it cost?", used by the preview
 * endpoint, by submit and by edit, so what the form shows is exactly what the server enforces.
 *
 * Order: resolve schedule / time zone / settings -> request form and times -> duration -> balance, reservations,
 * overlaps, limits -> eligibility, policy, workflow -> the configured rules decide severity and wording. When
 * `lock` is set (submit / edit) the employee's leave is serialised with an advisory lock first, so two requests
 * made at the same moment are judged one after the other, each seeing the other's reservation.
 */
@Injectable()
export class LeaveRequestValidationService {
  private readonly logger = new Logger(LeaveRequestValidationService.name);

  constructor(
    private readonly workSchedule: WorkScheduleResolutionService,
    private readonly ledger: LeaveLedgerService,
    private readonly settingsService: LeaveDurationSettingsService,
    private readonly rulesService: LeaveValidationRulesService,
    private readonly workflow: WorkflowService
  ) {}

  async evaluate(
    client: PoolClient,
    claims: RequestClaims,
    p: {
      employee: ValidationEmployee;
      leaveType: LeaveTypeView;
      policyId: string | null;
      input: ValidationInput;
      excludeRequestId?: string;
      lock?: boolean;
      now?: Date;
      /** An unsaved rule to evaluate alongside (or instead of, when it carries a stored rule's code) the stored ones. */
      draftRule?: LeaveValidationRuleView;
    }
  ): Promise<EvaluatedRequest> {
    const { employee, leaveType, input } = p;
    const now = p.now ?? new Date();
    const companyId = employee.company_id;
    const isTimed = input.dayPart === "hours";

    // --- serialise this employee's leave decisions
    let lockFailed = false;
    if (p.lock) {
      await client.query("SAVEPOINT leave_lock");
      try {
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 58))", [`leave:${employee.id}`]);
        await client.query("RELEASE SAVEPOINT leave_lock");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT leave_lock");
        await client.query("RELEASE SAVEPOINT leave_lock");
        if ((err as { code?: string }).code !== "55P03") throw err;
        lockFailed = true;
      }
    }

    const settings = await this.settingsService.resolveEffective(client, companyId, leaveType.code, p.policyId);
    const [schedule, companyTz] = await Promise.all([
      this.workSchedule.resolve(client, employee.id, input.startDate),
      client.query<{ timezone: string }>("SELECT timezone FROM companies WHERE id = $1", [companyId]),
    ]);
    const timeZone = schedule.timezone ?? companyTz.rows[0]?.timezone ?? DEFAULT_LEAVE_TIME_ZONE;
    const today = localParts(now.getTime(), timeZone).date;

    // --- the form of the request
    const structuralErrors: string[] = [];
    const timedModes = new Set(["short_hours", "hourly", "flexible_partial"]);
    const supportsTimed = timedModes.has(leaveType.durationMode);
    if (input.endDate < input.startDate) structuralErrors.push("The end date cannot be before the start date.");
    if (isTimed) {
      if (!supportsTimed) structuralErrors.push(`${leaveType.name} cannot be requested by the hour.`);
      if (input.startDate !== input.endDate) structuralErrors.push("A request by hours is for one date: pick the date and the start and end times.");
    } else {
      if (leaveType.durationMode === "short_hours" || leaveType.durationMode === "hourly") {
        structuralErrors.push(`${leaveType.name} is requested by the hour: pick a date and a start and end time.`);
      }
      if (input.dayPart !== "full") {
        if (!leaveType.halfDayAllowed) structuralErrors.push(`${leaveType.name} cannot be taken as a half day`);
        if (input.startDate !== input.endDate) structuralErrors.push("A half-day leave request must start and end on the same date");
      }
    }
    if (!isTimed && daysBetween(input.startDate, input.endDate) + 1 > MAX_RANGE_DAYS) structuralErrors.push("A leave request can cover at most one year.");

    // --- duration
    const calc: TimedLeaveCalculation | null =
      isTimed && supportsTimed && input.startDate === input.endDate
        ? calculateTimedLeave({
            date: input.startDate,
            startTime: input.startTime ?? "",
            endTime: input.endTime ?? "",
            timeZone,
            schedule,
            breakTreatment: settings.breakTreatment,
            allowOvernight: settings.allowOvernight,
          })
        : null;
    const dayMinutes = settings.dayEquivalentMinutes ?? scheduledDayMinutes(schedule, settings.breakTreatment);
    const unit = leaveType.balanceUnit;

    // --- working days / holidays across the range
    const restDates: string[] = [];
    const holidays: Array<{ date: string; name: string }> = [];
    let chargeableDays = 0;
    let dayBasedMinutes = 0;
    const scheduleByDate = new Map<string, ResolvedWorkScheduleView>([[input.startDate, schedule]]);
    const lastDate = isTimed || structuralErrors.some((e) => e.startsWith("The end date") || e.startsWith("A leave request can cover")) ? input.startDate : input.endDate;
    for (let cursor = input.startDate; cursor <= lastDate; cursor = addDaysIso(cursor, 1)) {
      let day = scheduleByDate.get(cursor);
      if (!day) {
        day = await this.workSchedule.resolve(client, employee.id, cursor);
        scheduleByDate.set(cursor, day);
      }
      if (day.isMandatoryHoliday) holidays.push({ date: cursor, name: day.holidayName ?? "public holiday" });
      else if (!day.isWorking) restDates.push(cursor);
      else {
        const share = !isTimed && input.dayPart !== "full" ? 0.5 : 1;
        chargeableDays += share;
        if (unit !== "days" && !isTimed) dayBasedMinutes += (settings.dayEquivalentMinutes ?? scheduledDayMinutes(day, settings.breakTreatment) ?? FALLBACK_DAY_MINUTES) * share;
      }
    }

    let durationMinutes: number | null = null;
    let requestedUnits = 0;
    let daysRequested = 0;
    let daysEquivalent = 0;
    if (isTimed) {
      if (calc?.ok) {
        durationMinutes = calc.netMinutes;
        requestedUnits = toBalanceUnits(calc.netMinutes, unit, dayMinutes);
        daysEquivalent = Math.max(0.01, round2(toBalanceUnits(calc.netMinutes, "days", dayMinutes)));
        daysRequested = chargeableDays > 0 ? daysEquivalent : 0;
        if (chargeableDays === 0) requestedUnits = 0;
      }
    } else {
      daysRequested = chargeableDays;
      daysEquivalent = chargeableDays;
      requestedUnits = unit === "days" ? chargeableDays : toBalanceUnits(Math.round(dayBasedMinutes), unit, 1);
    }

    // --- supporting document / relief person must belong to this company (integrity, not configurable)
    if (input.attachmentDocumentId) {
      const doc = await client.query("SELECT 1 FROM employee_documents WHERE id = $1 AND employee_id = $2", [input.attachmentDocumentId, employee.id]);
      if (doc.rowCount === 0) throw new BadRequestException("The attached document does not belong to this employee");
    }
    if (input.delegateEmployeeId) {
      if (input.delegateEmployeeId === employee.id) throw new BadRequestException("An employee cannot delegate to themselves");
      const delegate = await client.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2", [input.delegateEmployeeId, companyId]);
      if (delegate.rowCount === 0) throw new BadRequestException("Delegate employee not found");
    }

    // --- policy, entitlement, balance
    const year = Number(input.startDate.slice(0, 4));
    const policy = { required: leaveType.tracksBalance, assigned: Boolean(p.policyId), entitlementMissing: false, policyId: p.policyId };
    let balance: BalanceFacts | "unavailable" | null = null;
    if (leaveType.tracksBalance && p.policyId) {
      const entitlement = await resolveEntitlement(client, p.policyId, leaveType.code);
      if (!entitlement) {
        policy.entitlementMissing = true;
      } else if (lockFailed) {
        balance = "unavailable";
      } else {
        balance = await this.readBalance(client, employee, leaveType, year, entitlement.days, entitlement.accrualMethod ?? leaveType.accrualMethod, p.excludeRequestId);
      }
    }

    // --- eligibility
    const eligibility = this.eligibilityProblems(leaveType, employee, input.startDate);

    // --- overlaps
    const overlapCount = await this.countOverlaps(client, employee.id, input, calc, schedule, p.excludeRequestId);

    // --- limits / frequency
    const limits = await this.readLimits(client, employee.id, leaveType.code, input.startDate, p.excludeRequestId);

    // --- notice / backdating
    const startInstant = isTimed ? (calc?.startAt ? Date.parse(calc.startAt) : null) : zonedWallClockToInstant(input.startDate, 0, timeZone);
    const notice = {
      minutesUntilStart: startInstant === null ? null : Math.floor((startInstant - now.getTime()) / 60000),
      startInPast: startInstant !== null && startInstant < now.getTime(),
      daysBack: daysBetween(input.startDate, today),
    };

    // --- shift / attendance
    const shift = this.shiftWindow(schedule);
    const withinShift =
      isTimed && calc?.ok && shift && schedule.isWorking && !schedule.isMandatoryHoliday
        ? (calc.startOffsetMinutes as number) >= shift.start && (calc.endOffsetMinutes as number) <= shift.end
        : null;
    let attendanceConflict = false;
    if (isTimed && calc?.ok && calc.startAt && calc.endAt) {
      const a = await client.query(
        `SELECT 1 FROM attendance_records
          WHERE employee_id = $1 AND approval_state <> 'rejected' AND clock_in_at < $3::timestamptz AND COALESCE(clock_out_at, $4::timestamptz) > $2::timestamptz LIMIT 1`,
        [employee.id, calc.startAt, calc.endAt, now.toISOString()]
      );
      attendanceConflict = (a.rowCount ?? 0) > 0;
    }

    // --- approval route
    const templateKey = settings.workflowTemplateKey ?? WORKFLOW_TEMPLATE_KEY;
    let workflowFacts = { resolvable: true, detail: null as string | null };
    if (employee.user_account_id) {
      const record = this.workflowRecord(leaveType, employee, input, daysRequested, durationMinutes, requestedUnits);
      workflowFacts = await this.workflow.checkRoutable(client, claims, templateKey, WORKFLOW_OBJECT_KEY, { subjectUserAccountId: employee.user_account_id, record }).then((r) => ({ resolvable: r.routable, detail: r.detail }));
    }

    // --- groups, then the engine
    const groups = await client.query<{ group_id: string }>(
      `SELECT group_id FROM employee_group_memberships WHERE employee_id = $1 AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`,
      [employee.id]
    );
    const shiftLabel = shift ? `${schedule.startTime?.slice(0, 5)}-${schedule.endTime?.slice(0, 5)}` : null;
    const [y, m, d] = input.startDate.split("-").map(Number);
    const facts: ValidationFacts = {
      requestStartDate: input.startDate,
      leaveType: {
        code: leaveType.code,
        name: leaveType.name,
        maxConsecutiveDays: leaveType.maxConsecutiveDays,
        documentRequired: leaveType.documentRequired,
        documentRequiredAfterDays: leaveType.documentRequiredAfterDays,
        tracksBalance: leaveType.tracksBalance,
      },
      isTimed,
      balanceUnit: unit,
      settings,
      structuralErrors,
      calc: isTimed
        ? calc
          ? { errors: calc.errors, startOffset: calc.startOffsetMinutes, endOffset: calc.endOffsetMinutes, grossMinutes: calc.grossMinutes }
          : { errors: [], startOffset: null, endOffset: null, grossMinutes: 0 }
        : null,
      request: {
        startDate: input.startDate,
        endDate: input.endDate,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        durationMinutes,
        requestedUnits,
        daysRequested,
        daysEquivalent,
        reasonLength: (input.reason ?? "").trim().length,
        hasAttachment: Boolean(input.attachmentDocumentId),
        dayOfWeek: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
      },
      balance,
      policy,
      eligibility,
      overlapCount,
      schedule: {
        hasSchedule: schedule.hasSchedule,
        chargeableDays,
        restDates,
        holidays,
        shiftWindow: shiftLabel,
        withinShift,
      },
      notice,
      limits,
      employee: { employmentType: employee.employment_type ?? null, groupIds: groups.rows.map((g) => g.group_id), policyId: p.policyId },
      attendanceConflict,
      workflow: workflowFacts,
    };

    let rules = await this.rulesService.loadAll(client, companyId);
    if (p.draftRule) rules = [...rules.filter((r) => r.code !== p.draftRule!.code), p.draftRule];
    const verdict = evaluateValidation(facts, rules, { locale: input.locale, acknowledgedWarnings: input.acknowledgedWarnings });

    const duration = isTimed && calc?.ok
      ? {
          timeZone,
          startAt: calc.startAt,
          endAt: calc.endAt,
          startDate: calc.startDate,
          endDate: calc.endDate,
          grossMinutes: calc.grossMinutes,
          breakMinutes: calc.breakMinutes,
          durationMinutes: calc.netMinutes,
          breaks: calc.breaks,
          balanceUnit: unit,
          balanceUnits: requestedUnits,
          daysEquivalent,
          scheduleName: schedule.scheduleName,
          scheduleStartTime: schedule.startTime?.slice(0, 5) ?? null,
          scheduleEndTime: schedule.endTime?.slice(0, 5) ?? null,
        }
      : null;

    const result: LeaveValidationResult = {
      ...verdict,
      duration,
      balance: balance && balance !== "unavailable" ? balance : null,
      settings: leaveType.durationMode === "full_day" || leaveType.durationMode === "half_day" ? (settings.id ? settings : null) : settings,
      approvers: [],
    };

    const priced: PricedRequest | null = verdict.canSubmit
      ? {
          daysRequested,
          balanceUnits: requestedUnits,
          balanceUnit: unit,
          timed: isTimed ? calc : null,
          settings,
          policyId: p.policyId,
          templateKey,
          year,
          snapshot: {
            evaluatedAt: now.toISOString(),
            timeZone,
            settings,
            durationMode: leaveType.durationMode,
            duration,
            balance: result.balance,
            findings: [...verdict.warnings, ...verdict.info],
            acknowledgedWarnings: verdict.acknowledged,
            ruleVersions: rules.filter((r) => r.isActive).map((r) => `${r.code}@${r.version}`),
            workflowTemplateKey: templateKey,
          },
        }
      : null;
    return { result, priced };
  }

  /** Workflow `record` for a leave request: the routing conditions can use the size of the request in days, minutes and balance units. */
  workflowRecord(leaveType: LeaveTypeView, employee: ValidationEmployee, input: ValidationInput, daysRequested: number, durationMinutes: number | null, balanceUnits: number): Record<string, unknown> {
    return {
      leaveType: leaveType.code,
      daysRequested,
      durationMinutes,
      balanceUnits,
      isTimed: input.dayPart === "hours",
      department: employee.department,
      orgUnitId: employee.org_unit_id ?? null,
    };
  }

  private eligibilityProblems(type: LeaveTypeView, employee: ValidationEmployee, startDate: string): string[] {
    const problems: string[] = [];
    if (!type.isActive) problems.push(`Leave type "${type.code}" is not available - ask HR to enable it`);
    if (type.genderRestriction !== "any") {
      const gender = (employee.gender ?? "").toLowerCase();
      if (gender !== type.genderRestriction) problems.push(`${type.name} is only available to ${type.genderRestriction} employees`);
    }
    if (type.minServiceMonths > 0) {
      const joined = employee.date_of_joining ? (typeof employee.date_of_joining === "string" ? employee.date_of_joining.slice(0, 10) : employee.date_of_joining.toISOString().slice(0, 10)) : null;
      if (!joined) {
        problems.push(`${type.name} needs ${type.minServiceMonths} month(s) of service, but this employee has no joining date`);
      } else {
        const [jy, jm, jd] = joined.split("-").map(Number);
        const [sy, sm, sd] = startDate.split("-").map(Number);
        const months = (sy - jy) * 12 + (sm - jm) - (sd < jd ? 1 : 0);
        if (months < type.minServiceMonths) problems.push(`${type.name} needs ${type.minServiceMonths} month(s) of service`);
      }
    }
    return problems;
  }

  /** Entitled / used / what pending requests already hold, in the leave type's unit. Any failure reads as "balance unavailable". */
  private async readBalance(
    client: PoolClient,
    employee: ValidationEmployee,
    leaveType: LeaveTypeView,
    year: number,
    entitlementDays: number,
    method: AccrualMethod,
    excludeRequestId?: string
  ): Promise<BalanceFacts | "unavailable"> {
    await client.query("SAVEPOINT leave_balance");
    try {
      const row = await this.ledger.ensureBalance(client, employee.company_id, employee.id, leaveType.code, year, { days: entitlementDays, method });
      const reserved = await client.query(
        `SELECT COALESCE(SUM(COALESCE(balance_units, days_requested)), 0) AS held FROM leave_requests
          WHERE employee_id = $1 AND leave_type = $2 AND status = 'pending' AND EXTRACT(YEAR FROM start_date) = $3 AND ($4::uuid IS NULL OR id <> $4)`,
        [employee.id, leaveType.code, year, excludeRequestId ?? null]
      );
      await client.query("RELEASE SAVEPOINT leave_balance");
      const entitled = Number(row.entitled_days);
      const used = Number(row.used_days);
      const held = Number(reserved.rows[0].held);
      return { unit: leaveType.balanceUnit, entitled, used, reserved: held, available: Math.round((entitled - used - held) * 10000) / 10000, year };
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT leave_balance");
      await client.query("RELEASE SAVEPOINT leave_balance");
      this.logger.warn(`Leave balance could not be read for employee ${employee.id}: ${(err as Error).message}`);
      return "unavailable";
    }
  }

  /** Pending/approved requests that collide with this one: whole days, halves of a day and timed requests each against their own span. */
  private async countOverlaps(
    client: PoolClient,
    employeeId: string,
    input: ValidationInput,
    calc: TimedLeaveCalculation | null,
    schedule: ResolvedWorkScheduleView,
    excludeRequestId?: string
  ): Promise<number> {
    const lastDate = input.dayPart === "hours" ? (calc?.endDate ?? input.startDate) : input.endDate;
    if (lastDate < input.startDate) return 0;
    const others = await client.query(
      `SELECT id, day_part, start_date, end_date, start_at, end_at FROM leave_requests
        WHERE employee_id = $1 AND status IN ('pending', 'approved') AND start_date <= $3 AND end_date >= $2 AND ($4::uuid IS NULL OR id <> $4)`,
      [employeeId, input.startDate, lastDate, excludeRequestId ?? null]
    );
    const half = this.halfWindows(schedule);
    let count = 0;
    for (const o of others.rows) {
      const part: string = o.day_part ?? "full";
      if (input.dayPart === "hours") {
        if (part === "full") count++;
        else if (part === "hours") {
          if (calc?.startAt && calc.endAt && o.start_at && o.end_at && o.start_at < new Date(calc.endAt) && o.end_at > new Date(calc.startAt)) count++;
        } else {
          // a half day blocks the matching half of the shift; without a schedule to place it, any timed request that day collides
          const w = half?.[part as "first_half" | "second_half"];
          if (!w || !calc || calc.startOffsetMinutes === null || calc.endOffsetMinutes === null) count++;
          else if (calc.startOffsetMinutes < w.end && calc.endOffsetMinutes > w.start) count++;
        }
      } else if (input.dayPart === "full") {
        count++;
      } else if (part === "full") {
        count++;
      } else if (part === "hours") {
        const w = half?.[input.dayPart as "first_half" | "second_half"];
        const tz = schedule.timezone ?? DEFAULT_LEAVE_TIME_ZONE;
        const os = o.start_at ? localParts(new Date(o.start_at).getTime(), tz).minutes : null;
        const oe = o.end_at ? localParts(new Date(o.end_at).getTime(), tz).minutes : null;
        if (!w || os === null || oe === null || (os < w.end && oe > w.start)) count++;
      } else if (part === input.dayPart) {
        count++;
      }
    }
    return count;
  }

  private shiftWindow(schedule: ResolvedWorkScheduleView): { start: number; end: number } | null {
    if (!schedule.hasSchedule) return null;
    const start = parseClock(schedule.isFlexible ? (schedule.flexibleStartTime ?? schedule.startTime) : schedule.startTime);
    let end = parseClock(schedule.isFlexible ? (schedule.flexibleEndTime ?? schedule.endTime) : schedule.endTime);
    if (start === null || end === null) return null;
    if (end <= start) end += 1440;
    return { start, end };
  }

  private halfWindows(schedule: ResolvedWorkScheduleView): { first_half: { start: number; end: number }; second_half: { start: number; end: number } } | null {
    const w = this.shiftWindow(schedule);
    if (!w) return null;
    const mid = w.start + Math.floor((w.end - w.start) / 2);
    return { first_half: { start: w.start, end: mid }, second_half: { start: mid, end: w.end } };
  }

  private async readLimits(client: PoolClient, employeeId: string, leaveType: string, startDate: string, excludeRequestId?: string) {
    const periods = (["day", "week", "month", "year"] as const).map((period) => ({ period, from: periodStart(startDate, period), to: periodEnd(startDate, period) }));
    const r = await client.query(
      `SELECT
          COALESCE(SUM(duration_minutes) FILTER (WHERE day_part = 'hours' AND start_date = $3::date), 0)::int AS day_minutes,
          COALESCE(SUM(duration_minutes) FILTER (WHERE day_part = 'hours' AND start_date BETWEEN $8::date AND $9::date), 0)::int AS month_minutes,
          COUNT(*) FILTER (WHERE start_date BETWEEN $4::date AND $5::date)::int AS day_count,
          COUNT(*) FILTER (WHERE start_date BETWEEN $6::date AND $7::date)::int AS week_count,
          COUNT(*) FILTER (WHERE start_date BETWEEN $8::date AND $9::date)::int AS month_count,
          COUNT(*) FILTER (WHERE start_date BETWEEN $10::date AND $11::date)::int AS year_count
         FROM leave_requests
        WHERE employee_id = $1 AND leave_type = $2 AND status IN ('pending', 'approved') AND ($12::uuid IS NULL OR id <> $12)`,
      [employeeId, leaveType, startDate, periods[0].from, periods[0].to, periods[1].from, periods[1].to, periods[2].from, periods[2].to, periods[3].from, periods[3].to, excludeRequestId ?? null]
    );
    const row = r.rows[0];
    return {
      dayUsedMinutes: row.day_minutes as number,
      monthUsedMinutes: row.month_minutes as number,
      periodCounts: { day: row.day_count as number, week: row.week_count as number, month: row.month_count as number, year: row.year_count as number },
    };
  }
}

