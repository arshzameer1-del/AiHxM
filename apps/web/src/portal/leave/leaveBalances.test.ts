import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdjustmentDays } from "./leaveBalances";

test("accepts positive, negative and fractional days", () => {
  assert.deepEqual(parseAdjustmentDays("5"), { value: 5, error: null });
  assert.deepEqual(parseAdjustmentDays(" -2.5 "), { value: -2.5, error: null });
  assert.deepEqual(parseAdjustmentDays("+1"), { value: 1, error: null });
});

test("refuses empty, zero, text, too many decimals and absurd sizes", () => {
  for (const bad of ["", "0", "0.00", "abc", "1.234", "400", "-366"]) {
    const r = parseAdjustmentDays(bad);
    assert.equal(r.value, null, bad);
    assert.ok(r.error, bad);
  }
});
