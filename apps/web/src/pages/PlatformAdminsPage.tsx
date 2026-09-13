import { FormEvent, useEffect, useState } from "react";
import type { PlatformAdmin } from "@boostfactor/shared-types";
import { api, ApiError } from "../api/client";
import { StatusPill } from "../components/StatusPill";

/**
 * Manages our own ops team's accounts — distinct from Company Super Admins
 * (see CompanyDetailPage's Admins tab). The very first Platform Admin is
 * bootstrapped outside the UI entirely (apps/api/src/database/seed.ts),
 * since nothing can sign in to create one through here until it exists;
 * this screen is how every Platform Admin after that first one gets added.
 */
export function PlatformAdminsPage() {
  const [admins, setAdmins] = useState<PlatformAdmin[] | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [initialPassword, setInitialPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdCredential, setCreatedCredential] = useState<{ email: string; password: string } | null>(
    null
  );
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      setAdmins(await api.listPlatformAdmins());
    } catch {
      setError("Could not load Platform Admins.");
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
      const admin = await api.createPlatformAdmin({ fullName, email, initialPassword });
      setAdmins((prev) => [...(prev ?? []), admin]);
      setCreatedCredential({ email, password: initialPassword });
      setFullName("");
      setEmail("");
      setInitialPassword("");
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

  return (
    <div className="max-w-2xl">
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
              <div key={admin.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium text-sm">{admin.fullName}</div>
                  <div className="text-xs text-label-tertiary">{admin.email}</div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusPill status={admin.status} />
                  <button
                    onClick={() => toggleLock(admin)}
                    className="text-xs font-semibold text-accent hover:underline"
                  >
                    {admin.status === "active" ? "Lock" : "Unlock"}
                  </button>
                </div>
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
