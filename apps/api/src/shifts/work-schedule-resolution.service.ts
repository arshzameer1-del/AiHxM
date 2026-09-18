import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { HolidaysService } from "../holidays/holidays.service";
import { ShiftsService, computeAttendanceStatus, dayOfWeekForIsoDate } from "./shifts.service";
import type { AttendanceStatus, ResolvedWorkScheduleView, WorkScheduleBreakView } from "@boostfactor/shared-types";

/**
 * The single cross-module schedule-resolution entry point Section 20 of
 * the Work Schedule & Employee Schedule Assignment Architecture
 * (claude/aihxm-work-schedule-architecture.md) names —
 * `WorkScheduleResolutionService` — composed from `ShiftsService` (which
 * owns "which schedule applies, and via what assignment source" —
 * `resolveForEmployeeOnDate()`, extended 2026-09-18 with the rule tier)
 * and `HolidaysService` (which owns "is this date a holiday"). Neither of
 * those two services gained a dependency on the other; this class exists
 * so the composition happens in exactly one place rather than every
 * caller re-joining "resolved shift + that day's weekly pattern + is it
 * a holiday" by hand — the same "don't duplicate schedule logic in every
 * consumer" rule Section 35 states explicitly.
 *
 * Every method here either takes an already-open `client` (the
 * cross-service-call shape `ShiftsService.resolveForEmployeeOnDate`
 * already established, for AttendanceService/LeaveRequestsService to
 * call from inside their own transaction) or opens one itself via
 * `withClaims` for the HTTP-facing `getEffectiveSchedule`.
 */
@Injectable()
export class WorkScheduleResolutionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly shifts: ShiftsService,
    private readonly holidays: HolidaysService
  ) {}

  /** HTTP-facing: Section 36's `GET /employees/:id/work-schedule?date=`. Authorization is the exact same self/team/all check `getCurrentShift`/`getAssignmentHistory` already use — a schedule is exactly the kind of employee-scoped fact those already gate. */
  async getEffectiveSchedule(claims: RequestClaims, employeeId: string, dateIso: string): Promise<ResolvedWorkScheduleView> {
    return this.db.withClaims(claims, async (client) => {
      await this.shifts.requireViewAccess(claims, client, employeeId);
      return this.resolve(client, employeeId, dateIso);
    });
  }

  /** Cross-module entry point, already-open transaction — same shape as `ShiftsService.resolveForEmployeeOnDate`. */
  async resolve(client: PoolClient, employeeId: string, dateIso: string): Promise<ResolvedWorkScheduleView> {
    const resolved = await this.shifts.resolveForEmployeeOnDate(client, employeeId, dateIso);
    if (!resolved) {
      // No schedule configured at all for this tenant/employee — the
      // "no_shift_assigned" case AttendanceStatus already names as
      // deliberately not an error (most SMB pilots won't configure Shift
      // Management on day one). Every day defaults to "working" so
      // nothing downstream (Leave's day-count, notably) starts silently
      // rejecting requests just because Work Schedule hasn't been set up.
      //
      // The holiday calendar is STILL checked here, deliberately: Leave's
      // mandatory-holiday exclusion (shipped before this architecture
      // existed) never depended on Shift Management being configured, and
      // isWorkingDay() below composes `isWorking && !isMandatoryHoliday`
      // uniformly regardless of `hasSchedule` — an early "no schedule,
      // skip the holiday check too" return here would have silently
      // regressed that already-shipped, already-tested behavior for
      // every tenant that hasn't configured Work Schedule yet (a real bug
      // this increment's own regression suite caught before this
      // comment/fix existed — see the roadmap doc's verification note).
      const employeeRow = await client.query<{ company_id: string }>("SELECT company_id FROM employees WHERE id = $1", [
        employeeId,
      ]);
      const holiday =
        (employeeRow.rowCount ?? 0) > 0
          ? await this.holidays.getHolidayOnDate(client, employeeRow.rows[0].company_id, dateIso)
          : null;
      return {
        date: dateIso,
        hasSchedule: false,
        scheduleId: null,
        scheduleName: null,
        scheduleType: null,
        timezone: null,
        assignmentSource: null,
        assignmentRuleName: null,
        isWorking: true,
        isHalfDay: false,
        startTime: null,
        endTime: null,
        crossesMidnight: false,
        isFlexible: false,
        flexibleStartTime: null,
        flexibleEndTime: null,
        coreStartTime: null,
        coreEndTime: null,
        breaks: [],
        graceMinutesLate: 0,
        graceMinutesEarly: 0,
        isHoliday: holiday !== null,
        isMandatoryHoliday: holiday !== null && !holiday.isOptional,
        holidayName: holiday?.name ?? null,
      };
    }

    const dayOfWeek = dayOfWeekForIsoDate(dateIso);
    const dayResult = await client.query(
      "SELECT * FROM work_schedule_days WHERE shift_id = $1 AND day_of_week = $2",
      [resolved.shiftId, dayOfWeek]
    );
    // Every shift has all 7 days populated — either by 0037's backfill
    // (pre-existing shifts) or by ShiftsService.createShift's own
    // immediate 7-day seed (every shift created since) — but a schedule
    // reached via the default-fallback branch could in principle predate
    // both if a migration was ever skipped in a stale environment, so
    // this still degrades to "working, using the shift's own top-level
    // hours" rather than throwing, matching the tolerant style
    // `resolveForEmployeeOnDate` itself already uses for its own
    // fallback branch.
    const day = dayResult.rows[0];

    let breaks: WorkScheduleBreakView[] = [];
    if (day) {
      const breakResult = await client.query(
        "SELECT * FROM work_schedule_breaks WHERE work_schedule_day_id = $1 ORDER BY start_time",
        [day.id]
      );
      breaks = breakResult.rows.map((b) => ({ id: b.id, startTime: b.start_time, endTime: b.end_time, isPaid: b.is_paid }));
    }

    const holiday = await this.holidays.getHolidayOnDate(client, resolved.companyId, dateIso);

    return {
      date: dateIso,
      hasSchedule: true,
      scheduleId: resolved.shiftId,
      scheduleName: resolved.shiftName,
      scheduleType: resolved.scheduleType as ResolvedWorkScheduleView["scheduleType"],
      timezone: resolved.timezone,
      assignmentSource: resolved.assignmentSource,
      assignmentRuleName: resolved.assignmentRuleName,
      isWorking: day ? day.is_working : true,
      isHalfDay: day ? day.is_half_day : false,
      startTime: day ? day.start_time : resolved.startTime,
      endTime: day ? day.end_time : resolved.endTime,
      crossesMidnight: resolved.crossesMidnight,
      isFlexible: day ? day.is_flexible : false,
      flexibleStartTime: day?.flexible_start_time ?? null,
      flexibleEndTime: day?.flexible_end_time ?? null,
      coreStartTime: day?.core_start_time ?? null,
      coreEndTime: day?.core_end_time ?? null,
      breaks,
      graceMinutesLate: resolved.graceMinutesLate,
      graceMinutesEarly: resolved.graceMinutesEarly,
      isHoliday: holiday !== null,
      isMandatoryHoliday: holiday !== null && !holiday.isOptional,
      holidayName: holiday?.name ?? null,
    };
  }

  /**
   * `isWorkingDay` per Section 20 — the one method LeaveRequestsService
   * needs to close the "no business-day/weekend exclusion" half of
   * KNOWN_ISSUES.md's leave-day-count entry (the mandatory-holiday half
   * closed 2026-09-18, before this architecture existed). A day counts
   * as a leave day only if the employee's resolved weekly pattern marks
   * it a working day AND it isn't a mandatory company holiday — an
   * optional holiday does NOT exclude a day here, same reasoning
   * `HolidaysService.countMandatoryHolidaysInRange` already documents.
   */
  async isWorkingDay(client: PoolClient, employeeId: string, dateIso: string): Promise<boolean> {
    const resolved = await this.resolve(client, employeeId, dateIso);
    // Uniform regardless of `hasSchedule` — see resolve()'s own no-schedule
    // branch doc comment for why the holiday check must not be skipped
    // just because Work Schedule isn't configured yet.
    return resolved.isWorking && !resolved.isMandatoryHoliday;
  }

  /**
   * The single place Attendance's on-time/late/early/rest-day/holiday
   * status is decided (Section 21: "Do not duplicate schedule logic
   * inside Attendance") — replaces the old
   * `computeAttendanceStatus(clockInAt, clockOutAt, shiftLevelFields)`
   * call site in `attendance.service.ts`, which compared every punch
   * against the SHIFT's flat start/end time regardless of day-of-week.
   * That was a real, if latent, bug relative to this architecture: a
   * weekly pattern marking Friday off would still have flagged a
   * Friday-morning clock-in as "late" against Monday's start time,
   * because nothing before this consulted the day itself.
   */
  async resolveAttendanceStatus(
    client: PoolClient,
    employeeId: string,
    dateIso: string,
    clockInAt: Date,
    clockOutAt: Date | null
  ): Promise<{ status: AttendanceStatus; shiftName: string | null }> {
    const resolved = await this.resolve(client, employeeId, dateIso);
    if (!resolved.hasSchedule) {
      return { status: "no_shift_assigned", shiftName: null };
    }
    if (resolved.isMandatoryHoliday) {
      return { status: "holiday", shiftName: resolved.scheduleName };
    }
    if (!resolved.isWorking) {
      return { status: "rest_day", shiftName: resolved.scheduleName };
    }
    const status = computeAttendanceStatus(clockInAt, clockOutAt, {
      startTime: resolved.startTime!,
      endTime: resolved.endTime!,
      graceMinutesLate: resolved.graceMinutesLate,
      graceMinutesEarly: resolved.graceMinutesEarly,
    });
    return { status, shiftName: resolved.scheduleName };
  }
}
