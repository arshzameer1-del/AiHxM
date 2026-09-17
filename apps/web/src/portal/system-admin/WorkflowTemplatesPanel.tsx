import { FormEvent, useEffect, useState } from "react";
import type {
  ApproverType,
  Role,
  WorkflowApproverConfig,
  WorkflowStepConfig,
  WorkflowTemplate,
} from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { APPROVER_TYPE_LABELS, ApproverTypeOption, KNOWN_WORKFLOWS } from "./workflowTemplateOptions";

type ApproverDraft = {
  approverType: ApproverType;
  roleId: string;
  userAccountId: string;
};

type StepDraft = {
  name: string;
  slaHours: string;
  approvers: ApproverDraft[];
};

function emptyApprover(defaultRoleId: string): ApproverDraft {
  return { approverType: "role", roleId: defaultRoleId, userAccountId: "" };
}

function emptyStep(defaultRoleId: string): StepDraft {
  return { name: "", slaHours: "", approvers: [emptyApprover(defaultRoleId)] };
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
  roles,
  assignableUsers,
  onCancel,
  onSaved,
}: {
  workflow: (typeof KNOWN_WORKFLOWS)[number];
  roles: Role[];
  assignableUsers: { userAccountId: string | null; fullName: string }[];
  onCancel: () => void;
  onSaved: (template: WorkflowTemplate) => void;
}) {
  const defaultRoleId = roles.find((r) => r.key === "hr_admin")?.id ?? roles[0]?.id ?? "";
  const [name, setName] = useState<string>(workflow.label);
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep(defaultRoleId)]);
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
        stepOrder: i + 1,
        name: step.name || `Step ${i + 1}`,
        slaHours: step.slaHours ? Number(step.slaHours) : undefined,
        approvers: step.approvers.map((a): WorkflowApproverConfig => {
          if (a.approverType === "role") return { approverType: "role", roleId: a.roleId };
          if (a.approverType === "specific_user") return { approverType: "specific_user", userAccountId: a.userAccountId };
          return { approverType: "manager_of_submitter" };
        }),
      }));
      const saved = await api.createWorkflowTemplate({
        key: workflow.key,
        name,
        objectKey: workflow.objectKey,
        steps: payloadSteps,
      });
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
                  <select
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
          {submitting ? "Saving…" : "Save workflow"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function stepSummary(step: WorkflowStepConfig, roles: Role[]): string {
  const roleName = (id?: string) => roles.find((r) => r.id === id)?.name ?? "an unknown role";
  const approverText = step.approvers
    .map((a) => {
      if (a.approverType === "role") return roleName(a.roleId);
      if (a.approverType === "manager_of_submitter") return "the submitter's manager";
      return "a specific person";
    })
    .join(" AND ");
  return `${step.name} — ${approverText}${step.slaHours ? ` (SLA ${step.slaHours}h)` : ""}`;
}

export function WorkflowTemplatesPanel() {
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [assignableUsers, setAssignableUsers] = useState<{ userAccountId: string | null; fullName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);

  function load() {
    Promise.all([api.listWorkflowTemplates(), api.listAssignableRoles(), api.listAssignableUsers()])
      .then(([t, r, u]) => {
        setTemplates(t);
        setRoles(r);
        setAssignableUsers(u);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load workflow templates."));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!templates || !roles) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-label-tertiary">
        Every module that routes a submission for approval — Leave & Attendance, Recruitment — needs one of these
        configured before anyone can submit anything through it. Until then, submission fails with "No active
        workflow template."
      </p>

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
                <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-success/15 text-green-700 shrink-0">
                  Configured
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
                    {stepSummary(step, roles)}
                  </li>
                ))}
              </ol>
            )}

            {configuring === workflow.key ? (
              <div className="mt-3">
                <TemplateForm
                  workflow={workflow}
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
              !existing && (
                <button
                  onClick={() => setConfiguring(workflow.key)}
                  className="mt-3 bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
                >
                  Configure
                </button>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
