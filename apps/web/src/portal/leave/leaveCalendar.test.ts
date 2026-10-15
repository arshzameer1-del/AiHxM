import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  buildMonth,
  countCalendarDays,
  countWorkingDays,
  dayKind,
  formatDisplayDate,
  formatDisplayRange,
  nextMonth,
  previousMonth,
  returnDateAfter,
  weekdayLabels,
} from "./leaveCalendar";

const noHolidays = new Map<string, string>();
const holidays = new Map<string, string>([["2026-10-27", "Test holiday"]]);

test("addDays crosses month and year ends without time zone drift", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("display formatting is DD.MM.YYYY", () => {
  assert.equal(formatDisplayDate("2026-10-25"), "25.10.2026");
  assert.equal(formatDisplayRange("2026-10-25", "2026-10-26"), "25.10.2026 – 26.10.2026");
  assert.equal(formatDisplayRange("2026-10-25", "2026-10-25"), "25.10.2026");
});

test("weekends and holidays do not count as working days", () => {
  // Mon 2026-10-19 .. Sun 2026-10-25: five working days with the default Sat/Sun weekend.
  assert.equal(countWorkingDays("2026-10-19", "2026-10-25", noHolidays), 5);
  assert.equal(countWorkingDays("2026-10-26", "2026-10-28", noHolidays), 3);
  assert.equal(countWorkingDays("2026-10-26", "2026-10-28", holidays), 2);
  assert.equal(countWorkingDays("2026-10-24", "2026-10-25", noHolidays), 0);
});

test("a company that observes Fri/Sat as weekend gets different counts", () => {
  assert.equal(countWorkingDays("2026-10-25", "2026-10-26", noHolidays, [5, 6]), 2);
  assert.equal(countWorkingDays("2026-10-30", "2026-10-31", noHolidays, [5, 6]), 0);
});

test("an inverted or empty range counts as zero", () => {
  assert.equal(countWorkingDays("2026-10-26", "2026-10-19", noHolidays), 0);
  assert.equal(countWorkingDays("", "", noHolidays), 0);
  assert.equal(countCalendarDays("2026-10-26", "2026-10-19"), 0);
});

test("calendar days include both ends", () => {
  assert.equal(countCalendarDays("2026-10-25", "2026-10-26"), 2);
  assert.equal(countCalendarDays("2026-10-25", "2026-10-25"), 1);
});

test("return date skips weekends and holidays", () => {
  // Fri 2026-10-23 -> Mon 2026-10-26
  assert.equal(returnDateAfter("2026-10-23", noHolidays), "2026-10-26");
  // Mon 2026-10-26 -> Tue 2026-10-27 is a holiday -> Wed 2026-10-28
  assert.equal(returnDateAfter("2026-10-26", holidays), "2026-10-28");
});

test("return date cannot loop forever when every weekday is a weekend", () => {
  const all = [0, 1, 2, 3, 4, 5, 6];
  const result = returnDateAfter("2026-10-26", noHolidays, all);
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test("dayKind prefers holiday over weekend", () => {
  const sat = new Map([["2026-10-24", "Sat holiday"]]);
  assert.equal(dayKind("2026-10-24", sat), "holiday");
  assert.equal(dayKind("2026-10-24", noHolidays), "non_working");
  assert.equal(dayKind("2026-10-26", noHolidays), "working");
});

test("buildMonth lays out October 2026 on a Monday-first grid", () => {
  const m = buildMonth(2026, 10, holidays);
  assert.equal(m.label, "October 2026");
  // Oct 1 2026 is a Thursday: Mon, Tue, Wed are padding.
  assert.deepEqual(m.weeks[0].slice(0, 3), [null, null, null]);
  assert.equal(m.weeks[0][3]?.date, "2026-10-01");
  for (const week of m.weeks) assert.equal(week.length, 7);
  const cells = m.weeks.flat().filter((c) => c !== null);
  assert.equal(cells.length, 31);
  assert.equal(cells.find((c) => c!.date === "2026-10-27")?.kind, "holiday");
  assert.equal(cells.find((c) => c!.date === "2026-10-24")?.kind, "non_working");
});

test("buildMonth honours a Saturday week start (SAP layout)", () => {
  const m = buildMonth(2026, 10, noHolidays, [5, 6], 6);
  // Oct 1 2026 (Thu) is the 6th column when the week starts on Saturday.
  assert.equal(m.weeks[0][5]?.date, "2026-10-01");
  assert.deepEqual(weekdayLabels(6), ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
});

test("month navigation wraps the year", () => {
  assert.deepEqual(nextMonth(2026, 12), { year: 2027, month: 1 });
  assert.deepEqual(previousMonth(2026, 1), { year: 2025, month: 12 });
  assert.deepEqual(nextMonth(2026, 10), { year: 2026, month: 11 });
});

test("long date formats", async () => {
  const { formatLongDate, formatLongRange } = await import("./leaveCalendar");
  assert.equal(formatLongDate("2026-08-30"), "August 30, 2026");
  assert.equal(formatLongRange("2026-08-30", "2026-08-31"), "August 30, 2026 – August 31, 2026");
  assert.equal(formatLongRange("2026-08-30", "2026-08-30"), "August 30, 2026");
});

test("eachDate is inclusive, empty for an inverted range and capped", async () => {
  const { eachDate } = await import("./leaveCalendar");
  assert.deepEqual(eachDate("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(eachDate("2026-11-02", "2026-10-30"), []);
  assert.equal(eachDate("2020-01-01", "2030-01-01").length, 400);
});

test("week and month windows", async () => {
  const { weekWindow, monthWindow } = await import("./leaveCalendar");
  // Wed 2026-10-14 in a Monday-first week.
  assert.deepEqual(weekWindow("2026-10-14", 1), { from: "2026-10-12", to: "2026-10-18" });
  // Same day in a Saturday-first week (SAP).
  assert.deepEqual(weekWindow("2026-10-14", 6), { from: "2026-10-10", to: "2026-10-16" });
  // A Monday is the first day of its own Monday-first week.
  assert.deepEqual(weekWindow("2026-10-12", 1), { from: "2026-10-12", to: "2026-10-18" });
  assert.deepEqual(monthWindow("2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthWindow("2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
});

test("shiftWindow moves a week or a calendar month and wraps the year", async () => {
  const { shiftWindow, covers } = await import("./leaveCalendar");
  assert.equal(shiftWindow("2026-10-14", "week", 1), "2026-10-21");
  assert.equal(shiftWindow("2026-10-14", "week", -1), "2026-10-07");
  assert.equal(shiftWindow("2026-12-20", "month", 1), "2027-01-01");
  assert.equal(shiftWindow("2026-01-20", "month", -1), "2025-12-01");
  assert.equal(covers("2026-10-19", "2026-10-20", "2026-10-20"), true);
  assert.equal(covers("2026-10-19", "2026-10-20", "2026-10-21"), false);
});
