import type { TeamAttendanceMember } from "@aihxm/shared-types";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The window the Team Attendance page shows: the last 14 days up to and including today. */
export function teamWindow(today: Date = new Date()): { from: string; to: string } {
  const from = new Date(today.getTime() - 13 * 86400000);
  return { from: iso(from), to: iso(today) };
}

/** People who need a look first: clocked in for very long, then absent days, then late minutes. */
export function sortTeam(members: readonly TeamAttendanceMember[]): TeamAttendanceMember[] {
  const score = (m: TeamAttendanceMember) => (m.summary.byStatus.absent ?? 0) * 1000 + m.summary.lateMinutes;
  return [...members].sort((a, b) => score(b) - score(a) || a.employeeName.localeCompare(b.employeeName));
}

export function hoursMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
