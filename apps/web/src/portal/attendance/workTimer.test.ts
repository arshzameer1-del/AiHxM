import test from "node:test";
import assert from "node:assert/strict";
import type { TimesheetEntryView } from "@aihxm/shared-types";
import { clearTimer, elapsedSeconds, mergeIntoDay, minutesToLog, readTimer, startTimer, timerText, TIMER_KEY } from "./workTimer";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
}
const entry = (workDate: string, minutes: number, description: string | null = null): TimesheetEntryView => ({ id: workDate + minutes, workDate, minutes, costCenterId: null, taskRef: null, description });

test("work timer: start, read back, clear", () => {
  const store = memoryStore();
  const t = startTimer("e1", "  Fix payroll report  ", new Date("2026-10-23T05:00:00Z"), store);
  assert.equal(t.label, "Fix payroll report");
  assert.deepEqual(readTimer("e1", store), t);
  clearTimer(store);
  assert.equal(readTimer("e1", store), null);
});

test("work timer: another person's timer and broken storage are ignored", () => {
  const store = memoryStore();
  startTimer("e1", "x", new Date(), store);
  assert.equal(readTimer("e2", store), null);
  store.raw.set(TIMER_KEY, "{not json");
  assert.equal(readTimer("e1", store), null);
  store.raw.set(TIMER_KEY, JSON.stringify({ employeeId: "e1", startedAt: "nonsense" }));
  assert.equal(readTimer("e1", store), null);
  assert.equal(readTimer("e1", null), null);
});

test("work timer: elapsed and clock text", () => {
  const t = { employeeId: "e1", startedAt: "2026-10-23T05:00:00Z", label: "" };
  assert.equal(elapsedSeconds(t, new Date("2026-10-23T07:14:09Z")), 2 * 3600 + 14 * 60 + 9);
  assert.equal(elapsedSeconds(t, new Date("2026-10-23T04:00:00Z")), 0);
  assert.equal(timerText(2 * 3600 + 14 * 60 + 9), "2:14:09");
  assert.equal(timerText(5), "0:00:05");
});

test("work timer: minutes to log", () => {
  assert.equal(minutesToLog(10), 0);
  assert.equal(minutesToLog(29), 0);
  assert.equal(minutesToLog(30), 1);
  assert.equal(minutesToLog(90), 2);
  assert.equal(minutesToLog(3600), 60);
});

const taskEntry = (workDate: string, minutes: number, taskRef: string | null, description: string | null = null): TimesheetEntryView => ({ id: workDate + minutes + taskRef, workDate, minutes, costCenterId: null, taskRef, description });

test("work timer: minutes top up today's entry for the same task; other days and tasks stay as they are", () => {
  const out = mergeIntoDay([taskEntry("2026-10-22", 120, "Old"), taskEntry("2026-10-23", 60, "Fiori app"), taskEntry("2026-10-23", 30, "Report")], "2026-10-23", 30, " Fiori app ");
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { workDate: "2026-10-22", minutes: 120, costCenterId: null, taskRef: "Old", description: null });
  assert.equal(out[1].minutes, 90);
  assert.equal(out[2].minutes, 30);
});

test("work timer: a new task or a new day gets its own entry, the task is the label", () => {
  const fresh = mergeIntoDay([entry("2026-10-22", 60)], "2026-10-23", 45, "Support");
  assert.equal(fresh.length, 2);
  assert.deepEqual(fresh[1], { workDate: "2026-10-23", minutes: 45, taskRef: "Support" });
  const other = mergeIntoDay([taskEntry("2026-10-23", 10, "Support")], "2026-10-23", 5, "Review");
  assert.equal(other.length, 2);
  assert.equal(other[1].taskRef, "Review");
  const noLabel = mergeIntoDay([entry("2026-10-23", 10)], "2026-10-23", 5, "");
  assert.equal(noLabel.length, 1);
  assert.equal(noLabel[0].minutes, 15);
});
