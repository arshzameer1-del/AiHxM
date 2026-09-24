import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  CompanyDashboardRow,
  CompanyListFilters,
  CompanyStatus,
  ImpersonateResponse,
  PackageTier,
  PlatformSavedView,
} from "@aihxm/shared-types";
import { api } from "../api/client";
import { StatusPill } from "../components/StatusPill";
import { ReasonModal } from "../components/ReasonModal";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

const STATUS_OPTIONS: CompanyStatus[] = ["draft", "trial", "active", "suspended", "locked", "archived", "churned"];
const TIER_OPTIONS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

/**
 * TM-001–005 — Tenant Directory: list, debounced search, status/plan
 * filters, saved reusable views, and per-row actions (View / Login As /
 * Suspend). "Suspend" here is a quick action from the row itself; the
 * full status picker (including Lock, and every other transition) still
 * lives on the Tenant detail page's Overview tab.
 */
export function DashboardPage() {
  const [companies, setCompanies] = useState<CompanyDashboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [impersonation, setImpersonation] = useState<ImpersonateResponse | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<CompanyStatus>>(new Set());
  const [tierFilter, setTierFilter] = useState<Set<PackageTier>>(new Set());

  const [savedViews, setSavedViews] = useState<PlatformSavedView[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [newViewName, setNewViewName] = useState("");

  const [suspendTarget, setSuspendTarget] = useState<CompanyDashboardRow | null>(null);

  // TM-002: "Debounced search" — 300ms after the person stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters: CompanyListFilters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      status: statusFilter.size > 0 ? Array.from(statusFilter) : undefined,
      packageTier: tierFilter.size > 0 ? Array.from(tierFilter) : undefined,
    }),
    [debouncedSearch, statusFilter, tierFilter]
  );

  const load = useCallback(async (f: CompanyListFilters) => {
    try {
      setCompanies(await api.listCompanies(f));
    } catch {
      setError("Could not load companies.");
    }
  }, []);

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  useEffect(() => {
    api.listSavedViews().then(setSavedViews).catch(() => undefined);
  }, []);

  function toggle<T>(set: Set<T>, value: T, setter: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  function applyView(view: PlatformSavedView) {
    setSearchInput(view.filters.search ?? "");
    setDebouncedSearch(view.filters.search ?? "");
    setStatusFilter(new Set(view.filters.status ?? []));
    setTierFilter(new Set(view.filters.packageTier ?? []));
  }

  async function saveCurrentView() {
    if (!newViewName.trim()) return;
    setSavingView(true);
    try {
      const view = await api.createSavedView(newViewName.trim(), filters);
      setSavedViews((prev) => [...prev, view]);
      setNewViewName("");
    } catch {
      setError("Could not save this view.");
    } finally {
      setSavingView(false);
    }
  }

  async function deleteView(id: string) {
    setSavedViews((prev) => prev.filter((v) => v.id !== id));
    try {
      await api.deleteSavedView(id);
    } catch {
      setError("Could not delete this saved view.");
    }
  }

  function clearFilters() {
    setSearchInput("");
    setDebouncedSearch("");
    setStatusFilter(new Set());
    setTierFilter(new Set());
  }

  const hasActiveFilters = Boolean(debouncedSearch) || statusFilter.size > 0 || tierFilter.size > 0;

  async function handleLoginAs(id: string) {
    try {
      setImpersonation(await api.impersonate(id));
    } catch {
      setError("Could not start a scoped session for this company.");
    }
  }

  async function confirmSuspend(reason: string) {
    if (!suspendTarget) return;
    const updated = await api.updateCompanyStatus(suspendTarget.id, "suspended", reason);
    setCompanies((prev) => prev?.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)) ?? prev);
    setSuspendTarget(null);
  }

  const totalMrr = companies?.reduce((sum, c) => sum + c.mockMrrUsd, 0) ?? 0;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tenant Directory</h1>
          <p className="text-label-tertiary text-sm">
            Every tenant on the platform. Isolation is enforced by Postgres Row Level Security, not
            just this screen's filters — see DECISIONS.md Decision #1.
          </p>
        </div>
        <Link
          to="/companies/new"
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold whitespace-nowrap"
        >
          + Create Tenant
        </Link>
      </div>

      {companies && companies.length > 0 && (
        <div className="bg-card rounded-card p-4 shadow-sm mb-6 flex gap-8">
          <div>
            <div className="text-xs uppercase tracking-wide text-label-tertiary">Tenants</div>
            <div className="text-xl font-bold">{companies.length}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-label-tertiary">
              Mock MRR (placeholder, no billing yet)
            </div>
            <div className="text-xl font-bold">{pkr.format(totalMrr)}</div>
          </div>
        </div>
      )}

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {/* TM-002/TM-003: search + filters */}
      <div className="bg-card rounded-card p-4 shadow-sm mb-4 space-y-3">
        <div className="flex gap-3 items-center">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by company, slug, domain, or admin email…"
            className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs font-semibold text-label-tertiary hover:underline">
              Clear filters
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-4">
          <div>
            <div className="text-xs font-semibold text-label-tertiary mb-1">Status</div>
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => toggle(statusFilter, s, setStatusFilter)}
                  className={`text-xs px-2.5 py-1 rounded-full capitalize border ${
                    statusFilter.has(s)
                      ? "bg-accent text-white border-accent"
                      : "border-black/10 text-label-secondary hover:bg-black/5"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-label-tertiary mb-1">Plan</div>
            <div className="flex flex-wrap gap-1">
              {TIER_OPTIONS.map((t) => (
                <button
                  key={t}
                  onClick={() => toggle(tierFilter, t, setTierFilter)}
                  className={`text-xs px-2.5 py-1 rounded-full capitalize border ${
                    tierFilter.has(t)
                      ? "bg-accent text-white border-accent"
                      : "border-black/10 text-label-secondary hover:bg-black/5"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* TM-003: "Save as reusable view" */}
        <div className="border-t border-black/5 pt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-label-tertiary">Saved views:</span>
          {savedViews.map((v) => (
            <span
              key={v.id}
              className="inline-flex items-center gap-1 text-xs bg-surface rounded-full pl-2.5 pr-1 py-1"
            >
              <button onClick={() => applyView(v)} className="font-medium hover:underline">
                {v.name}
              </button>
              <button
                onClick={() => deleteView(v.id)}
                className="text-label-tertiary hover:text-danger px-1"
                aria-label={`Delete saved view ${v.name}`}
              >
                ×
              </button>
            </span>
          ))}
          {savedViews.length === 0 && <span className="text-xs text-label-tertiary">None yet.</span>}
          {hasActiveFilters && (
            <span className="inline-flex items-center gap-1 ml-2">
              <input
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                placeholder="Name this view…"
                className="text-xs rounded-lg border border-black/10 px-2 py-1 w-36 focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={saveCurrentView}
                disabled={savingView || !newViewName.trim()}
                className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
              >
                Save current
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="bg-card rounded-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5">
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Admins</th>
              <th className="px-4 py-3">Mock MRR</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {companies?.map((c) => (
              <tr key={c.id} className="border-b border-black/5 last:border-0">
                <td className="px-4 py-3">
                  <Link to={`/companies/${c.id}`} className="font-semibold hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-xs text-label-tertiary">{c.slug}</div>
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={c.status} />
                </td>
                <td className="px-4 py-3 capitalize">{c.packageTier}</td>
                <td className="px-4 py-3">{c.adminCount}</td>
                <td className="px-4 py-3">{pkr.format(c.mockMrrUsd)}</td>
                <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                  {c.status === "active" && (
                    <button
                      onClick={() => setSuspendTarget(c)}
                      className="text-danger text-xs font-semibold hover:underline"
                    >
                      Suspend
                    </button>
                  )}
                  <button
                    onClick={() => handleLoginAs(c.id)}
                    className="text-accent text-xs font-semibold hover:underline"
                  >
                    Login As
                  </button>
                  <Link to={`/companies/${c.id}`} className="text-accent text-xs font-semibold hover:underline">
                    View
                  </Link>
                </td>
              </tr>
            ))}
            {companies?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-label-tertiary">
                  {hasActiveFilters
                    ? "No tenants match these filters."
                    : "No companies yet. Create the first one to see isolation prove itself with a second."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {impersonation && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center px-4" onClick={() => setImpersonation(null)}>
          <div
            className="bg-card rounded-card p-6 shadow-sm max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold text-lg mb-2">Scoped session issued</h2>
            <p className="text-sm text-label-secondary mb-3">{impersonation.note}</p>
            <div className="bg-surface rounded-lg p-3 text-xs font-mono break-all mb-4">
              {impersonation.token}
            </div>
            <p className="text-xs text-label-tertiary mb-4">
              Expires in {impersonation.expiresIn}. Logged to the audit log as{" "}
              <code>company.impersonate</code>.
            </p>
            <button
              onClick={() => setImpersonation(null)}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {suspendTarget && (
        <ReasonModal
          title={`Suspend ${suspendTarget.name}?`}
          description="This immediately blocks every session already logged into this tenant, not just future logins."
          confirmLabel="Suspend tenant"
          danger
          onCancel={() => setSuspendTarget(null)}
          onConfirm={confirmSuspend}
        />
      )}
    </div>
  );
}
