import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDay, formatPeriod } from "./dates";

test("plain dates and ISO timestamps give the same day", () => {
  assert.equal(formatDay("2026-09-01"), "1 Sep 2026");
  assert.equal(formatDay("2026-09-01T00:00:00.000Z"), "1 Sep 2026");
  assert.equal(formatDay("2026-09-30T23:59:59.000Z"), "30 Sep 2026");
});
test("empty and unknown values do not break", () => {
  assert.equal(formatDay(null), "");
  assert.equal(formatDay("soon"), "soon");
});
test("period", () => {
  assert.equal(formatPeriod("2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z"), "1 Sep 2026 – 30 Sep 2026");
});
