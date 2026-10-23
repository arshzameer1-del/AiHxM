import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Download, Info, Lock, Star } from "lucide-react";
import type { ReportCatalogEntry, ReportFilterKey, ReportFilterOption, ReportFilterOptions, ReportFilterValues, ReportKpi, ReportResult } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { BackLink, LoadingNote, PageHeader } from "../shared/PageChrome";
import { describeError } from "../shared/describeError";
import { formatDateTime, formatDay } from "../shared/dates";
import { ReportChart } from "./charts";
import { appliedFilterChips, formatCell, formatKpiDelta, formatKpiValue } from "./reportFormat";

const OPTION_FILTERS: { key: Exclude<ReportFilterKey, "dateRange">; param: keyof ReportFilterValues; label: string }[] = [
  { key: "department", param: "department", label: "Department" },
  { key: "location", param: "location", label: "Location" },
  { key: "employmentType", param: "employmentType", label: "Employment type" },
  { key: "employmentStatus", param: "employmentStatus", label: "Status" },
  { key: "leaveType", param: "leaveType", label: "Leave type" },
  { key: "requestStatus", param: "requestStatus", label: "Request status" },
  { key: "runStatus", param: "runStatus", label: "Run status" },
];

const PAGE_SIZE = 50;

function KpiCard({ kpi }: { kpi: ReportKpi }) {
  const delta = formatKpiDelta(kpi);
  return (
    <div className="bg-card rounded-card p-4 shadow-sm" data-testid={`kpi-${kpi.key}`}>
      <div className="text-xs uppercase tracking-wide text-label-tertiary">{kpi.label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{formatKpiValue(kpi)}</div>
      {delta && <div className="text-xs tabular-nums text-label-secondary mt-0.5">{delta} vs previous period</div>}
      {kpi.note && <div className="text-xs text-label-tertiary mt-1">{kpi.note}</div>}
    </div>
  );
}

function ResultTable({ result }: { result: ReportResult }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rows = useMemo(() => {
    if (!sort) return result.rows;
    const col = result.columns.find((c) => c.key === sort.key);
    const numeric = col?.type === "number" || col?.type === "percent";
    return [...result.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x === null || x === undefined) return 1; // missing values always last
      if (y === null || y === undefined) return -1;
      return (numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [result, sort]);

  if (result.columns.length === 0) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm" aria-labelledby="rows-h">
      <h2 id="rows-h" className="text-sm font-semibold mb-3">
        Detail <span className="font-normal text-label-tertiary">({result.totalRows.toLocaleString("en-US")} {result.totalRows === 1 ? "row" : "rows"})</span>
      </h2>
      {result.rows.length === 0 ? (
        <p className="text-sm text-label-secondary" data-testid="report-empty">No records match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary">
                {result.columns.map((c) => {
                  const active = sort?.key === c.key;
                  const numeric = c.type === "number" || c.type === "percent";
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"} className={`py-1.5 pr-4 font-semibold ${numeric ? "text-right" : ""}`}>
                      <button type="button" className="uppercase tracking-wide hover:underline" onClick={() => setSort(active && sort!.dir === 1 ? { key: c.key, dir: -1 } : { key: c.key, dir: 1 })}>
                        {c.label}
                        {active ? (sort!.dir === 1 ? " ▲" : " ▼") : ""}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {result.columns.map((c) => (
                    <td key={c.key} className={`py-1.5 pr-4 ${c.type === "number" || c.type === "percent" ? "text-right tabular-nums" : ""}`}>
                      {formatCell(row[c.key], c.type)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit && (
        <button type="button" className="mt-3 text-sm font-semibold text-accent hover:underline" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
          Show {Math.min(PAGE_SIZE, rows.length - limit)} more
        </button>
      )}
      {result.truncated && (
        <p className="mt-3 text-xs text-warning" role="note">
          Only the first {result.rows.length.toLocaleString("en-US")} of {result.totalRows.toLocaleString("en-US")} rows are shown. Narrow the filters to see the rest.
        </p>
      )}
    </section>
  );
}

function FilterBar({
  entry,
  options,
  draft,
  onChange,
  onRun,
  running,
}: {
  entry: ReportCatalogEntry;
  options: ReportFilterOptions;
  draft: ReportFilterValues;
  onChange: (next: ReportFilterValues) => void;
  onRun: () => void;
  running: boolean;
}) {
  const hasDates = entry.filters.includes("dateRange");
  const selects = OPTION_FILTERS.filter((f) => entry.filters.includes(f.key));
  if (!hasDates && selects.length === 0) return null;
  const badRange = !!draft.dateFrom && !!draft.dateTo && draft.dateFrom > draft.dateTo;
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
            <label htmlFor="rf-from" className="block text-xs text-label-tertiary mb-1">From</label>
            <input id="rf-from" type="date" value={draft.dateFrom ?? ""} max={draft.dateTo || undefined} onChange={(e) => onChange({ ...draft, dateFrom: e.target.value || undefined })} className="rounded border border-black/25 px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor="rf-to" className="block text-xs text-label-tertiary mb-1">To</label>
            <input id="rf-to" type="date" value={draft.dateTo ?? ""} min={draft.dateFrom || undefined} onChange={(e) => onChange({ ...draft, dateTo: e.target.value || undefined })} className="rounded border border-black/25 px-2 py-1.5 text-sm" />
          </div>
        </>
      )}
      {selects.map((f) => {
        const list: ReportFilterOption[] = options[f.key] ?? [];
        return (
          <div key={f.key}>
            <label htmlFor={`rf-${f.key}`} className="block text-xs text-label-tertiary mb-1">{f.label}</label>
            <select id={`rf-${f.key}`} value={draft[f.param] ?? ""} onChange={(e) => onChange({ ...draft, [f.param]: e.target.value || undefined })} className="rounded border border-black/25 px-2 py-1.5 text-sm max-w-[14rem]">
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

export function ReportPage() {
  const { id = "" } = useParams();
  const [entry, setEntry] = useState<ReportCatalogEntry | null>(null);
  const [options, setOptions] = useState<ReportFilterOptions>({});
  const [draft, setDraft] = useState<ReportFilterValues>({});
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(
    async (filters: ReportFilterValues) => {
      const mine = ++seq.current;
      setRunning(true);
      setRunError(null);
      try {
        const r = await api.runReport(id, filters);
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
    setDraft({});
    api
      .getReportEntry(id)
      .then(async (e) => {
        if (cancelled) return;
        setEntry(e);
        if (e.status !== "available") return;
        api.getReportFilterOptions(id).then((o) => !cancelled && setOptions(o)).catch(() => undefined);
        void run({});
      })
      .catch((e) => !cancelled && setLoadError(e instanceof ApiError && e.status === 404 ? "This report does not exist, or you cannot see it." : describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [id, run]);

  if (loadError)
    return (
      <div>
        <BackLink to="/app/reports">All reports</BackLink>
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
  const doExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await api.exportReport(entry.id, result?.appliedFilters ?? draft);
    } catch (e) {
      setExportError(describeError(e));
    } finally {
      setExporting(false);
    }
  };
  const sensitive = entry.sensitivity === "sensitive" || entry.sensitivity === "restricted";
  const noChartData = result && result.charts.length === 0 && result.kpis.length === 0;

  return (
    <div className="max-w-6xl">
      <BackLink to="/app/reports">All reports</BackLink>
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
              <button
                type="button"
                onClick={doExport}
                disabled={!entry.canExport || exporting || !result}
                title={entry.canExport ? "Download the rows as CSV. Every export is recorded." : "You do not have permission to export this report."}
                className="inline-flex items-center gap-1.5 rounded bg-accent text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
              >
                <Download size={15} aria-hidden="true" /> {exporting ? "Preparing…" : "Export CSV"}
              </button>
            )}
          </>
        }
      />
      {exportError && <div className="text-danger text-sm mb-3" role="alert">{exportError}</div>}
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
          <FilterBar entry={entry} options={options} draft={draft} onChange={setDraft} onRun={() => run(draft)} running={running} />
          {runError && (
            <div className="bg-card rounded-card p-4 shadow-sm mb-4" role="alert" data-testid="report-error">
              <p className="text-sm text-danger">{runError}</p>
              <button type="button" className="mt-2 text-sm font-semibold text-accent hover:underline" onClick={() => run(draft)}>Try again</button>
            </div>
          )}
          {running && !result && <LoadingNote what="report" />}
          {result && (
            <div className={`space-y-4 ${running ? "opacity-60" : ""}`} aria-busy={running}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-label-secondary">
                <span>
                  {result.scope === "team" ? "Your team" : result.scope === "scoped" ? "Your payroll areas" : "Whole company"}
                  {result.dateRange ? ` · ${formatDay(result.dateRange.from)} to ${formatDay(result.dateRange.to)}` : ""}
                  {" · as of "}
                  {formatDateTime(result.asOf)}
                </span>
                {chips.map((c) => (
                  <span key={c.key} className="rounded-full bg-black/5 px-2 py-0.5">{c.text}</span>
                ))}
              </div>

              {result.kpis.length > 0 && (
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-4" data-testid="report-kpis">
                  {result.kpis.map((k) => (
                    <KpiCard key={k.key} kpi={k} />
                  ))}
                </div>
              )}

              {result.charts.length > 0 && (
                <div className={`grid gap-4 ${result.charts.length > 1 ? "lg:grid-cols-2" : ""}`}>
                  {result.charts.map((c, i) => (
                    <ReportChart key={`${c.title}-${i}`} spec={c} />
                  ))}
                </div>
              )}

              {noChartData && result.rows.length === 0 && <p className="text-sm text-label-secondary">There is nothing to show for these filters.</p>}

              <ResultTable result={result} />

              {result.notes.length > 0 && (
                <aside className="rounded-card border border-warning/40 bg-warning/5 p-4 text-sm" aria-label="Data notes">
                  <p className="font-semibold mb-1">Read with care</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-label-secondary">
                    {result.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </aside>
              )}

              <details className="bg-card rounded-card p-4 shadow-sm">
                <summary className="cursor-pointer text-sm font-semibold inline-flex items-center gap-1.5">
                  <Info size={15} aria-hidden="true" /> How is this calculated?
                </summary>
                <ul className="list-disc pl-5 mt-2 space-y-1 text-sm text-label-secondary">
                  {result.calculation.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                <p className="text-xs text-label-tertiary mt-3">Version {result.version} · source: {entry.sourceModule} · run {formatDateTime(result.generatedAt)}</p>
              </details>
            </div>
          )}
        </>
      )}
    </div>
  );
}
