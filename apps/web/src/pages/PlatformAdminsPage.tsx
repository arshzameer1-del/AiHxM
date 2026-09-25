import { FormEvent, useEffect, useState } from "react";
import type { CompanyDashboardRow, PlatformAdmin, PlatformAdminAccessLevel } from "@aihxm/shared-types";
import { api, ApiError } from "../api/client";
import { StatusPill } from "../components/StatusPill";
import { useStepUp } from "../hooks/useStepUp";

const ACCESS_LEVEL_LABEL: Record<PlatformAdminAccessLevel, string> = {
  full: "Full access",
  read_only: "Read-only",
  scoped: "Scoped to tenants",
};

const ACCESS_LEVEL_CLASS: Record<PlatformAdminAccessLevel, string> = {
  full: "bg-gray-100 text-gray-700",
  read_only: "bg-blue-100 text-blue-800",
  scoped: "bg-amber-100 text-amber-800",
};

/**
 * Manages our own ops team's accounts — distinct from Company Super Admins
 * (see CompanyDetailPage's Admins tab). The very first Platform Admin is
 * bootstrapped outside the UI entirely (apps/api/src/database/seed.ts),
 * since nothing can sign in to create one through here until it exists;
 * this screen is how every Platform Admin after that first one gets added.
 *
 * Phase 2 gap-fill item #7 — every admin here also carries a delegation
 * level: full (today's unrestricted default), read-only (every GET works,
 * every mutation is rejected server-side), or scoped (Tenant Directory and
 * every tenant-detail route are restricted to an explicit company list).
 */
export function PlatformAdminsPage() {
  const [admins, setAdmins] = useState<PlatformAdmin[] | null>(null);
  const [companies, setCompanies] = useState<CompanyDashboardRow[] | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [initialPassword, setInitialPassword] = useState("");
  const [accessLevel, setAccessLevel] = useState<PlatformAdminAccessLevel>("full");
  const [scopedCompanyIds, setScopedCompanyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdCredential, setCreatedCredential] = useState<{ email: string; password: string } | null>(
    null
  );
  const [adding, setAdding] = useState(false);
  const [editingAccessFor, setEditingAccessFor] = useState<string | null>(null);
  const [editAccessLevel, setEditAccessLevel] = useState<PlatformAdminAccessLevel>("full");
  const [editScopedCompanyIds, setEditScopedCompanyIds] = useState<string[]>([]);
  const [savingAccess, setSavingAccess] = useState(false);
  // Phase 2 gap-fill item #2 — creating a Platform Admin and changing an
  // existing one's access level are both @RequireStepUp() routes.
  const { runWithStepUp, stepUpModal } = useStepUp();

  async function load() {
    try {
      setAdmins(await api.listPlatformAdmins());
    } catch {
      setError("Could not load Platform Admins.");
    }
    try {
      setCompanies(await api.listCompanies());
    } catch {
      // Non-fatal — the scoped-tenant picker just won't have options yet.
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const admin = await runWithStepUp(() =>
        api.createPlatformAdmin({
          fullName,
          email,
          initialPassword,
          accessLevel,
          scopedCompanyIds: accessLevel === "scoped" ? scopedCompanyIds : undefined,
        })
      );
      setAdmins((prev) => [...(prev ?? []), admin]);
      setCreatedCredential({ email, password: initialPassword });
      setFullName("");
      setEmail("");
      setInitialPassword("");
      setAccessLevel("full");
      setScopedCompanyIds([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this Platform Admin.");
    } finally {
      setAdding(false);
    }
  }

  async function toggleLock(admin: PlatformAdmin) {
    const nextStatus = admin.status === "active" ? "locked" : "active";
    const updated = await api.setPlatformAdminStatus(admin.id, nextStatus);
    setAdmins((prev) => (prev ?? []).map((a) => (a.id === admin.id ? updated : a)));
  }

  function startEditAccess(admin: PlatformAdmin) {
    setEditingAccessFor(admin.id);
    setEditAccessLevel(admin.accessLevel);
    setEditScopedCompanyIds(admin.scopedCompanyIds);
  }

  async function saveAccess(adminId: string) {
    setSavingAccess(true);
    setError(null);
    try {
      const updated = await runWithStepUp(() =>
        api.setPlatformAdminAccess(adminId, {
          accessLevel: editAccessLevel,
          scopedCompanyIds: editAccessLevel === "scoped" ? editScopedCompanyIds : undefined,
        })
      );
      setAdmins((prev) => (prev ?? []).map((a) => (a.id === adminId ? updated : a)));
      setEditingAccessFor(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this admin's access.");
    } finally {
      setSavingAccess(false);
    }
  }

  function toggleCompanyInList(id: string, list: string[], setList: (next: string[]) => void) {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  return (
    <div className="max-w-2xl">
      {stepUpModal}
      <h1 className="text-2xl font-bold tracking-tight mb-1">Platform Admins</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Our own ops team — every module, every tenant. Never a Company Super Admin, which is scoped to
        one tenant (see that company's Admins tab).
      </p>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {createdCredential && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1 mb-6">
          <div className="font-semibold text-amber-900">
            Login created for {createdCredential.email} — share this password now, it won't be shown
            again. They'll set up mandatory MFA on first sign-in.
          </div>
          <code className="block bg-white rounded px-2 py-1">{createdCredential.password}</code>
          <button
            onClick={() => setCreatedCredential(null)}
            className="text-amber-800 hover:underline font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4 mb-6">
        {admins === null && <div className="text-label-tertiary text-sm">Loading…</div>}
        {admins && admins.length === 0 && (
          <div className="text-center text-sm text-label-tertiary py-4">No other Platform Admins yet.</div>
        )}
        {admins && admins.length > 0 && (
          <div className="divide-y divide-black/5">
            {admins.map((admin) => (
              <div key={admin.id} className="py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{admin.fullName}</div>
                    <div className="text-xs text-label-tertiary">{admin.email}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ACCESS_LEVEL_CLASS[admin.accessLevel]}`}>
                      {ACCESS_LEVEL_LABEL[admin.accessLevel]}
                    </span>
                    <StatusPill status={admin.status} />
                    <button
                      onClick={() => toggleLock(admin)}
                      className="text-xs font-semibold text-accent hover:underline"
                    >
                      {admin.status === "active" ? "Lock" : "Unlock"}
                    </button>
                    <button
                      onClick={() => (editingAccessFor === admin.id ? setEditingAccessFor(null) : startEditAccess(admin))}
                      className="text-xs font-semibold text-accent hover:underline"
                    >
                      {editingAccessFor === admin.id ? "Cancel" : "Edit access"}
                    </button>
                  </div>
                </div>
                {admin.accessLevel === "scoped" && admin.scopedCompanyIds.length > 0 && editingAccessFor !== admin.id && (
                  <div className="text-[11px] text-label-tertiary">
                    Scoped to {admin.scopedCompanyIds.length} tenant{admin.scopedCompanyIds.length === 1 ? "" : "s"}.
                  </div>
                )}
                {editingAccessFor === admin.id && (
                  <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                    <select
                      value={editAccessLevel}
                      onChange={(e) => setEditAccessLevel(e.target.value as PlatformAdminAccessLevel)}
                      className="rounded-lg border border-black/10 px-2 py-1.5 text-xs"
                    >
                      <option value="full">Full access</option>
                      <option value="read_only">Read-only</option>
                      <option value="scoped">Scoped to tenants</option>
                    </select>
                    {editAccessLevel === "scoped" && (
                      <div className="max-h-32 overflow-y-auto border border-black/10 rounded-lg p-2 space-y-1">
                        {(companies ?? []).map((c) => (
                          <label key={c.id} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={editScopedCompanyIds.includes(c.id)}
                              onChange={() => toggleCompanyInList(c.id, editScopedCompanyIds, setEditScopedCompanyIds)}
                            />
                            {c.name}
                          </label>
                        ))}
                        {(companies ?? []).length === 0 && (
                          <div className="text-[11px] text-label-tertiary">No tenants yet.</div>
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => saveAccess(admin.id)}
                      disabled={savingAccess}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50"
                    >
                      {savingAccess ? "Saving…" : "Save access"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          Add a Platform Admin
        </h2>
        <form onSubmit={handleAdd} className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Full name</label>
            <input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Initial password (10+ chars)</label>
            <input
              required
              minLength={10}
              value={initialPassword}
              onChange={(e) => setInitialPassword(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Access level</label>
            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as PlatformAdminAccessLevel)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="full">Full access — every module, every tenant</option>
              <option value="read_only">Read-only — can view everything, can't change anything</option>
              <option value="scoped">Scoped — restricted to specific tenants below</option>
            </select>
          </div>
          {accessLevel === "scoped" && (
            <div>
              <label className="block text-xs font-medium mb-1">Tenants this admin can access</label>
              <div className="max-h-32 overflow-y-auto border border-black/10 rounded-lg p-2 space-y-1">
                {(companies ?? []).map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={scopedCompanyIds.includes(c.id)}
                      onChange={() => toggleCompanyInList(c.id, scopedCompanyIds, setScopedCompanyIds)}
                    />
                    {c.name}
                  </label>
                ))}
                {(companies ?? []).length === 0 && (
                  <div className="text-[11px] text-label-tertiary">No tenants yet.</div>
                )}
              </div>
            </div>
          )}
          <button
            type="submit"
            disabled={adding}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {adding ? "Creating…" : "Create"}
          </button>
        </form>
      </section>
    </div>
  );
}
