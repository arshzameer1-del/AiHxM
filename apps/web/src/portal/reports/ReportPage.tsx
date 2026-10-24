import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Bookmark, Lock, Star } from "lucide-react";
import type { ReportCatalogEntry, ReportDatePreset, ReportExportFormat, ReportFilterKey, ReportFilterOption, ReportFilterOptions, ReportFilterValues, ReportResult } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { ExportMenu } from "./ExportMenu";
import { ResultView } from "./ResultView";
import { PRESET_OPTIONS, appliedFilterChips } from "./reportFormat";

const OPTION_FILTERS: { key: Exclude<ReportFilterKey, "dateRange">; param: keyof ReportFilterValues; label: string }[] = [
  { key: "department", param: "department", label: "Department" },
  { key: "location", param: "location", label: "Location" },
  { key: "employmentType", param: "employmentType", label: "Employment type" },
  { key: "employmentStatus", param: "employmentStatus", label: "Status" },
  { key: "leaveType", param: "leaveType", label: "Leave type" },
  { key: "requestStatus", param: "requestStatus", label: "Request status" },
  { key: "runStatus", param: "runStatus", label: "Run status" },
];

type View = { filters: ReportFilterValues; preset: ReportDatePreset | null; compare: boolean };

function FilterBar({
  entry,
  options,
  view,
  onChange,
  onRun,
  running,
}: {
  entry: ReportCatalogEntry;
  options: ReportFilterOptions;
  view: View;
  onChange: (next: View) => void;
  onRun: (next?: View) => void;
  running: boolean;
}) {
  const hasDates = entry.filters.includes("dateRange");
  const selects = OPTION_FILTERS.filter((f) => entry.filters.includes(f.key));
  if (!hasDates && selects.length === 0) return null;
  const { filters: draft } = view;
  const custom = view.preset === null || view.preset === "custom";
  const badRange = custom && !!draft.dateFrom && !!draft.dateTo && draft.dateFrom > draft.dateTo;
  return (
    <form
      className="bg-card rounded-card p-4 shadow-sm mb-4 flex flex-wrap gap-3 items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!badRange) onRun();
      }}
      aria-label="Report filters"
    >
      {hasDates && (
        <>
          <div>
            <label htmlFor="rf-period" className="block text-xs text-label-tertiary mb-1">Period</label>
            <select
              id="rf-period"
              value={view.preset ?? "default"}
              onChange={(e) => {
                const v = e.target.value;
                const next: View = { ...view, preset: v === "default" ? null : (v as ReportDatePreset) };
                if (v !== "custom" && v !== "default") next.filters = { ...view.filters, dateFrom: undefined, dateTo: undefined };
                if (v === "default") next.filters = { ...view.filters, dateFrom: undefined, dateTo: undefined };
                onChange(next);
                if (v !== "custom") onRun(next);
              }}
              className="rounded border border-black/25 px-2 py-1.5 text-sm"
            >
              <option value="default">Report default</option>
              {PRESET_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          {view.preset === "custom" && (
            <>
              <div>
                <label htmlFor="rf-from" className="block text-xs text-label-tertiary mb-1">From</label>
                <input id="rf-from" type="date" value={draft.dateFrom ?? ""} max={draft.dateTo || undefined} onChange={(e) => onChange({ ...view, filters: { ...draft, dateFrom: e.target.value || undefined } })} className="rounded border border-black/25 px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label htmlFor="rf-to" className="block text-xs text-label-tertiary mb-1">To</label>
                <input id="rf-to" type="date" value={draft.dateTo ?? ""} min={draft.dateFrom || undefined} onChange={(e) => onChange({ ...view, filters: { ...draft, dateTo: e.target.value || undefined } })} className="rounded border border-black/25 px-2 py-1.5 text-sm" />
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-sm pb-1.5">
            <input type="checkbox" checked={view.compare} onChange={(e) => { const next = { ...view, compare: e.target.checked }; onChange(next); onRun(next); }} />
            Compare with the previous period
          </label>
        </>
      )}
      {selects.map((f) => {
        const list: ReportFilterOption[] = options[f.key] ?? [];
        return (
          <div key={f.key}>
            <label htmlFor={`rf-${f.key}`} className="block text-xs text-label-tertiary mb-1">{f.label}</label>
            <select id={`rf-${f.key}`} value={draft[f.param] ?? ""} onChange={(e) => onChange({ ...view, filters: { ...draft, [f.param]: e.target.value || undefined } })} className="rounded border border-black/25 px-2 py-1.5 text-sm max-w-[14rem]">
              <option value="">All</option>
              {list.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        );
      })}
      <button type="submit" disabled={running || badRange} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
        {running ? "Running…" : "Apply"}
      </button>
      {badRange && <p className="basis-full text-xs text-danger" role="alert">The start date is after the end date.</p>}
    </form>
  );
}

function SavePanel({ onSave, onCancel, busy, error }: { onSave: (name: string) => void; onCancel: () => void; busy: boolean; error: string | null }) {
  const [name, setName] = useState("");
  return (
    <form
      className="bg-card rounded-card p-4 shadow-sm mb-4 flex flex-wrap gap-3 items-end"
      aria-label="Save this report view"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
    >
      <div className="flex-1 min-w-[14rem]">
        <label htmlFor="save-name" className="block text-xs text-label-tertiary mb-1">Name this view</label>
        <input id="save-name" autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-black/25 px-2 py-1.5 text-sm" placeholder="e.g. Leave in the last 30 days" />
      </div>
      <button type="submit" disabled={busy || !name.trim()} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
      <button type="button" onClick={onCancel} className="rounded border border-black/25 px-3 py-1.5 text-sm font-semibold">Cancel</button>
      <p className="basis-full text-xs text-label-tertiary">Saves the period and filters, not the numbers. It is re-run with the latest data every time you open it.</p>
      {error && <p className="basis-full text-sm text-danger" role="alert">{error}</p>}
    </form>
  );
}

/** Filters from a drill-down link (?department=…) become the starting filters of the report that opens. */
function filtersFromQuery(params: URLSearchParams): ReportFilterValues {
  const out: ReportFilterValues = {};
  for (const f of OPTION_FILTERS) {
    const v = params.get(f.param);
    if (v) (out as Record<string, string>)[f.param] = v;
  }
  return out;
}

export function ReportPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const [entry, setEntry] = useState<ReportCatalogEntry | null>(null);
  const [options, setOptions] = useState<ReportFilterOptions>({});
  const [view, setView] = useState<View>({ filters: {}, preset: null, compare: false });
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savePanel, setSavePanel] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAs, setSavedAs] = useState<{ id: string; name: string } | null>(null);
  const seq = useRef(0);
  const queryKey = params.toString();

  const run = useCallback(
    async (v: View) => {
      const mine = ++seq.current;
      setRunning(true);
      setRunError(null);
      try {
        const r = await api.runReport(id, v.filters, { ...(v.preset && v.preset !== "custom" ? { preset: v.preset } : {}), ...(v.compare ? { compare: true } : {}) });
        if (mine === seq.current) setResult(r);
      } catch (e) {
        if (mine === seq.current) {
          setResult(null);
          setRunError(e instanceof ApiError && e.status === 403 ? "You don't have access to this report." : describeError(e));
        }
      } finally {
        if (mine === seq.current) setRunning(false);
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setResult(null);
    setLoadError(null);
    setRunError(null);
    setSavedAs(null);
    setSavePanel(false);
    const start: View = { filters: filtersFromQuery(new URLSearchParams(queryKey)), preset: null, compare: false };
    setView(start);
    api
      .getReportEntry(id)
      .then(async (e) => {
        if (cancelled) return;
        setEntry(e);
        if (e.status !== "available") return;
        api.getReportFilterOptions(id).then((o) => !cancelled && setOptions(o)).catch(() => undefined);
        void run(start);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof ApiError && e.status === 404 ? "This report does not exist, or you cannot see it." : describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [id, run, queryKey]);

  if (loadError)
    return (
      <div>
        <BackLink to="/app/reports/library">All reports</BackLink>
        <div className="text-danger text-sm" role="alert">{loadError}</div>
      </div>
    );
  if (!entry) return <LoadingNote what="report" />;

  const labelOf = (key: keyof ReportFilterValues, value: string) => {
    const f = OPTION_FILTERS.find((o) => o.param === key);
    return (f && options[f.key]?.find((o) => o.value === value)?.label) || value;
  };
  // The date range is already written out in the summary line, so only the other filters become chips.
  const chips = result ? appliedFilterChips({ ...result.appliedFilters, dateFrom: undefined, dateTo: undefined }, labelOf) : [];
  const toggleFavorite = () => {
    const next = !entry.favorite;
    setEntry({ ...entry, favorite: next });
    api.setReportFavorite(entry.id, next).catch(() => setEntry((e) => (e ? { ...e, favorite: !next } : e)));
  };
  const doExport = async (format: ReportExportFormat) => {
    setExporting(true);
    setExportError(null);
    try {
      await api.exportReport(entry.id, result?.appliedFilters ?? view.filters, format, view.preset && view.preset !== "custom" ? view.preset : undefined);
    } catch (e) {
      setExportError(describeError(e));
    } finally {
      setExporting(false);
    }
  };
  const doSave = async (name: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const usePreset = view.preset && view.preset !== "custom" ? view.preset : null;
      const filters = { ...view.filters, ...(usePreset ? { dateFrom: undefined, dateTo: undefined } : {}) };
      const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""));
      const s = await api.saveReport({ name, kind: "catalog", reportId: entry.id, filters: clean, preset: usePreset, compare: view.compare });
      setSavedAs({ id: s.id, name: s.name });
      setSavePanel(false);
    } catch (e) {
      setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  const sensitive = entry.sensitivity === "sensitive" || entry.sensitivity === "restricted";

  return (
    <div className="max-w-6xl">
      <BackLink to="/app/reports/library">All reports</BackLink>
      <PageHeader
        title={`${entry.id} · ${entry.title}`}
        subtitle={entry.description}
        actions={
          <>
            <button type="button" onClick={toggleFavorite} aria-pressed={entry.favorite} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold">
              <Star size={15} className={entry.favorite ? "fill-warning text-warning" : ""} aria-hidden="true" />
              {entry.favorite ? "Favorite" : "Add to favorites"}
            </button>
            {entry.status === "available" && (
              <>
                <button type="button" onClick={() => setSavePanel((s) => !s)} disabled={!result} className="inline-flex items-center gap-1.5 rounded border border-black/25 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
                  <Bookmark size={15} aria-hidden="true" /> Save this view
                </button>
                <ExportMenu
                  onExport={doExport}
                  disabled={!entry.canExport || !result}
                  busy={exporting}
                  title={entry.canExport ? "Download the rows. Every export is recorded." : "You do not have permission to export this report."}
                />
              </>
            )}
          </>
        }
      />
      {exportError && <div className="text-danger text-sm mb-3" role="alert">{exportError}</div>}
      {savedAs && (
        <p className="mb-3 text-sm text-success" role="status">
          Saved as “{savedAs.name}”. <Link to={`/app/reports/saved/${savedAs.id}`} className="font-semibold underline">Open it</Link> or find it under My reports.
        </p>
      )}
      {savePanel && <SavePanel onSave={doSave} onCancel={() => setSavePanel(false)} busy={saving} error={saveError} />}
      {sensitive && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-xs text-label-secondary">
          <Lock size={12} aria-hidden="true" /> {entry.sensitivity === "restricted" ? "Restricted" : "Sensitive"} report. Opening and exporting it is recorded in the audit log.
        </p>
      )}

      {entry.status !== "available" ? (
        <div className="bg-card rounded-card p-6 shadow-sm" data-testid="report-unavailable">
          <p className="font-semibold mb-1">
            {entry.status === "blocked" ? "This report needs data AiHxM does not capture yet" : entry.status === "planned" ? "This report is planned" : "This report is not enabled for your company"}
          </p>
          <p className="text-sm text-label-secondary">{entry.statusReason ?? "No further detail is recorded."}</p>
          <p className="text-xs text-label-tertiary mt-3">We do not estimate or invent figures. The report appears here as soon as the data it needs exists.</p>
        </div>
      ) : (
        <>
          <FilterBar entry={entry} options={options} view={view} onChange={setView} onRun={(v) => run(v ?? view)} running={running} />
          {runError && (
            <div className="bg-card rounded-card p-4 shadow-sm mb-4" role="alert" data-testid="report-error">
              <p className="text-sm text-danger">{runError}</p>
              <button type="button" className="mt-2 text-sm font-semibold text-accent hover:underline" onClick={() => run(view)}>Try again</button>
            </div>
          )}
          {running && !result && <LoadingNote what="report" />}
          {result && (
            <div className={running ? "opacity-60" : ""} aria-busy={running}>
              <ResultView result={result} chips={chips} sourceNote={`source: ${entry.sourceModule}`} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
