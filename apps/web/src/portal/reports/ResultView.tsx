import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import type { ReportKpi, ReportResult } from "@aihxm/shared-types";
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

export function ResultTable({ result }: { result: ReportResult }) {
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
  const drill = result.drill ?? null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm" aria-labelledby="rows-h">
      <h2 id="rows-h" className="text-sm font-semibold mb-3">
        Detail <span className="font-normal text-label-tertiary">({result.totalRows.toLocaleString("en-US")} {result.totalRows === 1 ? "row" : "rows"})</span>
      </h2>
      {drill && <p className="text-xs text-label-tertiary mb-2">Select a name to see the people behind the number.</p>}
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
              {rows.slice(0, limit).map((row, i) => {
                const key = drill ? row[drill.rowKey] : undefined;
                const href = drill && key !== undefined && key !== null && key !== "" ? `/app/reports/${drill.reportId}?${drill.filter}=${encodeURIComponent(String(key))}` : null;
                return (
                  <tr key={i} className="border-t border-border">
                    {result.columns.map((c, ci) => (
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
      {result.truncated && (
        <p className="mt-3 text-xs text-warning" role="note">
          Only the first {result.rows.length.toLocaleString("en-US")} of {result.totalRows.toLocaleString("en-US")} rows are shown. Narrow the filters to see the rest.
        </p>
      )}
    </section>
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
        <p className="text-xs text-label-tertiary mt-3">Version {result.version}{sourceNote ? ` · ${sourceNote}` : ""} · run {formatDateTime(result.generatedAt)}</p>
      </details>
    </div>
  );
}
