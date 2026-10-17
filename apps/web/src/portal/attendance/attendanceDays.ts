import type { AttendanceDailyResultView, AttendanceRecordView } from "@aihxm/shared-types";
import { localDayKey } from "../shared/dates";

/** What a day looked like, in the few kinds the person cares about (colours on the month strip). */
export type DayKind = "on_time" | "late" | "early" | "half" | "absent" | "leave" | "holiday" | "none";

export const DAY_KIND_LABELS: Record<DayKind, string> = {
  on_time: "On time",
  late: "Late",
  early: "Left early",
  half: "Half day",
  absent: "Absent",
  leave: "Leave",
  holiday: "Holiday",
  none: "No data",
};

export type Session = { inAt: string; outAt: string | null };

export type DayRow = {
  date: string;
  kind: DayKind;
  firstIn: string | null;
  lastOut: string | null;
  /** Minutes actually worked: the attendance engine's figure for a processed day, otherwise the sum of the punches. */
  workedMinutes: number;
  /** Time away between first in and last out (lunch and other breaks). */
  breakMinutes: number;
  sessions: Session[];
  /** Clocked in right now (only ever true for today). */
  open: boolean;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  /** "Corrected by HR", "No clock-out"... */
  notes: string[];
};

const MINUTE = 60_000;
/** An open clock-in older than this is a forgotten clock-out, not running time. */
const STALE_OPEN_MS = 16 * 60 * MINUTE;

const FROM_RESULT: Record<string, DayKind> = {
  present: "on_time",
  on_duty: "on_time",
  late: "late",
  late_and_early: "late",
  early_departure: "early",
  half_day: "half",
  absent: "absent",
  on_leave: "leave",
  holiday: "holiday",
  rest_day: "none",
  no_schedule: "none",
};

const EXCEPTION_NOTES: Record<string, string> = {
  missing_clock_out: "No clock-out",
  unscheduled_work: "Worked on a day off",
};

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / MINUTE));
}

/**
 * Turns raw punches and (when the nightly run has produced them) processed days into one row per calendar day.
 * A processed day wins for status and worked time; punches fill every day it has not reached yet, today included.
 */
export function buildDays(records: AttendanceRecordView[], results: AttendanceDailyResultView[], now: Date = new Date()): Map<string, DayRow> {
  const byDay = new Map<string, AttendanceRecordView[]>();
  for (const r of records) {
    const key = localDayKey(r.clockInAt);
    if (!key) continue;
    byDay.set(key, [...(byDay.get(key) ?? []), r]);
  }
  const resultByDay = new Map(results.map((r) => [r.workDate.slice(0, 10), r]));
  const today = localDayKey(now);
  const rows = new Map<string, DayRow>();

  for (const date of new Set([...byDay.keys(), ...resultByDay.keys()])) {
    const punches = [...(byDay.get(date) ?? [])].sort((a, b) => new Date(a.clockInAt).getTime() - new Date(b.clockInAt).getTime());
    const result = resultByDay.get(date);
    const sessions: Session[] = punches.map((p) => ({ inAt: p.clockInAt, outAt: p.clockOutAt }));
    const last = punches[punches.length - 1];
    const open = date === today && Boolean(last && last.clockOutAt === null && now.getTime() - new Date(last.clockInAt).getTime() < STALE_OPEN_MS);

    const firstIn = punches[0]?.clockInAt ?? result?.firstInAt ?? null;
    const lastClosed = [...punches].reverse().find((p) => p.clockOutAt !== null);
    const lastOut = open ? null : lastClosed?.clockOutAt ?? result?.lastOutAt ?? null;

    let worked = 0;
    for (const s of sessions) {
      if (s.outAt) worked += minutesBetween(s.inAt, s.outAt);
      else if (open && s === sessions[sessions.length - 1]) worked += minutesBetween(s.inAt, now.toISOString());
    }
    let breakMinutes = 0;
    for (let i = 1; i < sessions.length; i++) {
      const prevOut = sessions[i - 1].outAt;
      if (prevOut) breakMinutes += minutesBetween(prevOut, sessions[i].inAt);
    }
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    const notes: string[] = [];
    let kind: DayKind = "none";

    if (result) {
      kind = FROM_RESULT[result.status] ?? "none";
      if (result.workedMinutes > 0) {
        worked = result.workedMinutes;
        if (result.firstInAt && result.lastOutAt) breakMinutes = Math.max(0, minutesBetween(result.firstInAt, result.lastOutAt) - result.workedMinutes);
      }
      lateMinutes = result.lateMinutes;
      earlyLeaveMinutes = result.earlyLeaveMinutes;
      for (const x of result.exceptions) notes.push(EXCEPTION_NOTES[x] ?? x);
      if (result.isOverridden) notes.push(`Corrected by HR${result.overrideReason ? `: ${result.overrideReason}` : ""}`);
    } else if (punches.length > 0) {
      if (punches[0].status === "late") kind = "late";
      else if (!open && last?.clockOutAt && last.status === "early_departure") kind = "early";
      else kind = "on_time";
      if (!open && last && last.clockOutAt === null) notes.push("No clock-out");
    }

    rows.set(date, { date, kind, firstIn, lastOut, workedMinutes: worked, breakMinutes, sessions, open, lateMinutes, earlyLeaveMinutes, notes });
  }
  return rows;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The last `count` calendar days ending today, oldest first, each with its kind ("none" when nothing is known). */
export function stripDays(rows: Map<string, DayRow>, today: string, count = 30): { date: string; kind: DayKind }[] {
  const out: { date: string; kind: DayKind }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    out.push({ date, kind: rows.get(date)?.kind ?? "none" });
  }
  return out;
}

/** "8h 31m" (never "0h 0m" for no time: "—"). */
export function minutesText(minutes: number): string {
  if (!minutes || minutes < 1) return "—";
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`;
}

/** "2:05:09" style running time for the live clock. */
export function runningText(fromIso: string, now: Date): string {
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
