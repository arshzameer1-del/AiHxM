import type { LeaveBalanceUnit, ResolvedWorkScheduleView } from "@aihxm/shared-types";

/**
 * BACKLOG58 - the one place a timed (short-hours) leave request is turned into minutes.
 *
 * Pure and deterministic: everything it needs (the employee's resolved work schedule for the day, the
 * time zone, the administrator's settings) is passed in, so the frontend preview, the validate endpoint and
 * the transactional submit all produce the same number. The internal unit is whole MINUTES; the unit a leave
 * type keeps its balance in (days / hours / minutes) is applied afterwards by `toBalanceUnits`.
 *
 * Time zone and DST: the requested wall-clock times are converted to real instants in the schedule's time
 * zone and the duration is the elapsed time between them, so a request across a spring-forward / fall-back
 * night is charged for the minutes that really pass. A wall-clock time that does not exist (the skipped hour)
 * is refused as `time_does_not_exist`; an ambiguous one (the repeated hour) is read as its first occurrence.
 */

export const DEFAULT_LEAVE_TIME_ZONE = "Asia/Karachi";

export type BreakTreatment = "exclude_all" | "exclude_unpaid" | "include";

export type TimedLeaveInput = {
  /** The day the request starts on (for an overnight shift: the day the shift starts), YYYY-MM-DD. */
  date: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  schedule: Pick<ResolvedWorkScheduleView, "hasSchedule" | "startTime" | "endTime" | "crossesMidnight" | "breaks">;
  breakTreatment: BreakTreatment;
  /** Only an explicitly enabled overnight request may run past midnight (and only on a shift that does). */
  allowOvernight: boolean;
};

export type TimedLeaveErrorCode = "invalid_time_format" | "end_not_after_start" | "time_does_not_exist" | "no_minutes_left";

export type TimedLeaveBreak = { startTime: string; endTime: string; isPaid: boolean; overlapMinutes: number; excluded: boolean };

export type TimedLeaveCalculation = {
  ok: boolean;
  errors: TimedLeaveErrorCode[];
  timeZone: string;
  startAt: string | null;
  endAt: string | null;
  /** Local calendar dates of the first and last minute. */
  startDate: string;
  endDate: string;
  grossMinutes: number;
  breakMinutes: number;
  netMinutes: number;
  breaks: TimedLeaveBreak[];
  /** Minutes since midnight of the start day (can exceed 1440 for an overnight request), for window checks. */
  startOffsetMinutes: number | null;
  endOffsetMinutes: number | null;
  overnight: boolean;
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = TIME_RE.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** The time zone's local calendar date and minute-of-day at an instant. */
export function localParts(instantMs: number, timeZone: string): { date: string; minutes: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const date = `${String(get("year")).padStart(4, "0")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`;
  return { date, minutes: get("hour") * 60 + get("minute") };
}

/** Offset of the zone from UTC at an instant, in milliseconds. */
function offsetMs(instantMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the wall clock of `timeZone` reads `dateIso` + `minutesOfDay` (minutes may exceed 1440 to
 * mean the following day). Returns null when that wall-clock time does not exist (skipped by a DST jump); an
 * ambiguous time resolves to its first occurrence.
 */
export function zonedWallClockToInstant(dateIso: string, minutesOfDay: number, timeZone: string): number | null {
  const [y, mo, d] = dateIso.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, minutesOfDay, 0);
  const candidates = new Set<number>();
  for (const probe of [guess - 86400000, guess, guess + 86400000]) {
    candidates.add(guess - offsetMs(probe, timeZone));
  }
  const wantedDate = addDaysIso(dateIso, Math.floor(minutesOfDay / 1440));
  const wantedMinutes = ((minutesOfDay % 1440) + 1440) % 1440;
  const valid = [...candidates].filter((c) => {
    const p = localParts(c, timeZone);
    return p.date === wantedDate && p.minutes === wantedMinutes;
  });
  if (valid.length === 0) return null;
  return Math.min(...valid);
}

const overlapMinutes = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.round((Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 60000));

export function calculateTimedLeave(input: TimedLeaveInput): TimedLeaveCalculation {
  const empty: TimedLeaveCalculation = {
    ok: false,
    errors: [],
    timeZone: input.timeZone,
    startAt: null,
    endAt: null,
    startDate: input.date,
    endDate: input.date,
    grossMinutes: 0,
    breakMinutes: 0,
    netMinutes: 0,
    breaks: [],
    startOffsetMinutes: null,
    endOffsetMinutes: null,
    overnight: false,
  };
  const start = parseClock(input.startTime);
  const end = parseClock(input.endTime);
  if (start === null || end === null) return { ...empty, errors: ["invalid_time_format"] };

  const shiftStart = parseClock(input.schedule.startTime);
  const overnightShift = input.allowOvernight && input.schedule.hasSchedule && input.schedule.crossesMidnight && shiftStart !== null;
  // On an overnight shift the hours after midnight belong to the shift's own day: a time earlier than the shift start
  // is read as the next morning. Everywhere else both times are on the request's own calendar day.
  const toOffset = (minutes: number) => (overnightShift && minutes < (shiftStart as number) ? minutes + 1440 : minutes);
  const startOffset = toOffset(start);
  const endOffset = toOffset(end);
  if (endOffset <= startOffset) return { ...empty, errors: ["end_not_after_start"], startOffsetMinutes: startOffset, endOffsetMinutes: endOffset };

  const startMs = zonedWallClockToInstant(input.date, startOffset, input.timeZone);
  const endMs = zonedWallClockToInstant(input.date, endOffset, input.timeZone);
  if (startMs === null || endMs === null) return { ...empty, errors: ["time_does_not_exist"], startOffsetMinutes: startOffset, endOffsetMinutes: endOffset };
  if (endMs <= startMs) return { ...empty, errors: ["end_not_after_start"], startOffsetMinutes: startOffset, endOffsetMinutes: endOffset };

  const gross = Math.round((endMs - startMs) / 60000);

  // Breaks: the schedule day's break windows, placed on the same timeline as the request.
  const breaks: TimedLeaveBreak[] = [];
  let breakMinutes = 0;
  if (input.schedule.hasSchedule) {
    for (const b of input.schedule.breaks ?? []) {
      const bs = parseClock(b.startTime);
      const be = parseClock(b.endTime);
      if (bs === null || be === null) continue;
      const bsOffset = overnightShift && bs < (shiftStart as number) ? bs + 1440 : bs;
      let beOffset = overnightShift && be < (shiftStart as number) ? be + 1440 : be;
      if (beOffset <= bsOffset) beOffset += 1440;
      const bStartMs = zonedWallClockToInstant(input.date, bsOffset, input.timeZone);
      const bEndMs = zonedWallClockToInstant(input.date, beOffset, input.timeZone);
      if (bStartMs === null || bEndMs === null) continue;
      const overlap = overlapMinutes(startMs, endMs, bStartMs, bEndMs);
      const excluded = input.breakTreatment === "exclude_all" || (input.breakTreatment === "exclude_unpaid" && !b.isPaid);
      if (overlap > 0) {
        breaks.push({ startTime: formatClock(bs), endTime: formatClock(be), isPaid: b.isPaid, overlapMinutes: overlap, excluded });
        if (excluded) breakMinutes += overlap;
      }
    }
  }
  const net = gross - breakMinutes;
  if (net <= 0) {
    return { ...empty, errors: ["no_minutes_left"], grossMinutes: gross, breakMinutes, breaks, startOffsetMinutes: startOffset, endOffsetMinutes: endOffset };
  }
  const startLocal = localParts(startMs, input.timeZone);
  const endLocal = localParts(endMs, input.timeZone);
  return {
    ok: true,
    errors: [],
    timeZone: input.timeZone,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    startDate: startLocal.date,
    endDate: endLocal.date,
    grossMinutes: gross,
    breakMinutes,
    netMinutes: net,
    breaks,
    startOffsetMinutes: startOffset,
    endOffsetMinutes: endOffset,
    overnight: endLocal.date !== startLocal.date,
  };
}

/**
 * Minutes in the employee's working day on that schedule (nominal start to end, less the breaks the settings
 * exclude). Null when the day has no hours to measure (no schedule, or a day without start/end times).
 */
export function scheduledDayMinutes(schedule: Pick<ResolvedWorkScheduleView, "hasSchedule" | "startTime" | "endTime" | "breaks">, breakTreatment: BreakTreatment): number | null {
  if (!schedule.hasSchedule) return null;
  const s = parseClock(schedule.startTime);
  const e = parseClock(schedule.endTime);
  if (s === null || e === null) return null;
  let span = e - s;
  if (span <= 0) span += 1440;
  let breaks = 0;
  for (const b of schedule.breaks ?? []) {
    const bs = parseClock(b.startTime);
    const be = parseClock(b.endTime);
    if (bs === null || be === null) continue;
    let len = be - bs;
    if (len <= 0) len += 1440;
    if (breakTreatment === "exclude_all" || (breakTreatment === "exclude_unpaid" && !b.isPaid)) breaks += len;
  }
  return Math.max(0, span - breaks);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Minutes -> the unit the leave type keeps its balance in. A balance in days needs the length of a working day:
 * the administrator's "day equivalent" if one is set, otherwise the employee's own scheduled day, and only when
 * the employee has no schedule at all the documented 8-hour fallback.
 */
export const FALLBACK_DAY_MINUTES = 480;

export function toBalanceUnits(minutes: number, unit: LeaveBalanceUnit, dayMinutes: number | null): number {
  if (unit === "minutes") return minutes;
  if (unit === "hours") return round4(minutes / 60);
  const day = dayMinutes && dayMinutes > 0 ? dayMinutes : FALLBACK_DAY_MINUTES;
  return round4(minutes / day);
}

/** Human-readable duration: "1 h 30 min", "45 min". */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export function formatUnits(units: number, unit: LeaveBalanceUnit): string {
  const n = Number.isInteger(units) ? String(units) : String(round4(units));
  if (unit === "minutes") return `${n} min`;
  if (unit === "hours") return `${n} h`;
  return `${n} day${units === 1 ? "" : "s"}`;
}

/** Calendar period start (YYYY-MM-DD) containing `dateIso`: Monday for weeks. */
export function periodStart(dateIso: string, period: "day" | "week" | "month" | "year"): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (period === "day") return dateIso;
  if (period === "month") return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  if (period === "year") return `${String(y).padStart(4, "0")}-01-01`;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysIso(dateIso, -((dow + 6) % 7));
}

export function periodEnd(dateIso: string, period: "day" | "week" | "month" | "year"): string {
  const start = periodStart(dateIso, period);
  const [y, m, d] = start.split("-").map(Number);
  if (period === "day") return start;
  if (period === "week") return addDaysIso(start, 6);
  if (period === "month") return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  void d;
  return `${String(y).padStart(4, "0")}-12-31`;
}
