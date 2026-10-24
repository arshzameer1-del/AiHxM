import { FormEvent, useState } from "react";
import type { ApproverType, WorkflowApproverOptions, WorkflowTemplate } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { ConditionEditor } from "./ConditionEditor";
import { conditionToDraft, draftProblem, draftToCondition, type ConditionDraft } from "./workflowConditions";
import { emptyApprover, emptyStep, stepFromDraft, stepToDraft, stepsProblem, type ApproverDraft, type StepDraft } from "./workflowDrafts";
import { APPROVER_TYPE_LABELS, ESCALATION_LABELS, FALLBACK_APPLIES_TO, FALLBACK_LABELS, FIXED_KEY_WORKFLOWS, type KnownWorkflow } from "./workflowTemplateOptions";

const SELECT = "rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent";
const INPUT = "rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const APPROVER_TYPES = Object.keys(APPROVER_TYPE_LABELS) as ApproverType[];

function RolePicker({ value, roles, onChange, label }: { value: string; roles: WorkflowApproverOptions["roles"]; onChange: (v: string) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>{r.name}</option>
      ))}
    </select>
  );
}

function PersonPicker({ value, people, onChange, label }: { value: string; people: WorkflowApproverOptions["people"]; onChange: (v: string) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
      <option value="">Choose a person…</option>
      {people.map((u) => (
        <option key={u.userAccountId} value={u.userAccountId}>{u.fullName}</option>
      ))}
    </select>
  );
}

function ApproverRow({
  approver,
  options,
  canRemove,
  hasSla,
  onChange,
  onRemove,
  testId,
}: {
  approver: ApproverDraft;
  options: WorkflowApproverOptions;
  canRemove: boolean;
  hasSla: boolean;
  onChange: (patch: Partial<ApproverDraft>) => void;
  onRemove: () => void;
  testId: string;
}) {
  const canFallback = FALLBACK_APPLIES_TO.includes(approver.approverType);
  const advancedCount = (approver.fallbackType ? 1 : 0) + (approver.escalationType || approver.escalationAction ? 1 : 0);
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex gap-2 items-center flex-wrap">
        <select aria-label="Approver type" value={approver.approverType} onChange={(e) => onChange({ approverType: e.target.value as ApproverType, ...(FALLBACK_APPLIES_TO.includes(e.target.value as ApproverType) ? {} : { fallbackType: "" as const }) })} className={SELECT}>
          {APPROVER_TYPES.map((t) => (
            <option key={t} value={t}>{APPROVER_TYPE_LABELS[t]}</option>
          ))}
        </select>
        {approver.approverType === "role" && <RolePicker label="Role" value={approver.roleId} roles={options.roles} onChange={(v) => onChange({ roleId: v })} />}
        {approver.approverType === "specific_user" && <PersonPicker label="Person" value={approver.userAccountId} people={options.people} onChange={(v) => onChange({ userAccountId: v })} />}
        {approver.approverType === "position" && (
          <select aria-label="Position" value={approver.positionId} onChange={(e) => onChange({ positionId: e.target.value })} className={SELECT}>
            <option value="">Choose a position…</option>
            {options.positions.map((p) => (
              <option key={p.id} value={p.id}>{p.title}{p.code ? ` (${p.code})` : ""}</option>
            ))}
          </select>
        )}
        {approver.approverType === "group" && (
          <select aria-label="Employee group" value={approver.employeeGroupId} onChange={(e) => onChange({ employeeGroupId: e.target.value })} className={SELECT}>
            <option value="">Choose a group…</option>
            {options.groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}
        {approver.approverType === "org_unit_head" && (
          <select aria-label="Unit" value={approver.orgUnitId} onChange={(e) => onChange({ orgUnitId: e.target.value })} className={SELECT}>
            <option value="">The requester's own unit</option>
            {options.orgUnits.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        )}
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label="Remove approver" className="text-label-tertiary hover:text-danger px-1 text-xs">
            ✕
          </button>
        )}
      </div>

      <details className="ml-1" open={advancedCount > 0}>
        <summary className="text-xs text-accent cursor-pointer select-none">When nobody answers or nobody is found{advancedCount ? ` (${advancedCount} set)` : ""}</summary>
        <div className="mt-2 space-y-2 pl-3 border-l border-black/10">
          {canFallback && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-label-secondary">If nobody is found</label>
              <select aria-label="If nobody is found" value={approver.fallbackType} onChange={(e) => onChange({ fallbackType: e.target.value as ApproverDraft["fallbackType"] })} className={SELECT}>
                <option value="">Refuse the request (default)</option>
                {(Object.keys(FALLBACK_LABELS) as Array<keyof typeof FALLBACK_LABELS>)
                  .filter((k) => !(k === "submitter_manager" && approver.approverType === "manager_of_submitter"))
                  .map((k) => (
                    <option key={k} value={k}>{FALLBACK_LABELS[k]}</option>
                  ))}
              </select>
              {approver.fallbackType === "role" && <RolePicker label="Fallback role" value={approver.fallbackRoleId} roles={options.roles} onChange={(v) => onChange({ fallbackRoleId: v })} />}
              {approver.fallbackType === "specific_user" && <PersonPicker label="Fallback person" value={approver.fallbackUserAccountId} people={options.people} onChange={(v) => onChange({ fallbackUserAccountId: v })} />}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-label-secondary">If this approval is overdue, escalate to</label>
            <select aria-label="Escalate to" value={approver.escalationType} onChange={(e) => onChange({ escalationType: e.target.value as ApproverDraft["escalationType"] })} className={SELECT}>
              <option value="">Nobody</option>
              {(Object.keys(ESCALATION_LABELS) as Array<keyof typeof ESCALATION_LABELS>).map((k) => (
                <option key={k} value={k}>{ESCALATION_LABELS[k]}</option>
              ))}
            </select>
            {approver.escalationType === "role" && <RolePicker label="Escalation role" value={approver.escalationRoleId} roles={options.roles} onChange={(v) => onChange({ escalationRoleId: v })} />}
            {approver.escalationType === "specific_user" && <PersonPicker label="Escalation person" value={approver.escalationUserAccountId} people={options.people} onChange={(v) => onChange({ escalationUserAccountId: v })} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-label-secondary">If it is still not answered</label>
            <select aria-label="Then decide automatically" value={approver.escalationAction} onChange={(e) => onChange({ escalationAction: e.target.value as ApproverDraft["escalationAction"] })} className={SELECT}>
              <option value="">Keep waiting</option>
              <option value="auto_approve">Approve automatically</option>
              <option value="auto_reject">Reject automatically</option>
            </select>
            {approver.escalationAction && (
              <>
                <input aria-label="Hours after escalation" type="number" min={1} placeholder="Hours" value={approver.escalationActionHours} onChange={(e) => onChange({ escalationActionHours: e.target.value })} className={`${SELECT} w-20`} />
                <span className="text-xs text-label-tertiary">hours after it is escalated</span>
                {!hasSla && <span className="text-xs text-warning">Set the step's SLA hours above first.</span>}
              </>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * Create or edit ONE route. Everything the engine can do is here: every approver type, several approvers, all / any / quorum,
 * parallel groups, "only when" conditions on the route and on each step, SLA, reminders, comments, what to do when nobody is
 * found, escalation and an automatic decision.
 */
export function WorkflowTemplateForm({
  workflow,
  existing,
  options,
  onCancel,
  onSaved,
}: {
  workflow: KnownWorkflow;
  existing?: WorkflowTemplate;
  options: WorkflowApproverOptions;
  onCancel: () => void;
  onSaved: (template: WorkflowTemplate) => void;
}) {
  const defaultRoleId = options.roles.find((r) => r.key === "hr_admin")?.id ?? options.roles[0]?.id ?? "";
  const [name, setName] = useState<string>(existing?.name ?? workflow.label);
  const [steps, setSteps] = useState<StepDraft[]>(existing ? existing.steps.map((s) => stepToDraft(s, defaultRoleId)) : [emptyStep(defaultRoleId)]);
  const initialStart = conditionToDraft(existing?.startCondition ?? null);
  const [start, setStart] = useState<ConditionDraft | null>(initialStart);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const optional = !FIXED_KEY_WORKFLOWS.has(workflow.key);

  const updateStep = (i: number, patch: Partial<StepDraft>) => setSteps((s) => s.map((step, idx) => (idx === i ? { ...step, ...patch } : step)));
  const updateApprover = (si: number, ai: number, patch: Partial<ApproverDraft>) =>
    setSteps((s) => s.map((step, idx) => (idx === si ? { ...step, approvers: step.approvers.map((a, k) => (k === ai ? { ...a, ...patch } : a)) } : step)));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = stepsProblem(steps);
    if (problem) return setError(problem);
    for (const [i, step] of steps.entries()) {
      const p = step.condition ? draftProblem(step.condition) : null;
      if (p) return setError(`Step ${i + 1}: ${p}`);
    }
    const startProblem = start ? draftProblem(start) : null;
    if (startProblem) return setError(`Route condition: ${startProblem}`);
    setSubmitting(true);
    try {
      const payloadSteps = steps.map(stepFromDraft);
      const startCondition = start ? draftToCondition(start) : (existing?.startCondition ?? null);
      const saved = existing
        ? await api.updateWorkflowTemplate(existing.key, { name, description: existing.description ?? undefined, triggerEvent: existing.triggerEvent ?? undefined, startCondition, steps: payloadSteps })
        : await api.createWorkflowTemplate({ key: workflow.key, name, objectKey: workflow.objectKey, startCondition, steps: payloadSteps });
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
        <label className="block text-sm font-medium mb-1" htmlFor={`wf-name-${workflow.key}`}>Workflow name</label>
        <input id={`wf-name-${workflow.key}`} required value={name} onChange={(e) => setName(e.target.value)} className={`w-full ${INPUT}`} />
      </div>

      {optional && start && (
        <details open={start.rules.length > 0}>
          <summary className="text-sm font-medium cursor-pointer select-none">Use this route only when… {start.rules.length === 0 ? "(always)" : ""}</summary>
          <div className="mt-2">
            <ConditionEditor value={start} fields={workflow.fields} onChange={setStart} testId="start-condition" intro="Leave empty to use this route for every request of this kind. Requests that do not match are decided the normal way." />
          </div>
        </details>
      )}

      <div className="space-y-3">
        <label className="block text-sm font-medium">Approval sequence — each step must be completed before the next one starts</label>
        {steps.map((step, stepIdx) => (
          <div key={stepIdx} className="bg-card rounded-lg p-3 border border-black/10 space-y-3" data-testid={`step-${stepIdx}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-label-tertiary">Step {stepIdx + 1}</span>
              <span className="flex items-center gap-3">
                {stepIdx > 0 && (
                  <button type="button" onClick={() => setSteps((s) => s.map((x, i) => (i === stepIdx - 1 ? s[stepIdx] : i === stepIdx ? s[stepIdx - 1] : x)))} className="text-xs text-label-tertiary hover:text-accent" aria-label="Move step up">
                    ↑ Move up
                  </button>
                )}
                {steps.length > 1 && (
                  <button type="button" onClick={() => setSteps((s) => s.filter((_, idx) => idx !== stepIdx))} className="text-xs text-label-tertiary hover:text-danger">
                    Remove step
                  </button>
                )}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input aria-label="Step name" placeholder={`e.g. "${stepIdx === 0 ? "HR Admin approves" : "Finance sign-off"}"`} value={step.name} onChange={(e) => updateStep(stepIdx, { name: e.target.value })} className={INPUT} />
              <input type="number" min={1} placeholder="SLA hours (optional)" value={step.slaHours} onChange={(e) => updateStep(stepIdx, { slaHours: e.target.value })} className={INPUT} />
            </div>

            <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <legend className="sr-only">Comments at this step</legend>
              <span className="text-xs text-label-tertiary">Comment is required to</span>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={step.commentOnApprove} onChange={(e) => updateStep(stepIdx, { commentOnApprove: e.target.checked })} data-testid={`step-${stepIdx}-comment-approve`} />
                Approve
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={step.commentOnReject} onChange={(e) => updateStep(stepIdx, { commentOnReject: e.target.checked })} data-testid={`step-${stepIdx}-comment-reject`} />
                Reject
              </label>
            </fieldset>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-label-tertiary">
                  Approver{step.approvers.length > 1 ? (step.approvalMode === "all" ? "s — every line must approve" : step.approvalMode === "any" ? "s — any one is enough" : `s — ${step.quorumCount || "?"} must approve`) : ""}
                </span>
                <button type="button" onClick={() => updateStep(stepIdx, { approvers: [...step.approvers, emptyApprover(defaultRoleId)] })} className="text-xs font-semibold text-accent hover:underline">
                  + Add approver
                </button>
              </div>
              {step.approvers.map((approver, approverIdx) => (
                <ApproverRow
                  key={approverIdx}
                  testId={`step-${stepIdx}-approver-${approverIdx}`}
                  approver={approver}
                  options={options}
                  canRemove={step.approvers.length > 1}
                  hasSla={Boolean(step.slaHours)}
                  onChange={(patch) => updateApprover(stepIdx, approverIdx, patch)}
                  onRemove={() => updateStep(stepIdx, { approvers: step.approvers.filter((_, k) => k !== approverIdx) })}
                />
              ))}
            </div>

            <details open={Boolean(step.reminderHours || step.approvalMode !== "all" || step.parallelGroup || (step.condition && step.condition.rules.length > 0) || step.keptCondition)}>
              <summary className="text-xs text-accent cursor-pointer select-none" data-testid={`step-${stepIdx}-more`}>More options for this step</summary>
              <div className="mt-2 space-y-3 pl-3 border-l border-black/10">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-label-secondary" htmlFor={`mode-${stepIdx}`}>When there are several approvers</label>
                  <select id={`mode-${stepIdx}`} value={step.approvalMode} onChange={(e) => updateStep(stepIdx, { approvalMode: e.target.value as StepDraft["approvalMode"] })} className={SELECT}>
                    <option value="all">Every one must approve</option>
                    <option value="any">Any one is enough</option>
                    <option value="quorum">A set number must approve</option>
                  </select>
                  {step.approvalMode === "quorum" && <input aria-label="Approvals needed" type="number" min={1} placeholder="How many" value={step.quorumCount} onChange={(e) => updateStep(stepIdx, { quorumCount: e.target.value })} className={`${SELECT} w-24`} />}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-label-secondary" htmlFor={`reminder-${stepIdx}`}>Remind approvers every</label>
                  <input id={`reminder-${stepIdx}`} type="number" min={1} placeholder="hours" value={step.reminderHours} onChange={(e) => updateStep(stepIdx, { reminderHours: e.target.value })} className={`${SELECT} w-24`} />
                  <span className="text-xs text-label-tertiary">hours (leave empty for no reminders)</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-label-secondary" htmlFor={`parallel-${stepIdx}`}>Run at the same time as neighbouring steps named</label>
                  <input id={`parallel-${stepIdx}`} placeholder="e.g. sign-offs" value={step.parallelGroup} onChange={(e) => updateStep(stepIdx, { parallelGroup: e.target.value })} className={`${SELECT} w-36`} />
                </div>
                {step.condition ? (
                  <div>
                    <div className="text-xs text-label-secondary mb-1">Only run this step when…</div>
                    <ConditionEditor value={step.condition} fields={workflow.fields} onChange={(c) => updateStep(stepIdx, { condition: c })} testId={`step-${stepIdx}-condition`} intro="Leave empty to always run this step. A step that does not match is skipped." />
                  </div>
                ) : (
                  <p className="text-xs text-label-tertiary">This step has a detailed condition set elsewhere; it is kept as it is.</p>
                )}
              </div>
            </details>
          </div>
        ))}
        <button type="button" onClick={() => setSteps((s) => [...s, emptyStep(defaultRoleId)])} className="text-xs font-semibold text-accent hover:underline">
          + Add another step
        </button>
      </div>

      {error && <div className="text-danger text-sm" role="alert">{error}</div>}

      <div className="flex gap-3">
        <button type="submit" disabled={submitting} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {submitting ? "Saving…" : existing ? "Save changes" : "Save workflow"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
