import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamAttendanceMember } from "@aihxm/shared-types";
import { hoursMinutes, sortTeam, teamWindow } from "./teamAttendance";

const m = (name: string, absent: number, late: number) =>
  ({ employeeName: name, summary: { byStatus: { absent }, lateMinutes: late } }) as unknown as TeamAttendanceMember;

test("window is 14 days ending today", () => {
  assert.deepEqual(teamWindow(new Date(2026, 9, 16, 10, 0)), { from: "2026-10-03", to: "2026-10-16" });
});
test("absent days outrank late minutes; ties by name", () => {
  const out = sortTeam([m("Cy", 0, 5), m("Ann", 0, 5), m("Bob", 1, 0), m("Dee", 0, 90)]);
  assert.deepEqual(out.map((x) => x.employeeName), ["Bob", "Dee", "Ann", "Cy"]);
});
test("hours and minutes", () => assert.equal(hoursMinutes(485), "8h 05m"));
