import { useId, useState, type ReactNode } from "react";
import type { ReportChartSpec, ReportColumn, ReportRow } from "@aihxm/shared-types";
import { describeSeries, formatCell, formatNumber } from "./reportFormat";

/**
 * Hand-built SVG/HTML charts for the Reports area (the app has no chart library). Every chart:
 *  - is a labelled figure with a plain-language summary for screen readers,
 *  - has a "Show as table" alternative holding exactly the same numbers,
 *  - never relies on colour alone (legend with values, direct value labels),
 *  - shows a tooltip on hover and keyboard focus,
 *  - draws everything from one scale, so a label always names a value the mark reaches.
 * Series colours are assigned by position, in a fixed order, and are never cycled.
 */
export const SERIES_COLORS = ["#2563eb", "#d97706", "#0d9488", "#7c3aed", "#db2777", "#65a30d", "#0891b2", "#64748b"] as const;
export const OTHER_COLOR = "#94a3b8";

export function colorOf(index: number): string {
  return SERIES_COLORS[index] ?? OTHER_COLOR;
}

type Series = ReportChartSpec["series"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Round a maximum up to a tick step of 1, 2, 2.5 or 5 times a power of ten, and return the ticks from 0. */
export function niceScale(max: number, target = 4): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
    if (v >= max) break;
  }
  return { top: ticks[ticks.length - 1], ticks };
}

function Legend({ series, totals }: { series: Series; totals?: (number | null)[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-label-secondary" aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(i) }} />
          {s.label}
          {totals && totals[i] !== null && totals[i] !== undefined ? <span className="tabular-nums text-label-tertiary">({formatNumber(totals[i])})</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ spec }: { spec: ReportChartSpec }) {
  const cols: ReportColumn[] = [{ key: spec.xKey, label: "Group", type: "text" }, ...spec.series.map((s) => ({ key: s.key, label: s.label, type: "number" as const }))];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{spec.title}, in {spec.unit}</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary">
            {cols.map((c) => (
              <th key={c.key} scope="col" className={`py-1.5 pr-4 font-semibold ${c.type === "number" ? "text-right" : ""}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.data.map((row, i) => (
            <tr key={i} className="border-t border-border">
              {cols.map((c) => (
                <td key={c.key} className={`py-1.5 pr-4 ${c.type === "number" ? "text-right tabular-nums" : ""}`}>{formatCell(row[c.key] as string | number | null, c.type)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Frame({ spec, summary, children, legend }: { spec: ReportChartSpec; summary: string; children: ReactNode; legend: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <figure className="bg-card rounded-card p-5 shadow-sm" data-testid={`chart-${spec.kind}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <figcaption id={`${id}-t`} className="text-sm font-semibold">
          {spec.title}
          <span className="block text-xs font-normal text-label-tertiary mt-0.5">{spec.unit}</span>
        </figcaption>
        <button
          type="button"
          className="text-xs font-semibold text-accent hover:underline shrink-0"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>
      {asTable ? (
        <DataTable spec={spec} />
      ) : (
        <>
          <p className="sr-only">{summary}</p>
          {children}
          {legend}
        </>
      )}
    </figure>
  );
}

function seriesTotals(spec: ReportChartSpec): (number | null)[] {
  return spec.series.map((s) => {
    const vals = spec.data.map((r) => num(r[s.key])).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  });
}

/** Horizontal bars, grouped when there are several series. Long category names stay readable. */
function BarChart({ spec }: { spec: ReportChartSpec }) {
  const max = Math.max(0, ...spec.data.flatMap((r) => spec.series.map((s) => num(r[s.key]) ?? 0)));
  const { top, ticks } = niceScale(max);
  const multi = spec.series.length > 1;
  return (
    <div>
      <ul className="space-y-3">
        {spec.data.map((row, ri) => (
          <li key={ri}>
            <div className="text-sm mb-1 truncate" title={String(row[spec.xKey] ?? "")}>{String(row[spec.xKey] ?? "—")}</div>
            <div className="space-y-1">
              {spec.series.map((s, si) => {
                const v = num(row[s.key]);
                const pct = v === null ? 0 : (v / top) * 100;
                const label = `${String(row[spec.xKey] ?? "—")}${multi ? ` · ${s.label}` : ""}: ${formatNumber(v)} ${spec.unit}`;
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <div className="flex-1 h-3 rounded-r-md bg-black/5 relative">
                      <div
                        tabIndex={0}
                        role="img"
                        aria-label={label}
                        title={label}
                        className="h-3 rounded-r-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        style={{ width: `${Math.max(pct, v ? 0.5 : 0)}%`, background: colorOf(si) }}
                      />
                    </div>
                    <span className="w-14 text-right text-sm tabular-nums text-label-secondary">{formatNumber(v)}</span>
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-label-tertiary tabular-nums" aria-hidden="true">Scale 0 to {formatNumber(ticks[ticks.length - 1])}</p>
    </div>
  );
}

/** One horizontal stacked bar per category, with a 2px gap between segments. */
function StackedBarChart({ spec }: { spec: ReportChartSpec }) {
  const totals = spec.data.map((r) => spec.series.reduce((a, s) => a + (num(r[s.key]) ?? 0), 0));
  const max = Math.max(0, ...totals);
  const { top } = niceScale(max);
  return (
    <ul className="space-y-3">
      {spec.data.map((row, ri) => (
        <li key={ri}>
          <div className="flex items-baseline justify-between gap-3 text-sm mb-1">
            <span className="truncate" title={String(row[spec.xKey] ?? "")}>{String(row[spec.xKey] ?? "—")}</span>
            <span className="tabular-nums text-label-secondary">{formatNumber(totals[ri])}</span>
          </div>
          <div className="flex h-4 gap-[2px]" style={{ width: `${(totals[ri] / top) * 100}%`, minWidth: totals[ri] ? 6 : 0 }}>
            {spec.series.map((s, si) => {
              const v = num(row[s.key]) ?? 0;
              if (v <= 0) return null;
              const label = `${String(row[spec.xKey] ?? "—")} · ${s.label}: ${formatNumber(v)} ${spec.unit}`;
              return (
                <div
                  key={s.key}
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  title={label}
                  className="h-4 first:rounded-l-md last:rounded-r-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  style={{ flexGrow: v, flexBasis: 0, background: colorOf(si) }}
                />
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}

const W = 640;
const H = 260;
const PAD = { l: 44, r: 16, t: 12, b: 32 };

function LineChart({ spec }: { spec: ReportChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = spec.data.length;
  const vals = spec.data.flatMap((r) => spec.series.map((s) => num(r[s.key]) ?? 0));
  const { top, ticks } = niceScale(Math.max(0, ...vals));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const hovered = hover === null ? null : spec.data[hover];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" aria-hidden="true" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.35 : 0.1} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor" fillOpacity={0.6}>{formatNumber(t)}</text>
          </g>
        ))}
        {spec.data.map((row, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fontSize="11" fill="currentColor" fillOpacity={0.6}>{String(row[spec.xKey] ?? "")}</text>
          ) : null,
        )}
        {spec.series.map((s, si) => {
          const pts = spec.data.map((r, i) => ({ i, v: num(r[s.key]) })).filter((p): p is { i: number; v: number } => p.v !== null);
          const path = pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
          const last = pts[pts.length - 1];
          return (
            <g key={s.key}>
              <path d={path} fill="none" stroke={colorOf(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.length <= 24 && pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={3} fill={colorOf(si)} stroke="rgb(var(--c-card))" strokeWidth={2} />)}
              {last && <circle cx={x(last.i)} cy={y(last.v)} r={4.5} fill={colorOf(si)} stroke="rgb(var(--c-card))" strokeWidth={2} />}
            </g>
          );
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + innerH} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="3 3" />}
        {/* Hit areas: one wide column per point, much bigger than the dot. */}
        {spec.data.map((_, i) => (
          <rect key={i} x={x(i) - innerW / Math.max(n, 1) / 2} y={PAD.t} width={innerW / Math.max(n, 1)} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Chart points">
        {/* Keyboard access: each point is reachable and announces its values. */}
        {spec.data.map((row, i) => (
          <button
            key={i}
            type="button"
            className="sr-only focus:not-sr-only text-xs border border-border rounded px-1.5 py-0.5"
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            {String(row[spec.xKey] ?? "")}: {spec.series.map((s) => `${s.label} ${formatNumber(num(row[s.key]))}`).join(", ")}
          </button>
        ))}
      </div>
      {hovered && (
        <div role="status" className="absolute top-1 right-2 rounded-md bg-brand-dark text-white text-xs px-2 py-1.5 shadow-lg">
          <div className="font-semibold">{String(hovered[spec.xKey] ?? "")}</div>
          {spec.series.map((s, si) => (
            <div key={s.key} className="flex items-center gap-1.5 tabular-nums">
              <span aria-hidden="true" className="inline-block w-2 h-2 rounded-sm" style={{ background: colorOf(si) }} />
              {s.label}: {formatNumber(num(hovered[s.key]))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_SLICES = 8;

function DonutChart({ spec }: { spec: ReportChartSpec }) {
  const [active, setActive] = useState<number | null>(null);
  const key = spec.series[0]?.key ?? "";
  let slices = spec.data
    .map((r) => ({ label: String(r[spec.xKey] ?? "—"), value: num(r[key]) ?? 0 }))
    .filter((s) => s.value > 0);
  if (slices.length > MAX_SLICES) {
    // A ninth colour is never invented: the smallest groups fold into "Other".
    const sorted = [...slices].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, MAX_SLICES - 1);
    const other = sorted.slice(MAX_SLICES - 1).reduce((a, s) => a + s.value, 0);
    slices = [...head, { label: "Other", value: other }];
  }
  const total = slices.reduce((a, s) => a + s.value, 0);
  const R = 70;
  const r = 44;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const sweep = total ? (s.value / total) * Math.PI * 2 : 0;
    const a0 = angle;
    const a1 = angle + Math.min(sweep, Math.PI * 2 - 0.0001);
    angle += sweep;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(80 + rad * Math.cos(a)).toFixed(2)} ${(80 + rad * Math.sin(a)).toFixed(2)}`;
    const d = `M${p(R, a0)} A${R} ${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
    return { ...s, d, i, color: i === MAX_SLICES - 1 && s.label === "Other" ? OTHER_COLOR : colorOf(i) };
  });
  const shown = active === null ? null : arcs[active];
  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <svg viewBox="0 0 160 160" className="w-40 h-40 shrink-0" aria-hidden="true">
        {arcs.length === 1 && (
          // One slice is a whole ring; a single arc from a point back to itself would draw nothing.
          <circle cx="80" cy="80" r={(R + r) / 2} fill="none" stroke={arcs[0].color} strokeWidth={R - r} />
        )}
        {arcs.length > 1 && arcs.map((a) => (
          <path
            key={a.i}
            d={a.d}
            fill={a.color}
            stroke="rgb(var(--c-card))"
            strokeWidth={2}
            opacity={active === null || active === a.i ? 1 : 0.45}
            onMouseEnter={() => setActive(a.i)}
            onMouseLeave={() => setActive(null)}
          />
        ))}
        <text x="80" y="76" textAnchor="middle" fontSize="18" fontWeight="700" fill="currentColor">{formatNumber(shown ? shown.value : total)}</text>
        <text x="80" y="94" textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity={0.6}>{shown ? shown.label : "total"}</text>
      </svg>
      <ul className="flex-1 w-full space-y-1.5 text-sm">
        {arcs.map((a) => (
          <li
            key={a.i}
            tabIndex={0}
            className="flex items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onMouseEnter={() => setActive(a.i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(a.i)}
            onBlur={() => setActive(null)}
          >
            <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: a.color }} />
            <span className="flex-1 truncate" title={a.label}>{a.label}</span>
            <span className="tabular-nums text-label-secondary">{formatNumber(a.value)}</span>
            <span className="w-12 text-right tabular-nums text-label-tertiary">{total ? `${formatNumber((a.value / total) * 100)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One chart card. Renders nothing for a chart with no data; the report page says "no data" itself. */
export function ReportChart({ spec }: { spec: ReportChartSpec }) {
  if (spec.data.length === 0 || spec.series.length === 0) return null;
  const summary = spec.series.map((s) => describeSeries(spec.title, spec.unit, spec.data as ReportRow[], spec.xKey, s.key)).join(" ");
  const legend = spec.kind === "donut" ? null : <Legend series={spec.series} totals={spec.kind === "line" ? undefined : seriesTotals(spec)} />;
  return (
    <Frame spec={spec} summary={summary} legend={legend}>
      {spec.kind === "bar" && <BarChart spec={spec} />}
      {spec.kind === "stackedBar" && <StackedBarChart spec={spec} />}
      {spec.kind === "line" && <LineChart spec={spec} />}
      {spec.kind === "donut" && <DonutChart spec={spec} />}
    </Frame>
  );
}
