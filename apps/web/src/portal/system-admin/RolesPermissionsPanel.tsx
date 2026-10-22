import { FormEvent, useEffect, useMemo, useState } from "react";
import type { PermissionView, Role } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";

// The names people already see in the role lists (the database names differ for the two Employee roles).
const BUILT_IN_LABELS: Record<string, string> = {
  employee_self_service: "Employee",
  ess_portal: "Employee Self Service",
};

const MODULE_LABELS: Record<string, string> = {
  hr_business_policy: "HR business policy",
  hr_reference_catalog: "HR reference catalog",
  org_unit: "Org unit",
  employee_org_assignment: "Employee org assignment",
  org_relationship: "Reporting relationship",
  org_change: "Reorganization",
};

function roleLabel(role: Pick<Role, "key" | "name">): string {
  return BUILT_IN_LABELS[role.key] ?? role.name;
}

function moduleLabel(objectKey: string | null): string {
  if (!objectKey) return "Other";
  return MODULE_LABELS[objectKey] ?? objectKey.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function keyFromName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(base) ? base : `r_${base}`;
}

/** Groups permissions by module, keeping the module order the API gives. */
function groupByModule(permissions: PermissionView[]): { module: string; items: PermissionView[] }[] {
  const map = new Map<string, PermissionView[]>();
  for (const p of permissions) {
    const k = moduleLabel(p.objectKey);
    const list = map.get(k) ?? [];
    list.push(p);
    map.set(k, list);
  }
  return Array.from(map, ([module, items]) => ({ module, items }));
}

function CreateRoleForm({
  roles,
  rolePermissions,
  held,
  onCancel,
  onCreated,
}: {
  roles: Role[];
  rolePermissions: Record<string, string[]>;
  held: Set<string>;
  onCancel: () => void;
  onCreated: (role: Role) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Give the role a name.");
      return;
    }
    // Copying a built-in role keeps only the permissions you hold yourself; anything else is left out and said so.
    const source = copyFrom ? (rolePermissions[copyFrom] ?? []) : [];
    const permissionKeys = source.filter((k) => held.has(k));
    setSaving(true);
    try {
      const role = await api.createCustomRole({ key: keyFromName(name), name: name.trim(), description: description.trim() || undefined, permissionKeys });
      onCreated(role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this role.");
    } finally {
      setSaving(false);
    }
  }

  const skipped = copyFrom ? (rolePermissions[copyFrom] ?? []).filter((k) => !held.has(k)).length : 0;

  return (
    <form onSubmit={submit} className="space-y-3 bg-black/5 rounded-lg p-3 mb-3">
      <div>
        <label htmlFor="new-role-name" className="block text-xs font-medium mb-1">Role name</label>
        <input id="new-role-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <div>
        <label htmlFor="new-role-description" className="block text-xs font-medium mb-1">What it is for (optional)</label>
        <input id="new-role-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <div>
        <label htmlFor="new-role-copy" className="block text-xs font-medium mb-1">Start from</label>
        <select id="new-role-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white">
          <option value="">Nothing (empty role)</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        {skipped > 0 && <p className="text-xs text-label-tertiary mt-1">{skipped} permission(s) of that role are left out because you do not hold them yourself.</p>}
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {saving ? "Creating…" : "Create role"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-label-secondary hover:text-label-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * System Admin: which permissions each role carries. Built-in roles are fixed and shown read-only; a company's own custom roles
 * can be created, ticked permission by permission, switched off, and then given to people under Roles & Access.
 * A custom role can only carry permissions the person editing it holds themselves (the server enforces it; the boxes for the
 * others are disabled and say so).
 */
export function RolesPermissionsPanel() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [permissions, setPermissions] = useState<PermissionView[]>([]);
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>({});
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<"role" | "matrix">("role");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function load(selectAfter?: string) {
    setError(null);
    try {
      const [roleList, permissionList, heldKeys] = await Promise.all([api.listRbacRoles(), api.listRbacPermissions(), api.listHeldPermissions()]);
      // The three proof-of-concept roles are not part of any company's setup.
      const visible = roleList.filter((r) => !r.key.startsWith("rbac_demo_"));
      const entries = await Promise.all(visible.map(async (r) => [r.id, await api.getRbacRolePermissions(r.id)] as const));
      setRoles(visible);
      setPermissions(permissionList);
      setHeld(new Set(heldKeys));
      setRolePermissions(Object.fromEntries(entries));
      setSelectedId((current) => selectAfter ?? current ?? visible[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load roles and permissions.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = roles?.find((r) => r.id === selectedId) ?? null;
  const editable = Boolean(selected && !selected.isSystem);

  // Each time another role is picked (or the data reloads) the draft starts from what is saved.
  useEffect(() => {
    if (selectedId) setDraft(new Set(rolePermissions[selectedId] ?? []));
  }, [selectedId, rolePermissions]);
  useEffect(() => {
    setNotice(null);
    setSaveError(null);
  }, [selectedId]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle ? permissions.filter((p) => p.key.includes(needle) || (p.description ?? "").toLowerCase().includes(needle) || moduleLabel(p.objectKey).toLowerCase().includes(needle)) : permissions;
    return groupByModule(list);
  }, [permissions, filter]);

  const dirty = useMemo(() => {
    if (!selectedId) return false;
    const saved = new Set(rolePermissions[selectedId] ?? []);
    if (saved.size !== draft.size) return true;
    for (const k of draft) if (!saved.has(k)) return true;
    return false;
  }, [draft, rolePermissions, selectedId]);

  function toggle(key: string) {
    setNotice(null);
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setModule(items: PermissionView[], on: boolean) {
    setNotice(null);
    setDraft((current) => {
      const next = new Set(current);
      for (const p of items) {
        if (!held.has(p.key)) continue;
        if (on) next.add(p.key);
        else next.delete(p.key);
      }
      return next;
    });
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const saved = await api.setCustomRolePermissions(selected.id, Array.from(draft));
      setRolePermissions((current) => ({ ...current, [selected.id]: saved }));
      setNotice("Saved. The change applies to everyone holding this role from their next request.");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save the permissions.");
    } finally {
      setSaving(false);
    }
  }

  async function setActive(on: boolean) {
    if (!selected) return;
    setSaveError(null);
    try {
      const updated = await api.setCustomRoleActive(selected.id, on);
      setRoles((current) => (current ? current.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)) : current));
      setNotice(on ? "Role switched on." : "Role switched off: people holding it lose its permissions, and it can no longer be given to anyone.");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not change the role.");
    }
  }

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!roles) return <LoadingNote what="roles and permissions" />;

  const customRoles = roles.filter((r) => !r.isSystem);
  const builtIn = roles.filter((r) => r.isSystem);
  const notHeldCount = permissions.filter((p) => !held.has(p.key)).length;

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-card p-4 shadow-sm text-sm text-label-secondary space-y-1">
        <p>
          Built-in roles are fixed. To give someone a different set of permissions, create a custom role here, tick what it may do, then give it to the person under <strong>Roles &amp; Access</strong>.
        </p>
        {notHeldCount > 0 && (
          <p className="text-xs text-label-tertiary">
            You can put only the {held.size} permission(s) you hold yourself into a custom role; the other {notHeldCount} show as disabled. This stops a role editor from creating more power than they have.
          </p>
        )}
      </div>

      <div className="flex gap-1">
        {(["role", "matrix"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            aria-pressed={view === v}
            className={`px-3 py-1.5 text-sm font-semibold rounded-lg ${view === v ? "bg-accent/10 text-accent" : "text-label-tertiary hover:text-label-primary"}`}
          >
            {v === "role" ? "By role" : "Matrix"}
          </button>
        ))}
      </div>

      {view === "role" ? (
        <div className="grid gap-4 md:grid-cols-[240px_1fr] items-start">
          <div className="bg-card rounded-card p-3 shadow-sm space-y-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-label-tertiary px-2 mb-1">Built-in</div>
              <div className="flex flex-col gap-0.5">
                {builtIn.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={selectedId === r.id}
                    className={`flex items-center justify-between gap-2 text-left px-2 py-1.5 rounded-lg text-sm ${selectedId === r.id ? "bg-accent/10 text-accent font-semibold" : "hover:bg-black/5"}`}
                  >
                    <span className="truncate">{roleLabel(r)}</span>
                    <span className="text-xs text-label-tertiary tabular-nums">{rolePermissions[r.id]?.length ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-label-tertiary">Custom</span>
                <button type="button" onClick={() => setCreating((c) => !c)} className="text-xs font-semibold text-accent hover:underline">
                  {creating ? "Close" : "New role"}
                </button>
              </div>
              {creating && (
                <CreateRoleForm
                  roles={roles}
                  rolePermissions={rolePermissions}
                  held={held}
                  onCancel={() => setCreating(false)}
                  onCreated={(role) => {
                    setCreating(false);
                    void load(role.id);
                  }}
                />
              )}
              <div className="flex flex-col gap-0.5">
                {customRoles.length === 0 && !creating && <p className="text-xs text-label-tertiary px-2">No custom roles yet.</p>}
                {customRoles.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={selectedId === r.id}
                    className={`flex items-center justify-between gap-2 text-left px-2 py-1.5 rounded-lg text-sm ${selectedId === r.id ? "bg-accent/10 text-accent font-semibold" : "hover:bg-black/5"}`}
                  >
                    <span className="truncate">
                      {r.name}
                      {r.isActive === false && <span className="ml-1 text-[10px] font-medium text-label-tertiary">(off)</span>}
                    </span>
                    <span className="text-xs text-label-tertiary tabular-nums">{rolePermissions[r.id]?.length ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {selected && (
            <div className="bg-card rounded-card p-5 shadow-sm min-w-0">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div className="min-w-0">
                  <h2 className="font-semibold text-base">{roleLabel(selected)}</h2>
                  <p className="text-xs text-label-tertiary mt-0.5">
                    {selected.isSystem ? "Built-in role (read only)" : selected.isActive === false ? "Custom role (switched off)" : "Custom role"}
                    {selected.description ? ` · ${selected.description}` : ""}
                  </p>
                </div>
                {editable && (
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void setActive(selected.isActive === false)} className="text-sm text-label-secondary hover:text-label-primary">
                      {selected.isActive === false ? "Switch on" : "Switch off"}
                    </button>
                    <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
                      {saving ? "Saving…" : "Save permissions"}
                    </button>
                  </div>
                )}
              </div>

              {notice && <div className="text-xs text-emerald-700 mb-2" role="status">{notice}</div>}
              {saveError && <div className="text-danger text-xs mb-2" role="alert">{saveError}</div>}

              <div className="flex items-center gap-3 mb-3">
                <label htmlFor="permission-filter" className="sr-only">Find a permission</label>
                <input
                  id="permission-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find a permission or module"
                  className="w-full max-w-sm rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <span className="text-xs text-label-tertiary whitespace-nowrap tabular-nums">{draft.size} of {permissions.length}</span>
              </div>

              <div className="space-y-4">
                {groups.map((g) => (
                  <section key={g.module}>
                    <div className="flex items-center justify-between border-b border-black/5 pb-1 mb-1">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">{g.module}</h3>
                      {editable && (
                        <span className="flex gap-3 text-xs">
                          <button type="button" onClick={() => setModule(g.items, true)} className="text-accent hover:underline">All</button>
                          <button type="button" onClick={() => setModule(g.items, false)} className="text-label-secondary hover:underline">None</button>
                        </span>
                      )}
                    </div>
                    <ul className="divide-y divide-black/5">
                      {g.items.map((p) => {
                        const on = draft.has(p.key);
                        const canTick = editable && held.has(p.key);
                        return (
                          <li key={p.id}>
                            <label className={`flex items-start gap-3 py-1.5 text-sm ${canTick ? "cursor-pointer" : ""}`}>
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={!canTick}
                                onChange={() => toggle(p.key)}
                                aria-label={p.key}
                                className="mt-0.5 rounded border-black/20"
                              />
                              <span className="min-w-0">
                                <code className={`text-xs ${on ? "text-label-primary" : "text-label-tertiary"}`}>{p.key}</code>
                                {p.description && <span className="block text-xs text-label-tertiary">{p.description}</span>}
                                {editable && !held.has(p.key) && <span className="block text-[11px] text-label-tertiary">You do not hold this permission, so you cannot give it.</span>}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {groups.length === 0 && <p className="text-sm text-label-tertiary">No permission matches that search.</p>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-card rounded-card shadow-sm overflow-x-auto">
          <table className="text-xs border-collapse min-w-full">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card text-left font-semibold px-3 py-2 border-b border-black/5 min-w-[260px]">Permission</th>
                {roles.map((r) => (
                  <th key={r.id} className="font-semibold px-2 py-2 border-b border-black/5 text-center align-bottom min-w-[84px]">
                    {roleLabel(r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupByModule(permissions).map((g) => (
                <MatrixGroup key={g.module} module={g.module} items={g.items} roles={roles} rolePermissions={rolePermissions} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MatrixGroup({ module, items, roles, rolePermissions }: { module: string; items: PermissionView[]; roles: Role[]; rolePermissions: Record<string, string[]> }) {
  const sets = useMemo(() => Object.fromEntries(roles.map((r) => [r.id, new Set(rolePermissions[r.id] ?? [])])), [roles, rolePermissions]);
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} className="sticky left-0 bg-black/5 px-3 py-1.5 font-semibold uppercase tracking-wide text-[11px] text-label-tertiary">
          {module}
        </td>
      </tr>
      {items.map((p) => (
        <tr key={p.id} className="border-b border-black/5">
          <td className="sticky left-0 bg-card px-3 py-1.5 font-mono text-[11px]">{p.key}</td>
          {roles.map((r) => (
            <td key={r.id} className="text-center py-1.5">
              {sets[r.id]?.has(p.key) ? <span aria-label="allowed" className="text-accent font-bold">●</span> : <span aria-label="not allowed" className="text-black/10">·</span>}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
