import { barChart, count, donutChart, lineChart, listReport, num, pct, percent, sqlReport, sum, type Q } from "../report-spec";

/**
 * Reports about the reports (catalog O01 to O05, O10 to O12, O15). They read report_run_log, which stores only safe
 * telemetry (report id, kind, status, timing, row count, error category): never filter values or result rows.
 *
 * Needs administration rights. Who ran a report is shown by employee name; accounts without an employee record show as
 * "A user without an employee record".
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const WHO = (emp: string) => `COALESCE(NULLIF(${NAME(emp)}, ''), 'A user without an employee record')`;
const LOG_USER = (log = "l", emp = "le") => `LEFT JOIN employees ${emp} ON ${emp}.user_account_id = ${log}.user_account_id AND ${emp}.company_id = ${log}.company_id`;
const IN_RANGE = (q: Q, log = "l") => `${log}.created_at::date BETWEEN ${q.from} AND ${q.to}`;
/** The catalog as parallel arrays for unnest(): id, title, category label, domain, status. */
const CATALOG = (q: Q) => {
  const c = q.ctx.catalog;
  return `unnest(${q.bind(c.map((x) => x.id))}::text[], ${q.bind(c.map((x) => x.title))}::text[], ${q.bind(c.map((x) => x.categoryLabel))}::text[], ${q.bind(c.map((x) => x.domain))}::text[], ${q.bind(c.map((x) => x.status))}::text[])`;
};
const EXPORT_BURST = 10;
const DENIAL_BURST = 3;
const ERROR_BURST = 3;

export const O01 = sqlReport({
  description: "How much each report category is used: reports available, runs, exports, people and errors.",
  defaultRange: "last90Days",
  tables: ["report_run_log"],
  viz: ["bar", "kpi", "table"],
  tags: ["usage", "catalog"],
  columns: [
    { key: "category", label: "Category", type: "text" },
    { key: "available", label: "Reports available", type: "number" },
    { key: "runs", label: "Runs", type: "number" },
    { key: "exports", label: "Exports", type: "number" },
    { key: "people", label: "Different people", type: "number" },
    { key: "errors", label: "Errors", type: "number" },
  ],
  sql: (q) => `
    SELECT cat.label AS category, COUNT(DISTINCT cat.id) FILTER (WHERE cat.status = 'available')::int AS available,
           COUNT(l.id) FILTER (WHERE l.kind = 'run' AND l.status = 'ok')::int AS runs, COUNT(l.id) FILTER (WHERE l.kind = 'export' AND l.status = 'ok')::int AS exports,
           COUNT(DISTINCT l.user_account_id)::int AS people, COUNT(l.id) FILTER (WHERE l.status = 'error')::int AS errors
      FROM ${CATALOG(q)} AS cat(id, title, label, domain, status)
      LEFT JOIN report_run_log l ON l.report_id = cat.id AND ${q.co("l")} AND ${IN_RANGE(q)}
     GROUP BY cat.label ORDER BY runs DESC, category`,
  chart: ({ rows }) => (sum(rows, "runs") > 0 ? barChart({ title: "Runs by category", unit: "runs", rows, labelKey: "category", valueKey: "runs", max: 15 }) : null),
  kpis: ({ rows }) => [count("runs", "Runs", sum(rows, "runs")), count("exports", "Exports", sum(rows, "exports")), count("available", "Reports available", sum(rows, "available"))],
  calculation: ["Counts successful runs and exports in the range from the report run log, grouped by the report's category. Available is how many reports in the category can run today.", "People counts each person once per category."],
});

export const O02 = sqlReport({
  description: "The reports people open most, with how many different people use them.",
  defaultRange: "last90Days",
  tables: ["report_run_log", "report_recent_views"],
  viz: ["bar", "table"],
  tags: ["usage", "popular"],
  columns: [
    { key: "report", label: "Report", type: "text" },
    { key: "title", label: "Title", type: "text" },
    { key: "runs", label: "Runs", type: "number" },
    { key: "people", label: "Different people", type: "number" },
    { key: "exports", label: "Exports", type: "number" },
    { key: "last", label: "Last run", type: "date" },
  ],
  sql: (q) => `
    SELECT l.report_id AS report, COALESCE(cat.title, l.report_id) AS title, COUNT(*) FILTER (WHERE l.kind = 'run')::int AS runs, COUNT(DISTINCT l.user_account_id)::int AS people,
           COUNT(*) FILTER (WHERE l.kind = 'export')::int AS exports, MAX(l.created_at)::date::text AS last
      FROM report_run_log l LEFT JOIN ${CATALOG(q)} AS cat(id, title, label, domain, status) ON cat.id = l.report_id
     WHERE ${q.co("l")} AND l.status = 'ok' AND ${IN_RANGE(q)}
     GROUP BY l.report_id, cat.title ORDER BY runs DESC, people DESC, report`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Most-run reports", unit: "runs", rows: rows.map((r) => ({ ...r, label: `${r.report} ${r.title}` })), labelKey: "label", valueKey: "runs", max: 10 }) : null),
  kpis: ({ rows }) => [count("reports", "Reports used", rows.length), count("runs", "Runs", sum(rows, "runs"))],
  calculation: ["Counts successful runs in the range per report, most-run first. Denied, invalid and failed attempts are not counted here."],
});

export const O03 = sqlReport({
  description: "Available reports that nobody ran in the period, so you can see what is not being used.",
  defaultRange: "last90Days",
  tables: ["report_run_log"],
  viz: ["kpi", "table"],
  tags: ["usage", "unused"],
  columns: [
    { key: "report", label: "Report", type: "text" },
    { key: "title", label: "Title", type: "text" },
    { key: "category", label: "Category", type: "text" },
    { key: "runs", label: "Runs in range", type: "number" },
    { key: "last", label: "Last run ever", type: "date" },
  ],
  sql: (q) => `
    SELECT cat.id AS report, cat.title AS title, cat.label AS category,
           (SELECT COUNT(*)::int FROM report_run_log l WHERE ${q.co("l")} AND l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok' AND ${IN_RANGE(q)}) AS runs,
           (SELECT MAX(l.created_at)::date::text FROM report_run_log l WHERE ${q.co("l")} AND l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok') AS last
      FROM ${CATALOG(q)} AS cat(id, title, label, domain, status) WHERE cat.status = 'available'
     ORDER BY runs ASC, last ASC NULLS FIRST, report`,
  kpis: ({ rows }) => [count("unused", "Not run in the range", rows.filter((r) => num(r, "runs") === 0).length), count("available", "Reports available", rows.length)],
  calculation: ["Lists every report that can run today with its successful runs in the range, fewest first. A report with zero runs was not used in the period."],
});

export const O04 = sqlReport({
  description: "How long reports take to run: average, slowest and 95th percentile, per report.",
  defaultRange: "last30Days",
  tables: ["report_run_log"],
  viz: ["bar", "table"],
  tags: ["performance", "duration"],
  columns: [
    { key: "report", label: "Report", type: "text" },
    { key: "runs", label: "Runs", type: "number" },
    { key: "average", label: "Average (ms)", type: "number" },
    { key: "p95", label: "95th percentile (ms)", type: "number" },
    { key: "slowest", label: "Slowest (ms)", type: "number" },
  ],
  sql: (q) => `
    SELECT l.report_id AS report, COUNT(*)::int AS runs, ROUND(AVG(l.duration_ms))::int AS average, ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.duration_ms))::int AS p95, MAX(l.duration_ms)::int AS slowest
      FROM report_run_log l WHERE ${q.co("l")} AND l.status = 'ok' AND ${IN_RANGE(q)}
     GROUP BY l.report_id ORDER BY average DESC, report`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Slowest reports (average ms)", unit: "milliseconds", rows, labelKey: "report", valueKey: "average", max: 12 }) : null),
  kpis: ({ rows }) => [count("runs", "Runs timed", sum(rows, "runs")), count("slowest", "Slowest run (ms)", rows.length ? Math.max(...rows.map((r) => num(r, "slowest"))) : null)],
  calculation: ["Uses successful runs and exports in the range. Duration is the time from the request reaching the report to the result being ready.", "The 95th percentile is the duration that 95% of runs finished within."],
});

export const O05 = sqlReport({
  description: "Reports that failed or timed out, how often, and what kind of failure.",
  defaultRange: "last30Days",
  tables: ["report_run_log"],
  viz: ["bar", "kpi", "table"],
  tags: ["failures", "errors"],
  columns: [
    { key: "report", label: "Report", type: "text" },
    { key: "attempts", label: "Attempts", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "timeouts", label: "Timed out", type: "number" },
    { key: "rate", label: "Failed (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT l.report_id AS report, COUNT(*)::int AS attempts, COUNT(*) FILTER (WHERE l.status = 'error')::int AS failed, COUNT(*) FILTER (WHERE l.error_category = 'timeout')::int AS timeouts,
           ROUND(COUNT(*) FILTER (WHERE l.status = 'error') * 100.0 / COUNT(*), 1) AS rate
      FROM report_run_log l WHERE ${q.co("l")} AND l.status IN ('ok', 'error') AND ${IN_RANGE(q)}
     GROUP BY l.report_id HAVING COUNT(*) FILTER (WHERE l.status = 'error') > 0 ORDER BY failed DESC, rate DESC, report`,
  summary: (q) => `SELECT COUNT(*)::int AS attempts, COUNT(*) FILTER (WHERE l.status = 'error')::int AS failed FROM report_run_log l WHERE ${q.co("l")} AND l.status IN ('ok', 'error') AND ${IN_RANGE(q)}`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Failed attempts by report", unit: "attempts", rows, labelKey: "report", valueKey: "failed", max: 12 }) : null),
  kpis: ({ summary }) => [count("attempts", "Attempts", summary.attempts ?? 0), count("failed", "Failed", summary.failed ?? 0), percent("rate", "Failure rate", pct(summary.failed ?? 0, summary.attempts ?? 0))],
  calculation: ["Counts runs and exports that ended ok or in error in the range. Denied and invalid-filter attempts are user mistakes and are counted in O11, not here.", "Only reports with at least one failure are listed."],
});

export const O10 = sqlReport({
  description: "Report exports by month: how many, how many rows left the system, and how many people exported.",
  defaultRange: "last12Months",
  tables: ["report_run_log", "audit_log"],
  viz: ["line", "kpi", "table"],
  tags: ["export", "volume"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "exports", label: "Exports", type: "number" },
    { key: "rows", label: "Rows exported", type: "number" },
    { key: "people", label: "Different people", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(l.id)::int AS exports, COALESCE(SUM(l.row_count), 0)::int AS rows, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM mo LEFT JOIN report_run_log l ON ${q.co("l")} AND l.kind = 'export' AND l.status = 'ok' AND l.created_at::date >= mo.ms AND l.created_at::date < mo.ms + interval '1 month'
     GROUP BY mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => (rows.length ? lineChart({ title: "Exports per month", unit: "exports", rows, xKey: "month", series: [{ key: "exports", label: "Exports" }] }) : null),
  kpis: ({ rows }) => [count("exports", "Exports", sum(rows, "exports")), count("rows", "Rows exported", sum(rows, "rows"))],
  calculation: ["Counts successful exports per month from the report run log. Every export is CSV today, so there is no format split to show."],
  notes: () => ["CSV is the only export format, so a format mix would always be 100% CSV."],
});

export const O11 = listReport({
  description: "Attempts to run or export a report without the right permission: who, which report and how often.",
  defaultRange: "last30Days",
  tables: ["report_run_log"],
  tags: ["denied", "access"],
  countLabel: "People denied",
  columns: [
    { key: "person", label: "Person", type: "text" },
    { key: "report", label: "Report", type: "text" },
    { key: "kind", label: "Tried to", type: "text" },
    { key: "times", label: "Times", type: "number" },
    { key: "last", label: "Latest", type: "date" },
  ],
  sql: (q) => `
    SELECT ${WHO("le")} AS person, l.report_id AS report, CASE WHEN l.kind = 'export' THEN 'Export' ELSE 'Run' END AS kind, COUNT(*)::int AS times, MAX(l.created_at)::date::text AS last
      FROM report_run_log l ${LOG_USER()}
     WHERE ${q.co("l")} AND l.status = 'denied' AND ${IN_RANGE(q)}
     GROUP BY l.user_account_id, le.id, le.first_name, le.last_name, l.report_id, l.kind ORDER BY times DESC, last DESC, person`,
  kpis: ({ rows }) => [count("attempts", "Denied attempts", sum(rows, "times")), count("reports", "Different reports", new Set(rows.map((r) => r.report)).size)],
  calculation: ["Lists denied attempts recorded in the report run log in the range, grouped by person, report and whether it was a run or an export."],
});

export const O12 = sqlReport({
  description: "How many reports each data family can offer today, and how many are planned or waiting on data that does not exist yet.",
  staticData: true,
  tables: ["report catalog (defined in code)"],
  viz: ["donut", "kpi", "table"],
  tags: ["catalog", "availability", "data sources"],
  columns: [
    { key: "domain", label: "Data family", type: "text" },
    { key: "reports", label: "Reports in the catalog", type: "number" },
    { key: "available", label: "Available", type: "number" },
    { key: "planned", label: "Planned", type: "number" },
    { key: "blocked", label: "Blocked (data missing)", type: "number" },
    { key: "unavailable", label: "Unavailable", type: "number" },
  ],
  sql: (q) => `
    SELECT INITCAP(cat.domain) AS domain, COUNT(*)::int AS reports, COUNT(*) FILTER (WHERE cat.status = 'available')::int AS available, COUNT(*) FILTER (WHERE cat.status = 'planned')::int AS planned,
           COUNT(*) FILTER (WHERE cat.status = 'blocked')::int AS blocked, COUNT(*) FILTER (WHERE cat.status = 'unavailable')::int AS unavailable
      FROM ${CATALOG(q)} AS cat(id, title, label, domain, status) GROUP BY cat.domain ORDER BY available DESC, domain`,
  chart: ({ rows }) => {
    const parts = [{ label: "Available", n: sum(rows, "available") }, { label: "Planned", n: sum(rows, "planned") }, { label: "Blocked", n: sum(rows, "blocked") }, { label: "Unavailable", n: sum(rows, "unavailable") }].filter((p) => p.n > 0);
    return parts.length ? donutChart({ title: "Reports by status", unit: "reports", rows: parts, labelKey: "label", valueKey: "n" }) : null;
  },
  kpis: ({ rows }) => [count("total", "Reports in the catalog", sum(rows, "reports")), percent("available", "Available", pct(sum(rows, "available"), sum(rows, "reports"))), count("blocked", "Blocked by missing data", sum(rows, "blocked"))],
  calculation: ["Counts the report catalog by the family of data each report reads and by its honest status. A blocked report names the data or module that is missing in the catalog; nothing is estimated to fill the gap."],
});

export const O15 = listReport({
  description: "Unusual report activity worth a look: bursts of exports, repeated access denials and reports failing repeatedly.",
  defaultRange: "last30Days",
  tables: ["report_run_log"],
  tags: ["governance", "exceptions"],
  countLabel: "Exceptions",
  columns: [
    { key: "exception", label: "Exception", type: "text" },
    { key: "person", label: "Person", type: "text" },
    { key: "report", label: "Report", type: "text" },
    { key: "times", label: "Times", type: "number" },
    { key: "detail", label: "Why it is listed", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT 'Many exports' AS exception, ${WHO("le")} AS person, 'Several' AS report, COUNT(*)::int AS times, 'Exported ${EXPORT_BURST} or more reports in the range' AS detail
        FROM report_run_log l ${LOG_USER()} WHERE ${q.co("l")} AND l.kind = 'export' AND l.status = 'ok' AND ${IN_RANGE(q)}
       GROUP BY l.user_account_id, le.id, le.first_name, le.last_name HAVING COUNT(*) >= ${EXPORT_BURST}
      UNION ALL
      SELECT 'Repeated denials', ${WHO("le")}, l.report_id, COUNT(*)::int, 'Refused ${DENIAL_BURST} or more times on the same report'
        FROM report_run_log l ${LOG_USER()} WHERE ${q.co("l")} AND l.status = 'denied' AND ${IN_RANGE(q)}
       GROUP BY l.user_account_id, le.id, le.first_name, le.last_name, l.report_id HAVING COUNT(*) >= ${DENIAL_BURST}
      UNION ALL
      SELECT 'Report failing', 'Anyone', l.report_id, COUNT(*)::int, 'Failed ${ERROR_BURST} or more times in the range'
        FROM report_run_log l WHERE ${q.co("l")} AND l.status = 'error' AND ${IN_RANGE(q)} GROUP BY l.report_id HAVING COUNT(*) >= ${ERROR_BURST}
    ) t ORDER BY t.times DESC, t.exception`,
  calculation: [`Lists people who exported ${EXPORT_BURST} or more reports, people refused ${DENIAL_BURST} or more times on one report, and reports that failed ${ERROR_BURST} or more times in the range.`, "The limits are fixed review thresholds, not policy: they are meant to prompt a look, not to prove a problem."],
});
