import assert from "node:assert/strict";
import { test } from "node:test";
import type { CourseEnrollmentView } from "@aihxm/shared-types";
import { groupTeamLearning } from "./teamLearning";

const row = (employeeId: string, name: string, status: string, progress: number) =>
  ({ id: `${employeeId}-${status}-${progress}`, employeeId, employeeName: name, employeeNumber: `N-${employeeId}`, status, progressPercent: progress }) as unknown as CourseEnrollmentView;

test("groups by person, leaves out the manager, overdue first", () => {
  const out = groupTeamLearning(
    [row("a", "Ann", "completed", 100), row("a", "Ann", "in_progress", 50), row("b", "Bob", "overdue", 10), row("me", "Boss", "assigned", 0)],
    "me"
  );
  assert.deepEqual(out.map((m) => m.name), ["Bob", "Ann"]);
  assert.equal(out[1].completed, 1);
  assert.equal(out[1].averageProgress, 75);
  assert.equal(out[0].overdue, 1);
});
test("empty gives empty", () => assert.deepEqual(groupTeamLearning([], null), []));
