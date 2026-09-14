import { FormEvent, useEffect, useState } from "react";
import type { LeavePolicyView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type PolicyFormValue = {
  name: string;
  annualLeaveDays: string;
  casualLeaveDays: string;
  sickLeaveDays: string;
  isDefault: boolean;
};

function emptyForm(initial?: LeavePolicyView): PolicyFormValue {
  return {
    name: initial?.name ?? "",
    annualLeaveDays: String(initial?.annualLeaveDays ?? 0),
    casualLeaveDays: String(initial?.casualLeaveDays ?? 0),
    sickLeaveDays: String(initial?.sickLeaveDays ?? 0),
    isDefault: initial?.isDefault ?? false,
  };
}

function DayField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <input
        type="number"
        min={0}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </div>
  );
}

function PolicyForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: LeavePolicyView;
  onCancel: () => void;
  onSaved: (policy: LeavePolicyView) => void;
}) {
  const [value, setValue] = useState<PolicyFormValue>(() => emptyForm(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: value.name,
        annualLeaveDays: Number(value.annualLeaveDays) || 0,
        casualLeaveDays: Number(value.casualLeaveDays) || 0,
        sickLeaveDays: Number(value.sickLeaveDays) || 0,
        isDefault: value.isDefault,
      };
      const saved = initial ? await api.updateLeavePolicy(initial.id, payload) : await api.createLeavePolicy(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this policy.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <input
          required
          value={value.name}
          onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <DayField
          label="Annual leave (days/yr)"
          value={value.annualLeaveDays}
          onChange={(v) => setValue((s) => ({ ...s, annualLeaveDays: v }))}
        />
        <DayField
          label="Casual leave (days/yr)"
          value={value.casualLeaveDays}
          onChange={(v) => setValue((s) => ({ ...s, casualLeaveDays: v }))}
        />
        <DayField
          label="Sick leave (days/yr)"
          value={value.sickLeaveDays}
          onChange={(v) => setValue((s) => ({ ...s, sickLeaveDays: v }))}
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.isDefault}
          onChange={(e) => setValue((v) => ({ ...v, isDefault: e.target.checked }))}
          className="rounded border-black/20"
        />
        Make this the tenant default (applies to any employee no group covers)
      </label>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create policy"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function PolicyRow({ policy, onChanged }: { policy: LeavePolicyView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm(`Delete the "${policy.name}" policy? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await api.deleteLeavePolicy(policy.id);
      onChanged();
    } catch (err) {
      // ConflictException ("still assigned to a group") surfaces here verbatim —
      // exactly the guardrail EmployeeGroupsService.deleteLeavePolicy() enforces.
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this policy.");
    }
  }

  if (editing) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm">
        <PolicyForm
          initial={policy}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      </div>
    );
  }

  return (
    <div className="bg-card rounded-card p-5 shadow-sm">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{policy.name}</h3>
          {policy.isDefault && (
            <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent">
              Tenant default
            </span>
          )}
        </div>
        <div className="flex gap-3 shrink-0">
          <button onClick={() => setEditing(true)} className="text-xs font-semibold text-accent hover:underline">
            Edit
          </button>
          <button onClick={handleDelete} className="text-xs font-medium text-label-tertiary hover:text-danger">
            Delete
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Annual</div>
          <div className="font-mono">{policy.annualLeaveDays} days</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Casual</div>
          <div className="font-mono">{policy.casualLeaveDays} days</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-label-tertiary mb-0.5">Sick</div>
          <div className="font-mono">{policy.sickLeaveDays} days</div>
        </div>
      </div>
      {deleteError && <p className="text-xs text-danger mt-2">{deleteError}</p>}
    </div>
  );
}

/**
 * Task #49 — Admin Center, half two: the concrete policies employee
 * groups (or the tenant default) resolve to. `isDefault` is enforced as
 * "at most one" server-side (a DB partial unique index, not just this
 * UI) — checking the box here simply calls the same update/create
 * endpoint that already un-defaults whichever policy held it before.
 */
export function LeavePoliciesPanel() {
  const [policies, setPolicies] = useState<LeavePolicyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.listLeavePolicies().then(setPolicies).catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!policies) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Define leave entitlements once, then assign each policy to the employee groups it should apply to.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Policy
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <PolicyForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {policies.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No leave policies yet. Create one and mark it as the tenant default so every employee has an
          entitlement even before you set up groups.
        </div>
      )}

      {policies.map((policy) => (
        <PolicyRow key={policy.id} policy={policy} onChanged={load} />
      ))}
    </div>
  );
}
