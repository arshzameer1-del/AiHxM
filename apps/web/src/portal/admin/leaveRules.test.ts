import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeaveRuleConditionGroup } from "@aihxm/shared-types";
import { draftFromRule, draftToRequest, paramsToRequest, ruleProblem, scopeSummary, slugify, changeField, changeOperator, clockToMinutes, conditionProblem, countConditions, describeGroup, emptyGroup, minutesToClock, newCondition, operatorsFor, updateAt } from "./leaveRules";

test("clock times convert both ways and reject nonsense", () => {
  assert.equal(clockToMinutes("09:30"), 570);
  assert.equal(clockToMinutes("24:00"), null);
  assert.equal(clockToMinutes("9:30"), null);
  assert.equal(minutesToClock(570), "09:30");
});

test("a rule reads as a sentence", () => {
  const g: LeaveRuleConditionGroup = {
    op: "and",
    children: [
      { field: "durationMinutes", operator: "gt", value: 120 },
      { op: "or", children: [{ field: "dayOfWeek", operator: "in", value: [1, 5] }, { field: "startMinute", operator: "between", value: [480, 600] }] },
    ],
  };
  assert.equal(describeGroup(g), "Duration (minutes) is more than 120 AND (Day of the week is one of Monday, Friday OR Start time is between 08:00 and 10:00)");
  assert.equal(describeGroup(emptyGroup()), "Always applies");
  assert.equal(countConditions(g), 3);
});

test("changing the field or operator keeps the condition well-formed", () => {
  const c = newCondition("durationMinutes");
  assert.equal(c.operator, "eq");
  const between = changeOperator({ ...c, value: 60 }, "between");
  assert.deepEqual(between.value, [60, 60]);
  const list = changeOperator(newCondition("employmentType"), "in");
  assert.deepEqual(list.value, []);
  assert.equal(changeField(c, "isTimed").value, true);
  assert.deepEqual(operatorsFor("bool"), ["eq"]);
  assert.equal(changeField({ ...c, operator: "gt", value: 5 }, "noticeMinutes").operator, "gt");
});

test("problems are reported before saving", () => {
  assert.match(conditionProblem({ op: "and", children: [{ field: "employmentType", operator: "in", value: [] }] }) ?? "", /at least one value/);
  assert.match(conditionProblem({ op: "and", children: [{ field: "leaveType", operator: "eq", value: " " }] }) ?? "", /Enter a value/);
  assert.match(conditionProblem({ op: "and", children: [{ field: "durationMinutes", operator: "between", value: [10, 5] }] }) ?? "", /first value/);
  assert.equal(conditionProblem({ op: "and", children: [{ field: "durationMinutes", operator: "gt", value: 5 }] }), null);
  const many: LeaveRuleConditionGroup = { op: "or", children: Array.from({ length: 21 }, () => newCondition()) };
  assert.match(conditionProblem(many) ?? "", /at most 20/);
});

test("nodes can be edited and removed by path without touching the rest", () => {
  const root: LeaveRuleConditionGroup = { op: "and", children: [newCondition("durationMinutes"), { op: "or", children: [newCondition("isTimed")] }] };
  const edited = updateAt(root, [1, 0], (n) => ({ ...n, value: false }) as never);
  assert.equal(((edited.children[1] as LeaveRuleConditionGroup).children[0] as { value: boolean }).value, false);
  assert.equal((root.children[1] as LeaveRuleConditionGroup).children.length, 1);
  const removed = updateAt(root, [0], () => null);
  assert.equal(removed.children.length, 1);
});

test("a rule name becomes a code the server accepts", () => {
  assert.equal(slugify("Short leave: max 2 hours!"), "short_leave_max_2_hours");
  assert.equal(slugify("2 hour cap"), "rule_2_hour_cap");
  assert.equal(slugify("!!!"), "");
});

test("only the parameters a validation understands are sent, as numbers and lists", () => {
  assert.deepEqual(paramsToRequest({ maxMinutes: "120", minMinutes: "", allowedEmploymentTypes: "permanent, contract", dailyLimitMinutes: "60" }, ["maxMinutes", "allowedEmploymentTypes"]), {
    maxMinutes: 120,
    allowedEmploymentTypes: ["permanent", "contract"],
  });
});

test("a new rule is turned into a request, a system rule keeps its code and type out of it", () => {
  const draft = draftFromRule(null, { validationType: "max_duration_exceeded", message: "Too long", severity: "warning" });
  draft.name = "Two hour cap";
  draft.params = { maxMinutes: "120" };
  const req = draftToRequest(draft, ["maxMinutes"]);
  assert.equal(req.code, "two_hour_cap");
  assert.equal(req.validationType, "max_duration_exceeded");
  assert.equal(req.severity, "warning");
  assert.equal(req.conditions, null);
  assert.deepEqual(req.params, { maxMinutes: 120 });
  const existing = { ...draft, id: "abc", isLocked: true };
  const upd = draftToRequest(existing, ["maxMinutes"]);
  assert.equal("code" in upd, false);
  assert.equal(upd.severity, "block");
  assert.equal(upd.isActive, true);
});

test("a rule is checked before saving", () => {
  const d = draftFromRule(null, { validationType: "max_duration_exceeded", message: "m", severity: "block" });
  assert.match(ruleProblem(d, []) ?? "", /name/);
  d.name = "x";
  assert.equal(ruleProblem(d, []), null);
  assert.match(ruleProblem({ ...d, priority: "0" }, []) ?? "", /Priority/);
  assert.match(ruleProblem({ ...d, effectiveFrom: "2026-02-01", effectiveTo: "2026-01-01" }, []) ?? "", /cannot end/);
  assert.match(ruleProblem({ ...d, messages: [{ locale: "urdu", text: "x" }] }, []) ?? "", /language code/);
  assert.match(ruleProblem({ ...d, params: { maxMinutes: "-5" } }, ["maxMinutes"]) ?? "", /zero or more/);
});

test("scope reads in one line", () => {
  assert.equal(scopeSummary({ leaveTypes: [], policyIds: [], employeeGroupIds: [] }, (c) => c), "Everyone");
  assert.equal(scopeSummary({ leaveTypes: ["short_leave"], policyIds: ["a", "b"], employeeGroupIds: ["g"] }, () => "Short leave"), "Short leave · 2 policies · 1 group");
});
