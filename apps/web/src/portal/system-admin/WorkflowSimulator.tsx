import { useState } from "react";
import type { WorkflowApproverOptions, WorkflowSimulationResult, WorkflowTemplate } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import type { KnownWorkflow } from "./workflowTemplateOptions";

const OUTCOME_TEXT: Record<string, string> = { person: "Person", role: "Role", group: "Group", skipped: "Skipped", blocked: "Cannot be found" };

/** "Who would approve this?" - runs the saved route for a chosen requester and example values, sending nothing. */
export function WorkflowSimulator({ workflow, template, options }: { workflow: KnownWorkflow; template: WorkflowTemplate; options: WorkflowApproverOptions }) {
  const [subject, setSubject] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WorkflowSimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setError(null);
    setResult(null);
    if (!subject) return setError("Choose who is asking.");
    const record: Record<string, unknown> = {};
    for (const f of workflow.fields) {
      const raw = (values[f.key] ?? "").trim();
      if (raw === "") continue;
      record[f.key] = f.kind === "number" ? Number(raw) : raw;
    }
    setBusy(true);
    try {
      setResult(await api.simulateWorkflow(template.key, { subjectUserAccountId: subject, record }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check this route.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-3" data-testid={`simulate-${template.key}`}>
      <summary className="text-sm font-medium text-accent cursor-pointer select-none">Who would approve this?</summary>
      <div className="mt-3 space-y-3 bg-black/5 rounded-lg p-3">
        <p className="text-xs text-label-tertiary">Pick a requester and example values to see who this route would ask, step by step. Nothing is sent.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="block mb-1 text-label-secondary">Who is asking?</span>
            <select value={subject} onChange={(e) => setSubject(e.target.value)} className="rounded-lg border border-black/10 px-2 py-1.5 text-xs">
              <option value="">Choose a person…</option>
              {options.people.map((p) => (
                <option key={p.userAccountId} value={p.userAccountId}>{p.fullName}</option>
              ))}
            </select>
          </label>
          {workflow.fields.map((f) => (
            <label key={f.key} className="text-xs">
              <span className="block mb-1 text-label-secondary">{f.label}</span>
              <input type={f.kind === "number" ? "number" : "text"} value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className="rounded-lg border border-black/10 px-2 py-1.5 text-xs w-32" />
            </label>
          ))}
          <button type="button" onClick={run} disabled={busy} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
            {busy ? "Checking…" : "Check"}
          </button>
        </div>
        {error && <div role="alert" className="text-danger text-xs">{error}</div>}
        {result && (
          <div data-testid="simulation-result" className="space-y-2">
            {!result.startConditionMatched && <p className="text-xs text-warning">These values do not match this route's "use only when" condition, so such a request would not use this route.</p>}
            {result.blocked && <p className="text-xs text-danger">A required approver cannot be found, so this request could not be submitted. Add a fallback to the approver, or fix the requester's reporting line.</p>}
            <ol className="space-y-2">
              {result.steps.map((step) => (
                <li key={step.stepOrder} className="text-xs">
                  <div className="font-semibold">
                    Step {step.stepOrder}: {step.name}
                    {step.status === "skipped_condition" && <span className="ml-2 font-normal text-label-tertiary">skipped - its condition does not match these values</span>}
                    {step.status === "skipped_nobody" && <span className="ml-2 font-normal text-label-tertiary">skipped - nobody to ask</span>}
                    {step.status === "will_run" && step.approvers.length > 1 && (
                      <span className="ml-2 font-normal text-label-tertiary">
                        {step.approvalMode === "all" ? "every one must approve" : step.approvalMode === "any" ? "any one is enough" : `${step.quorumCount} must approve`}
                      </span>
                    )}
                    {step.slaHours ? <span className="ml-2 font-normal text-label-tertiary">overdue after {step.slaHours}h</span> : null}
                  </div>
                  {step.status !== "skipped_condition" &&
                    step.approvers.map((a, i) => (
                      <div key={i} className="ml-3 text-label-secondary">
                        <span className={a.outcome === "blocked" ? "text-danger" : ""}>
                          {a.label}: {a.names.length > 0 ? a.names.join(", ") : OUTCOME_TEXT[a.outcome]}
                        </span>
                        {a.note && <span className="text-label-tertiary"> - {a.note}</span>}
                      </div>
                    ))}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </details>
  );
}
