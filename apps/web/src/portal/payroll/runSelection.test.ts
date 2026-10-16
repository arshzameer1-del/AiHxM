import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSelection, matchPastedEmployeeNumbers, selectionRequest } from "./runSelection";

const people = [
  { id: "1", employeeNumber: "EMP0001" },
  { id: "2", employeeNumber: "EMP0002" },
  { id: "3", employeeNumber: "emp-77" },
];

test("pasted employee numbers are matched whatever the separator or case", () => {
  const r = matchPastedEmployeeNumbers("emp0001, EMP0002;\nEMP-77  EMP0001 nobody", people);
  assert.deepEqual(r.matched.map((m) => m.id), ["1", "2", "3"]);
  assert.deepEqual(r.unknown, ["nobody"]);
});

test("nothing chosen sends no selection", () => {
  assert.equal(selectionRequest({ employeeIds: [], payrollAreaIds: [], employeeGroupIds: [] }), undefined);
  assert.deepEqual(selectionRequest({ employeeIds: ["1"], payrollAreaIds: [], employeeGroupIds: [] }), { employeeIds: ["1"], payrollAreaIds: [], employeeGroupIds: [] });
});

test("the selection is described in plain words", () => {
  assert.equal(describeSelection({ employeeIds: [], payrollAreaIds: [], employeeGroupIds: [] }), "Everyone the run covers");
  assert.equal(describeSelection({ employeeIds: ["a"], payrollAreaIds: [], employeeGroupIds: [] }), "1 chosen employee");
  assert.equal(describeSelection({ employeeIds: ["a", "b"], payrollAreaIds: ["x", "y", "z"], employeeGroupIds: ["g"] }), "2 chosen employees, 3 payroll areas and 1 employee group");
});
