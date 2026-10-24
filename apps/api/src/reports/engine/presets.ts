import { BadRequestException } from "@nestjs/common";
import type { ReportDatePreset } from "@aihxm/shared-types";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const parse = (s: string): Date => new Date(`${s}T00:00:00Z`);

export const DATE_PRESETS: readonly ReportDatePreset[] = [
  "today", "yesterday", "thisWeek", "lastWeek", "last7Days", "last30Days", "last90Days",
  "thisMonth", "lastMonth", "quarterToDate", "lastQuarter", "yearToDate", "lastYear", "custom",
];

/**
 * Turns a named period into a date range, relative to `today` in the company's own time zone. Weeks start on Monday.
 * `custom` has no range of its own (the caller's dateFrom / dateTo are used). Pure, so it is unit-tested.
 */
export function resolvePreset(preset: ReportDatePreset, today: string): { from: string; to: string } | null {
  const t = parse(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  switch (preset) {
    case "custom":
      return null;
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const d = iso(new Date(t.getTime() - DAY));
      return { from: d, to: d };
    }
    case "thisWeek":
      return { from: iso(new Date(t.getTime() - dow * DAY)), to: today };
    case "lastWeek": {
      const start = t.getTime() - (dow + 7) * DAY;
      return { from: iso(new Date(start)), to: iso(new Date(start + 6 * DAY)) };
    }
    case "last7Days":
      return { from: iso(new Date(t.getTime() - 6 * DAY)), to: today };
    case "last30Days":
      return { from: iso(new Date(t.getTime() - 29 * DAY)), to: today };
    case "last90Days":
      return { from: iso(new Date(t.getTime() - 89 * DAY)), to: today };
    case "thisMonth":
      return { from: iso(utc(y, m, 1)), to: today };
    case "lastMonth":
      return { from: iso(utc(y, m - 1, 1)), to: iso(utc(y, m, 0)) };
    case "quarterToDate":
      return { from: iso(utc(y, Math.floor(m / 3) * 3, 1)), to: today };
    case "lastQuarter": {
      const qStart = Math.floor(m / 3) * 3;
      return { from: iso(utc(y, qStart - 3, 1)), to: iso(utc(y, qStart, 0)) };
    }
    case "yearToDate":
      return { from: `${y}-01-01`, to: today };
    case "lastYear":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    default:
      throw new BadRequestException("Unknown date period");
  }
}

/** The period of the same length that ends the day before `range` starts. */
export function previousRange(range: { from: string; to: string }): { from: string; to: string } {
  const from = parse(range.from).getTime();
  const to = parse(range.to).getTime();
  const days = Math.round((to - from) / DAY) + 1;
  const prevTo = from - DAY;
  return { from: iso(new Date(prevTo - (days - 1) * DAY)), to: iso(new Date(prevTo)) };
}
