import { FormEvent, useEffect, useState } from "react";
import type { EmployeeGroupCondition, EmployeeGroupView, LeavePolicyView } from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { CONDITION_FIELDS, CONDITION_FIELD_LABELS } from "./conditionLabels";

/**
 * A module-not-licensed (404) or not-permitted (403) response reads very
 * differently to an HR Admin than "something broke" — EmployeeGroupsService
 * throws exactly these two, gated in that order (module first, then
 * permission), so the message here mirrors that.
 */
function describeError(err: unknown, moduleLabel: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return `The ${moduleLabel} module isn't enabled for this company.`;
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type GroupFormValue = {
  name: string;
  description: string;
  conditions: EmployeeGroupCondition[];
};

function emptyForm(initial?: EmployeeGroupView): GroupFormValue {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    conditions: initial?.conditions.length ? initial.conditions.map((c) => ({ ...c })) : [{ field: "department", equals: "" }],
  };
}

function GroupForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: EmployeeGroupView;
  onCancel: () => void;
  onSaved: (group: EmployeeGroupView) => void;
}) {
  const [value, setValue] = useState<GroupFormValue>(() => emptyForm(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateCondition(index: number, patch: Partial<EmployeeGroupCondition>) {
    setValue((v) => ({
      ...v,
      conditions: v.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function addCondition() {
    setValue((v) => ({ ...v, conditions: [...v.conditions, { field: "department", equals: "" }] }));
  }

  function removeCondition(index: number) {
    setValue((v) => ({ ...v, conditions: v.conditions.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: value.name,
        description: value.description || undefined,
        conditions: value.conditions,
      };
      const saved = initial ? await api.updateEmployeeGroup(initial.id, payload) : await api.createEmployeeGroup(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this group.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            required
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Description (optional)</label>
          <input
            value={value.description}
            onChange={(e) => setValue((v) => ({ ...v, description: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium">
            Conditions — an employee must match every one to belong to this group
          </label>
          <button type="button" onClick={addCondition} className="text-xs font-semibold text-accent hover:underline">
            + Add condition
          </button>
        </div>
        <div className="space-y-2">
          {value.conditions.map((condition, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select
                value={condition.field}
                onChange={(e) => updateCondition(i, { field: e.target.value as EmployeeGroupCondition["field"] })}
                className="rounded-lg border border-black/10 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {CONDITION_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {CONDITION_FIELD_LABELS[f]}
                  </option>
                ))}
              </select>
              <span className="text-sm text-label-tertiary">equals</span>
              <input
                required
                value={condition.equals}
                onChange={(e) => updateCondition(i, { equals: e.target.value })}
                placeholder="e.g. Engineering"
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
              {value.conditions.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeCondition(i)}
                  aria-label="Remove condition"
                  className="text-label-tertiary hover:text-danger px-1"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create group"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function PolicyAssignment({
  group,
  policies,
  onChanged,
}: {
  group: EmployeeGroupView;
  policies: LeavePolicyView[];
  onChanged: () => void;
}) {
  const current = group.policyAssignments.find((a) => a.policyType === "leave");
  const currentPolicy = current ? policies.find((p) => p.id === current.policyId) : undefined;
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState(policies[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAssign() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.assignGroupPolicy(group.id, { policyType: "leave", policyId: selected });
      setAssigning(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not assign this policy.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnassign() {
    setBusy(true);
    setError(null);
    try {
      await api.unassignGroupPolicy(group.id, "leave");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this assignment.");
    } finally {
      setBusy(false);
    }
  }

  if (policies.length === 0) {
    return <p className="text-xs text-label-tertiary">Create a leave policy first to assign one here.</p>;
  }

  return (
    <div>
      {currentPolicy ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-success/15 text-green-700">
            Leave policy: {currentPolicy.name}
          </span>
          <button
            onClick={handleUnassign}
            disabled={busy}
            className="text-xs font-medium text-label-tertiary hover:text-danger disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : assigning ? (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleAssign}
            disabled={busy}
            className="text-xs font-semibold text-accent disabled:opacity-50"
          >
            Assign
          </button>
          <button onClick={() => setAssigning(false)} className="text-xs text-label-tertiary">
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={() => setAssigning(true)} className="text-xs font-semibold text-accent hover:underline">
          Assign a leave policy
        </button>
      )}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

function GroupCard({
  group,
  policies,
  onChanged,
}: {
  group: EmployeeGroupView;
  policies: LeavePolicyView[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm(`Delete the "${group.name}" group? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await api.deleteEmployeeGroup(group.id);
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this group.");
    }
  }

  if (editing) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm">
        <GroupForm
          initial={group}
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
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-semibold">{group.name}</h3>
          {group.description && <p className="text-sm text-label-tertiary mt-0.5">{group.description}</p>}
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

      <div className="flex flex-wrap gap-1.5 mb-3">
        {group.conditions.map((c, i) => (
          <span
            key={i}
            className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-black/5 text-label-secondary"
          >
            {CONDITION_FIELD_LABELS[c.field]} = {c.equals}
          </span>
        ))}
      </div>

      <PolicyAssignment group={group} policies={policies} onChanged={onChanged} />
      {deleteError && <p className="text-xs text-danger mt-2">{deleteError}</p>}
    </div>
  );
}

/**
 * Task #49 — Admin Center, half one: employee segmentation. Every group
 * shown here is exactly what `EmployeeGroupsService.resolvePolicyInternal()`
 * (Phase 8/9) matches employees against — most-specific-match-wins, safe-
 * deny default when nothing matches. This screen is pure CRUD + assignment
 * against `employee_group.manage`/`leave_policy.manage`; it doesn't
 * duplicate the resolver's own matching logic anywhere.
 */
export function EmployeeGroupsPanel() {
  const [groups, setGroups] = useState<EmployeeGroupView[] | null>(null);
  const [policies, setPolicies] = useState<LeavePolicyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    Promise.all([api.listEmployeeGroups(), api.listLeavePolicies()])
      .then(([g, p]) => {
        setGroups(g);
        setPolicies(p);
      })
      .catch((err) => setError(describeError(err, "Employee")));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!groups || !policies) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Segment employees by attribute (department, location, designation, employment type or status) so the
          right leave policy applies automatically.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Group
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <GroupForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {groups.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No employee groups yet. Every employee falls back to the tenant's default leave policy until you create
          one.
        </div>
      )}

      {groups.map((group) => (
        <GroupCard key={group.id} group={group} policies={policies} onChanged={load} />
      ))}
    </div>
  );
}
