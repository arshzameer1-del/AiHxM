import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeaveValidationResult } from "@aihxm/shared-types";
import { findingsFor, formatMinutes, formatUnits, isTimeMode, isTimeOnly, pruneAcks, toggleAck } from "./leaveUnits";

const finding = (ruleCode: string, field: string | null, severity: "block" | "warning" | "info" = "warning") => ({
  code: "max_duration_exceeded" as const, ruleCode, ruleName: ruleCode, severity, message: "m", field, allowProceed: true,
});
const result = (blocking: ReturnType<typeof finding>[], warnings: ReturnType<typeof finding>[]): LeaveValidationResult => ({
  canSubmit: blocking.length === 0, blocking, warnings, info: [], acknowledged: [], duration: null, balance: null, settings: null, approvers: [],
});

test("minutes read as hours and minutes", () => {
  assert.equal(formatMinutes(45), "45 min");
  assert.equal(formatMinutes(60), "1 h");
  assert.equal(formatMinutes(90), "1 h 30 min");
  assert.equal(formatMinutes(0), "0 min");
});

test("units are singular for one and trimmed to two decimals", () => {
  assert.equal(formatUnits(1, "days"), "1 Day");
  assert.equal(formatUnits(1.5, "hours"), "1.5 Hours");
  assert.equal(formatUnits(0.3333, "days"), "0.33 Days");
  assert.equal(formatUnits(90, "minutes"), "90 Minutes");
});

test("duration modes", () => {
  assert.equal(isTimeMode("short_hours"), true);
  assert.equal(isTimeMode("full_day"), false);
  assert.equal(isTimeOnly("hourly"), true);
  assert.equal(isTimeOnly("flexible_partial"), false);
});

test("findings are grouped by the field they belong to", () => {
  const r = result([finding("a", "endTime", "block")], [finding("b", "startTime"), finding("c", null)]);
  assert.deepEqual(findingsFor(r, "endTime").map((f) => f.ruleCode), ["a"]);
  assert.deepEqual(findingsFor(r, "startTime").map((f) => f.ruleCode), ["b"]);
  assert.deepEqual(findingsFor(null, "startTime"), []);
});

test("confirmations are added, removed and dropped when the warning goes away", () => {
  let acks = toggleAck([], "b", true);
  acks = toggleAck(acks, "c", true);
  assert.deepEqual(acks, ["b", "c"]);
  assert.deepEqual(toggleAck(acks, "b", false), ["c"]);
  assert.deepEqual(pruneAcks(acks, result([], [finding("c", null)])), ["c"]);
  assert.equal(pruneAcks(acks, null), acks);
});
