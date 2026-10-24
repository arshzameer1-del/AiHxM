import type {
  ApproverType,
  EscalationApproverType,
  WorkflowApprovalMode,
  WorkflowApproverConfig,
  WorkflowEscalationAction,
  WorkflowFallbackType,
  WorkflowFieldCondition,
  WorkflowStepConfig,
} from "@aihxm/shared-types";
import { conditionToDraft, draftToCondition, type ConditionDraft } from "./workflowConditions";

/** BACKLOG58 - the editable shape of a template on screen, and the way back to what the server stores. Pure, so it is unit tested. */
export type ApproverDraft = {
  approverType: ApproverType;
  roleId: string;
  userAccountId: string;
  positionId: string;
  employeeGroupId: string;
  orgUnitId: string;
  fallbackType: WorkflowFallbackType | "";
  fallbackRoleId: string;
  fallbackUserAccountId: string;
  escalationType: EscalationApproverType | "";
  escalationRoleId: string;
  escalationUserAccountId: string;
  escalationAction: WorkflowEscalationAction | "";
  escalationActionHours: string;
};

export type StepDraft = {
  name: string;
  slaHours: string;
  reminderHours: string;
  approvalMode: WorkflowApprovalMode;
  quorumCount: string;
  parallelGroup: string;
  commentOnApprove: boolean;
  commentOnReject: boolean;
  /** null = the stored condition is too complex for the builder and is kept as it is. */
  condition: ConditionDraft | null;
  keptCondition: WorkflowFieldCondition | null;
  approvers: ApproverDraft[];
};

export function emptyApprover(defaultRoleId: string): ApproverDraft {
  return {
    approverType: "role", roleId: defaultRoleId, userAccountId: "", positionId: "", employeeGroupId: "", orgUnitId: "",
    fallbackType: "", fallbackRoleId: defaultRoleId, fallbackUserAccountId: "",
    escalationType: "", escalationRoleId: defaultRoleId, escalationUserAccountId: "", escalationAction: "", escalationActionHours: "",
  };
}

export function emptyStep(defaultRoleId: string): StepDraft {
  return {
    name: "", slaHours: "", reminderHours: "", approvalMode: "all", quorumCount: "", parallelGroup: "",
    commentOnApprove: false, commentOnReject: false, condition: { mode: "all", rules: [] }, keptCondition: null,
    approvers: [emptyApprover(defaultRoleId)],
  };
}

export function approverToDraft(a: WorkflowApproverConfig, defaultRoleId: string): ApproverDraft {
  return {
    approverType: a.approverType,
    roleId: a.roleId ?? defaultRoleId,
    userAccountId: a.userAccountId ?? "",
    positionId: a.positionId ?? "",
    employeeGroupId: a.employeeGroupId ?? "",
    orgUnitId: a.orgUnitId ?? "",
    fallbackType: a.fallbackType ?? "",
    fallbackRoleId: a.fallbackRoleId ?? defaultRoleId,
    fallbackUserAccountId: a.fallbackUserAccountId ?? "",
    escalationType: a.escalationApproverType ?? "",
    escalationRoleId: a.escalationRoleId ?? defaultRoleId,
    escalationUserAccountId: a.escalationUserAccountId ?? "",
    escalationAction: a.escalationAction ?? "",
    escalationActionHours: a.escalationActionHours ? String(a.escalationActionHours) : "",
  };
}

export function stepToDraft(s: WorkflowStepConfig, defaultRoleId: string): StepDraft {
  const condition = conditionToDraft(s.condition ?? null);
  return {
    name: s.name,
    slaHours: s.slaHours ? String(s.slaHours) : "",
    reminderHours: s.reminderHours ? String(s.reminderHours) : "",
    approvalMode: s.approvalMode ?? "all",
    quorumCount: s.quorumCount ? String(s.quorumCount) : "",
    parallelGroup: s.parallelGroup ?? "",
    commentOnApprove: Boolean(s.requireCommentOnApprove),
    commentOnReject: Boolean(s.requireCommentOnReject),
    condition,
    keptCondition: condition ? null : (s.condition ?? null),
    approvers: s.approvers.map((a) => approverToDraft(a, defaultRoleId)),
  };
}

export function approverFromDraft(a: ApproverDraft): WorkflowApproverConfig {
  const out: WorkflowApproverConfig = { approverType: a.approverType };
  if (a.approverType === "role") out.roleId = a.roleId;
  if (a.approverType === "specific_user") out.userAccountId = a.userAccountId;
  if (a.approverType === "position") out.positionId = a.positionId;
  if (a.approverType === "group") out.employeeGroupId = a.employeeGroupId;
  if (a.approverType === "org_unit_head" && a.orgUnitId) out.orgUnitId = a.orgUnitId;
  if (a.fallbackType) {
    out.fallbackType = a.fallbackType;
    if (a.fallbackType === "role") out.fallbackRoleId = a.fallbackRoleId;
    if (a.fallbackType === "specific_user") out.fallbackUserAccountId = a.fallbackUserAccountId;
  }
  if (a.escalationType) {
    out.escalationApproverType = a.escalationType;
    if (a.escalationType === "role") out.escalationRoleId = a.escalationRoleId;
    if (a.escalationType === "specific_user") out.escalationUserAccountId = a.escalationUserAccountId;
  }
  if (a.escalationAction) {
    out.escalationAction = a.escalationAction;
    out.escalationActionHours = Number(a.escalationActionHours);
  }
  return out;
}

export function stepFromDraft(s: StepDraft, index: number): WorkflowStepConfig {
  const out: WorkflowStepConfig = {
    stepOrder: index + 1,
    name: s.name || `Step ${index + 1}`,
    approvalMode: s.approvalMode,
    requireCommentOnApprove: s.commentOnApprove,
    requireCommentOnReject: s.commentOnReject,
    approvers: s.approvers.map(approverFromDraft),
  };
  if (s.slaHours) out.slaHours = Number(s.slaHours);
  if (s.reminderHours) out.reminderHours = Number(s.reminderHours);
  if (s.approvalMode === "quorum") out.quorumCount = Number(s.quorumCount);
  if (s.parallelGroup.trim()) out.parallelGroup = s.parallelGroup.trim();
  const condition = s.condition ? draftToCondition(s.condition) : s.keptCondition;
  if (condition) out.condition = condition;
  return out;
}

/** The first thing wrong with the steps, in plain words (the server checks the rest and its message is shown too). */
export function stepsProblem(steps: StepDraft[]): string | null {
  if (steps.length === 0) return "Add at least one approval step.";
  for (const [i, step] of steps.entries()) {
    const where = `Step ${i + 1}`;
    if (step.approvers.length === 0) return `${where} needs at least one approver.`;
    if (step.approvalMode === "quorum") {
      const q = Number(step.quorumCount);
      if (!q || q < 1) return `${where}: say how many approvals are needed.`;
      if (q > step.approvers.length) return `${where}: ${q} approvals are needed but the step has only ${step.approvers.length} approver(s).`;
    }
    for (const a of step.approvers) {
      if (a.approverType === "role" && !a.roleId) return `${where}: choose a role for each "Anyone holding a role" approver.`;
      if (a.approverType === "specific_user" && !a.userAccountId) return `${where}: choose a person for each "A specific person" approver.`;
      if (a.approverType === "position" && !a.positionId) return `${where}: choose a position.`;
      if (a.approverType === "group" && !a.employeeGroupId) return `${where}: choose an employee group.`;
      if (a.fallbackType === "role" && !a.fallbackRoleId) return `${where}: choose the role to ask when nobody is found.`;
      if (a.fallbackType === "specific_user" && !a.fallbackUserAccountId) return `${where}: choose the person to ask when nobody is found.`;
      if (a.escalationType === "role" && !a.escalationRoleId) return `${where}: choose the role to escalate to.`;
      if (a.escalationType === "specific_user" && !a.escalationUserAccountId) return `${where}: choose the person to escalate to.`;
      if (a.escalationAction) {
        if (!(Number(a.escalationActionHours) >= 1)) return `${where}: say after how many hours the automatic decision happens.`;
        if (!step.slaHours) return `${where}: an automatic decision needs an SLA (the hours after which the approval becomes overdue).`;
      }
    }
  }
  return null;
}
