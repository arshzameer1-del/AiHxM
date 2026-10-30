import test from "node:test";
import assert from "node:assert/strict";
import type { FormLayout } from "@aihxm/shared-types";
import { addField, addSection, moveField, nudgeField, removeField, removeSection, slugKey, updateField } from "./formDesignerOps";

const base = () => ({ sections: [
  { key: "a", title: "A", fields: [{ key: "x" }, { key: "y", showWhen: { field: "x", op: "filled" as const } }] },
  { key: "b", title: "B", fields: [{ key: "z" }] },
] });
const keys = (l: FormLayout) => l.sections.map((s) => s.fields.map((f) => f.key));

test("a field moves between sections and within one", () => {
  assert.deepEqual(keys(moveField(base(), "x", "b", 1)), [["y"], ["z", "x"]]);
  assert.deepEqual(keys(moveField(base(), "y", "a", 0)), [["y", "x"], ["z"]]);
});

test("nudging past the edge crosses into the next section", () => {
  assert.deepEqual(keys(nudgeField(base(), "y", 1)), [["x"], ["y", "z"]]);
  assert.deepEqual(keys(nudgeField(base(), "z", -1)), [["x", "y", "z"], []]);
  assert.deepEqual(keys(nudgeField(base(), "x", -1)), [["x", "y"], ["z"]]);
});

test("removing a field also drops rules that looked at it", () => {
  const out = removeField(base(), "x");
  assert.deepEqual(keys(out), [["y"], ["z"]]);
  assert.equal(out.sections[0].fields[0].showWhen, undefined);
});

test("a field cannot be added twice, and removing a section keeps its fields", () => {
  assert.equal(addField(base(), "b", { key: "x" }).sections[1].fields.length, 1);
  assert.deepEqual(keys(removeSection(base(), "b")), [["x", "y", "z"]]);
  assert.deepEqual(keys(removeSection(removeSection(base(), "b"), "a")), [["x", "y", "z"]]);
});

test("rules can be set and cleared on a field", () => {
  const l = updateField(base(), "z", { readOnly: true, requiredWhen: { field: "x", op: "filled" } });
  assert.equal(l.sections[1].fields[0].readOnly, true);
  const cleared = updateField(l, "z", { readOnly: false, requiredWhen: undefined });
  assert.deepEqual(cleared.sections[1].fields[0], { key: "z" });
  assert.equal(addSection(base()).sections[2].key, "section_3");
});

test("custom field keys are valid and unique", () => {
  assert.equal(slugKey("Medical Insurance Number", new Set()), "medical_insurance_number");
  assert.equal(slugKey("Medical Insurance Number", new Set(["medical_insurance_number"])), "medical_insurance_number_2");
  assert.equal(slugKey("123", new Set()), "field");
  assert.match(slugKey("شناختی", new Set()), /^[a-z][a-z0-9_]*$/);
});
