import type { LeaveBalanceUnit, LeaveDurationMode, LeaveValidationFinding, LeaveValidationResult } from "@aihxm/shared-types";

/** BACKLOG58 - small pure helpers for hours/minutes leave, shared by the request form, the balances and the detail page. */

/** 90 -> "1 h 30 min", 45 -> "45 min", 120 -> "2 h". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

const UNIT_WORDS: Record<LeaveBalanceUnit, [string, string]> = { days: ["Day", "Days"], hours: ["Hour", "Hours"], minutes: ["Minute", "Minutes"] };

/** 1.5,"hours" -> "1.5 Hours"; 1,"days" -> "1 Day". At most two decimals, no trailing zeros. */
export function formatUnits(value: number, unit: LeaveBalanceUnit): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${UNIT_WORDS[unit][rounded === 1 ? 0 : 1]}`;
}

/** The three modes that take a start and end time. */
export function isTimeMode(mode: LeaveDurationMode | undefined): boolean {
  return mode === "short_hours" || mode === "hourly" || mode === "flexible_partial";
}

/** Short-hours and hourly types can only be requested by the hour; flexible types offer both. */
export function isTimeOnly(mode: LeaveDurationMode | undefined): boolean {
  return mode === "short_hours" || mode === "hourly";
}

/** Findings belong next to a field: "startTime" -> start time input. Findings without a field show in the summary. */
export function findingsFor(result: LeaveValidationResult | null, field: string): LeaveValidationFinding[] {
  if (!result) return [];
  return [...result.blocking, ...result.warnings].filter((f) => f.field === field);
}

/** Every finding that stops the request or needs confirming, in the order the server listed them. */
export function allFindings(result: LeaveValidationResult | null): LeaveValidationFinding[] {
  return result ? [...result.blocking, ...result.warnings, ...result.info] : [];
}

/** Adds or removes one warning's rule code from the confirmed list. */
export function toggleAck(list: string[], ruleCode: string, on: boolean): string[] {
  const without = list.filter((c) => c !== ruleCode);
  return on ? [...without, ruleCode] : without;
}

/** Keeps only confirmations for warnings that still exist (a changed request can drop a warning). */
export function pruneAcks(list: string[], result: LeaveValidationResult | null): string[] {
  if (!result) return list;
  const live = new Set(result.warnings.map((w) => w.ruleCode));
  const kept = list.filter((c) => live.has(c));
  return kept.length === list.length ? list : kept;
}

type TimedLike = { dayPart: string; startTime?: string | null; endTime?: string | null; durationMinutes?: number | null; balanceUnits?: number | null; balanceUnit?: LeaveBalanceUnit | null; daysRequested: number };

/** "09:00 – 10:30 (1 h 30 min)" for a timed request, or null for any other. */
export function timedRangeText(r: TimedLike): string | null {
  if (r.dayPart !== "hours" || !r.startTime || !r.endTime) return null;
  const range = `${r.startTime.slice(0, 5)} – ${r.endTime.slice(0, 5)}`;
  return r.durationMinutes ? `${range} (${formatMinutes(r.durationMinutes)})` : range;
}

/** What a request charges: "1.5 Hours" for a timed one kept in hours, otherwise "N Days". */
export function chargedText(r: TimedLike): string {
  if (r.dayPart === "hours" && r.balanceUnits != null && r.balanceUnit) return formatUnits(r.balanceUnits, r.balanceUnit);
  return formatUnits(r.daysRequested, "days");
}

/** "Days" / "Hours" / "Minutes" for a balance column. */
export function unitWord(unit: LeaveBalanceUnit | undefined): string {
  return UNIT_WORDS[unit ?? "days"][1];
}
