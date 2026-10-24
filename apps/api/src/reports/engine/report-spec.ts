import type { ReportDomain } from "../catalog/report-catalog.types";
import type { ReportChartSpec, ReportColumn, ReportFilterKey, ReportKpi, ReportRow, ReportSection, ReportSensitivity, ReportVisualization } from "@aihxm/shared-types";
import type { DefaultRange } from "./filters";
import { CURRENT_HEADCOUNT, Params, UNASSIGNED, employeeConditions } from "./sql";
import type { ExecutorContext, ExecutorOutput, ReportExecutor } from "./executors/types";

/** Filter keys, named once so report files never spell the legacy column name out. */
export const DEPT = "department" as const;
export const LOC = "location" as const;
export const ETYPE = "employmentType" as const;

/** What a query author gets: bound-parameter helpers that already carry the caller's scope and filters. */
export type Q = {
  ctx: ExecutorContext;
  /** Bind any value; returns its `$n` placeholder. */
  bind: (v: unknown) => string;
  /** `$n::date` for today in the company's timezone. */
  today: string;
  /** `$n::date` bounds of the chosen range. Throws if the report has no date range. */
  from: string;
  to: string;
  /** Conditions (joined by AND) that limit an `employees` alias to the caller's scope and the chosen filters. */
  emp: (alias?: string) => string;
  /** Employee still counted in headcount on `today`: joined, and not terminated. */
  current: (alias?: string) => string;
  /** Condition for an organisation-unit or location filter against any column, e.g. `q.dim(DEPT, "p.org_unit_id")`. TRUE when the filter is not chosen. */
  dim: (key: typeof DEPT | typeof LOC, column: string) => string;
  /** One row per month from the range start to its end: `ms` (month start) and `point` (month end, or today for the current month). */
  months: () => string;
  /**
   * Smallest group a table may show on its own. 1 (no merging) for a caller who sees the whole company, such as HR admin;
   * 3 for team-scoped or payroll-area-limited callers, whose small groups would reveal one person.
   */
  minGroup: number;
  /** `alias.company_id = $n::uuid` for tables that are not tied to an employee. */
  co: (alias: string) => string;
  /** Payroll area limit for a `payroll_runs` alias: TRUE for company-wide payroll access, else the caller's areas. */
  area: (alias: string) => string;
  /** The value of a filter the report declares (undefined when not chosen). Reading it marks the filter as applied. */
  filter: (key: Exclude<ReportFilterKey, "dateRange">) => string | undefined;
};

export type RowsInfo = {
  rows: ReportRow[];
  total: number;
  ctx: ExecutorContext;
  /** One-row figures from the spec's `summary` query: counts that cannot be read off the listed rows (e.g. everything checked). */
  summary: Record<string, number>;
};

export type ReportMeta = {
  /** Overrides of the catalog's category defaults, for reports that read from a different data family or need more rights. */
  domain?: ReportDomain;
  sensitivity?: ReportSensitivity;
  needs?: string[];
  tables?: string[];
  description: string;
  filters: ReportFilterKey[];
  viz: ReportVisualization[];
  tags: string[];
  defaultRange: DefaultRange | null;
};

export type ReportOverrides = Pick<ReportMeta, "domain" | "sensitivity" | "needs" | "tables">;

/**
 * An extra table under a report: a breakdown, a trend or the records behind the headline figures. It is held to exactly the
 * same rules as the report's own query (company limit, reporting line, payroll area, filters, date range), and it may never show
 * more than the report's sensitivity allows: a report that is not Restricted must not list pay here.
 */
export type ReportSectionSpec = {
  key: string;
  title: string;
  description?: string;
  columns: ReportColumn[];
  sql: (q: Q) => string;
};

export type SqlReportSpec = ReportOverrides & {
  description: string;
  /** Filters this report understands. Date range is implied by `defaultRange`. */
  filters?: ReportFilterKey[];
  viz: ReportVisualization[];
  tags?: string[];
  defaultRange?: DefaultRange;
  columns: ReportColumn[];
  /** One SELECT returning a column for every `columns[].key`. No LIMIT: the framework adds it. */
  sql: (q: Q) => string;
  /** Optional second query returning exactly one row of numbers, shown to `kpis`/`notes` as `info.summary`. Same scope and filters as `sql`. */
  summary?: (q: Q) => string;
  /** The query reads no company rows at all, only values handed to it through unnest() (for example the report catalog). */
  staticData?: boolean;
  chart?: (info: RowsInfo) => ReportChartSpec | ReportChartSpec[] | null;
  kpis?: (info: RowsInfo) => ReportKpi[];
  calculation: string[];
  notes?: (info: RowsInfo) => string[];
  /** Extra tables shown under the figures (tabs on the report page, extra sheets in an Excel export). */
  sections?: ReportSectionSpec[];
};

const CHART_ROW_CAP = 2000;

/** A query must return a column for every column it declares, even when it returns no rows. */
function assertColumns(columns: readonly ReportColumn[], fields: ReadonlyArray<{ name: string }>, where: string): void {
  const names = new Set(fields.map((f) => f.name));
  for (const c of columns) if (!names.has(c.key)) throw new Error(`${where} is missing the column "${c.key}"`);
}

function normalise(columns: readonly ReportColumn[], raw: Record<string, unknown>): ReportRow {
  const out: ReportRow = {};
  for (const c of columns) {
    const v = raw[c.key];
    if (!(c.key in raw)) throw new Error(`Report query is missing the column "${c.key}"`);
    if (v === null || v === undefined) out[c.key] = null;
    else if (c.type === "number" || c.type === "percent") out[c.key] = Number(v);
    else if (v instanceof Date) out[c.key] = v.toISOString().slice(0, c.type === "date" ? 10 : 19).replace("T", " ");
    else out[c.key] = String(v);
  }
  return out;
}

/** Builds the query helpers for one statement. Every statement gets its own parameter list, so a parameter nothing refers to can never reach Postgres. */
function makeQ(ctx: ExecutorContext): { q: Q; p: Params; used: Set<string> } {
  const p = new Params();
  let todayBound: string | null = null;
  // bound on first use: a parameter nothing refers to would leave Postgres unable to type it
  const todayParam = (): string => (todayBound ??= p.add(ctx.today) + "::date");
  let fromParam: string | null = null;
  let toParam: string | null = null;
  const used = new Set<string>();
  const q: Q = {
    ctx,
    bind: (v) => p.add(v),
    get today() {
      return todayParam();
    },
    get from() {
      if (!ctx.range) throw new Error("This report has no date range");
      used.add("dateRange");
      return (fromParam ??= p.add(ctx.range.from) + "::date");
    },
    get to() {
      if (!ctx.range) throw new Error("This report has no date range");
      used.add("dateRange");
      return (toParam ??= p.add(ctx.range.to) + "::date");
    },
    filter: (key) => {
      used.add(key);
      return ctx.filters[key];
    },
    emp: (alias = "e") => {
      used.add("department");
      used.add("location");
      used.add("employmentType");
      return employeeConditions(p, {
        alias,
        companyId: ctx.companyId,
        scope: ctx.scope,
        callerEmployeeId: ctx.callerEmployeeId,
        department: ctx.filters.department,
        location: ctx.filters.location,
        employmentType: ctx.filters.employmentType,
      }).join(" AND ");
    },
    current: (alias = "e") => CURRENT_HEADCOUNT(alias, todayParam()),
    dim: (key, column) => {
      used.add(key);
      const v = ctx.filters[key];
      if (!v) return "TRUE";
      if (v === UNASSIGNED) return `${column} IS NULL`;
      return `${column} = ${p.add(v)}::uuid`;
    },
    months: () => {
      if (!ctx.range) throw new Error("This report has no date range");
      used.add("dateRange");
      const a = p.add(ctx.range.from);
      const b = p.add(ctx.range.to);
      return `SELECT gs::date AS ms, LEAST((gs + interval '1 month - 1 day')::date, ${todayParam()}) AS point
                FROM generate_series(date_trunc('month', ${a}::date)::date, date_trunc('month', ${b}::date)::date, interval '1 month') gs`;
    },
    minGroup: ctx.scope === "tenant" && (!ctx.payrollAccess || ctx.payrollAccess.unrestricted) ? 1 : 3,
    co: (alias) => `${alias}.company_id = ${p.add(ctx.companyId)}::uuid`,
    area: (alias) => {
      const a = ctx.payrollAccess;
      if (!a || a.unrestricted) return "TRUE";
      return `${alias}.payroll_area_id = ANY(${p.add(a.payrollAreaIds)}::uuid[])`;
    },
  };
  return { q, p, used };
}

/** Runs each extra table with its own parameter list, the same guards and the same row limit as the report's own table. */
export async function runSections(specs: readonly ReportSectionSpec[], ctx: ExecutorContext, staticData: boolean): Promise<ReportSection[]> {
  const out: ReportSection[] = [];
  for (const sec of specs) {
    const { q, p } = makeQ(ctx);
    const inner = sec.sql(q);
    guardScope(inner, ctx, staticData);
    const res = await ctx.client.query(`SELECT * FROM (${inner}) AS section_rows LIMIT ${ctx.rowLimit + 1}`, p.values);
    assertColumns(sec.columns, res.fields, `Section "${sec.key}"`);
    const truncated = res.rows.length > ctx.rowLimit;
    const rows = res.rows.slice(0, ctx.rowLimit).map((r) => normalise(sec.columns, r));
    let total = rows.length;
    if (truncated) {
      const c = await ctx.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM (${inner}) AS section_rows`, p.values);
      total = c.rows[0]?.n ?? rows.length;
    }
    out.push({ key: sec.key, title: sec.title, ...(sec.description ? { description: sec.description } : {}), columns: sec.columns, rows, totalRows: total, truncated });
  }
  return out;
}

/** Refuses a query that ignores the caller's scope. A missing limit is an error, never a wider answer. */
function guardScope(inner: string, ctx: ExecutorContext, staticData: boolean): void {
    // A manager with no employee record has no team: employeeConditions then adds a plain FALSE, which is the closed answer (no rows).
    const closedTeam = !ctx.callerEmployeeId && /\bFALSE\b/.test(inner);
    if (ctx.scope === "team" && !inner.includes("org_relationships") && !closedTeam) throw new Error("Team-scoped report query ignored the reporting line");
    if (ctx.payrollAccess && !ctx.payrollAccess.unrestricted && !inner.includes("payroll_area_id = ANY")) throw new Error("Area-scoped report query ignored the payroll area limit");
    // Either the query limits its tables to the company itself, or it reads only through the app.report_company_*() functions,
    // which return nothing but the current company's rows by construction (migrations 0165 and 0166).
    if (staticData) {
      if (/\b(FROM|JOIN)\s+(?!unnest\(|\()[a-z_]/i.test(inner)) throw new Error("A static-data report may read only values passed to unnest(), never a table");
    } else if (!/company_id\s*=\s*\$\d+/.test(inner) && !/\bapp\.report_company_\w+\(\)/.test(inner)) {
      throw new Error("Report query is not limited to the caller's company");
    }
}

/**
 * Turns a declarative spec into an executor. The framework, not the author, adds the row limit, binds every value,
 * and refuses to run a query that ignores the caller's scope: team scope must go through the reporting line and
 * payroll-area scope must go through the area limit. A query that forgets is an error, never a wider answer.
 */
export function sqlReport(spec: SqlReportSpec): { run: ReportExecutor; meta: ReportMeta } {
  const run: ReportExecutor = async (ctx) => {
    const { q, p, used } = makeQ(ctx);
    const inner = spec.sql(q);
    const sm = spec.summary ? makeQ(ctx) : null;
    const summarySql = spec.summary && sm ? spec.summary(sm.q) : null;
    for (const declared of spec.filters ?? []) {
      if (declared !== "dateRange" && !used.has(declared)) throw new Error(`Report declares the "${declared}" filter but its query never applies it`);
    }
    if (spec.defaultRange && !used.has("dateRange")) throw new Error("Report declares a date range but its query never applies it");

    guardScope(inner, ctx, spec.staticData === true);

    const cap = Math.max(ctx.rowLimit, CHART_ROW_CAP);
    const res = await ctx.client.query(`SELECT * FROM (${inner}) AS report_rows LIMIT ${cap + 1}`, p.values);
    assertColumns(spec.columns, res.fields, "Report query");
    const capped = res.rows.length > cap;
    const fetched = res.rows.slice(0, cap).map((r) => normalise(spec.columns, r));
    let total = fetched.length;
    if (capped) {
      const c = await ctx.client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM (${inner}) AS report_rows`, p.values);
      total = c.rows[0]?.n ?? fetched.length;
    }
    let summary: Record<string, number> = {};
    if (summarySql) {
      const sr = await ctx.client.query(`SELECT * FROM (${summarySql}) AS report_summary LIMIT 1`, sm?.p.values);
      summary = Object.fromEntries(Object.entries(sr.rows[0] ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));
    }
    const info: RowsInfo = { rows: fetched, total, ctx, summary };
    const charts = spec.chart?.(info);
    const notes = [...(spec.notes?.(info) ?? [])];
    if (capped) notes.push(`Summary figures and charts cover the first ${cap} rows of ${total}. Narrow the filters to see the rest.`);
    const sections = spec.sections && !ctx.skipSections ? await runSections(spec.sections, ctx, spec.staticData === true) : undefined;
    const out: ExecutorOutput = {
      ...(sections && sections.length ? { sections } : {}),
      kpis: spec.kpis?.(info) ?? [],
      charts: charts ? (Array.isArray(charts) ? charts : [charts]) : [],
      columns: spec.columns,
      rows: fetched.slice(0, ctx.rowLimit),
      totalRows: total,
      truncated: total > ctx.rowLimit,
      calculation: spec.calculation,
      notes,
    };
    return out;
  };
  const meta: ReportMeta = {
    description: spec.description,
    filters: [...(spec.defaultRange ? (["dateRange"] as ReportFilterKey[]) : []), ...(spec.filters ?? []).filter((f) => f !== "dateRange")],
    viz: spec.viz,
    tags: spec.tags ?? [],
    defaultRange: spec.defaultRange ?? null,
    ...(spec.domain ? { domain: spec.domain } : {}),
    ...(spec.sensitivity ? { sensitivity: spec.sensitivity } : {}),
    ...(spec.needs ? { needs: spec.needs } : {}),
    ...(spec.tables ? { tables: spec.tables } : {}),
  };
  return { run, meta };
}

// ---------------------------------------------------------------- small helpers query authors share

export const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
export const num = (r: ReportRow, k: string): number => Number(r[k] ?? 0);
export const sum = (rows: ReportRow[], k: string): number => rows.reduce((s, r) => s + num(r, k), 0);
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function barChart(o: { title: string; unit: string; rows: ReportRow[]; labelKey: string; valueKey: string; valueLabel?: string; max?: number }): ReportChartSpec {
  const max = o.max ?? 12;
  let data = o.rows.map((r) => ({ label: String(r[o.labelKey] ?? "Not set"), value: num(r, o.valueKey) }));
  if (data.length > max) {
    const head = data.slice(0, max - 1);
    const rest = data.slice(max - 1);
    data = [...head, { label: `Other (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0) }];
  }
  return { kind: "bar", title: o.title, unit: o.unit, xKey: "label", series: [{ key: "value", label: o.valueLabel ?? o.unit }], data };
}

export function donutChart(o: { title: string; unit: string; rows: ReportRow[]; labelKey: string; valueKey: string; max?: number }): ReportChartSpec {
  return { ...barChart({ ...o, max: o.max ?? 8 }), kind: "donut" };
}

export function lineChart(o: { title: string; unit: string; rows: ReportRow[]; xKey: string; series: { key: string; label: string }[] }): ReportChartSpec {
  return { kind: "line", title: o.title, unit: o.unit, xKey: o.xKey, series: o.series, data: o.rows };
}

export function stackedChart(o: { title: string; unit: string; rows: ReportRow[]; xKey: string; series: { key: string; label: string }[] }): ReportChartSpec {
  return { ...lineChart(o), kind: "stackedBar" };
}

export const count = (key: string, label: string, value: number | null, note?: string): ReportKpi => ({ key, label, value, unit: "count", ...(note ? { note } : {}) });
export const percent = (key: string, label: string, value: number | null, note?: string): ReportKpi => ({ key, label, value, unit: "percent", ...(note ? { note } : {}) });
export const days = (key: string, label: string, value: number | null, note?: string): ReportKpi => ({ key, label, value, unit: "days", ...(note ? { note } : {}) });

// ---------------------------------------------------------------- "X by Y" reports

type GroupedOptions = ReportOverrides & {
  description: string;
  filters?: ReportFilterKey[];
  tags?: string[];
  defaultRange?: DefaultRange;
  /** Column header for the label, e.g. "Department". */
  dimension: string;
  /** Header for the number, e.g. "Employees". */
  valueLabel: string;
  /** What the number counts, for chart axes and screen readers, e.g. "employees". */
  unit: string;
  valueType?: "count" | "days" | "hours" | "percent";
  /** A query returning `label` (text) and `n` (number), ordered the way it should read. */
  sql: (q: Q) => string;
  chart?: "bar" | "donut" | "none";
  max?: number;
  totalLabel: string;
  totalNote?: string;
  groupsLabel?: string;
  /** Show a share-of-total column. Off for averages and rates, where shares are meaningless. */
  showShare?: boolean;
  calculation: string[];
  notes?: (info: RowsInfo) => string[];
  sections?: ReportSectionSpec[];
};

/** A two-column "label, number" report with a share column, one chart, and total + group-count tiles. */
export function groupedReport(o: GroupedOptions): { run: ReportExecutor; meta: ReportMeta } {
  const showShare = o.showShare !== false;
  const columns: ReportColumn[] = [
    { key: "label", label: o.dimension, type: "text" },
    { key: "n", label: o.valueLabel, type: o.valueType === "percent" ? "percent" : "number" },
    ...(showShare ? ([{ key: "share", label: "Share of total (%)", type: "percent" }] as ReportColumn[]) : []),
  ];
  const chartKind = o.chart ?? "bar";
  const inner = sqlReport({
    domain: o.domain,
    sensitivity: o.sensitivity,
    needs: o.needs,
    tables: o.tables,
    description: o.description,
    filters: o.filters,
    tags: o.tags,
    defaultRange: o.defaultRange,
    viz: [...(chartKind === "none" ? [] : [chartKind === "donut" ? "donut" : "bar"]), "kpi", "table"] as ReportVisualization[],
    columns: columns.filter((c) => c.key !== "share").concat(showShare ? [{ key: "share", label: "Share of total (%)", type: "percent" }] : []),
    sql: (q) => {
      const base = o.sql(q);
      return showShare ? `SELECT b.label, b.n, CASE WHEN SUM(b.n) OVER () > 0 THEN ROUND(b.n * 100.0 / SUM(b.n) OVER (), 1) END AS share FROM (${base}) b` : `SELECT b.label, b.n FROM (${base}) b`;
    },
    chart: ({ rows }) => (chartKind === "none" || rows.length === 0 ? null : chartKind === "donut" ? donutChart({ title: `${o.valueLabel} by ${o.dimension.toLowerCase()}`, unit: o.unit, rows, labelKey: "label", valueKey: "n" }) : barChart({ title: `${o.valueLabel} by ${o.dimension.toLowerCase()}`, unit: o.unit, rows, labelKey: "label", valueKey: "n", max: o.max })),
    kpis: ({ rows }) => {
      const total = round2(sum(rows, "n"));
      const unit = o.valueType === "days" ? "days" : o.valueType === "percent" ? "percent" : "count";
      return [
        { key: "total", label: o.totalLabel, value: o.valueType === "percent" ? null : total, unit, ...(o.totalNote ? { note: o.totalNote } : {}) },
        { key: "groups", label: o.groupsLabel ?? `${o.dimension} groups`, value: rows.length, unit: "count" },
      ].filter((k) => !(o.valueType === "percent" && k.key === "total")) as ReportKpi[];
    },
    calculation: o.calculation,
    notes: o.notes,
    sections: o.sections,
  });
  return inner;
}


// ---------------------------------------------------------------- table-first reports (lists, watchlists, exceptions)

type ListOptions = Omit<SqlReportSpec, "viz" | "kpis"> & {
  viz?: ReportVisualization[];
  /** Label for the tile that counts the rows, e.g. "Employees listed". */
  countLabel: string;
  countNote?: string;
  kpis?: (info: RowsInfo) => ReportKpi[];
};

/** A report whose main content is the list itself: a count tile, the table, and optionally a chart. */
export function listReport(o: ListOptions): { run: ReportExecutor; meta: ReportMeta } {
  return sqlReport({
    ...o,
    viz: o.viz ?? (o.chart ? ["kpi", "bar", "table"] : ["kpi", "table"]),
    kpis: (info) => [{ key: "rows", label: o.countLabel, value: info.total, unit: "count", ...(o.countNote ? { note: o.countNote } : {}) }, ...(o.kpis?.(info) ?? [])],
  });
}
