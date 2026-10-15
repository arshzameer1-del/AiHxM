/**
 * Pure date helpers for the SAP-style "My Leave Request" screen (calendar, "N days will be consumed",
 * return date). Dates are plain `YYYY-MM-DD` strings and all arithmetic is done in UTC so the result never
 * depends on the browser's time zone.
 *
 * These are a PREVIEW for the employee. The server still decides what a request actually costs
 * (`daysRequested`) and which days are working days; nothing here is stored.
 */

export type DayKind = "working" | "non_working" | "holiday";

export type CalendarCell = {
  /** `YYYY-MM-DD` */
  date: string;
  dayOfMonth: number;
  kind: DayKind;
  holidayName?: string;
};

export type CalendarMonth = {
  year: number;
  /** 1-12 */
  month: number;
  label: string;
  /** Week rows, each exactly 7 slots starting on `weekStart`; `null` pads days outside the month. */
  weeks: (CalendarCell | null)[][];
};

/** 0 = Sunday ... 6 = Saturday. The weekend a company observes is a tenant setting; Sat/Sun is only the default. */
export const DEFAULT_WEEKEND: readonly number[] = [0, 6];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** `2026-10-25` -> `25.10.2026`, the SAP-style display used on this screen. */
export function formatDisplayDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function formatDisplayRange(start: string, end: string): string {
  return start === end ? formatDisplayDate(start) : `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
}

export function dayKind(iso: string, holidayDates: ReadonlyMap<string, string>, weekend: readonly number[] = DEFAULT_WEEKEND): DayKind {
  if (holidayDates.has(iso)) return "holiday";
  return weekend.includes(parseIsoDate(iso).getUTCDay()) ? "non_working" : "working";
}

/** Working days in the inclusive range (weekends and public holidays do not count). 0 when `end < start`. */
export function countWorkingDays(start: string, end: string, holidayDates: ReadonlyMap<string, string>, weekend: readonly number[] = DEFAULT_WEEKEND): number {
  if (!start || !end || end < start) return 0;
  let count = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (dayKind(d, holidayDates, weekend) === "working") count += 1;
  }
  return count;
}

/** Calendar days in the inclusive range (SAP's "Absence days"). */
export function countCalendarDays(start: string, end: string): number {
  if (!start || !end || end < start) return 0;
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86_400_000) + 1;
}

/** First working day after `end`. */
export function returnDateAfter(end: string, holidayDates: ReadonlyMap<string, string>, weekend: readonly number[] = DEFAULT_WEEKEND): string {
  let d = addDays(end, 1);
  // A guard against a (mis)configured all-days-off weekend so this can never loop forever.
  for (let i = 0; i < 400 && dayKind(d, holidayDates, weekend) !== "working"; i += 1) d = addDays(d, 1);
  return d;
}

/** One month as week rows. `weekStart` is 0 (Sunday) ... 6 (Saturday); Monday (1) is the default here. */
export function buildMonth(year: number, month: number, holidayDates: ReadonlyMap<string, string>, weekend: readonly number[] = DEFAULT_WEEKEND, weekStart = 1): CalendarMonth {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() - weekStart + 7) % 7;
  const slots: (CalendarCell | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    slots.push({ date, dayOfMonth: day, kind: dayKind(date, holidayDates, weekend), holidayName: holidayDates.get(date) });
  }
  while (slots.length % 7 !== 0) slots.push(null);
  const weeks: (CalendarCell | null)[][] = [];
  for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7));
  return { year, month, label: `${MONTH_NAMES[month - 1]} ${year}`, weeks };
}

/** The month after `year`/`month`, wrapping the year. */
export function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Weekday header labels for the given week start, e.g. weekStart 1 -> Mon..Sun. */
export function weekdayLabels(weekStart = 1): string[] {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Array.from({ length: 7 }, (_, i) => names[(weekStart + i) % 7]);
}

/** `2026-08-30` -> `August 30, 2026` (the long form SAP's request header uses). */
export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

export function formatLongRange(start: string, end: string): string {
  return start === end ? formatLongDate(start) : `${formatLongDate(start)} – ${formatLongDate(end)}`;
}

/** Every date from `start` to `end`, both included. Empty when `end < start`; capped so a bad range cannot hang the page. */
export function eachDate(start: string, end: string, cap = 400): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The 7-day window that contains `iso`, starting on `weekStart` (0 = Sunday ... 6 = Saturday). */
export function weekWindow(iso: string, weekStart = 1): { from: string; to: string } {
  const lead = (parseIsoDate(iso).getUTCDay() - weekStart + 7) % 7;
  const from = addDays(iso, -lead);
  return { from, to: addDays(from, 6) };
}

/** The calendar month that contains `iso`. */
export function monthWindow(iso: string): { from: string; to: string } {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/** Moves a window one step back (-1) or forward (+1): a week by 7 days, a month by one calendar month. */
export function shiftWindow(anchor: string, mode: "week" | "month", direction: -1 | 1): string {
  if (mode === "week") return addDays(anchor, 7 * direction);
  const [y, m] = anchor.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + direction, 1));
  return toIsoDate(target);
}

/** Does leave `[start, end]` cover `date`? */
export function covers(start: string, end: string, date: string): boolean {
  return start <= date && date <= end;
}
