/**
 * The one place the web app turns dates into text (and "today" into a value).
 *
 *   calendar day   "2026-09-01" or "2026-09-01T00:00:00.000Z"  ->  "1 Sep 2026"      formatDay
 *   moment         "2026-10-15T16:50:00.000Z"                    ->  "15 Oct 2026, 9:50 PM"  formatDateTime
 *   time of day    same moment                                   ->  "9:50 PM"         formatTime
 *
 * Rules every screen relies on:
 *  - A calendar day is read from its first ten characters only, so the viewer's time zone can never move it
 *    (a leave starting on the 1st stays the 1st for someone at UTC-8 and for someone at UTC+5).
 *  - A moment is shown in the viewer's own time zone, which is what "clocked in at" has to mean.
 *  - Month names are written out here, not taken from Intl, so every browser and ICU version prints "Sep" the same way.
 *  - Nothing throws: no value gives "" (or the fallback you pass), a value that is not a date comes back as it was.
 */

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

export type DayParts = { year: number; month: number; day: number };

/** The year, month (1-12) and day of an API date or timestamp, or null when it does not start with YYYY-MM-DD. */
export function parseDay(value: string | null | undefined): DayParts | null {
  const m = value ? DAY_RE.exec(value) : null;
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: Number(m[1]), month, day };
}

/** The `YYYY-MM-DD` part of an API date or timestamp, "" when there is none. */
export function dayKey(value: string | null | undefined): string {
  const m = value ? DAY_RE.exec(value) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** Weekday of an API day, 0 = Sunday. Calendar arithmetic in UTC, so it never depends on the viewer's zone. */
export function weekdayOf(value: string | null | undefined): number | null {
  const p = parseDay(value);
  return p ? new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() : null;
}

/** "1 Sep 2026". No value gives `empty` ("" unless you pass one, e.g. "—"); a value that is not a date comes back unchanged. */
export function formatDay(value: string | null | undefined, empty = ""): string {
  if (!value) return empty;
  const p = parseDay(value);
  return p ? `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}` : value;
}

/** "1 September 2026", for headings and sentences. */
export function formatLongDay(value: string | null | undefined, empty = ""): string {
  if (!value) return empty;
  const p = parseDay(value);
  return p ? `${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}` : value;
}

/** "Tue, 1 Sep 2026". */
export function formatDayWithWeekday(value: string | null | undefined, empty = ""): string {
  if (!value) return empty;
  const p = parseDay(value);
  const wd = weekdayOf(value);
  return p && wd !== null ? `${WEEKDAYS_SHORT[wd]}, ${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}` : value;
}

/** "Tue 1", the column heading of a week view. */
export function formatWeekdayAndDate(value: string | null | undefined): string {
  const p = parseDay(value);
  const wd = weekdayOf(value);
  return p && wd !== null ? `${WEEKDAYS_SHORT[wd]} ${p.day}` : (value ?? "");
}

/** "Sep 2026". Takes a day ("2026-09-01") or a month ("2026-09"). */
export function formatMonthYear(value: string | null | undefined, empty = ""): string {
  if (!value) return empty;
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return value;
  return `${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}`;
}

/** "1 Sep 2026 – 30 Sep 2026". */
export function formatPeriod(start: string, end: string): string {
  return `${formatDay(start)} – ${formatDay(end)}`;
}

/**
 * A span of days: one day reads once ("25 Oct 2026"), a span as "25 Oct 2026 – 26 Oct 2026",
 * and a span with no end as "1 Jan 2026 – present" (pass `open` to change the word, e.g. "Unlimited").
 */
export function formatRange(start: string | null | undefined, end: string | null | undefined, open = "present"): string {
  if (!start && !end) return "";
  if (!end) return `${formatDay(start)} – ${open}`;
  if (!start) return `until ${formatDay(end)}`;
  if (dayKey(start) === dayKey(end)) return formatDay(start);
  return `${formatDay(start)} – ${formatDay(end)}`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "9:50 PM" in the viewer's time zone. A date with no time ("2026-10-15") has no time of day: it gives `empty`. */
export function formatTime(value: string | number | Date | null | undefined, empty = ""): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return empty;
  const d = toDate(value);
  if (!d) return value ? String(value) : empty;
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** A time of day with no date, as the API stores shifts ("09:00" or "17:30:00"), shown "9:00 AM" / "5:30 PM". */
export function formatClock(value: string | null | undefined, empty = ""): string {
  if (!value) return empty;
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return value;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "15 Oct 2026, 9:50 PM" in the viewer's time zone. A plain date ("2026-10-15") reads as a day only. */
export function formatDateTime(value: string | number | Date | null | undefined, empty = ""): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDay(value);
  const d = toDate(value);
  if (!d) return value ? String(value) : empty;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${formatTime(d)}`;
}

/** The calendar day of a moment in the viewer's time zone, "2026-10-15". Not the UTC day: at 2 AM in Karachi that is still yesterday in UTC. */
export function localDayKey(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today in the viewer's time zone as "YYYY-MM-DD" - the value for date inputs and "is it past" checks. */
export function todayIso(now: Date = new Date()): string {
  return localDayKey(now);
}

/** Now as the value of an `<input type="datetime-local">` ("2026-10-15T21:50"), in the viewer's time zone. */
export function nowLocalInput(now: Date = new Date()): string {
  return `${localDayKey(now)}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatTimeAgo(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return "";
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
