import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeaveApprovalLineView } from "@aihxm/shared-types";
import { approverStepLabel, approverSummary, groupApprovalSteps } from "./leaveApprovals";

const line = (stepOrder: number, approverName: string | null, status: LeaveApprovalLineView["status"], stepName = `Step ${stepOrder}`): LeaveApprovalLineView => ({
  stepOrder,
  stepName,
  approverName,
  status,
  decidedAt: null,
});

test("pending shows who the request is waiting on", () => {
  assert.equal(approverSummary("pending", [line(1, "Maya", "approved"), line(2, "Hira", "pending")]), "Hira");
  assert.equal(approverSummary("pending", [line(1, "Maya", "pending")]), "Maya");
});

test("decided requests show who decided", () => {
  assert.equal(approverSummary("approved", [line(1, "Maya", "approved"), line(2, "Hira", "approved")]), "Hira");
  assert.equal(approverSummary("rejected", [line(1, "Maya", "approved"), line(2, "Hira", "rejected")]), "Hira");
  assert.equal(approverSummary("cancelled", [line(1, "Maya", "approved")]), "Maya");
});

test("no approval lines, or an unnamed line, shows nothing", () => {
  assert.equal(approverSummary("pending", undefined), null);
  assert.equal(approverSummary("pending", []), null);
  assert.equal(approverSummary("pending", [line(1, null, "pending")]), null);
  assert.equal(approverSummary("rejected", [line(1, "Maya", "approved")]), null);
});

test("ordinal labels", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(approverStepLabel), [
    "1st Level Approver",
    "2nd Level Approver",
    "3rd Level Approver",
    "4th Level Approver",
    "11th Level Approver",
    "12th Level Approver",
    "13th Level Approver",
    "21st Level Approver",
    "22nd Level Approver",
    "23rd Level Approver",
    "101st Level Approver",
    "111th Level Approver",
  ]);
  assert.equal(approverStepLabel(0), "1st Level Approver");
});

test("parallel lines of a step collapse into one row", () => {
  const rows = groupApprovalSteps([line(2, "Hira", "approved", "HR"), line(1, "Maya", "approved", "Manager"), line(1, "Zed", "pending", "Manager"), line(2, "Hira", "approved", "HR")]);
  assert.deepEqual(rows, [
    { stepOrder: 1, stepName: "Manager", names: ["Maya", "Zed"], status: "pending" },
    { stepOrder: 2, stepName: "HR", names: ["Hira"], status: "approved" },
  ]);
  assert.deepEqual(groupApprovalSteps(undefined), []);
  assert.equal(groupApprovalSteps([line(1, "A", "approved"), line(1, "B", "rejected")])[0].status, "rejected");
  assert.equal(groupApprovalSteps([line(1, "A", "escalated")])[0].status, "escalated");
});
