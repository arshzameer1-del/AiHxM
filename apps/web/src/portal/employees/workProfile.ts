import type { EmployeeWorkProfileView, TimeRecordingProfile } from "@aihxm/shared-types";

export const RECORDING_LABELS: Record<TimeRecordingProfile, string> = {
  clock: "Clock in and out",
  timesheet: "Timesheet",
  exception_only: "Only exceptions are recorded",
  none: "Not recorded",
};

/** The first problem with the form, in plain words; null when it can be saved. */
export function workProfileProblem(v: { percent: string; weekly: string; monthly: string }): string | null {
  const p = Number(v.percent);
  if (!v.percent.trim() || !Number.isFinite(p) || p < 1 || p > 100) return "The share of a full-time job must be between 1 and 100.";
  if (v.weekly.trim()) {
    const w = Number(v.weekly);
    if (!Number.isFinite(w) || w < 0.5 || w > 168) return "Hours per week must be between 0.5 and 168.";
  }
  if (v.monthly.trim()) {
    const m = Number(v.monthly);
    if (!Number.isFinite(m) || m < 1 || m > 744) return "Hours per month must be between 1 and 744.";
  }
  if (v.weekly.trim() && v.monthly.trim()) {
    const w = Number(v.weekly);
    const m = Number(v.monthly);
    if (Math.abs(m - (w * 52) / 12) > Math.max(8, m * 0.1)) return "Weekly and monthly hours do not agree. Give one of them, or make them match.";
  }
  return null;
}

/** "Part-time, 60% · 24 h a week · clock in and out". */
export function workProfileSummary(p: Pick<EmployeeWorkProfileView, "employmentPercentage" | "weeklyHours" | "effectiveMonthlyHours" | "isPartTime" | "timeRecordingProfile">): string {
  const hours = p.weeklyHours != null ? `${p.weeklyHours} h a week` : p.effectiveMonthlyHours != null ? `${Math.round(p.effectiveMonthlyHours * 10) / 10} h a month` : "standard hours";
  return `${p.isPartTime ? "Part-time" : "Full-time"}, ${p.employmentPercentage}% · ${hours} · ${RECORDING_LABELS[p.timeRecordingProfile].toLowerCase()}`;
}
