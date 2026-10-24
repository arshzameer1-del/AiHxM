import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Lock, Search, Star } from "lucide-react";
import type { ReportCatalogEntry, ReportCatalogResponse, ReportStatus } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { filterCatalog, type LibraryView } from "./reportCatalogView";

const STATUS_LABEL: Record<ReportStatus, string> = {
  available: "Available",
  blocked: "Needs data",
  planned: "Planned",
  unavailable: "Not enabled",
};

const STATUS_TONE: Record<ReportStatus, string> = {
  available: "bg-success/10 text-success",
  blocked: "bg-warning/10 text-warning",
  planned: "bg-info/10 text-info",
  unavailable: "bg-black/5 text-label-secondary",
};

function StatusBadge({ status }: { status: ReportStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

function ReportCard({ entry, onToggleFavorite }: { entry: ReportCatalogEntry; onToggleFavorite: (e: ReportCatalogEntry) => void }) {
  const restricted = entry.sensitivity === "sensitive" || entry.sensitivity === "restricted";
  return (
    <li className="bg-card rounded-card p-4 shadow-sm flex flex-col gap-2" data-testid={`report-card-${entry.id}`}>
      <div className="flex items-start gap-2">
        <Link to={`/app/reports/${entry.id}`} className="flex-1 min-w-0 font-semibold hover:underline focus-visible:underline outline-none">
          <span className="text-xs font-mono text-label-tertiary mr-1.5">{entry.id}</span>
          {entry.title}
        </Link>
        <button
          type="button"
          onClick={() => onToggleFavorite(entry)}
          aria-pressed={entry.favorite}
          aria-label={entry.favorite ? `Remove ${entry.title} from favorites` : `Add ${entry.title} to favorites`}
          className="shrink-0 p-1 -m-1 rounded text-label-tertiary hover:text-warning focus-visible:ring-2 focus-visible:ring-accent outline-none"
        >
          <Star size={18} className={entry.favorite ? "fill-warning text-warning" : ""} />
        </button>
      </div>
      <p className="text-sm text-label-secondary">{entry.description}</p>
      {entry.status !== "available" && entry.statusReason && <p className="text-xs text-label-tertiary">{entry.statusReason}</p>}
      <div className="mt-auto pt-1 flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge status={entry.status} />
        {restricted && (
          <span className="inline-flex items-center gap-1 text-label-secondary">
            <Lock size={12} aria-hidden="true" /> {entry.sensitivity === "restricted" ? "Restricted" : "Sensitive"}
          </span>
        )}
        {entry.scope === "team" && <span className="text-label-secondary">Your team only</span>}
        {entry.scope === "scoped" && <span className="text-label-secondary">Your payroll areas</span>}
        <span className="text-label-tertiary">{entry.categoryLabel}</span>
      </div>
    </li>
  );
}

export function ReportsLibraryPage() {
  const [catalog, setCatalog] = useState<ReportCatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<LibraryView>({ query: "", category: "all", status: "available", only: "all" });

  useEffect(() => {
    let cancelled = false;
    api
      .getReportCatalog()
      .then((r) => !cancelled && setCatalog(r))
      .catch((e) => !cancelled && setError(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFavorite = (entry: ReportCatalogEntry) => {
    const next = !entry.favorite;
    const patch = (on: boolean) =>
      setCatalog((c) =>
        c ? { ...c, entries: c.entries.map((e) => (e.id === entry.id ? { ...e, favorite: on } : e)), favorites: on ? [...new Set([...c.favorites, entry.id])] : c.favorites.filter((f) => f !== entry.id) } : c,
      );
    patch(next);
    api.setReportFavorite(entry.id, next).catch(() => patch(!next));
  };

  const shown = useMemo(() => (catalog ? filterCatalog(catalog, view) : []), [catalog, view]);

  if (error) return <div className="text-danger text-sm" role="alert">{error}</div>;
  if (!catalog) return <LoadingNote what="reports" />;

  const { counts } = catalog;
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Report library"
        subtitle={`${counts.available} reports ready to run. ${counts.blocked} more need data that is not captured yet; each one says what is missing.`}
      />

      <div className="bg-card rounded-card p-4 shadow-sm mb-4 space-y-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary" aria-hidden="true" />
          <label htmlFor="report-search" className="sr-only">Search reports</label>
          <input
            id="report-search"
            type="search"
            value={view.query}
            onChange={(e) => setView({ ...view, query: e.target.value })}
            placeholder="Search by name, topic or code, for example “attrition” or B04"
            className="w-full rounded border border-black/25 pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label htmlFor="report-category" className="block text-xs text-label-tertiary mb-1">Category</label>
            <select id="report-category" value={view.category} onChange={(e) => setView({ ...view, category: e.target.value })} className="rounded border border-black/25 px-2 py-1.5 text-sm">
              <option value="all">All categories</option>
              {catalog.categories.filter((c) => c.count > 0).map((c) => (
                <option key={c.key} value={c.key}>{c.label} ({c.count})</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="report-status" className="block text-xs text-label-tertiary mb-1">Status</label>
            <select id="report-status" value={view.status} onChange={(e) => setView({ ...view, status: e.target.value as LibraryView["status"] })} className="rounded border border-black/25 px-2 py-1.5 text-sm">
              <option value="available">Available ({counts.available})</option>
              <option value="blocked">Needs data ({counts.blocked})</option>
              <option value="planned">Planned ({counts.planned})</option>
              <option value="all">All ({counts.visible})</option>
            </select>
          </div>
          <div role="group" aria-label="Show" className="flex gap-1">
            {(["all", "favorites", "recent"] as const).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={view.only === o}
                onClick={() => setView({ ...view, only: o })}
                className={`rounded px-3 py-1.5 text-sm font-semibold border ${view.only === o ? "bg-accent text-white border-accent" : "border-black/25 text-label-secondary"}`}
              >
                {o === "all" ? "All" : o === "favorites" ? `Favorites (${catalog.favorites.length})` : `Recent (${catalog.recent.length})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-sm text-label-tertiary mb-3" role="status">{shown.length} {shown.length === 1 ? "report" : "reports"}</p>
      {shown.length === 0 ? (
        <div className="bg-card rounded-card p-8 shadow-sm text-center text-sm text-label-secondary">
          {view.only === "favorites"
            ? "No favorites yet. Use the star on a report to keep it here."
            : view.only === "recent"
              ? "You have not opened any report yet."
              : "No report matches. Try a shorter search, or set Status to All."}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((e) => (
            <ReportCard key={e.id} entry={e} onToggleFavorite={toggleFavorite} />
          ))}
        </ul>
      )}
    </div>
  );
}
