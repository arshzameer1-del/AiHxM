import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import type { ReportColumn, ReportDrill, ReportKpi, ReportResult, ReportRow } from "@aihxm/shared-types";
import { formatDateTime, formatDay } from "../shared/dates";
import { ReportChart } from "./charts";
import { formatCell, formatKpiDelta, formatKpiValue, formatNumber } from "./reportFormat";

const PAGE_SIZE = 50;

export function KpiCard({ kpi, to }: { kpi: ReportKpi; to?: string }) {
  const delta = formatKpiDelta(kpi);
  const body = (
    <>
      <div className="text-xs uppercase tracking-wide text-label-tertiary">{kpi.label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{formatKpiValue(kpi)}</div>
      {delta && (
        <div className="text-xs tabular-nums text-label-secondary mt-0.5" data-testid={`kpi-delta-${kpi.key}`}>
          {delta} vs previous period{kpi.previous !== undefined && kpi.previous !== null ? ` (${formatNumber(kpi.previous)})` : ""}
        </div>
      )}
      {kpi.note && <div className="text-xs text-label-tertiary mt-1">{kpi.note}</div>}
    </>
  );
  const cls = "bg-card rounded-card p-4 shadow-sm block";
  return to ? (
    <Link to={to} className={`${cls} hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent outline-none`} data-testid={`kpi-${kpi.key}`}>
      {body}
    </Link>
  ) : (
    <div className={cls} data-testid={`kpi-${kpi.key}`}>
      {body}
    </div>
  );
}

type TableData = { columns: ReportColumn[]; rows: ReportRow[]; totalRows: number; truncated: boolean };

/** A sortable, pageable table. Used for the report's own rows and for each extra table (section) under it. */
export function DataTable({ data, title, description, drill, headingId, emptyTestId }: { data: TableData; title: string; description?: string; drill?: ReportDrill | null; headingId: string; emptyTestId?: string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rows = useMemo(() => {
    if (!sort) return data.rows;
    const col = data.columns.find((c) => c.key === sort.key);
    const numeric = col?.type === "number" || col?.type === "percent";
    return [...data.rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x === null || x === undefined) return 1; // missing values always last
      if (y === null || y === undefined) return -1;
      return (numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [data, sort]);

  if (data.columns.length === 0) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-semibold mb-1">
        {title} <span className="font-normal text-label-tertiary">({data.totalRows.toLocaleString("en-US")} {data.totalRows === 1 ? "row" : "rows"})</span>
      </h2>
      {description && <p className="text-xs text-label-tertiary mb-2">{description}</p>}
      {drill && <p className="text-xs text-label-tertiary mb-2">Select a name to see the people behind the number.</p>}
      {data.rows.length === 0 ? (
        <p className="text-sm text-label-secondary" data-testid={emptyTestId}>No records match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary">
                {data.columns.map((c) => {
                  const active = sort?.key === c.key;
                  const numeric = c.type === "number" || c.type === "percent";
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"} className={`py-1.5 pr-4 font-semibold whitespace-nowrap ${numeric ? "text-right" : ""}`}>
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
              {rows.slice(0, limit).map((row, i) => {
                const key = drill ? row[drill.rowKey] : undefined;
                const href = drill && key !== undefined && key !== null && key !== "" ? `/app/reports/${drill.reportId}?${drill.filter}=${encodeURIComponent(String(key))}` : null;
                return (
                  <tr key={i} className="border-t border-border">
                    {data.columns.map((c, ci) => (
                      <td key={c.key} className={`py-1.5 pr-4 ${c.type === "number" || c.type === "percent" ? "text-right tabular-nums" : ""}`}>
                        {ci === 0 && href ? (
                          <Link to={href} className="text-accent font-semibold hover:underline" title={drill?.label}>
                            {formatCell(row[c.key], c.type)}
                          </Link>
                        ) : (
                          formatCell(row[c.key], c.type)
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit && (
        <button type="button" className="mt-3 text-sm font-semibold text-accent hover:underline" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
          Show {Math.min(PAGE_SIZE, rows.length - limit)} more
        </button>
      )}
      {data.truncated && (
        <p className="mt-3 text-xs text-warning" role="note">
          Only the first {data.rows.length.toLocaleString("en-US")} of {data.totalRows.toLocaleString("en-US")} rows are shown. Narrow the filters to see the rest.
        </p>
      )}
    </section>
  );
}

export function ResultTable({ result }: { result: ReportResult }) {
  return <DataTable data={result} title="Detail" drill={result.drill ?? null} headingId="rows-h" emptyTestId="report-empty" />;
}

/** The report's own table plus its extra tables (breakdowns, trends, the records behind the figures), one tab each. */
export function ResultTabs({ result }: { result: ReportResult }) {
  const sections = result.sections ?? [];
  const [active, setActive] = useState("detail");
  if (sections.length === 0) return <ResultTable result={result} />;
  const tabs = [{ key: "detail", label: "Detail", count: result.totalRows }, ...sections.map((s) => ({ key: s.key, label: s.title, count: s.totalRows }))];
  const current = sections.find((s) => s.key === active);
  return (
    <div className="space-y-3" data-testid="report-tabs">
      <div role="tablist" aria-label="Report tables" className="flex flex-wrap gap-1.5">
        {tabs.map((t) => {
          const on = (current ? current.key : "detail") === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`report-tab-${t.key}`}
              aria-selected={on}
              aria-controls="report-tabpanel"
              data-testid={`report-tab-${t.key}`}
              onClick={() => setActive(t.key)}
              className={`rounded-full px-3 py-1 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? "bg-accent text-white" : "bg-black/5 text-label-secondary hover:bg-black/10"}`}
            >
              {t.label} <span className={on ? "opacity-80" : "text-label-tertiary"}>({t.count.toLocaleString("en-US")})</span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id="report-tabpanel" aria-labelledby={`report-tab-${current ? current.key : "detail"}`}>
        {current ? (
          <DataTable key={current.key} data={current} title={current.title} description={current.description} headingId={`section-h-${current.key}`} />
        ) : (
          <ResultTable result={result} />
        )}
      </div>
    </div>
  );
}

/** What every report result looks like: scope line, key figures, charts, detail table, notes and the calculation. */
export function ResultView({ result, chips = [], sourceNote }: { result: ReportResult; chips?: { key: string; text: string }[]; sourceNote?: string }) {
  const noChartData = result.charts.length === 0 && result.kpis.length === 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-label-secondary">
        <span>
          {result.scope === "team" ? "Your team" : result.scope === "scoped" ? "Your payroll areas" : "Whole company"}
          {result.dateRange ? ` · ${formatDay(result.dateRange.from)} to ${formatDay(result.dateRange.to)}` : ""}
          {result.comparison ? ` · compared with ${formatDay(result.comparison.from)} to ${formatDay(result.comparison.to)}` : ""}
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

      <ResultTabs result={result} />

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
        <p className="text-xs text-label-tertiary mt-3">Version {result.version}{sourceNote ? ` · ${sourceNote}` : ""} · run {formatDateTime(result.generatedAt)}</p>
      </details>
    </div>
  );
}
