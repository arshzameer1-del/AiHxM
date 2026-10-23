import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type {
  ApproverType,
  Role,
  WorkflowApproverConfig,
  WorkflowStepConfig,
  WorkflowTemplate,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { APPROVER_TYPE_LABELS, ApproverTypeOption, KNOWN_WORKFLOWS } from "./workflowTemplateOptions";

type ApproverDraft = {
  approverType: ApproverType;
  roleId: string;
  userAccountId: string;
  /** The approver as stored, when editing. Kinds this screen cannot edit (position, group, ...) are kept as they are. */
  base?: WorkflowApproverConfig;
};

type StepDraft = {
  name: string;
  slaHours: string;
  /** The approver must write a comment to approve / to reject at this step. */
  commentOnApprove: boolean;
  commentOnReject: boolean;
  approvers: ApproverDraft[];
  /** The step as stored, when editing, so settings this screen does not show (conditions, quorum...) survive a save. */
  base?: WorkflowStepConfig;
};

const EDITABLE_APPROVER_TYPES: ApproverType[] = ["role", "specific_user", "manager_of_submitter"];

function draftFromTemplate(t: WorkflowTemplate): StepDraft[] {
  return t.steps.map((s) => ({
    name: s.name,
    slaHours: s.slaHours ? String(s.slaHours) : "",
    commentOnApprove: Boolean(s.requireCommentOnApprove),
    commentOnReject: Boolean(s.requireCommentOnReject),
    base: s,
    approvers: s.approvers.map((a) => ({ approverType: a.approverType, roleId: a.roleId ?? "", userAccountId: a.userAccountId ?? "", base: a })),
  }));
}

function emptyApprover(defaultRoleId: string): ApproverDraft {
  return { approverType: "role", roleId: defaultRoleId, userAccountId: "" };
}

function emptyStep(defaultRoleId: string): StepDraft {
  return { name: "", slaHours: "", commentOnApprove: false, commentOnReject: false, approvers: [emptyApprover(defaultRoleId)] };
}

/**
 * The create form for ONE known workflow (leave_request or job_requisition)
 * — see 0024_system_admin.sql / DECISIONS.md Decision #20. This is what
 * closes the P0 gap Decisions #18/#19 both named: before this screen
 * existed, nothing a real tenant login could reach could ever create the
 * `workflow_templates` row Leave/Recruitment submission requires.
 */
function TemplateForm({
  workflow,
  existing,
  roles,
  assignableUsers,
  onCancel,
  onSaved,
}: {
  workflow: (typeof KNOWN_WORKFLOWS)[number];
  /** Present when editing the configured template; absent when creating it. */
  existing?: WorkflowTemplate;
  roles: Role[];
  assignableUsers: { userAccountId: string | null; fullName: string }[];
  onCancel: () => void;
  onSaved: (template: WorkflowTemplate) => void;
}) {
  const defaultRoleId = roles.find((r) => r.key === "hr_admin")?.id ?? roles[0]?.id ?? "";
  const [name, setName] = useState<string>(existing?.name ?? workflow.label);
  const [steps, setSteps] = useState<StepDraft[]>(existing ? draftFromTemplate(existing) : [emptyStep(defaultRoleId)]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const loginHolders = assignableUsers.filter((u): u is { userAccountId: string; fullName: string } => Boolean(u.userAccountId));

  function updateStep(i: number, patch: Partial<StepDraft>) {
    setSteps((s) => s.map((step, idx) => (idx === i ? { ...step, ...patch } : step)));
  }
  function updateApprover(stepIdx: number, approverIdx: number, patch: Partial<ApproverDraft>) {
    setSteps((s) =>
      s.map((step, idx) =>
        idx === stepIdx
          ? { ...step, approvers: step.approvers.map((a, ai) => (ai === approverIdx ? { ...a, ...patch } : a)) }
          : step
      )
    );
  }
  function addStep() {
    setSteps((s) => [...s, emptyStep(defaultRoleId)]);
  }
  function removeStep(i: number) {
    setSteps((s) => s.filter((_, idx) => idx !== i));
  }
  function addApprover(stepIdx: number) {
    setSteps((s) => s.map((step, idx) => (idx === stepIdx ? { ...step, approvers: [...step.approvers, emptyApprover(defaultRoleId)] } : step)));
  }
  function removeApprover(stepIdx: number, approverIdx: number) {
    setSteps((s) =>
      s.map((step, idx) => (idx === stepIdx ? { ...step, approvers: step.approvers.filter((_, ai) => ai !== approverIdx) } : step))
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (steps.length === 0) {
      setError("Add at least one approval step.");
      return;
    }
    for (const step of steps) {
      if (step.approvers.length === 0) {
        setError("Every step needs at least one approver.");
        return;
      }
      for (const approver of step.approvers) {
        if (approver.approverType === "role" && !approver.roleId) {
          setError(`Every "Anyone holding a role" approver needs a role selected.`);
          return;
        }
        if (approver.approverType === "specific_user" && !approver.userAccountId) {
          setError(`Every "A specific person" approver needs a person selected.`);
          return;
        }
      }
    }
    setSubmitting(true);
    try {
      const payloadSteps: WorkflowStepConfig[] = steps.map((step, i) => ({
        // Settings the form does not show (condition, quorum, parallel group...) are carried over when editing.
        ...(step.base ?? {}),
        stepOrder: i + 1,
        name: step.name || `Step ${i + 1}`,
        slaHours: step.slaHours ? Number(step.slaHours) : undefined,
        requireCommentOnApprove: step.commentOnApprove,
        requireCommentOnReject: step.commentOnReject,
        approvers: step.approvers.map((a): WorkflowApproverConfig => {
          if (a.base && !EDITABLE_APPROVER_TYPES.includes(a.base.approverType)) return a.base;
          const escalation = a.base
            ? { escalationApproverType: a.base.escalationApproverType, escalationRoleId: a.base.escalationRoleId, escalationUserAccountId: a.base.escalationUserAccountId }
            : {};
          if (a.approverType === "role") return { ...escalation, approverType: "role", roleId: a.roleId };
          if (a.approverType === "specific_user") return { ...escalation, approverType: "specific_user", userAccountId: a.userAccountId };
          return { ...escalation, approverType: "manager_of_submitter" };
        }),
      }));
      const saved = existing
        ? await api.updateWorkflowTemplate(existing.key, {
            name,
            description: existing.description ?? undefined,
            triggerEvent: existing.triggerEvent ?? undefined,
            startCondition: existing.startCondition ?? undefined,
            steps: payloadSteps,
          })
        : await api.createWorkflowTemplate({ key: workflow.key, name, objectKey: workflow.objectKey, steps: payloadSteps });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this workflow.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div>
        <label className="block text-sm font-medium mb-1">Workflow name</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="space-y-3">
        <label className="block text-sm font-medium">Approval sequence — each step must approve before the next one starts</label>
        {steps.map((step, stepIdx) => (
          <div key={stepIdx} className="bg-card rounded-lg p-3 border border-black/10 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-label-tertiary">Step {stepIdx + 1}</span>
              {steps.length > 1 && (
                <button type="button" onClick={() => removeStep(stepIdx)} className="text-xs text-label-tertiary hover:text-danger">
                  Remove step
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder={`e.g. "${stepIdx === 0 ? "HR Admin approves" : "Finance sign-off"}"`}
                value={step.name}
                onChange={(e) => updateStep(stepIdx, { name: e.target.value })}
                className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <input
                type="number"
                min={1}
                placeholder="SLA hours (optional)"
                value={step.slaHours}
                onChange={(e) => updateStep(stepIdx, { slaHours: e.target.value })}
                className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>

            <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <legend className="sr-only">Comments at this step</legend>
              <span className="text-xs text-label-tertiary">Comment is required to</span>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={step.commentOnApprove}
                  onChange={(e) => updateStep(stepIdx, { commentOnApprove: e.target.checked })}
                  data-testid={`step-${stepIdx}-comment-approve`}
                />
                Approve
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={step.commentOnReject}
                  onChange={(e) => updateStep(stepIdx, { commentOnReject: e.target.checked })}
                  data-testid={`step-${stepIdx}-comment-reject`}
                />
                Reject
              </label>
            </fieldset>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-label-tertiary">
                  Approver{step.approvers.length > 1 ? "s — every line must approve" : ""}
                </span>
                <button type="button" onClick={() => addApprover(stepIdx)} className="text-xs font-semibold text-accent hover:underline">
                  + Add approver
                </button>
              </div>
              {step.approvers.map((approver, approverIdx) => (
                <div key={approverIdx} className="flex gap-2 items-center flex-wrap">
                  {approver.base && !EDITABLE_APPROVER_TYPES.includes(approver.base.approverType) ? (
                    <span className="text-xs text-label-secondary">Kept as configured: {approverTypeText(approver.base.approverType)}</span>
                  ) : (<>
                  <select
                    aria-label="Approver type"
                    value={approver.approverType}
                    onChange={(e) => updateApprover(stepIdx, approverIdx, { approverType: e.target.value as ApproverTypeOption })}
                    className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    {(Object.keys(APPROVER_TYPE_LABELS) as ApproverTypeOption[]).map((t) => (
                      <option key={t} value={t}>
                        {APPROVER_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>

                  {approver.approverType === "role" && (
                    <select
                      value={approver.roleId}
                      onChange={(e) => updateApprover(stepIdx, approverIdx, { roleId: e.target.value })}
                      className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  )}

                  {approver.approverType === "specific_user" && (
                    <select
                      value={approver.userAccountId}
                      onChange={(e) => updateApprover(stepIdx, approverIdx, { userAccountId: e.target.value })}
                      className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="">Choose a person…</option>
                      {loginHolders.map((u) => (
                        <option key={u.userAccountId} value={u.userAccountId}>
                          {u.fullName}
                        </option>
                      ))}
                    </select>
                  )}
                  </>)}

                  {step.approvers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeApprover(stepIdx, approverIdx)}
                      aria-label="Remove approver"
                      className="text-label-tertiary hover:text-danger px-1 text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <button type="button" onClick={addStep} className="text-xs font-semibold text-accent hover:underline">
          + Add another step
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : existing ? "Save changes" : "Save workflow"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function approverTypeText(t: ApproverType): string {
  switch (t) {
    case "position": return "whoever holds a position";
    case "group": return "a member of an employee group";
    case "org_unit_head": return "the head of the org unit";
    case "dotted_line_manager": return "the dotted-line manager";
    case "specific_user": return "a specific person";
    case "manager_of_submitter": return "the submitter's manager";
    default: return "a role";
  }
}

function stepSummary(step: WorkflowStepConfig, roles: Role[], people: { userAccountId: string | null; fullName: string }[]): string {
  const roleName = (id?: string) => roles.find((r) => r.id === id)?.name ?? "an unknown role";
  const approverText = step.approvers
    .map((a) => {
      if (a.approverType === "role") return roleName(a.roleId);
      if (a.approverType === "specific_user") return people.find((p) => p.userAccountId === a.userAccountId)?.fullName ?? "a specific person";
      return approverTypeText(a.approverType);
    })
    .join(" AND ");
  const comments = [step.requireCommentOnApprove ? "approve" : "", step.requireCommentOnReject ? "reject" : ""].filter(Boolean).join(" and ");
  return `${step.name} — ${approverText}${step.slaHours ? ` (SLA ${step.slaHours}h)` : ""}${comments ? ` · comment needed to ${comments}` : ""}`;
}

export function WorkflowTemplatesPanel() {
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [assignableUsers, setAssignableUsers] = useState<{ userAccountId: string | null; fullName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function toggleActive(key: string, isActive: boolean) {
    setToggleError(null);
    try {
      await api.setWorkflowTemplateActive(key, isActive);
      load();
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : "Could not change this workflow.");
    }
  }

  function load() {
    // The list of people only feeds the "A specific person" picker, so its failure must not take the whole screen down.
    Promise.all([api.listWorkflowTemplates(), api.listAssignableRoles(), api.listAssignableUsers().catch(() => null)])
      .then(([t, r, u]) => {
        setTemplates(t);
        setRoles(r);
        setAssignableUsers(u ?? []);
        setPeopleFailed(u === null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load workflow templates."));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!templates || !roles) return <LoadingNote />;

  return (
    <div className="space-y-4">
      <p className="text-sm text-label-tertiary">
        Every module that routes a submission for approval — Leave Management, Recruitment — needs one of these
        configured before anyone can submit anything through it. Until then, submission fails with "No active
        workflow template."
      </p>

      {peopleFailed && (
        <p className="text-xs text-warning">The list of people could not be loaded, so "A specific person" is unavailable for now. Role and manager approvers still work.</p>
      )}
      {toggleError && <p className="text-xs text-danger">{toggleError}</p>}

      {KNOWN_WORKFLOWS.map((workflow) => {
        const existing = templates.find((t) => t.key === workflow.key);
        return (
          <div key={workflow.key} className="bg-card rounded-card p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold">{workflow.label}</h3>
                <p className="text-sm text-label-tertiary mt-0.5">{workflow.description}</p>
              </div>
              {existing ? (
                <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold shrink-0 ${existing.isActive ? "bg-success/15 text-green-700" : "bg-warning/15 text-warning"}`}>
                  {existing.isActive ? "Configured" : "Switched off"}
                </span>
              ) : (
                <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary shrink-0">
                  Not configured
                </span>
              )}
            </div>

            {existing && (
              <ol className="mt-3 space-y-1 list-decimal list-inside">
                {existing.steps.map((step) => (
                  <li key={step.stepOrder} className="text-sm text-label-secondary">
                    {stepSummary(step, roles, assignableUsers)}
                  </li>
                ))}
              </ol>
            )}

            {configuring === workflow.key ? (
              <div className="mt-3">
                <TemplateForm
                  workflow={workflow}
                  existing={existing}
                  roles={roles}
                  assignableUsers={assignableUsers}
                  onCancel={() => setConfiguring(null)}
                  onSaved={() => {
                    setConfiguring(null);
                    load();
                  }}
                />
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-4 flex-wrap">
                <button
                  type="button"
                  onClick={() => setConfiguring(workflow.key)}
                  className={existing ? "border border-accent text-accent rounded-lg px-4 py-2 text-sm font-semibold" : "bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"}
                >
                  {existing ? "Edit approvers" : "Configure"}
                </button>
                {existing && (
                  <button type="button" onClick={() => toggleActive(existing.key, !existing.isActive)} className="text-sm font-medium text-label-secondary hover:text-accent">
                    {existing.isActive ? "Switch off" : "Switch on"}
                  </button>
                )}
                {existing && existing.currentVersionNo && <span className="text-xs text-label-tertiary">Version {existing.currentVersionNo}. Requests already sent keep the version they started with.</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
