import type { TimesheetEntryInput, TimesheetEntryView, TimesheetView } from "@aihxm/shared-types";

/**
 * A timesheet line is one project (cost centre) and task with hours for each day of the week, the way One exD shows project rows
 * with their days. The stored entries are one row per line and day (`cost_center_id`, `task_ref`, `description`), so no new
 * table is needed: lines are rebuilt from entries when the sheet loads and written back as entries when it is saved.
 */
export type TimesheetLine = {
  key: string;
  costCenterId: string | null;
  task: string;
  description: string;
  /** Hours typed per day ("2", "1.5"), by day "YYYY-MM-DD". */
  hours: Record<string, string>;
};

let lineCounter = 0;
export function newLineKey(): string {
  lineCounter += 1;
  return `line-${lineCounter}`;
}

export function emptyLine(): TimesheetLine {
  return { key: newLineKey(), costCenterId: null, task: "", description: "", hours: {} };
}

export function hoursOf(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(/\.?0+$/, "") || "0";
}

/** Entries grouped into lines by (project, task), in the order they first appear. A sheet with no entries gets one empty line. */
export function linesFromEntries(entries: TimesheetEntryView[]): TimesheetLine[] {
  const lines = new Map<string, TimesheetLine & { minutes: Record<string, number> }>();
  for (const e of entries) {
    const id = `${e.costCenterId ?? ""}|${(e.taskRef ?? "").trim()}`;
    let line = lines.get(id);
    if (!line) {
      line = { key: newLineKey(), costCenterId: e.costCenterId ?? null, task: (e.taskRef ?? "").trim(), description: "", hours: {}, minutes: {} };
      lines.set(id, line);
    }
    const day = e.workDate.slice(0, 10);
    line.minutes[day] = (line.minutes[day] ?? 0) + e.minutes;
    if (e.description && !line.description.split("; ").includes(e.description)) {
      line.description = line.description ? `${line.description}; ${e.description}` : e.description;
    }
  }
  const out: TimesheetLine[] = [];
  for (const l of lines.values()) {
    const hours: Record<string, string> = {};
    for (const [day, minutes] of Object.entries(l.minutes)) hours[day] = hoursOf(minutes);
    out.push({ key: l.key, costCenterId: l.costCenterId, task: l.task, description: l.description, hours });
  }
  return out.length > 0 ? out : [emptyLine()];
}

export function minutesOfCell(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
}

/** Entries to save: one per line and day with hours above zero. A line with hours but no task still saves (task empty). */
export function entriesFromLines(lines: TimesheetLine[], days: string[]): TimesheetEntryInput[] {
  const out: TimesheetEntryInput[] = [];
  for (const line of lines) {
    for (const d of days) {
      const minutes = minutesOfCell(line.hours[d]);
      if (minutes > 0) {
        out.push({
          workDate: d,
          minutes,
          costCenterId: line.costCenterId,
          taskRef: line.task.trim() || null,
          description: line.description.trim() || null,
        });
      }
    }
  }
  return out;
}

export function dayTotals(lines: TimesheetLine[], days: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const d of days) totals[d] = lines.reduce((sum, l) => sum + minutesOfCell(l.hours[d]), 0);
  return totals;
}

export function lineTotal(line: TimesheetLine, days: string[]): number {
  return days.reduce((sum, d) => sum + minutesOfCell(line.hours[d]), 0);
}

/** Total minutes by day over several sheets (the Month view). Sheets are weeks, so a day only ever appears once. */
export function minutesByDay(sheets: Pick<TimesheetView, "entries">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sheets) {
    for (const e of s.entries) {
      const day = e.workDate.slice(0, 10);
      out[day] = (out[day] ?? 0) + e.minutes;
    }
  }
  return out;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The month containing `day` as whole Monday-to-Sunday weeks: the cells of a month calendar, with `inMonth` per cell. */
export function monthGrid(day: string): { first: string; last: string; cells: { day: string; inMonth: boolean }[] } {
  const [y, m] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(last);
  end.setUTCDate(end.getUTCDate() + (6 - ((end.getUTCDay() + 6) % 7)));
  const cells: { day: string; inMonth: boolean }[] = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    cells.push({ day: isoOf(d), inMonth: d.getUTCMonth() === m - 1 });
  }
  return { first: isoOf(first), last: isoOf(last), cells };
}

/** The same date one month earlier or later, kept inside the target month ("2026-03-31" + 1 month = "2026-04-30"). */
export function shiftMonth(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + delta, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return isoOf(target);
}
