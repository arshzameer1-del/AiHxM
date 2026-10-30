import test from "node:test";
import assert from "node:assert/strict";
import { conditionHolds, requiredKeys, visibleKeys } from "./formLayoutRules";

const layout = { sections: [{ key: "a", title: "", fields: [
  { key: "type" },
  { key: "badge", custom: true, showWhen: { field: "type", op: "equals" as const, value: "Contract" }, requiredWhen: { field: "type", op: "filled" as const } },
  { key: "note", showWhen: { field: "badge", op: "filled" as const } },
] }] };

test("conditions ignore case and treat blank as empty", () => {
  assert.equal(conditionHolds({ field: "g", op: "equals", value: "Female" }, { g: "female" }), true);
  assert.equal(conditionHolds({ field: "g", op: "filled" }, { g: "  " }), false);
  assert.equal(conditionHolds({ field: "g", op: "notEquals", value: "x" }, {}), true);
});

test("a field is shown only while its condition holds, and so is anything depending on it", () => {
  assert.deepEqual([...visibleKeys(layout, { type: "permanent", badge: "B1" })], ["type"]);
  assert.deepEqual([...visibleKeys(layout, { type: "contract", badge: "B1" })].sort(), ["badge", "note", "type"]);
  assert.deepEqual([...visibleKeys(layout, { type: "contract" })].sort(), ["badge", "type"]);
});

test("required-when only counts for a field that is showing", () => {
  assert.deepEqual([...requiredKeys(layout, { type: "contract" })], ["badge"]);
  assert.deepEqual([...requiredKeys(layout, { type: "permanent" })], []);
});
