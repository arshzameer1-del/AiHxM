import type { ResolvedWorkScheduleView } from "@aihxm/shared-types";
import { formatClock } from "../shared/dates";

function minutesOf(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Minutes of unpaid breaks in the schedule (what is taken off the day's working time). */
export function unpaidBreakMinutes(s: ResolvedWorkScheduleView): number {
  return s.breaks
    .filter((b) => !b.isPaid)
    .reduce((sum, b) => {
      const span = minutesOf(b.endTime) - minutesOf(b.startTime);
      return sum + (span > 0 ? span : 0);
    }, 0);
}

export type ShiftSummary = {
  /** "Holiday", "Day off", "No shift assigned" or the shift's name. */
  title: string;
  /** "9:00 AM – 6:00 PM", empty when there are no set hours. */
  hours: string;
  /** "1 h unpaid break · 15 min grace", empty when nothing to add. */
  detail: string;
  working: boolean;
};

/** One readable description of what the person is expected to do on a day. */
export function summariseShift(s: ResolvedWorkScheduleView | null): ShiftSummary {
  if (!s || !s.hasSchedule) return { title: "No shift assigned", hours: "", detail: "Ask HR to assign your work schedule.", working: false };
  if (s.isMandatoryHoliday) return { title: s.holidayName ? `Holiday: ${s.holidayName}` : "Holiday", hours: "", detail: "", working: false };
  if (!s.isWorking) return { title: "Day off", hours: "", detail: s.scheduleName ?? "", working: false };
  const hours = s.isFlexible
    ? `Flexible · core ${formatClock(s.coreStartTime, "—")} – ${formatClock(s.coreEndTime, "—")}`
    : `${formatClock(s.startTime, "—")} – ${formatClock(s.endTime, "—")}${s.crossesMidnight ? " (next day)" : ""}`;
  const brk = unpaidBreakMinutes(s);
  const parts: string[] = [];
  if (brk > 0) parts.push(brk % 60 === 0 ? `${brk / 60} h unpaid break` : `${brk} min unpaid break`);
  if (s.graceMinutesLate > 0) parts.push(`${s.graceMinutesLate} min grace`);
  return { title: `${s.scheduleName ?? "Shift"}${s.isHalfDay ? " (half day)" : ""}`, hours, detail: parts.join(" · "), working: true };
}
