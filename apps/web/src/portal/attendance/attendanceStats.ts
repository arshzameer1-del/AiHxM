import type { DayRow } from "./attendanceDays";
import { stripDays } from "./attendanceDays";

/** Everything the Time & Attendance overview shows, worked out from the day rows the attendance hook already has. */

const DAY_MIN = 8 * 60;
export const WEEK_TARGET_MINUTES = 5 * DAY_MIN;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday. */
function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function mondayOf(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

export type WeekHours = {
  workedMinutes: number;
  targetMinutes: number;
  remainingMinutes: number;
  /** What is still to do each remaining working day (today counts while the week is not over). */
  perRemainingDayMinutes: number;
  /** 0..1, capped. */
  fraction: number;
};

/** Hours this week against the 40 h target (Monday to Friday are the working days). */
export function weekHours(days: Map<string, DayRow>, today: string, targetMinutes = WEEK_TARGET_MINUTES): WeekHours {
  const monday = mondayOf(today);
  let worked = 0;
  let remainingDays = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    if (d <= today) worked += days.get(d)?.workedMinutes ?? 0;
    if (i < 5 && d >= today) remainingDays++;
  }
  const remaining = Math.max(0, targetMinutes - worked);
  return {
    workedMinutes: worked,
    targetMinutes,
    remainingMinutes: remaining,
    perRemainingDayMinutes: remainingDays > 0 ? Math.round(remaining / remainingDays) : 0,
    fraction: targetMinutes > 0 ? Math.min(1, worked / targetMinutes) : 0,
  };
}

export type AttendanceMonth = {
  onTime: number;
  late: number;
  absent: number;
  /** Left early or half day: they came in, so they count as present. */
  other: number;
  /** Days that count (came in or were absent). */
  counted: number;
  /** 0..100, null when there is nothing to judge. */
  presentPercent: number | null;
};

const PRESENT_KINDS = new Set(["on_time", "late", "early", "half"]);

/** The last `count` days (today included): how many on time, late, absent; present % over days that count. */
export function attendanceMonth(days: Map<string, DayRow>, today: string, count = 30): AttendanceMonth {
  let onTime = 0, late = 0, absent = 0, other = 0;
  for (const { date, kind } of stripDays(days, today, count)) {
    void date;
    if (kind === "on_time") onTime++;
    else if (kind === "late") late++;
    else if (kind === "absent") absent++;
    else if (kind === "early" || kind === "half") other++;
  }
  const present = onTime + late + other;
  const counted = present + absent;
  return { onTime, late, absent, other, counted, presentPercent: counted > 0 ? Math.round((present / counted) * 100) : null };
}

function localMinutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** "10:03 AM" from minutes after midnight. */
export function clockText(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export type Punctuality = {
  /** 0..100, null with no check-ins. */
  onTimePercent: number | null;
  lateDays: number;
  averageIn: number | null;
  earliestIn: number | null;
  latestIn: number | null;
};

/** When they come in: share of on-time days, average / earliest / latest check-in time over the last `count` days. */
export function punctuality(days: Map<string, DayRow>, today: string, count = 30): Punctuality {
  const ins: number[] = [];
  let onTime = 0, late = 0, checked = 0;
  for (const { date, kind } of stripDays(days, today, count)) {
    const row = days.get(date);
    if (!row?.firstIn || !PRESENT_KINDS.has(kind)) continue;
    checked++;
    if (kind === "on_time") onTime++;
    if (kind === "late") late++;
    ins.push(localMinutesOfDay(row.firstIn));
  }
  return {
    onTimePercent: checked > 0 ? Math.round((onTime / checked) * 100) : null,
    lateDays: late,
    averageIn: ins.length ? Math.round(ins.reduce((a, b) => a + b, 0) / ins.length) : null,
    earliestIn: ins.length ? Math.min(...ins) : null,
    latestIn: ins.length ? Math.max(...ins) : null,
  };
}

export type HoursAtWork = { averageMinutes: number; longestMinutes: number; daysCheckedIn: number; targetMinutes: number; fraction: number };

/** Average and longest worked day over the last `count` days (days with hours only). */
export function hoursAtWork(days: Map<string, DayRow>, today: string, count = 30): HoursAtWork {
  let total = 0, longest = 0, withHours = 0, checkedIn = 0;
  for (const { date } of stripDays(days, today, count)) {
    const row = days.get(date);
    if (!row) continue;
    if (row.firstIn) checkedIn++;
    if (row.workedMinutes > 0) {
      withHours++;
      total += row.workedMinutes;
      longest = Math.max(longest, row.workedMinutes);
    }
  }
  const average = withHours > 0 ? Math.round(total / withHours) : 0;
  return { averageMinutes: average, longestMinutes: longest, daysCheckedIn: checkedIn, targetMinutes: DAY_MIN, fraction: Math.min(1, average / DAY_MIN) };
}

export type AwayCounts = { leaveDays: number; holidayDays: number; onDutyDays: number };

/** Days on leave, public holidays and on-duty days in the last `count` days. */
export function awayCounts(days: Map<string, DayRow>, today: string, count = 30): AwayCounts {
  const out: AwayCounts = { leaveDays: 0, holidayDays: 0, onDutyDays: 0 };
  for (const { date, kind } of stripDays(days, today, count)) {
    if (kind === "leave") out.leaveDays++;
    else if (kind === "holiday") out.holidayDays++;
    if (days.get(date)?.onDuty) out.onDutyDays++;
  }
  return out;
}

/** "24.7" from minutes. */
export function hoursText(minutes: number): string {
  return (minutes / 60).toFixed(1);
}
