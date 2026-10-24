import assert from "node:assert/strict";
import { test } from "node:test";
import { conditionToDraft, describeCondition, draftProblem, draftToCondition, emptyRule } from "./workflowConditions";

const label = (f: string) => ({ amount: "Amount", category: "Category" }[f] ?? f);

test("no rules means no condition", () => {
  assert.equal(draftToCondition({ mode: "all", rules: [] }), null);
  assert.deepEqual(conditionToDraft(null), { mode: "all", rules: [] });
});

test("one rule becomes a simple condition, several are joined by all / any", () => {
  const one = draftToCondition({ mode: "all", rules: [{ field: "amount", op: "gte", value: "100000", value2: "" }] });
  assert.deepEqual(one, { field: "amount", op: "gte", value: 100000 });
  const both = draftToCondition({ mode: "any", rules: [{ field: "amount", op: "gte", value: "5", value2: "" }, { field: "category", op: "eq", value: "Travel", value2: "" }] });
  assert.deepEqual(both, { any: [{ field: "amount", op: "gte", value: 5 }, { field: "category", op: "eq", value: "Travel" }] });
});

test("a stored condition comes back as the same rules", () => {
  const stored = { all: [{ field: "amount", op: "between" as const, value: [10, 20] as [number, number] }, { field: "category", op: "in" as const, value: ["Travel", "Meals"] }] };
  const draft = conditionToDraft(stored)!;
  assert.equal(draft.mode, "all");
  assert.deepEqual(draft.rules.map((r) => [r.op, r.value, r.value2]), [["between", "10", "20"], ["in", "Travel, Meals", ""]]);
  assert.deepEqual(draftToCondition(draft), stored);
  assert.deepEqual(conditionToDraft({ field: "category", equals: "Travel" }), { mode: "all", rules: [{ field: "category", op: "eq", value: "Travel", value2: "" }] });
});

test("conditions the builder cannot show are left alone", () => {
  assert.equal(conditionToDraft({ all: [{ any: [{ field: "amount", op: "gt", value: 1 }] }] }), null);
  assert.equal(conditionToDraft({ field: "category", op: "not_in", value: ["x"] }), null);
});

test("problems are described in plain words", () => {
  assert.match(draftProblem({ mode: "all", rules: [emptyRule("")] })!, /Choose what/);
  assert.match(draftProblem({ mode: "all", rules: [{ field: "amount", op: "gte", value: "", value2: "" }] })!, /needs a number/);
  assert.match(draftProblem({ mode: "all", rules: [{ field: "amount", op: "between", value: "9", value2: "3" }] })!, /first number/);
  assert.equal(draftProblem({ mode: "all", rules: [{ field: "amount", op: "gte", value: "9", value2: "" }] }), null);
});

test("a condition reads as a sentence", () => {
  assert.equal(describeCondition({ all: [{ field: "amount", op: "gte", value: 100000 }, { field: "category", equals: "Travel" }] }, label), "Amount is at least 100000 and Category is Travel");
  assert.equal(describeCondition(null, label), "");
});
