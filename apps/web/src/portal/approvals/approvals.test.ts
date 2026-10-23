import test from "node:test";
import assert from "node:assert/strict";
import type { AttendanceCorrectionRequestView, LeaveRequestView, TimesheetView } from "@aihxm/shared-types";
import { ageText, correctionItem, isoWeek, itemsForTab, leaveItem, tabCount, timesheetDetail, timesheetItem } from "./approvals";

const leave = {
  id: "l1", employeeId: "e1", employeeName: "Ayesha Khan", leaveType: "annual", leaveTypeName: "Annual leave", startDate: "2026-10-26", endDate: "2026-10-28",
  daysRequested: 3, absenceDays: 3, status: "pending", createdAt: "2026-10-20T08:00:00Z",
  approvals: [{ stepOrder: 1, stepName: "Line manager", approverName: "Muhammad Qasim", status: "pending", decidedAt: null }],
} as unknown as LeaveRequestView;
const sheet = { id: "t1", employeeId: "e1", employeeName: "Ayesha Khan", periodStart: "2026-10-19", periodEnd: "2026-10-25", status: "pending", totalMinutes: 1500, submittedAt: "2026-10-20T09:00:00Z" } as unknown as TimesheetView;
const fix = { id: "c1", employeeId: "e1", employeeName: "Ayesha Khan", requestedDate: "2026-10-21", createdAt: "2026-10-22T09:00:00Z", status: "pending" } as unknown as AttendanceCorrectionRequestView;

test("ISO week numbers", () => {
  assert.equal(isoWeek("2026-10-19"), 43);
  assert.equal(isoWeek("2026-10-25"), 43);
  assert.equal(isoWeek("2026-01-01"), 1);
  assert.equal(isoWeek("2026-10-12"), 42);
});

test("a leave request becomes a row waiting on its approver", () => {
  const i = leaveItem(leave);
  assert.equal(i.kind, "leave");
  assert.equal(i.title, "Annual leave");
  assert.equal(i.stage, "Line manager");
  assert.equal(i.waitingOn, "Muhammad Qasim");
  assert.match(i.detail, /3 days/);
  assert.equal(i.to, "/app/leave/l1");
});

test("a timesheet becomes a row with its week and hours", () => {
  const i = timesheetItem(sheet);
  assert.match(i.title, /^Week 43/);
  assert.equal(i.detail, "25.0 h submitted");
});

test("tabs filter by kind, 'all' is everything to decide, 'mine' is the person's own", () => {
  const toDecide = [leaveItem(leave), timesheetItem(sheet), correctionItem(fix)];
  const mine = [timesheetItem(sheet)];
  assert.equal(tabCount("all", toDecide, mine), 3);
  assert.equal(tabCount("leave", toDecide, mine), 1);
  assert.equal(tabCount("timesheet", toDecide, mine), 1);
  assert.equal(tabCount("correction", toDecide, mine), 1);
  assert.equal(itemsForTab("mine", toDecide, mine).length, 1);
});

test("age of a submission", () => {
  const now = new Date("2026-10-23T10:00:00Z");
  assert.equal(ageText("2026-10-23T08:00:00Z", now), "today");
  assert.equal(ageText("2026-10-22T08:00:00Z", now), "1 day");
  assert.equal(ageText("2026-10-20T08:00:00Z", now), "3 days");
  assert.equal(ageText(null, now), "");
});

test("the timesheet detail groups entries into task lines with minutes per day and the clock beside them", () => {
  const t = {
    ...sheet,
    entries: [
      { id: "1", workDate: "2026-10-19", minutes: 120, costCenterId: "cc1", taskRef: "Payroll", description: "Run" },
      { id: "2", workDate: "2026-10-20", minutes: 60, costCenterId: "cc1", taskRef: "Payroll", description: "Run" },
      { id: "3", workDate: "2026-10-20", minutes: 30, costCenterId: null, taskRef: null, description: null },
    ],
    totalMinutes: 210,
    recordedMinutesByDay: { "2026-10-19": 480, "2026-10-20": 450 },
  } as unknown as TimesheetView;
  const d = timesheetDetail(t);
  assert.equal(d.days.length, 7);
  assert.equal(d.days[0], "2026-10-19");
  assert.equal(d.lines.length, 2);
  assert.equal(d.lines[0].total, 180);
  assert.deepEqual(d.lines[0].minutesByDay, { "2026-10-19": 120, "2026-10-20": 60 });
  assert.equal(d.lines[1].task, "");
  assert.equal(d.recordedMinutes, 930);
  assert.equal(timesheetItem(t).record?.kind, "timesheet");
});

test("a correction carries what was asked for and why", () => {
  const c = { ...fix, requestedClockIn: "2026-10-21T04:00:00Z", requestedClockOut: null, reason: "Forgot to clock", isOnBehalf: false } as unknown as AttendanceCorrectionRequestView;
  const r = correctionItem(c).record;
  assert.equal(r?.kind, "correction");
  assert.equal(r && r.kind === "correction" ? r.reason : "", "Forgot to clock");
});
