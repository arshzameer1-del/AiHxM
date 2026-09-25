import { useEffect, useState } from "react";
import type { AuditLogEntry, AuditLogFilters, CompanyDashboardRow, PlatformSavedView } from "@aihxm/shared-types";
import { api } from "../api/client";

const dateFormat = new Intl.DateTimeFormat("en-PK", {
  dateStyle: "medium",
  timeStyle: "short",
});

// Tenant Management gap-fill Phase 1 item #6 — Audit tab search/filter +
// saved searches. Extends the original company-only filter with
// actor/action/date-range, and reuses the Tenant Directory's own
// saved-views mechanism (platform_saved_views, view_type='audit_log') so a
// Platform Admin can name and reload a search combination instead of
// re-typing it every time.
export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [companies, setCompanies] = useState<CompanyDashboardRow[]>([]);
  const [companyFilter, setCompanyFilter] = useState<string>("");
  const [actorFilter, setActorFilter] = useState<string>("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [fromFilter, setFromFilter] = useState<string>("");
  const [toFilter, setToFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [savedSearches, setSavedSearches] = useState<PlatformSavedView[]>([]);
  const [newSearchName, setNewSearchName] = useState("");
  const [savingSearch, setSavingSearch] = useState(false);

  useEffect(() => {
    api.listCompanies().then(setCompanies).catch(() => undefined);
  }, []);

  useEffect(() => {
    api.listSavedViews("audit_log").then(setSavedSearches).catch(() => undefined);
  }, []);

  const filters: AuditLogFilters = {
    companyId: companyFilter || undefined,
    actor: actorFilter.trim() || undefined,
    action: actionFilter.trim() || undefined,
    from: fromFilter ? new Date(fromFilter).toISOString() : undefined,
    to: toFilter ? new Date(toFilter).toISOString() : undefined,
  };

  useEffect(() => {
    api
      .listAuditLog(filters)
      .then(setEntries)
      .catch(() => setError("Could not load the audit log."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyFilter, actorFilter, actionFilter, fromFilter, toFilter]);

  function clearFilters() {
    setCompanyFilter("");
    setActorFilter("");
    setActionFilter("");
    setFromFilter("");
    setToFilter("");
  }

  function applySearch(view: PlatformSavedView) {
    const f = view.filters as AuditLogFilters;
    setCompanyFilter(f.companyId ?? "");
    setActorFilter(f.actor ?? "");
    setActionFilter(f.action ?? "");
    setFromFilter(f.from ? f.from.slice(0, 10) : "");
    setToFilter(f.to ? f.to.slice(0, 10) : "");
  }

  async function saveCurrentSearch() {
    if (!newSearchName.trim()) return;
    setSavingSearch(true);
    try {
      const view = await api.createSavedView(newSearchName.trim(), "audit_log", filters);
      setSavedSearches((prev) => [...prev, view]);
      setNewSearchName("");
    } catch {
      setError("Could not save this search.");
    } finally {
      setSavingSearch(false);
    }
  }

  async function deleteSearch(id: string) {
    setSavedSearches((prev) => prev.filter((v) => v.id !== id));
    try {
      await api.deleteSavedView(id);
    } catch {
      setError("Could not delete this saved search.");
    }
  }

  const hasActiveFilters =
    !!companyFilter || !!actorFilter.trim() || !!actionFilter.trim() || !!fromFilter || !!toFilter;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-label-tertiary text-sm">
            Append-only at the database level (see migration 0001) — nothing in this app can edit
            or delete an entry, including this screen.
          </p>
        </div>
      </div>

      <div className="bg-card rounded-card shadow-sm p-4 mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1">Company</label>
            <select
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1">Actor</label>
            <input
              placeholder="Actor contains…"
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1">Action</label>
            <input
              placeholder="e.g. company.impersonate"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1">From</label>
            <input
              type="date"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1">To</label>
            <input
              type="date"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs font-semibold text-accent hover:underline pb-2">
              Clear filters
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-black/5">
          {savedSearches.map((view) => (
            <span
              key={view.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/5 pl-3 pr-1.5 py-1 text-xs"
            >
              <button onClick={() => applySearch(view)} className="font-medium hover:underline">
                {view.name}
              </button>
              <button
                onClick={() => deleteSearch(view.id)}
                className="text-label-tertiary hover:text-danger rounded-full w-4 h-4 flex items-center justify-center"
                aria-label={`Delete saved search "${view.name}"`}
              >
                ×
              </button>
            </span>
          ))}
          {hasActiveFilters && (
            <div className="flex items-center gap-1.5">
              <input
                placeholder="Save this search as…"
                value={newSearchName}
                onChange={(e) => setNewSearchName(e.target.value)}
                className="text-xs rounded-lg border border-black/10 px-2 py-1 w-40 focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={saveCurrentSearch}
                disabled={!newSearchName.trim() || savingSearch}
                className="text-xs font-semibold text-accent hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Save
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      <div className="bg-card rounded-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Target</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((entry) => (
              <tr key={entry.id} className="border-b border-black/5 last:border-0 align-top">
                <td className="px-4 py-3 whitespace-nowrap text-label-tertiary text-xs">
                  {dateFormat.format(new Date(entry.createdAt))}
                </td>
                <td className="px-4 py-3">{entry.companyName ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{entry.action}</td>
                <td className="px-4 py-3 text-xs">{entry.actor}</td>
                <td className="px-4 py-3 text-xs text-label-tertiary">{entry.target ?? "—"}</td>
              </tr>
            ))}
            {entries?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-label-tertiary">
                  {hasActiveFilters ? "No activity matches these filters." : "No activity yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
