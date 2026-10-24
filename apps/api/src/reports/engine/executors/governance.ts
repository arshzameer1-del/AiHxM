import { barChart, count, donutChart, lineChart, listReport, num, pct, percent, round1, sqlReport, stackedChart, sum, type Q } from "../report-spec";

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

// ---------------------------------------------------------------- reports about saved reports, sharing, schedules, builder and dashboards (v2)
// These read the Reports v2 tables. Names of private saved reports are never shown, only that one exists: a private report is
// the owner's own working note, and the title can be as telling as the contents.

const OWNER = (emp = "oe") => `COALESCE(NULLIF(TRIM(COALESCE(${emp}.first_name, '') || ' ' || COALESCE(${emp}.last_name, '')), ''), 'A user without an employee record')`;
const OWNER_JOIN = (alias: string, emp = "oe") => `LEFT JOIN employees ${emp} ON ${emp}.user_account_id = ${alias}.owner_user_account_id AND ${emp}.company_id = ${alias}.company_id`;

export const O06 = listReport({
  description: "Every saved report in the company: who owns it, what it is built on, whether it is shared and whether it is scheduled. Private report names are not shown.",
  tables: ["saved_reports", "report_shares", "report_schedules"],
  tags: ["saved reports", "inventory"],
  countLabel: "Saved reports",
  columns: [
    { key: "owner", label: "Owner", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "source", label: "Built on", type: "text" },
    { key: "visibility", label: "Visibility", type: "text" },
    { key: "sharedWith", label: "Shared with", type: "number" },
    { key: "schedules", label: "Schedules", type: "number" },
    { key: "updated", label: "Last changed", type: "date" },
  ],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, CASE WHEN s.visibility = 'shared' THEN s.name ELSE 'Private report' END AS name,
           CASE WHEN s.kind = 'custom' THEN 'Built in Report Builder' ELSE 'Library report' END AS kind,
           CASE WHEN s.kind = 'custom' THEN INITCAP(REPLACE(s.definition->>'dataset', '_', ' ')) ELSE s.report_id END AS source,
           INITCAP(s.visibility) AS visibility,
           (SELECT COUNT(*)::int FROM report_shares h WHERE h.saved_report_id = s.id) AS "sharedWith",
           (SELECT COUNT(*)::int FROM report_schedules sc WHERE sc.saved_report_id = s.id) AS schedules,
           s.updated_at::date::text AS updated
      FROM saved_reports s ${OWNER_JOIN("s")}
     WHERE ${q.co("s")} AND s.archived_at IS NULL
     ORDER BY s.updated_at DESC, owner`,
  kpis: ({ rows }) => [count("shared", "Shared", rows.filter((r) => r.visibility === "Shared").length), count("custom", "Built in Report Builder", rows.filter((r) => r.kind === "Built in Report Builder").length)],
  calculation: ["Lists saved reports that have not been archived. A report is Shared when its owner has shared it with at least one person or role.", "Schedules counts the schedules that deliver the saved report. The name of a private report is replaced with “Private report”."],
});

export const O07 = listReport({
  description: "Saved reports and dashboards that have been shared: who shared them and with how many people and roles.",
  tables: ["saved_reports", "dashboards", "report_shares"],
  tags: ["sharing", "inventory"],
  countLabel: "Shared items",
  columns: [
    { key: "owner", label: "Shared by", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "roles", label: "Roles", type: "number" },
    { key: "since", label: "First shared", type: "date" },
  ],
  sql: (q) => `
    SELECT x.owner, x.type, x.name, x.people, x.roles, x.since FROM (
      SELECT ${OWNER()} AS owner, 'Saved report' AS type, s.name AS name,
             COUNT(*) FILTER (WHERE h.grantee_type = 'user')::int AS people, COUNT(*) FILTER (WHERE h.grantee_type = 'role')::int AS roles, MIN(h.created_at)::date::text AS since
        FROM saved_reports s ${OWNER_JOIN("s")} JOIN report_shares h ON h.saved_report_id = s.id
       WHERE ${q.co("s")} AND s.archived_at IS NULL GROUP BY s.id, oe.id, oe.first_name, oe.last_name
      UNION ALL
      SELECT ${OWNER()}, 'Dashboard', d.name,
             COUNT(*) FILTER (WHERE h.grantee_type = 'user')::int, COUNT(*) FILTER (WHERE h.grantee_type = 'role')::int, MIN(h.created_at)::date::text
        FROM dashboards d ${OWNER_JOIN("d")} JOIN report_shares h ON h.dashboard_id = d.id
       WHERE ${q.co("d")} AND d.archived_at IS NULL GROUP BY d.id, oe.id, oe.first_name, oe.last_name
    ) x ORDER BY x.since DESC, x.owner`,
  kpis: ({ rows }) => [count("people", "People given access", sum(rows, "people")), count("roles", "Roles given access", sum(rows, "roles"))],
  calculation: ["Counts every saved report and dashboard that has at least one share. Sharing never gives anyone more data than their own permissions allow: each viewer runs the report with their own access."],
});

export const O08 = listReport({
  description: "Every scheduled report: owner, what it delivers, how often, in which format, to how many people, and how the last run went.",
  tables: ["report_schedules", "report_deliveries"],
  tags: ["schedules", "inventory"],
  countLabel: "Schedules",
  columns: [
    { key: "owner", label: "Owner", type: "text" },
    { key: "name", label: "Schedule", type: "text" },
    { key: "source", label: "Report", type: "text" },
    { key: "frequency", label: "Repeats", type: "text" },
    { key: "format", label: "Format", type: "text" },
    { key: "recipients", label: "Recipients", type: "number" },
    { key: "status", label: "Status", type: "text" },
    { key: "last", label: "Last run", type: "date" },
    { key: "next", label: "Next run", type: "date" },
  ],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, sc.name AS name, COALESCE(sc.report_id, 'Saved report') AS source, INITCAP(sc.frequency) AS frequency, UPPER(sc.format) AS format,
           jsonb_array_length(sc.recipients)::int AS recipients, INITCAP(sc.status) AS status, sc.last_run_at::date::text AS last, sc.next_run_at::date::text AS next
      FROM report_schedules sc ${OWNER_JOIN("sc")}
     WHERE ${q.co("sc")}
     ORDER BY (sc.status = 'failed') DESC, sc.next_run_at NULLS LAST, owner`,
  kpis: ({ rows }) => [count("active", "Active", rows.filter((r) => r.status === "Active").length), count("failed", "Failed", rows.filter((r) => r.status === "Failed").length)],
  calculation: ["Lists every schedule in the company, including paused and failed ones. Recipients is the number of people named on the schedule; people who may not receive the report are skipped at delivery time."],
});

export const O09 = sqlReport({
  description: "Month by month, how many scheduled deliveries succeeded: delivered by email, stored in the app, failed or skipped.",
  defaultRange: "last90Days",
  tables: ["report_deliveries", "report_schedules"],
  viz: ["bar", "kpi", "table"],
  tags: ["schedules", "delivery", "success rate"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "runs", label: "Runs", type: "number" },
    { key: "sent", label: "Emailed", type: "number" },
    { key: "stored", label: "Kept in the app", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "skipped", label: "Skipped", type: "number" },
    { key: "success", label: "Success (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         d AS (SELECT date_trunc('month', r.run_at)::date AS ms, r.status FROM report_deliveries r WHERE ${q.co("r")} AND r.run_at::date BETWEEN ${q.from} AND ${q.to})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(d.status)::int AS runs, COUNT(*) FILTER (WHERE d.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE d.status = 'stored')::int AS stored,
           COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE d.status = 'skipped')::int AS skipped,
           ROUND(COUNT(*) FILTER (WHERE d.status IN ('sent', 'stored')) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE d.status <> 'skipped'), 0), 1) AS success
      FROM mo LEFT JOIN d ON d.ms = mo.ms GROUP BY mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => stackedChart({ title: "Scheduled deliveries by outcome", unit: "runs", rows, xKey: "month", series: [{ key: "sent", label: "Emailed" }, { key: "stored", label: "Kept in the app" }, { key: "failed", label: "Failed" }, { key: "skipped", label: "Skipped" }] }),
  kpis: ({ rows }) => {
    const ok = sum(rows, "sent") + sum(rows, "stored");
    const tried = ok + sum(rows, "failed");
    return [percent("success", "Delivery success", tried ? round1((ok * 100) / tried) : null, "Skipped runs are not counted"), count("runs", "Runs", sum(rows, "runs")), count("failed", "Failed", sum(rows, "failed"))];
  },
  calculation: ["Counts each run of a schedule in the range. Success is emailed plus kept in the app, divided by all runs that were attempted; skipped runs (no recipient was allowed to receive the file) are left out of the rate."],
});

export const O13 = sqlReport({
  description: "Which fields people use in reports they build: how often each is a column, a grouping, a measure or a filter.",
  tables: ["saved_reports"],
  viz: ["bar", "table"],
  tags: ["report builder", "fields"],
  columns: [
    { key: "dataset", label: "Data", type: "text" },
    { key: "field", label: "Field", type: "text" },
    { key: "reports", label: "Saved reports using it", type: "number" },
    { key: "asColumn", label: "As a column", type: "number" },
    { key: "asGroup", label: "To group by", type: "number" },
    { key: "asMeasure", label: "As a measure", type: "number" },
    { key: "asFilter", label: "As a filter", type: "number" },
  ],
  sql: (q) => `
    SELECT INITCAP(REPLACE(s.definition->>'dataset', '_', ' ')) AS dataset, INITCAP(REPLACE(u.field, '_', ' ')) AS field, COUNT(DISTINCT s.id)::int AS reports,
           COUNT(*) FILTER (WHERE u.role = 'column')::int AS "asColumn", COUNT(*) FILTER (WHERE u.role = 'group')::int AS "asGroup",
           COUNT(*) FILTER (WHERE u.role = 'measure')::int AS "asMeasure", COUNT(*) FILTER (WHERE u.role = 'filter')::int AS "asFilter"
      FROM saved_reports s
     CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.definition->'columns') = 'array' THEN s.definition->'columns' ELSE '[]'::jsonb END) AS field, 'column' AS role
        UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.definition->'groupBy') = 'array' THEN s.definition->'groupBy' ELSE '[]'::jsonb END), 'group'
        UNION ALL SELECT m->>'field', 'measure' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.definition->'measures') = 'array' THEN s.definition->'measures' ELSE '[]'::jsonb END) m WHERE m->>'field' IS NOT NULL
        UNION ALL SELECT f->>'field', 'filter' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.definition->'filters') = 'array' THEN s.definition->'filters' ELSE '[]'::jsonb END) f
     ) u
     WHERE ${q.co("s")} AND s.kind = 'custom' AND s.archived_at IS NULL AND u.field IS NOT NULL
     GROUP BY s.definition->>'dataset', u.field ORDER BY reports DESC, dataset, field`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Most used fields", unit: "reports", rows: rows.map((r) => ({ ...r, label: `${r.dataset}: ${r.field}` })), labelKey: "label", valueKey: "reports", max: 12 }) : null),
  kpis: ({ rows }) => [count("fields", "Different fields used", rows.length)],
  notes: ({ rows }) => (rows.length === 0 ? ["No one has saved a report built in Report Builder yet."] : []),
  calculation: ["Reads the definitions of saved reports built in Report Builder (not archived) and counts each field wherever it appears. A saved report counts once per field in the “Saved reports using it” column even if it uses the field in more than one way."],
});

export const O14 = sqlReport({
  description: "What dashboards are made of: how many widgets and dashboards use each report, and as a number, chart or table.",
  tables: ["dashboard_widgets", "dashboards", "saved_reports"],
  viz: ["bar", "table"],
  tags: ["dashboards", "widgets"],
  columns: [
    { key: "source", label: "Report", type: "text" },
    { key: "widgets", label: "Widgets", type: "number" },
    { key: "dashboards", label: "Dashboards", type: "number" },
    { key: "numbers", label: "As a number", type: "number" },
    { key: "charts", label: "As a chart", type: "number" },
    { key: "tables", label: "As a table", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(w.report_id, CASE WHEN sr.kind = 'custom' THEN 'Custom report (Report Builder)' ELSE sr.report_id END) AS source,
           COUNT(*)::int AS widgets, COUNT(DISTINCT w.dashboard_id)::int AS dashboards,
           COUNT(*) FILTER (WHERE w.widget_type = 'kpi')::int AS numbers, COUNT(*) FILTER (WHERE w.widget_type = 'chart')::int AS charts, COUNT(*) FILTER (WHERE w.widget_type = 'table')::int AS tables
      FROM dashboard_widgets w JOIN dashboards d ON d.id = w.dashboard_id AND d.archived_at IS NULL
      LEFT JOIN saved_reports sr ON sr.id = w.saved_report_id
     WHERE ${q.co("w")}
     GROUP BY 1 ORDER BY widgets DESC, source`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Widgets per report", unit: "widgets", rows, labelKey: "source", valueKey: "widgets", max: 12 }) : null),
  kpis: ({ rows }) => [count("widgets", "Widgets", sum(rows, "widgets")), count("reports", "Reports on dashboards", rows.length)],
  notes: ({ rows }) => (rows.length === 0 ? ["No dashboards have been built yet."] : []),
  calculation: ["Counts widgets on dashboards that are not archived, grouped by the library report (or saved Report Builder report) each one shows."],
});

export const N06 = listReport({
  description: "Scheduled report jobs and their health: failing, overdue, paused or running normally, with the last error category.",
  tables: ["report_schedules", "report_deliveries"],
  tags: ["schedules", "jobs", "health"],
  countLabel: "Schedules",
  columns: [
    { key: "owner", label: "Owner", type: "text" },
    { key: "name", label: "Schedule", type: "text" },
    { key: "health", label: "Health", type: "text" },
    { key: "failures", label: "Failures in a row", type: "number" },
    { key: "last", label: "Last run", type: "date" },
    { key: "error", label: "Last error", type: "text" },
    { key: "next", label: "Next run", type: "date" },
  ],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, sc.name AS name,
           CASE WHEN sc.status = 'failed' THEN 'Failed'
                WHEN sc.status = 'paused' THEN 'Paused'
                WHEN sc.consecutive_failures > 0 THEN 'Failing'
                WHEN sc.next_run_at IS NOT NULL AND sc.next_run_at < now() - interval '30 minutes' THEN 'Overdue'
                ELSE 'Healthy' END AS health,
           sc.consecutive_failures AS failures, sc.last_run_at::date::text AS last,
           (SELECT d.error_category FROM report_deliveries d WHERE d.schedule_id = sc.id AND d.status = 'failed' ORDER BY d.run_at DESC LIMIT 1) AS error,
           sc.next_run_at::date::text AS next
      FROM report_schedules sc ${OWNER_JOIN("sc")}
     WHERE ${q.co("sc")}
     ORDER BY (CASE WHEN sc.status = 'failed' THEN 0 WHEN sc.consecutive_failures > 0 THEN 1 WHEN sc.next_run_at < now() - interval '30 minutes' THEN 2 ELSE 3 END), sc.next_run_at NULLS LAST, owner`,
  kpis: ({ rows }) => [count("healthy", "Healthy", rows.filter((r) => r.health === "Healthy").length), count("attention", "Need attention", rows.filter((r) => r.health === "Failed" || r.health === "Failing" || r.health === "Overdue").length), count("paused", "Paused", rows.filter((r) => r.health === "Paused").length)],
  calculation: ["Failed means three runs in a row failed and the schedule stopped. Failing means the last run failed and it will try again. Overdue means an active schedule is more than 30 minutes past its next run time. Only a category of error is shown, never the report data."],
});
