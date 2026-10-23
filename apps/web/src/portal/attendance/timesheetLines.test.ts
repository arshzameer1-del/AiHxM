import test from "node:test";
import assert from "node:assert/strict";
import type { TimesheetEntryView } from "@aihxm/shared-types";
import { dayTotals, entriesFromLines, emptyLine, lineTotal, linesFromEntries, minutesByDay, monthGrid, shiftMonth } from "./timesheetLines";

const e = (workDate: string, minutes: number, taskRef: string | null, costCenterId: string | null = null, description: string | null = null): TimesheetEntryView => ({
  id: `${workDate}${taskRef}${minutes}`, workDate, minutes, costCenterId, taskRef, description,
});

test("lines: entries group by project and task, days fill the line, notes join", () => {
  const lines = linesFromEntries([e("2026-10-19", 120, "Payroll", "cc1", "Run"), e("2026-10-20", 90, "Payroll", "cc1", "Run"), e("2026-10-20", 30, "Support"), e("2026-10-21", 60, "Payroll", "cc1", "Checks")]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].hours, { "2026-10-19": "2", "2026-10-20": "1.5", "2026-10-21": "1" });
  assert.equal(lines[0].costCenterId, "cc1");
  assert.equal(lines[0].description, "Run; Checks");
  assert.equal(lines[1].task, "Support");
  assert.equal(linesFromEntries([]).length, 1, "an empty sheet still shows one line to type in");
});

test("lines: saving writes one entry per line and day above zero, and round-trips", () => {
  const days = ["2026-10-19", "2026-10-20", "2026-10-21"];
  const a = { ...emptyLine(), task: " Payroll ", costCenterId: "cc1", description: "Run", hours: { "2026-10-19": "2", "2026-10-20": "0", "2026-10-21": "1.5" } };
  const b = { ...emptyLine(), hours: { "2026-10-20": "0.5", "2026-10-21": "abc" } };
  const out = entriesFromLines([a, b], days);
  assert.deepEqual(out, [
    { workDate: "2026-10-19", minutes: 120, costCenterId: "cc1", taskRef: "Payroll", description: "Run" },
    { workDate: "2026-10-21", minutes: 90, costCenterId: "cc1", taskRef: "Payroll", description: "Run" },
    { workDate: "2026-10-20", minutes: 30, costCenterId: null, taskRef: null, description: null },
  ]);
  const back = linesFromEntries(out.map((o, i) => ({ id: String(i), workDate: o.workDate, minutes: o.minutes, costCenterId: o.costCenterId ?? null, taskRef: o.taskRef ?? null, description: o.description ?? null })));
  assert.equal(back.length, 2);
  assert.equal(lineTotal(back[0], days), 210);
});

test("lines: day totals add every line", () => {
  const days = ["2026-10-19", "2026-10-20"];
  const l1 = { ...emptyLine(), hours: { "2026-10-19": "2", "2026-10-20": "1" } };
  const l2 = { ...emptyLine(), hours: { "2026-10-19": "1.5" } };
  assert.deepEqual(dayTotals([l1, l2], days), { "2026-10-19": 210, "2026-10-20": 60 });
});

test("month: minutes by day over sheets, whole-week calendar grid, month stepping", () => {
  const sheets = [{ entries: [e("2026-10-19", 60, "x"), e("2026-10-19", 30, "y")] }, { entries: [e("2026-10-26", 45, "z")] }];
  assert.deepEqual(minutesByDay(sheets), { "2026-10-19": 90, "2026-10-26": 45 });
  const g = monthGrid("2026-10-23");
  assert.equal(g.first, "2026-10-01");
  assert.equal(g.last, "2026-10-31");
  assert.equal(g.cells.length % 7, 0);
  assert.equal(g.cells[0].day, "2026-09-28"); // Oct 1 2026 is a Thursday, the grid starts on Monday
  assert.equal(g.cells[0].inMonth, false);
  assert.equal(g.cells[g.cells.length - 1].day, "2026-11-01");
  assert.equal(shiftMonth("2026-03-31", 1), "2026-04-30");
  assert.equal(shiftMonth("2026-01-15", -1), "2025-12-15");
});
