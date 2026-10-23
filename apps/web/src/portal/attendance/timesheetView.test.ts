import test from "node:test";
import assert from "node:assert/strict";
import { timesheetStepper, weekTarget } from "./timesheetView";

const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];

test("timesheet target is 8 h on each Monday to Friday", () => {
  const t = weekTarget(week, () => undefined);
  assert.equal(t.minutes, 2400);
  assert.equal(t.workingDates.length, 5);
});

test("timesheet target drops holidays and leave days", () => {
  const t = weekTarget(week, (d) => (d === "2026-10-21" ? "holiday" : d === "2026-10-22" ? "leave" : undefined));
  assert.equal(t.minutes, 1440);
  assert.deepEqual(t.workingDates, ["2026-10-19", "2026-10-20", "2026-10-23"]);
});

test("timesheet stepper follows the status", () => {
  assert.equal(timesheetStepper("draft").current, 0);
  assert.equal(timesheetStepper("pending").current, 1);
  assert.equal(timesheetStepper("approved").current, 3);
  assert.equal(timesheetStepper("rejected").failed, true);
  assert.equal(timesheetStepper("cancelled").failed, true);
});
