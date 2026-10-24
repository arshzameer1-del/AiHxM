import assert from "node:assert/strict";
import { test } from "node:test";
import { approverFromDraft, emptyApprover, emptyStep, stepFromDraft, stepToDraft, stepsProblem } from "./workflowDrafts";

test("a plain role step round-trips and carries only what it needs", () => {
  const step = emptyStep("role-1");
  step.name = "HR";
  const cfg = stepFromDraft(step, 0);
  assert.deepEqual(cfg, { stepOrder: 1, name: "HR", approvalMode: "all", requireCommentOnApprove: false, requireCommentOnReject: false, approvers: [{ approverType: "role", roleId: "role-1" }] });
});

test("every option survives the trip through the screen", () => {
  const stored = {
    stepOrder: 2, name: "Finance", slaHours: 24, reminderHours: 8, approvalMode: "quorum" as const, quorumCount: 2, parallelGroup: "fin",
    requireCommentOnApprove: true, requireCommentOnReject: false,
    condition: { field: "amount", op: "gte" as const, value: 50000 },
    approvers: [
      { approverType: "manager_of_manager" as const, fallbackType: "role" as const, fallbackRoleId: "r1", escalationApproverType: "manager_of_approver" as const, escalationAction: "auto_reject" as const, escalationActionHours: 48 },
      { approverType: "position" as const, positionId: "p1", fallbackType: "skip" as const },
      { approverType: "group" as const, employeeGroupId: "g1" },
    ],
  };
  const back = stepFromDraft(stepToDraft(stored, "r0"), 1);
  assert.deepEqual(back, stored);
});

test("a condition the builder cannot show is kept", () => {
  const stored = { stepOrder: 1, name: "x", approvalMode: "all" as const, requireCommentOnApprove: false, requireCommentOnReject: false, condition: { all: [{ any: [{ field: "a", op: "gt" as const, value: 1 }] }] }, approvers: [{ approverType: "manager_of_submitter" as const }] };
  const draft = stepToDraft(stored, "r");
  assert.equal(draft.condition, null);
  assert.deepEqual(stepFromDraft(draft, 0).condition, stored.condition);
});

test("fields that do not apply to the chosen kind are not sent", () => {
  const a = { ...emptyApprover("r"), approverType: "manager_of_submitter" as const, roleId: "leftover", userAccountId: "leftover", fallbackType: "skip" as const, fallbackRoleId: "leftover" };
  assert.deepEqual(approverFromDraft(a), { approverType: "manager_of_submitter", fallbackType: "skip" });
});

test("problems are named by step", () => {
  const ok = emptyStep("r");
  assert.equal(stepsProblem([ok]), null);
  assert.match(stepsProblem([])!, /at least one approval step/);
  const quorum = { ...emptyStep("r"), approvalMode: "quorum" as const, quorumCount: "3" };
  assert.match(stepsProblem([quorum])!, /Step 1: 3 approvals are needed but the step has only 1/);
  const auto = emptyStep("r");
  auto.approvers[0] = { ...auto.approvers[0], escalationAction: "auto_approve", escalationActionHours: "12" };
  assert.match(stepsProblem([auto])!, /needs an SLA/);
  auto.slaHours = "4";
  assert.equal(stepsProblem([auto]), null);
});
