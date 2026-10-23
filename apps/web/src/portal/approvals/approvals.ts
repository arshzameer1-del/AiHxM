import type { AttendanceCorrectionRequestView, LeaveRequestView, TimesheetView } from "@aihxm/shared-types";
import { formatDay, formatPeriod } from "../shared/dates";
import { approverSummary, groupApprovalSteps } from "../leave/leaveApprovals";

export type ApprovalKind = "leave" | "timesheet" | "correction";

/** What the approver needs to see before deciding, without leaving the page. */
export type TimesheetDetail = {
  kind: "timesheet";
  days: string[];
  lines: { key: string; task: string; costCenterId: string | null; description: string; minutesByDay: Record<string, number>; total: number }[];
  recordedByDay: Record<string, number>;
  totalMinutes: number;
  recordedMinutes: number;
};
export type CorrectionDetail = { kind: "correction"; date: string; clockIn: string | null; clockOut: string | null; reason: string; onBehalf: boolean };
export type ApprovalDetail = TimesheetDetail | CorrectionDetail;

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
  /** Where the full record lives (a leave request opens its own page; timesheets and corrections show their details in the row). */
  to: string;
  record?: ApprovalDetail;
  /** The step this item waits at needs a comment to approve (known for leave; the others learn it from the server's answer). */
  commentOnApprove?: boolean;
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
    commentOnApprove: Boolean(r.approvals?.find((l) => l.status === "pending" || l.status === "escalated")?.requireCommentOnApprove),
  };
}

function addDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The submitted lines (project and task) with minutes per day, next to what the clock recorded. */
export function timesheetDetail(t: TimesheetView): TimesheetDetail {
  const days = Array.from({ length: 7 }, (_, i) => addDay(t.periodStart.slice(0, 10), i));
  const lines = new Map<string, TimesheetDetail["lines"][number]>();
  for (const e of t.entries ?? []) {
    const task = (e.taskRef ?? "").trim();
    const id = `${e.costCenterId ?? ""}|${task}`;
    let line = lines.get(id);
    if (!line) {
      line = { key: id, task, costCenterId: e.costCenterId ?? null, description: "", minutesByDay: {}, total: 0 };
      lines.set(id, line);
    }
    const day = e.workDate.slice(0, 10);
    line.minutesByDay[day] = (line.minutesByDay[day] ?? 0) + e.minutes;
    line.total += e.minutes;
    if (e.description && !line.description.split("; ").includes(e.description)) line.description = line.description ? `${line.description}; ${e.description}` : e.description;
  }
  const recordedMinutes = days.reduce((sum, d) => sum + (t.recordedMinutesByDay?.[d] ?? 0), 0);
  return { kind: "timesheet", days, lines: [...lines.values()], recordedByDay: t.recordedMinutesByDay ?? {}, totalMinutes: t.totalMinutes, recordedMinutes };
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
    record: timesheetDetail(t),
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
    record: { kind: "correction", date: c.requestedDate, clockIn: c.requestedClockIn, clockOut: c.requestedClockOut, reason: c.reason, onBehalf: c.isOnBehalf },
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
