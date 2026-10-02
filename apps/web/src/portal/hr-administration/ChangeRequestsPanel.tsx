import { FormEvent, useEffect, useState } from "react";
import type { ConfigurationChangeDomain, ConfigurationChangeOperation, ConfigurationChangeRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

/**
 * HR Administration — Change Requests tab ("then 2" Phase 6, 2026-10-02,
 * gap-table item #13, the Configuration Publish Lifecycle). Sits
 * alongside the Reference Catalogs / Business Policies tabs in the same
 * `HrAdministrationPage.tsx` workspace. Unlike those two tabs, this one
 * is domain-agnostic by construction — a change request names which of
 * the three underlying engines (reference catalog item / business
 * policy / configuration rule mapping) it targets, so this page never
 * needs its own per-domain forms; it edits `payload` as raw JSON the
 * same way `BusinessPoliciesPanel.tsx` already edits `rules` as raw
 * JSON, for the same reason — the shape genuinely differs by domain and
 * operation.
 */

const DOMAIN_LABELS: Record<ConfigurationChangeDomain, string> = {
  hr_reference_catalog_item: "Reference catalog item",
  hr_business_policy: "Business policy",
  configuration_rule_mapping: "Scoped override",
};

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-black/5 text-label-tertiary",
  validated: "bg-sky-500/10 text-sky-700",
  pending_approval: "bg-amber-500/10 text-amber-700",
  approved: "bg-emerald-500/10 text-emerald-700",
  rejected: "bg-red-500/10 text-red-700",
  published: "bg-accent/10 text-accent",
  retired: "bg-black/10 text-label-tertiary",
};

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view HR Administration change requests.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const textareaClass = `${inputClass} font-mono text-xs min-h-[90px]`;

function NewChangeRequestForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [configDomain, setConfigDomain] = useState<ConfigurationChangeDomain>("hr_business_policy");
  const [operation, setOperation] = useState<ConfigurationChangeOperation>("update");
  const [targetId, setTargetId] = useState("");
  const [payloadText, setPayloadText] = useState("{}");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let payload: Record<string, unknown>;
    try {
      payload = operation === "deactivate" ? {} : JSON.parse(payloadText || "{}");
    } catch {
      setError("Payload must be valid JSON.");
      return;
    }
    if (operation !== "create" && !targetId.trim()) {
      setError("Target id is required for an update or deactivate change.");
      return;
    }
    setSaving(true);
    try {
      await api.createConfigurationChangeRequest({
        configDomain,
        operation,
        targetId: operation === "create" ? undefined : targetId.trim(),
        payload,
        effectiveFrom: effectiveFrom || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this change request.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-black/5 rounded-lg p-3 space-y-3 mb-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Domain</label>
          <select value={configDomain} onChange={(e) => setConfigDomain(e.target.value as ConfigurationChangeDomain)} className={inputClass}>
            {Object.entries(DOMAIN_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Operation</label>
          <select value={operation} onChange={(e) => setOperation(e.target.value as ConfigurationChangeOperation)} className={inputClass}>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="deactivate">Deactivate</option>
          </select>
        </div>
        {operation !== "create" && (
          <div className="col-span-2">
            <label className="block text-xs font-medium mb-1">Target id</label>
            <input
              required
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="The id of the existing row to change — copy it from the Reference Catalogs / Business Policies tab"
              className={inputClass}
            />
          </div>
        )}
        {operation !== "deactivate" && (
          <div className="col-span-2">
            <label className="block text-xs font-medium mb-1">
              Payload (JSON) — the create/update fields for the chosen domain (e.g. {"{"}"name": "...", "rules": {"{"}...{"}"}
              {"}"} for a business policy)
            </label>
            <textarea value={payloadText} onChange={(e) => setPayloadText(e.target.value)} className={textareaClass} spellCheck={false} />
          </div>
        )}
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Effective from (optional, record-keeping only)</label>
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputClass} />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {saving ? "Creating…" : "Create draft"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RejectForm({ onCancel, onReject }: { onCancel: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex items-center gap-2 mt-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for rejecting"
        className={`${inputClass} flex-1`}
      />
      <button
        onClick={() => reason.trim() && onReject(reason.trim())}
        disabled={!reason.trim()}
        className="text-xs font-semibold text-danger hover:underline disabled:opacity-50 shrink-0"
      >
        Confirm reject
      </button>
      <button onClick={onCancel} className="text-xs font-medium text-label-tertiary hover:text-label-primary shrink-0">
        Cancel
      </button>
    </div>
  );
}

function ChangeRequestRow({ change, onChanged }: { change: ConfigurationChangeRequestView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setRowError(null);
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : "That action couldn't be completed.");
    } finally {
      setBusy(false);
      setRejecting(false);
    }
  }

  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[change.status] ?? "bg-black/5 text-label-tertiary"}`}>
              {change.status.replace(/_/g, " ")}
            </span>
            <span className="font-medium">{DOMAIN_LABELS[change.configDomain]}</span>
            <span className="text-xs text-label-tertiary">{change.operation}</span>
            {change.targetId && <span className="text-xs text-label-tertiary font-mono truncate">{change.targetId}</span>}
          </div>
          {change.validationResult && (
            <div className="text-xs text-label-tertiary mt-1.5 space-y-0.5">
              <div>{change.validationResult.impactPreview}</div>
              {change.validationResult.warnings.map((w, i) => (
                <div key={i} className={change.validationResult!.hasBlockingIssues ? "text-danger" : "text-amber-700"}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}
          {change.rejectionReason && <div className="text-xs text-danger mt-1">Rejected: {change.rejectionReason}</div>}
          {rowError && <div className="text-xs text-danger mt-1">{rowError}</div>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {change.status === "draft" && (
            <button
              onClick={() => run(() => api.validateConfigurationChangeRequest(change.id))}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              Validate
            </button>
          )}
          {change.status === "validated" && (
            <button
              onClick={() => run(() => api.submitConfigurationChangeRequest(change.id))}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              Submit for approval
            </button>
          )}
          {change.status === "pending_approval" && (
            <>
              <button
                onClick={() => run(() => api.approveConfigurationChangeRequest(change.id))}
                disabled={busy}
                className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => setRejecting(true)}
                disabled={busy}
                className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
          {change.status === "approved" && (
            <button
              onClick={() => run(() => api.publishConfigurationChangeRequest(change.id))}
              disabled={busy}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
            >
              Publish
            </button>
          )}
          {change.status === "published" && (
            <>
              <button
                onClick={() => run(() => api.retireConfigurationChangeRequest(change.id))}
                disabled={busy}
                className="text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
              >
                Retire
              </button>
              <button
                onClick={() => run(() => api.rollbackConfigurationChangeRequest(change.id))}
                disabled={busy}
                className="text-xs font-medium text-label-tertiary hover:text-accent disabled:opacity-50"
              >
                Roll back
              </button>
            </>
          )}
          {change.status === "retired" && (
            <button
              onClick={() => run(() => api.rollbackConfigurationChangeRequest(change.id))}
              disabled={busy}
              className="text-xs font-medium text-label-tertiary hover:text-accent disabled:opacity-50"
            >
              Roll back
            </button>
          )}
        </div>
      </div>
      {rejecting && (
        <RejectForm onCancel={() => setRejecting(false)} onReject={(reason) => run(() => api.rejectConfigurationChangeRequest(change.id, reason))} />
      )}
    </div>
  );
}

export function ChangeRequestsPanel() {
  const [changes, setChanges] = useState<ConfigurationChangeRequestView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  function load() {
    api
      .listConfigurationChangeRequests(undefined, statusFilter || undefined)
      .then(setChanges)
      .catch((err) => setLoadError(describeError(err)));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  return (
    <section className="bg-card rounded-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="font-semibold text-base">Change Requests</h2>
          <p className="text-xs text-label-tertiary mt-0.5">
            Draft → Validate → Submit → Approve → Publish → Retire, for a change to any reference catalog item, business
            policy, or scoped override above — with a linked rollback to the state before the change. Approving requires a
            different HR Administrator than whoever submitted it.
          </p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-xs font-semibold text-accent hover:underline shrink-0">
            + New change request
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-3 mb-3">
        <label className="text-xs text-label-tertiary">Filter by status</label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputClass} w-auto`}>
          <option value="">All</option>
          <option value="draft">Draft</option>
          <option value="validated">Validated</option>
          <option value="pending_approval">Pending approval</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="published">Published</option>
          <option value="retired">Retired</option>
        </select>
      </div>

      {loadError && <div className="text-danger text-xs mb-2">{loadError}</div>}

      {adding && (
        <NewChangeRequestForm
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      {changes === null && <div className="text-sm text-label-tertiary">Loading…</div>}
      {changes && changes.length === 0 && !adding && <div className="text-sm text-label-tertiary">No change requests yet.</div>}

      {changes && changes.length > 0 && (
        <div className="divide-y divide-black/5">
          {changes.map((c) => (
            <ChangeRequestRow key={c.id} change={c} onChanged={load} />
          ))}
        </div>
      )}
    </section>
  );
}
