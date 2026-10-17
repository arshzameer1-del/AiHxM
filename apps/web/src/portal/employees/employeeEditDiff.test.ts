import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptiedFields } from "./employeeEditDiff";

const base = { phone: "0300", department: "Ops", designation: "Clerk", location: "Karachi", salaryBand: "B2", maritalStatus: "single", orgUnitId: null, locationId: null };
const same = { phone: "0300", department: "Ops", designation: "Clerk", location: "Karachi", salaryBand: "B2", maritalStatus: "single" };

test("nothing emptied when nothing changed", () => {
  assert.deepEqual(emptiedFields(base, same), []);
});
test("a field that had a value and is now blank is named", () => {
  assert.deepEqual(emptiedFields(base, { ...same, phone: "", designation: "  " }), ["phone", "designation"]);
});
test("a field that was already empty is not sent", () => {
  assert.deepEqual(emptiedFields({ ...base, phone: null }, { ...same, phone: "" }), []);
});
test("department and location linked to the organization are never cleared from the form", () => {
  assert.deepEqual(emptiedFields({ ...base, orgUnitId: "u", locationId: "l" }, { ...same, department: "", location: "" }), []);
});
