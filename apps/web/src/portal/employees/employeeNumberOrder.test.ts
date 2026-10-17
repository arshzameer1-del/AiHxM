import assert from "node:assert/strict";
import { test } from "node:test";
import { compareEmployeeNumbers } from "./employeeNumberOrder";

test("numbers sort by the number inside, mixed styles together", () => {
  const sorted = ["EMP1002", "EMP-0019", "EMP-0003", "EMP-10", "EMP-9", "EMP-0001"].sort(compareEmployeeNumbers);
  assert.deepEqual(sorted, ["EMP-0001", "EMP-0003", "EMP-9", "EMP-10", "EMP-0019", "EMP1002"]);
});
test("same number: letters decide, and a number with no digits goes first", () => {
  assert.deepEqual(["B-5", "A-5", "NONE"].sort(compareEmployeeNumbers), ["NONE", "A-5", "B-5"]);
});
