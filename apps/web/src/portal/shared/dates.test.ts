import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDay, formatPeriod } from "./dates";

test("plain dates and ISO timestamps give the same day", () => {
  assert.equal(formatDay("2026-09-01"), "1 Sep 2026");
  assert.equal(formatDay("2026-09-01T00:00:00.000Z"), "1 Sep 2026");
  assert.equal(formatDay("2026-09-30T23:59:59.000Z"), "30 Sep 2026");
});
test("empty and unknown values do not break", () => {
  assert.equal(formatDay(null), "");
  assert.equal(formatDay("soon"), "soon");
});
test("period", () => {
  assert.equal(formatPeriod("2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z"), "1 Sep 2026 – 30 Sep 2026");
});

import {
  dayKey, formatClock, formatDateTime, formatDayWithWeekday, formatLongDay, formatMonthYear, formatRange, formatTime, formatTimeAgo,
  formatWeekdayAndDate, localDayKey, nowLocalInput, parseDay, todayIso, weekdayOf,
} from "./dates";

test("parseDay / dayKey read only the date part and reject nonsense", () => {
  assert.deepEqual(parseDay("2026-10-05T23:00:00Z"), { year: 2026, month: 10, day: 5 });
  assert.equal(parseDay("2026-13-05"), null);
  assert.equal(parseDay("05/10/2026"), null);
  assert.equal(dayKey("2026-10-05T23:00:00Z"), "2026-10-05");
  assert.equal(dayKey(undefined), "");
});

test("empty fallback is yours to choose", () => {
  assert.equal(formatDay(null, "—"), "—");
  assert.equal(formatDay("", "—"), "—");
  assert.equal(formatDateTime(undefined, "—"), "—");
  assert.equal(formatTime(null, "—"), "—");
});

test("long form, weekday form and week-view headings", () => {
  assert.equal(formatLongDay("2026-08-30"), "30 August 2026");
  assert.equal(weekdayOf("2026-10-25"), 0);
  assert.equal(formatDayWithWeekday("2026-10-25"), "Sun, 25 Oct 2026");
  assert.equal(formatWeekdayAndDate("2026-10-26"), "Mon 26");
  assert.equal(formatMonthYear("2026-06-30"), "Jun 2026");
  assert.equal(formatMonthYear("2026-06"), "Jun 2026");
});

test("ranges: one day reads once, open end says present", () => {
  assert.equal(formatRange("2026-10-25", "2026-10-25"), "25 Oct 2026");
  assert.equal(formatRange("2026-10-25", "2026-10-26"), "25 Oct 2026 – 26 Oct 2026");
  assert.equal(formatRange("2026-10-25T00:00:00Z", null), "25 Oct 2026 – present");
  assert.equal(formatRange("2026-10-25", null, "Unlimited"), "25 Oct 2026 – Unlimited");
  assert.equal(formatRange(null, null), "");
});

test("moments are shown in the viewer's zone, 12-hour clock, no US month-first order", () => {
  const evening = new Date(2026, 9, 15, 21, 50).toISOString();
  assert.equal(formatDateTime(evening), "15 Oct 2026, 9:50 PM");
  assert.equal(formatTime(evening), "9:50 PM");
  assert.equal(formatTime(new Date(2026, 9, 15, 0, 5)), "12:05 AM");
  assert.equal(formatTime(new Date(2026, 9, 15, 12, 0)), "12:00 PM");
  assert.equal(formatTime(new Date(2026, 9, 15, 9, 7)), "9:07 AM");
});

test("a plain date has no time of day", () => {
  assert.equal(formatDateTime("2026-10-15"), "15 Oct 2026");
  assert.equal(formatTime("2026-10-15"), "");
  assert.equal(formatDateTime("not a date"), "not a date");
});

test("today and now follow the viewer's calendar, not UTC", () => {
  const justAfterMidnight = new Date(2026, 9, 16, 0, 30);
  assert.equal(todayIso(justAfterMidnight), "2026-10-16");
  assert.equal(localDayKey(justAfterMidnight), "2026-10-16");
  assert.equal(nowLocalInput(new Date(2026, 9, 16, 21, 5)), "2026-10-16T21:05");
  assert.equal(localDayKey("garbage"), "");
});

test("time ago", () => {
  const now = new Date(2026, 9, 16, 12, 0);
  assert.equal(formatTimeAgo(new Date(2026, 9, 16, 11, 59, 40), now), "just now");
  assert.equal(formatTimeAgo(new Date(2026, 9, 16, 11, 55), now), "5m ago");
  assert.equal(formatTimeAgo(new Date(2026, 9, 16, 9, 0), now), "3h ago");
  assert.equal(formatTimeAgo(new Date(2026, 9, 14, 12, 0), now), "2d ago");
});

test("shift times of day", () => {
  assert.equal(formatClock("09:00"), "9:00 AM");
  assert.equal(formatClock("17:30:00"), "5:30 PM");
  assert.equal(formatClock("00:15"), "12:15 AM");
  assert.equal(formatClock("12:00"), "12:00 PM");
  assert.equal(formatClock(null, "—"), "—");
  assert.equal(formatClock("late"), "late");
});
