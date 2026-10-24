import { useState } from "react";
import type { WorkflowApproverConfig, WorkflowStepConfig, WorkflowTemplate } from "@aihxm/shared-types";
import { api, ApiError, type WorkflowTemplateVersion } from "../../api/client";

type StoredStep = Record<string, unknown> & { approvers?: Array<Record<string, unknown>> };

/** A stored version (nulls everywhere) as the plain config the update call accepts. */
export function stepFromStoredVersion(step: StoredStep): WorkflowStepConfig {
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && v !== undefined && k !== "id"));
  return { ...strip(step), approvers: (step.approvers ?? []).map((a) => strip(a) as unknown as WorkflowApproverConfig) } as unknown as WorkflowStepConfig;
}

/** Earlier versions of a route: what each one asked, and a way to put one back (as a new version). */
export function WorkflowHistory({ template, onRestored }: { template: WorkflowTemplate; onRestored: () => void }) {
  const [versions, setVersions] = useState<WorkflowTemplateVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (versions) return;
    try {
      setVersions(await api.listWorkflowTemplateVersions(template.key));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the history.");
    }
  }

  async function restore(v: WorkflowTemplateVersion) {
    setError(null);
    setBusy(true);
    try {
      await api.updateWorkflowTemplate(template.key, {
        name: template.name,
        description: template.description ?? undefined,
        triggerEvent: v.definition.triggerEvent ?? undefined,
        startCondition: v.definition.startCondition ?? null,
        steps: v.definition.steps.map((s) => stepFromStoredVersion(s as unknown as StoredStep)),
      });
      setVersions(null);
      onRestored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not restore this version.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-2" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()} data-testid={`history-${template.key}`}>
      <summary className="text-sm font-medium text-label-secondary cursor-pointer select-none">Version history</summary>
      <div className="mt-2 space-y-1.5">
        {error && <div role="alert" className="text-danger text-xs">{error}</div>}
        {!versions && !error && <p className="text-xs text-label-tertiary">Loading…</p>}
        {versions?.map((v) => (
          <div key={v.versionNo} className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-semibold">Version {v.versionNo}</span>
            <span className="text-label-tertiary">{new Date(v.createdAt).toLocaleString()}</span>
            <span className="text-label-secondary">{v.definition.steps.length} step(s): {v.definition.steps.map((s) => s.name).join(" → ")}</span>
            {v.versionNo === template.currentVersionNo ? (
              <span className="text-label-tertiary">current</span>
            ) : (
              <button type="button" disabled={busy} onClick={() => void restore(v)} className="text-accent font-semibold hover:underline disabled:opacity-50">
                Use this version again
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
