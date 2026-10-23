import type { TimesheetStatus } from "@aihxm/shared-types";
import type { DayKind } from "./attendanceDays";

const DAY_MIN = 8 * 60;

function isWeekday(day: string): boolean {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w >= 1 && w <= 5;
}

/**
 * The week's target and the days that count towards it: Monday to Friday at 8 h, minus holidays and leave
 * (the dashed line in the One exD timesheet is "lowered or removed on holidays and leave").
 */
export function weekTarget(days: string[], kindOf: (day: string) => DayKind | undefined): { minutes: number; workingDates: string[] } {
  const workingDates = days.filter((d) => isWeekday(d) && kindOf(d) !== "holiday" && kindOf(d) !== "leave");
  return { minutes: workingDates.length * DAY_MIN, workingDates };
}

export type TimesheetStepper = { steps: string[]; current: number; failed: boolean; note: string };

/** Where a timesheet is on its way: Draft, Manager, Approved. */
export function timesheetStepper(status: TimesheetStatus): TimesheetStepper {
  const steps = ["Draft", "Manager", "Approved"];
  switch (status) {
    case "draft":
      return { steps, current: 0, failed: false, note: "In draft, not submitted yet" };
    case "returned":
      return { steps, current: 0, failed: false, note: "Sent back to you, change it and submit again" };
    case "pending":
      return { steps, current: 1, failed: false, note: "Waiting for your approver" };
    case "approved":
      return { steps, current: 3, failed: false, note: "Approved and signed off" };
    case "rejected":
      return { steps, current: 1, failed: true, note: "Rejected by the approver" };
    case "cancelled":
      return { steps, current: 0, failed: true, note: "Withdrawn" };
  }
}
