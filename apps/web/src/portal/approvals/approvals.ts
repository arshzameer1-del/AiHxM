import type { AttendanceCorrectionRequestView, LeaveRequestView, TimesheetView } from "@aihxm/shared-types";
import { formatDay, formatPeriod } from "../shared/dates";
import { approverSummary, groupApprovalSteps } from "../leave/leaveApprovals";

export type ApprovalKind = "leave" | "timesheet" | "correction";

/** One row on the Approvals page, whatever it came from. */
export type ApprovalItem = {
  key: string;
  id: string;
  kind: ApprovalKind;
  /** Who it is about (the requester). */
  who: string;
  /** What it is: "Annual leave", "Week 43", "Attendance correction". */
  title: string;
  detail: string;
  stage: string;
  waitingOn: string | null;
  submittedAt: string | null;
  /** Where the full record lives. */
  to: string;
};

export const KIND_LABELS: Record<ApprovalKind, string> = { leave: "Time off", timesheet: "Timesheet", correction: "Correction" };

function hoursText(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

/** ISO week number (Monday-based) of a date, for "Week 43". */
export function isoWeek(day: string): number {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

export function leaveItem(r: LeaveRequestView): ApprovalItem {
  const steps = groupApprovalSteps(r.approvals);
  const waiting = steps.find((s) => s.status === "pending" || s.status === "escalated");
  const days = r.absenceDays ?? r.daysRequested;
  return {
    key: `leave:${r.id}`,
    id: r.id,
    kind: "leave",
    who: r.employeeName ?? "Employee",
    title: r.leaveTypeName ?? r.leaveType,
    detail: `${formatDay(r.startDate)}${r.endDate !== r.startDate ? ` to ${formatDay(r.endDate)}` : ""} · ${days} day${days === 1 ? "" : "s"}`,
    stage: waiting?.stepName ?? "Approval",
    waitingOn: approverSummary(r.status, r.approvals),
    submittedAt: r.createdAt,
    to: `/app/leave/${r.id}`,
  };
}

export function timesheetItem(t: TimesheetView): ApprovalItem {
  return {
    key: `timesheet:${t.id}`,
    id: t.id,
    kind: "timesheet",
    who: t.employeeName ?? "Employee",
    title: `Week ${isoWeek(t.periodStart)} · ${formatPeriod(t.periodStart, t.periodEnd)}`,
    detail: `${hoursText(t.totalMinutes)} submitted`,
    stage: "Line manager",
    waitingOn: null,
    submittedAt: t.submittedAt,
    to: "/app/attendance/timesheet",
  };
}

export function correctionItem(c: AttendanceCorrectionRequestView): ApprovalItem {
  return {
    key: `correction:${c.id}`,
    id: c.id,
    kind: "correction",
    who: c.employeeName,
    title: "Attendance correction",
    detail: formatDay(c.requestedDate),
    stage: "Line manager",
    waitingOn: null,
    submittedAt: c.createdAt,
    to: "/app/attendance/approvals",
  };
}

export type ApprovalTab = "all" | ApprovalKind | "mine";

export function itemsForTab(tab: ApprovalTab, toDecide: ApprovalItem[], mine: ApprovalItem[]): ApprovalItem[] {
  if (tab === "mine") return mine;
  if (tab === "all") return toDecide;
  return toDecide.filter((i) => i.kind === tab);
}

export function tabCount(tab: ApprovalTab, toDecide: ApprovalItem[], mine: ApprovalItem[]): number {
  return itemsForTab(tab, toDecide, mine).length;
}

/** "2 days" style age of a submission. */
export function ageText(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}
