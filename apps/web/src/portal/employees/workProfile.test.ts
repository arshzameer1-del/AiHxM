import assert from "node:assert/strict";
import { test } from "node:test";
import { workProfileProblem, workProfileSummary } from "./workProfile";

test("the form is checked the same way the server checks it", () => {
  assert.match(workProfileProblem({ percent: "", weekly: "", monthly: "" }) ?? "", /between 1 and 100/);
  assert.match(workProfileProblem({ percent: "101", weekly: "", monthly: "" }) ?? "", /between 1 and 100/);
  assert.match(workProfileProblem({ percent: "100", weekly: "200", monthly: "" }) ?? "", /per week/);
  assert.match(workProfileProblem({ percent: "100", weekly: "40", monthly: "100" }) ?? "", /do not agree/);
  assert.equal(workProfileProblem({ percent: "100", weekly: "40", monthly: "173" }), null);
  assert.equal(workProfileProblem({ percent: "60", weekly: "24", monthly: "" }), null);
});

test("the summary says part-time or full-time with the hours", () => {
  assert.equal(workProfileSummary({ employmentPercentage: 60, weeklyHours: 24, effectiveMonthlyHours: 104, isPartTime: true, timeRecordingProfile: "clock" }), "Part-time, 60% · 24 h a week · clock in and out");
  assert.equal(workProfileSummary({ employmentPercentage: 100, weeklyHours: null, effectiveMonthlyHours: 173.3, isPartTime: false, timeRecordingProfile: "timesheet" }), "Full-time, 100% · 173.3 h a month · timesheet");
  assert.equal(workProfileSummary({ employmentPercentage: 100, weeklyHours: null, effectiveMonthlyHours: null, isPartTime: false, timeRecordingProfile: "none" }), "Full-time, 100% · standard hours · not recorded");
});
