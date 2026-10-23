import test from "node:test";
import assert from "node:assert/strict";
import type { DayKind, DayRow } from "./attendanceDays";
import { attendanceMonth, awayCounts, clockText, hoursAtWork, hoursText, mondayOf, punctuality, weekHours } from "./attendanceStats";

function row(date: string, kind: DayKind, over: Partial<DayRow> = {}): DayRow {
  return { date, kind, firstIn: null, lastOut: null, workedMinutes: 0, breakMinutes: 0, sessions: [], open: false, lateMinutes: 0, earlyLeaveMinutes: 0, notes: [], onDuty: false, ...over };
}
const at = (date: string, hm: string) => new Date(`${date}T${hm}:00`).toISOString();
function assertSubset(actual: object, expected: Record<string, unknown>) {
  for (const [k, v] of Object.entries(expected)) assert.equal((actual as Record<string, unknown>)[k], v, k);
}
const map = (rows: DayRow[]) => new Map(rows.map((r) => [r.date, r]));

test("attendance stats: finds the Monday of a week", () => {
  assert.equal(mondayOf("2026-10-23"), "2026-10-19"); // Friday
  assert.equal(mondayOf("2026-10-25"), "2026-10-19"); // Sunday
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
});

test("attendance stats: adds up the week against 40 h and spreads what is left over the remaining working days", () => {
  const days = map([row("2026-10-19", "late", { workedMinutes: 440 }), row("2026-10-20", "on_time", { workedMinutes: 450 }), row("2026-10-21", "on_time", { workedMinutes: 430 }), row("2026-10-22", "late", { workedMinutes: 150 })]);
  const w = weekHours(days, "2026-10-23");
  assert.equal(w.workedMinutes, 1470);
  assert.equal(w.remainingMinutes, 930);
  assert.equal(w.perRemainingDayMinutes, 930); // only Friday is left
  assert.equal(hoursText(w.workedMinutes), "24.5");
  assert.ok(Math.abs(w.fraction - 0.6125) < 0.001);
});

test("attendance stats: counts on time, late and absent, and the present share over days that count", () => {
  const days = map([
    row("2026-10-19", "on_time"), row("2026-10-20", "late"), row("2026-10-21", "late"), row("2026-10-22", "absent"),
    row("2026-10-18", "holiday"), row("2026-10-17", "leave"), row("2026-10-16", "early"),
  ]);
  const m = attendanceMonth(days, "2026-10-23");
  assertSubset(m, { onTime: 1, late: 2, absent: 1, other: 1, counted: 5, presentPercent: 80 });
  assert.equal(attendanceMonth(new Map(), "2026-10-23").presentPercent, null);
});

test("attendance stats: works out punctuality from the first check-in times", () => {
  const days = map([
    row("2026-10-19", "on_time", { firstIn: at("2026-10-19", "09:00") }),
    row("2026-10-20", "late", { firstIn: at("2026-10-20", "10:30") }),
    row("2026-10-21", "late", { firstIn: at("2026-10-21", "11:00") }),
    row("2026-10-22", "absent"),
  ]);
  const p = punctuality(days, "2026-10-23");
  assert.equal(p.onTimePercent, 33);
  assert.equal(p.lateDays, 2);
  assert.equal(p.earliestIn, 9 * 60);
  assert.equal(p.latestIn, 11 * 60);
  assert.equal(p.averageIn, Math.round((540 + 630 + 660) / 3));
  assert.equal(clockText(p.averageIn ?? 0), "10:10 AM");
  assert.equal(punctuality(new Map(), "2026-10-23").onTimePercent, null);
});

test("attendance stats: works out hours at work", () => {
  const days = map([
    row("2026-10-19", "on_time", { firstIn: at("2026-10-19", "09:00"), workedMinutes: 600 }),
    row("2026-10-20", "on_time", { firstIn: at("2026-10-20", "09:00"), workedMinutes: 400 }),
    row("2026-10-21", "absent"),
  ]);
  assertSubset(hoursAtWork(days, "2026-10-23"), { averageMinutes: 500, longestMinutes: 600, daysCheckedIn: 2, targetMinutes: 480 });
});

test("attendance stats: counts leave, holiday and on-duty days", () => {
  const days = map([row("2026-10-19", "leave"), row("2026-10-20", "holiday"), row("2026-10-21", "on_time", { onDuty: true })]);
  assert.deepEqual(awayCounts(days, "2026-10-23"), { leaveDays: 1, holidayDays: 1, onDutyDays: 1 });
});

test("attendance stats: writes clock times", () => {
  assert.equal(clockText(0), "12:00 AM");
  assert.equal(clockText(12 * 60 + 5), "12:05 PM");
  assert.equal(clockText(23 * 60 + 59), "11:59 PM");
});
