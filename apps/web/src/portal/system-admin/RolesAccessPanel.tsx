import { FormEvent, useEffect, useState } from "react";
import type { AssignableUserView, Role, SystemAdminRoleAssignmentView, TenantRoleKey } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const ROLE_LABELS: Record<TenantRoleKey, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee (Self-Service)",
  system_admin: "System Admin",
};

/**
 * Creates a login for an employee who doesn't have one yet, via the same
 * `POST /employees/:id/account` Task #48 already built (Decision #12) —
 * widened by Decision #20 so a System Admin (who holds no employee.*
 * permission at all) can also call it, gated on the new
 * user_account.manage.all permission instead.
 */
function CreateLoginForm({ user, onCancel, onCreated }: { user: AssignableUserView; onCancel: () => void; onCreated: () => void }) {
  const [password, setPassword] = useState("");
  const [roleKeys, setRoleKeys] = useState<TenantRoleKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleRole(key: TenantRoleKey) {
    setRoleKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (roleKeys.length === 0) {
      setError("Choose at least one role to grant.");
      return;
    }
    setSubmitting(true);
    try {
      await api.createEmployeeLogin(user.employeeId, { initialPassword: password, roleKeys });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this login.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-3 bg-black/5 rounded-lg p-3">
      <div>
        <label className="block text-xs font-medium mb-1">Initial password (at least 8 characters)</label>
        <input
          required
          minLength={8}
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">Grant role(s)</label>
        <div className="flex flex-wrap gap-3">
          {(Object.keys(ROLE_LABELS) as TenantRoleKey[]).map((key) => (
            <label key={key} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={roleKeys.includes(key)} onChange={() => toggleRole(key)} />
              {ROLE_LABELS[key]}
            </label>
          ))}
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={submitting} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {submitting ? "Creating…" : "Create login"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AssignRoleControl({
  user,
  roles,
  onChanged,
}: {
  user: AssignableUserView;
  roles: Role[];
  onChanged: () => void;
}) {
  const grantable = roles.filter((r) => !user.roleKeys.includes(r.key as TenantRoleKey));
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState(grantable[0]?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAssign() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.assignSystemAdminRole({ employeeId: user.employeeId, roleKey: selected as TenantRoleKey });
      setAssigning(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not assign this role.");
    } finally {
      setBusy(false);
    }
  }

  if (grantable.length === 0) return null;

  return assigning ? (
    <div className="flex items-center gap-2 flex-wrap mt-1">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="rounded-lg border border-black/10 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
      >
        {grantable.map((r) => (
          <option key={r.key} value={r.key}>
            {ROLE_LABELS[r.key as TenantRoleKey] ?? r.name}
          </option>
        ))}
      </select>
      <button onClick={handleAssign} disabled={busy} className="text-xs font-semibold text-accent disabled:opacity-50">
        Grant
      </button>
      <button onClick={() => setAssigning(false)} className="text-xs text-label-tertiary">
        Cancel
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  ) : (
    <button onClick={() => setAssigning(true)} className="text-xs font-semibold text-accent hover:underline mt-1">
      + Grant a role
    </button>
  );
}

function RevokeButton({ assignmentId, onChanged }: { assignmentId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke() {
    setBusy(true);
    setError(null);
    try {
      await api.revokeSystemAdminRole(assignmentId);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke this role.");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={handleRevoke} disabled={busy} aria-label="Revoke role" className="text-label-tertiary hover:text-danger disabled:opacity-50">
        ✕
      </button>
      {error && <span className="text-xs text-danger ml-1">{error}</span>}
    </span>
  );
}

function UserRow({
  user,
  roles,
  assignments,
  onChanged,
}: {
  user: AssignableUserView;
  roles: Role[];
  assignments: SystemAdminRoleAssignmentView[];
  onChanged: () => void;
}) {
  const [creatingLogin, setCreatingLogin] = useState(false);
  const userAssignments = assignments.filter((a) => a.userAccountId === user.userAccountId);

  return (
    <div className="bg-card rounded-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-sm">
            {user.fullName} <span className="text-label-tertiary font-normal">({user.employeeNumber})</span>
          </div>
          <div className="text-xs text-label-tertiary mt-0.5">{user.email ?? "No email on file"}</div>
        </div>
        {!user.hasLogin && (
          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary shrink-0">
            No login yet
          </span>
        )}
      </div>

      {user.hasLogin ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {userAssignments.length === 0 && <span className="text-xs text-label-tertiary">No roles assigned</span>}
          {userAssignments.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-success/15 text-green-700"
            >
              {ROLE_LABELS[a.roleKey] ?? a.roleName}
              <RevokeButton assignmentId={a.id} onChanged={onChanged} />
            </span>
          ))}
        </div>
      ) : creatingLogin ? (
        <CreateLoginForm
          user={user}
          onCancel={() => setCreatingLogin(false)}
          onCreated={() => {
            setCreatingLogin(false);
            onChanged();
          }}
        />
      ) : (
        <button onClick={() => setCreatingLogin(true)} className="mt-2 text-xs font-semibold text-accent hover:underline">
          Create login
        </button>
      )}

      {user.hasLogin && <AssignRoleControl user={user} roles={roles} onChanged={onChanged} />}
    </div>
  );
}

/**
 * Task #52 (Decision #20) — the self-service, tenant-scoped counterpart to
 * Platform Admin's `/platform/role-assignments`. Deliberately shows only
 * name/email/login-status/roles per employee (`AssignableUserView`), never
 * the full `EmployeeView` — a System Admin has no employee.view.* of their
 * own (0024_system_admin.sql) and this screen must not become a back door
 * around that.
 */
export function RolesAccessPanel() {
  const [users, setUsers] = useState<AssignableUserView[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [assignments, setAssignments] = useState<SystemAdminRoleAssignmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([api.listAssignableUsers(), api.listAssignableRoles(), api.listSystemAdminRoleAssignments()])
      .then(([u, r, a]) => {
        setUsers(u);
        setRoles(r);
        setAssignments(a);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load users and roles."));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!users || !roles || !assignments) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-label-tertiary">
        Every employee in this company, whether they have a login yet, and which roles it holds. hr_admin and
        system_admin are independent — grant either, both, or split them across different people.
      </p>
      {users.map((user) => (
        <UserRow key={user.employeeId} user={user} roles={roles} assignments={assignments} onChanged={load} />
      ))}
    </div>
  );
}
