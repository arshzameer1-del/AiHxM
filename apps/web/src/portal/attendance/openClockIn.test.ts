import assert from "node:assert/strict";
import { test } from "node:test";
import { staleClockInHours, staleClockInMessage } from "./openClockIn";

const now = new Date("2026-10-15T20:00:00Z");
test("a normal shift is not stale, a forgotten one is", () => {
  assert.equal(staleClockInHours("2026-10-15T09:00:00Z", now), null);
  assert.equal(staleClockInHours("2026-10-13T19:39:00Z", now), 48);
  assert.equal(staleClockInHours("not a date", now), null);
});
test("message speaks in days once it is a day or more", () => {
  assert.match(staleClockInMessage(48), /2 days/);
  assert.match(staleClockInMessage(24), /1 day\./);
  assert.match(staleClockInMessage(18), /18 hours/);
});
