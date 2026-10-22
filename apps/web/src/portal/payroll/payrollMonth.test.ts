import assert from "node:assert/strict";
import { test } from "node:test";
import type { PayrollDashboardRunView, PayrollDashboardView } from "@aihxm/shared-types";
import { describeRun, pickMonthFocus } from "./payrollMonth";

const run = (over: Partial<PayrollDashboardRunView>): PayrollDashboardRunView => ({
  runId: "r", runType: "regular", payrollAreaId: null, periodStart: "2026-10-01", periodEnd: "2026-10-31", status: "draft", calculationMode: "sync",
  populationCount: 40, calculatedCount: 0, failedCount: 0, openExceptions: 0, partitions: { total: 0, byState: {} }, progressPercent: 0,
  throughputPerMinute: null, estimatedSecondsRemaining: null, jobStatus: null, paymentStatus: null, postingStatus: null, totalGross: null, totalNet: null, totalEmployerCost: null, ...over,
});
const dash = (active: PayrollDashboardRunView[], recent: PayrollDashboardRunView[] = []): PayrollDashboardView => ({ generatedAt: "", runsByStatus: {}, active, recent, attention: [] });

test("each status lands on the right step and earlier steps are done", () => {
  const f = describeRun(run({ status: "calculated" }));
  assert.deepEqual(f.steps.map((s) => s.state), ["done", "done", "current", "todo", "todo", "todo"]);
  assert.equal(describeRun(run({ status: "pending_approval" })).steps[3].state, "current");
  assert.equal(describeRun(run({ status: "approved" })).steps[4].state, "current");
  assert.equal(describeRun(run({ status: "finalized" })).steps[5].state, "current");
  const done = describeRun(run({ status: "closed" }));
  assert.ok(done.steps.every((s) => s.state === "done"));
  assert.equal(done.needsAction, false);
});

test("the next action reflects problems and payment progress", () => {
  assert.match(describeRun(run({ status: "calculated", failedCount: 2 })).next, /Fix the people/);
  assert.match(describeRun(run({ status: "calculated" })).next, /Review who moved/);
  assert.match(describeRun(run({ status: "finalized" })).next, /bank file/);
  assert.match(describeRun(run({ status: "payment_released", paymentStatus: "released" })).next, /Post the journal/);
  assert.match(describeRun(run({ status: "payment_released", paymentStatus: "released", postingStatus: "posted" })).next, /Reconcile/);
  assert.match(describeRun(run({ status: "calculating", progressPercent: 40, estimatedSecondsRemaining: 120 })).next, /40% done, about 2 min left/);
});

test("the focus is the newest unfinished regular run, else the newest finished one, and says if it reaches this month", () => {
  const sept = run({ runId: "sep", periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "closed" });
  const oct = run({ runId: "oct", status: "calculated" });
  const offCycle = run({ runId: "off", runType: "off_cycle", periodEnd: "2026-10-31", status: "draft" });
  assert.equal(pickMonthFocus(dash([offCycle, oct], [sept]), "2026-10-22").focus?.run.runId, "oct");
  const onlySept = pickMonthFocus(dash([], [sept]), "2026-10-22");
  assert.equal(onlySept.focus?.run.runId, "sep");
  assert.equal(onlySept.coversThisMonth, false);
  assert.equal(pickMonthFocus(dash([oct]), "2026-10-22").coversThisMonth, true);
  assert.equal(pickMonthFocus(dash([]), "2026-10-22").focus, null);
});
