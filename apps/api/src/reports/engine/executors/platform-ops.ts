import { barChart, count, donutChart, lineChart, listReport, pct, percent, round1, sqlReport, sum } from "../report-spec";

/**
 * Operations reports for the company's own administrators (catalog N01, N05, N07 to N12): usage, background jobs, exports,
 * storage, notification health, integrations and configuration completeness. Everything is limited to the caller's company.
 *
 * Platform-wide views (other companies, API latency, uptime, entitlements) are not here: they belong in the Platform Admin
 * console and stay blocked in this catalog.
 *
 * Tables only the platform may read are reached through the narrow app.report_company_*() functions
 * (migrations 0165 and 0166), which return the caller's company only and never a secret, token or file key.
 */

const LABEL = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const USAGE = "app.report_company_usage()";
const EXPORTS = "app.report_company_exports()";
const HEALTH = "app.report_company_health()";
const INTEGRATIONS = "app.report_company_integrations()";
const MB = (col: string) => `ROUND(${col} / 1048576.0, 2)`;

export const N01 = sqlReport({
  description: "Your company's API requests and emails sent, by month, next to the seats and storage you have.",
  defaultRange: "last12Months",
  tables: ["tenant_daily_usage_counter", "companies"],
  viz: ["line", "kpi", "table"],
  tags: ["usage", "tenant"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "api", label: "API requests", type: "number" },
    { key: "emails", label: "Emails sent", type: "number" },
    { key: "days", label: "Days with activity", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COALESCE(SUM(u.api_request_count), 0)::int AS api, COALESCE(SUM(u.email_sent_count), 0)::int AS emails, COUNT(u.usage_date)::int AS days
      FROM mo LEFT JOIN ${USAGE} u ON u.usage_date >= mo.ms AND u.usage_date < mo.ms + interval '1 month'
     GROUP BY mo.ms ORDER BY mo.ms`,
  summary: (q) => `
    SELECT COALESCE(c.seats_purchased, 0)::int AS seats, COALESCE(c.storage_quota_mb, 0)::int AS quota,
           (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.current()})::int AS employees
      FROM companies c WHERE c.id = ${q.bind(q.ctx.companyId)}::uuid`,
  chart: ({ rows }) => (rows.length ? lineChart({ title: "API requests and emails by month", unit: "count", rows, xKey: "month", series: [{ key: "api", label: "API requests" }, { key: "emails", label: "Emails sent" }] }) : null),
  kpis: ({ rows, summary }) => [count("api", "API requests", sum(rows, "api")), count("emails", "Emails sent", sum(rows, "emails")), count("seats", "Seats purchased", summary.seats ?? 0), count("employees", "Current employees", summary.employees ?? 0)],
  calculation: ["Adds the daily counters kept for your company into months. Days with activity is how many days in the month had any counted request or email.", "Seats purchased comes from your subscription; current employees are people who have joined and have not left."],
});

export const N05 = sqlReport({
  description: "Background jobs the platform ran for your company: how many finished, are waiting, running or failed, and how long they took.",
  defaultRange: "last30Days",
  tables: ["background_jobs"],
  viz: ["bar", "kpi", "table"],
  tags: ["jobs", "status"],
  columns: [
    { key: "job", label: "Job type", type: "text" },
    { key: "total", label: "Jobs", type: "number" },
    { key: "completed", label: "Completed", type: "number" },
    { key: "running", label: "Running", type: "number" },
    { key: "queued", label: "Waiting", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "minutes", label: "Average minutes", type: "number" },
  ],
  sql: (q) => `
    SELECT j.job_type AS job, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE j.status = 'completed')::int AS completed, COUNT(*) FILTER (WHERE j.status = 'running')::int AS running,
           COUNT(*) FILTER (WHERE j.status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed,
           ROUND((AVG(EXTRACT(EPOCH FROM (j.finished_at - j.started_at)) / 60.0) FILTER (WHERE j.status = 'completed' AND j.started_at IS NOT NULL))::numeric, 2) AS minutes
      FROM background_jobs j WHERE ${q.co("j")} AND j.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY j.job_type ORDER BY failed DESC, total DESC, job`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Jobs by type", unit: "jobs", rows, labelKey: "job", valueKey: "total", max: 12 }) : null),
  kpis: ({ rows }) => [count("jobs", "Jobs", sum(rows, "total")), count("failed", "Failed", sum(rows, "failed")), count("queued", "Waiting", sum(rows, "queued"))],
  calculation: ["Counts background jobs created in the range by type and current status. Average minutes covers completed jobs that recorded a start and finish time."],
});

export const N07 = sqlReport({
  description: "Company data exports: how many were requested, finished, failed or expired, how big they were and how long they took.",
  defaultRange: "last90Days",
  tables: ["tenant_data_exports", "background_jobs"],
  viz: ["donut", "kpi", "table"],
  tags: ["export", "jobs"],
  columns: [
    { key: "scope", label: "What was exported", type: "text" },
    { key: "format", label: "Format", type: "text" },
    { key: "exports", label: "Exports", type: "number" },
    { key: "ready", label: "Ready", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "mb", label: "Total size (MB)", type: "number" },
    { key: "minutes", label: "Average minutes", type: "number" },
  ],
  sql: (q) => `
    SELECT ${LABEL("x.scope")} AS scope, UPPER(x.format) AS format, COUNT(*)::int AS exports, COUNT(*) FILTER (WHERE x.status = 'completed')::int AS ready, COUNT(*) FILTER (WHERE x.status = 'failed')::int AS failed,
           COALESCE(${MB("SUM(x.size_bytes)")}, 0) AS mb, ROUND((AVG(EXTRACT(EPOCH FROM (x.completed_at - x.created_at)) / 60.0) FILTER (WHERE x.completed_at IS NOT NULL))::numeric, 2) AS minutes
      FROM ${EXPORTS} x WHERE x.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY x.scope, x.format ORDER BY exports DESC, scope`,
  chart: ({ rows }) => {
    const parts = [{ label: "Ready", n: sum(rows, "ready") }, { label: "Failed", n: sum(rows, "failed") }, { label: "Other", n: Math.max(0, sum(rows, "exports") - sum(rows, "ready") - sum(rows, "failed")) }].filter((p) => p.n > 0);
    return parts.length ? donutChart({ title: "Export outcomes", unit: "exports", rows: parts, labelKey: "label", valueKey: "n" }) : null;
  },
  kpis: ({ rows }) => [count("exports", "Exports", sum(rows, "exports")), count("failed", "Failed", sum(rows, "failed")), { key: "mb", label: "Total size (MB)", value: round1(sum(rows, "mb")), unit: "count" as const }],
  calculation: ["Counts company data exports requested in the range. 'Ready' means the export finished; other statuses (cancelled, expired, still running) are counted in Exports only.", "Size is the stored file size. File names and download keys are never shown."],
});

export const N08 = sqlReport({
  description: "Stored files by source, with how much of your storage allowance the quota-counted files use.",
  tables: ["employee_documents", "candidate_documents", "expense_claim_receipts", "workflow_attachments"],
  viz: ["donut", "kpi", "table"],
  tags: ["storage", "documents"],
  columns: [
    { key: "source", label: "Files from", type: "text" },
    { key: "files", label: "Files", type: "number" },
    { key: "mb", label: "Size (MB)", type: "number" },
    { key: "share", label: "Share of stored (%)", type: "percent" },
    { key: "counted", label: "Counts toward quota", type: "text" },
  ],
  sql: (q) => `
    SELECT s.source, s.files, ${MB("s.bytes")} AS mb, ROUND(s.bytes * 100.0 / NULLIF(SUM(s.bytes) OVER (), 0), 1) AS share, s.counted FROM (
      SELECT 'Employee documents' AS source, COUNT(*)::int AS files, COALESCE(SUM(size_bytes), 0)::numeric AS bytes, 'Yes' AS counted FROM employee_documents d WHERE ${q.co("d")}
      UNION ALL SELECT 'Candidate documents', COUNT(*)::int, COALESCE(SUM(size_bytes), 0)::numeric, 'Yes' FROM candidate_documents d WHERE ${q.co("d")}
      UNION ALL SELECT 'Expense receipts', COUNT(*)::int, COALESCE(SUM(size_bytes), 0)::numeric, 'No' FROM expense_claim_receipts d WHERE ${q.co("d")}
      UNION ALL SELECT 'Workflow attachments', COUNT(*)::int, COALESCE(SUM(size_bytes), 0)::numeric, 'No' FROM workflow_attachments d WHERE ${q.co("d")}
    ) s ORDER BY s.bytes DESC, s.source`,
  summary: (q) => `
    SELECT COALESCE((SELECT storage_quota_mb FROM companies WHERE id = ${q.bind(q.ctx.companyId)}::uuid), 0)::int AS quota,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM (SELECT size_bytes FROM employee_documents d WHERE ${q.co("d")} UNION ALL SELECT size_bytes FROM candidate_documents d WHERE ${q.co("d")}) u)::numeric / 1048576.0 AS used_mb`,
  chart: ({ rows }) => (sum(rows, "files") > 0 ? donutChart({ title: "Stored size by source", unit: "MB", rows, labelKey: "source", valueKey: "mb" }) : null),
  kpis: ({ rows, summary }) => [
    { key: "used", label: "Counted toward quota (MB)", value: round1(summary.used_mb ?? 0), unit: "count" as const },
    { key: "quota", label: "Storage allowance (MB)", value: summary.quota ?? 0, unit: "count" as const },
    percent("pctUsed", "Allowance used", (summary.quota ?? 0) > 0 ? round1(((summary.used_mb ?? 0) / (summary.quota as number)) * 100) : null),
    count("files", "Files stored", sum(rows, "files")),
  ],
  calculation: ["Adds up the stored size of each kind of file. Quota is counted on employee and candidate documents, the same as the usage page; receipts and workflow attachments are shown for completeness.", "Backups and exports are not file storage in this sense and are not included."],
});

export const N09 = sqlReport({
  description: "Is notification delivery healthy? For each channel: sent, failed and never-attempted notifications, and when the last one went out or failed.",
  defaultRange: "last30Days",
  tables: ["notification_log"],
  viz: ["kpi", "table"],
  tags: ["notifications", "health"],
  columns: [
    { key: "channel", label: "Channel", type: "text" },
    { key: "total", label: "Notifications", type: "number" },
    { key: "sent", label: "Sent", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "notSent", label: "Logged, not sent", type: "number" },
    { key: "lastSent", label: "Last sent", type: "date" },
    { key: "lastFailed", label: "Last failure", type: "date" },
    { key: "health", label: "Health", type: "text" },
  ],
  sql: (q) => `
    SELECT ${LABEL("n.channel")} AS channel, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE n.status = 'logged')::int AS "notSent", MAX(n.created_at) FILTER (WHERE n.status = 'sent')::date::text AS "lastSent", MAX(n.created_at) FILTER (WHERE n.status = 'failed')::date::text AS "lastFailed",
           CASE WHEN COUNT(*) FILTER (WHERE n.status IN ('sent', 'failed')) = 0 THEN 'Nothing attempted'
                WHEN COUNT(*) FILTER (WHERE n.status = 'failed') * 2 >= COUNT(*) FILTER (WHERE n.status IN ('sent', 'failed')) THEN 'Failing'
                WHEN COUNT(*) FILTER (WHERE n.status = 'failed') > 0 THEN 'Some failures' ELSE 'Healthy' END AS health
      FROM notification_log n WHERE ${q.co("n")} AND n.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY n.channel ORDER BY failed DESC, channel`,
  kpis: ({ rows }) => [count("total", "Notifications", sum(rows, "total")), count("failed", "Failed", sum(rows, "failed")), count("failing", "Channels failing", rows.filter((r) => r.health === "Failing").length)],
  calculation: ["Failing means at least half of the attempted notifications failed (the same rule the platform health check uses). Some failures means a failure but under half. Logged, not sent notifications were recorded without a send attempt, for example when email delivery is not set up."],
});

export const N10 = listReport({
  description: "Your connected integrations and the platform's latest health checks for them, so a broken connection shows up.",
  tables: ["tenant_integrations", "tenant_health_check_log"],
  tags: ["integrations", "health"],
  countLabel: "Items",
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "state", label: "State", type: "text" },
    { key: "detail", label: "Detail", type: "text" },
    { key: "when", label: "Last updated or checked", type: "date" },
  ],
  sql: () => `
    SELECT * FROM (
      SELECT ${LABEL("i.provider_key")} AS name, 'Integration' AS kind, CASE WHEN i.enabled THEN 'Enabled' ELSE 'Disabled' END AS state,
             CASE WHEN i.scim_enabled THEN 'SCIM provisioning on' ELSE 'No provisioning' END AS detail, i.updated_at::date::text AS "when", 1 AS ord
        FROM ${INTEGRATIONS} i
      UNION ALL
      SELECT ${LABEL("h.check_key")}, 'Latest health check', ${LABEL("h.status")}, LEFT(COALESCE(h.detail, ''), 200), h.checked_at::date::text, 2
        FROM (SELECT DISTINCT ON (check_key) check_key, status, detail, checked_at FROM ${HEALTH} ORDER BY check_key, checked_at DESC) h
       WHERE h.check_key IN ('integrations', 'webhook', 'email')
    ) t ORDER BY t.ord, t.name`,
  kpis: ({ rows }) => [count("enabled", "Integrations enabled", rows.filter((r) => r.kind === "Integration" && r.state === "Enabled").length), count("unhealthy", "Checks not healthy", rows.filter((r) => r.kind === "Latest health check" && r.state !== "Ok").length)],
  calculation: ["Integrations are the connections configured for your company. The health rows are the most recent result for the integrations, webhook and email checks. Secrets, tokens and settings are never shown."],
});

export const N11 = listReport({
  description: "Data imports and company exports that failed or finished with failed rows.",
  defaultRange: "last90Days",
  tables: ["import_batches", "tenant_data_exports"],
  tags: ["import", "export", "failures"],
  countLabel: "Problem runs",
  columns: [
    { key: "when", label: "When", type: "date" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "what", label: "What", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "failedRows", label: "Failed rows", type: "number" },
    { key: "error", label: "Error", type: "text" },
  ],
  sql: (q) => `
    SELECT t."when", t.kind, t.what, t.status, t."failedRows", t.error FROM (
      SELECT b.created_at AS at, b.created_at::date::text AS "when", 'Import' AS kind, ${LABEL("b.import_type")} || ' - ' || COALESCE(b.file_name, 'file') AS what, ${LABEL("b.status")} AS status,
             COALESCE(b.failed_rows, 0) AS "failedRows", COALESCE(NULLIF(LEFT(b.last_error, 200), ''), 'No error text') AS error
        FROM import_batches b WHERE ${q.co("b")} AND (b.status = 'failed' OR COALESCE(b.failed_rows, 0) > 0) AND b.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL
      SELECT x.created_at, x.created_at::date::text, 'Export', ${LABEL("x.scope")} || ' (' || UPPER(x.format) || ')', ${LABEL("x.status")}, 0, COALESCE(NULLIF(LEFT(x.error, 200), ''), 'No error text')
        FROM ${EXPORTS} x WHERE x.status = 'failed' AND x.created_at::date BETWEEN ${q.from} AND ${q.to}
    ) t ORDER BY t.at DESC`,
  kpis: ({ rows }) => [count("imports", "Imports", rows.filter((r) => r.kind === "Import").length), count("exports", "Exports", rows.filter((r) => r.kind === "Export").length), count("failedRows", "Failed import rows", sum(rows, "failedRows"))],
  calculation: ["Lists imports that failed or had rows that could not be imported, and exports that failed, created in the range. Error text is cut to 200 characters."],
});

export const N12 = sqlReport({
  description: "A checklist of the setup an administrator is expected to finish, and which parts are still empty.",
  tables: ["companies", "company_config", "org_units", "locations", "cost_centers", "positions", "leave_types", "holiday_calendars", "payroll_areas", "tax_profiles", "workflow_templates", "shifts"],
  viz: ["kpi", "table"],
  tags: ["configuration", "setup"],
  columns: [
    { key: "area", label: "Area", type: "text" },
    { key: "item", label: "What should be set up", type: "text" },
    { key: "state", label: "State", type: "text" },
    { key: "count", label: "Records", type: "number" },
  ],
  sql: (q) => `
    SELECT t.area, t.item, CASE WHEN t.n > 0 THEN 'Done' ELSE 'Missing' END AS state, t.n AS count FROM (
      SELECT 1 AS ord, 'Company' AS area, 'Legal name, registration number, industry, country, time zone and currency filled in' AS item,
             (CASE WHEN COALESCE(c.legal_name, '') <> '' AND COALESCE(c.registration_number, '') <> '' AND COALESCE(c.industry, '') <> '' AND COALESCE(c.country, '') <> '' AND COALESCE(c.timezone, '') <> '' AND COALESCE(c.currency, '') <> '' THEN 1 ELSE 0 END)::int AS n
        FROM companies c WHERE c.id = ${q.bind(q.ctx.companyId)}::uuid
      UNION ALL SELECT 2, 'Organisation', 'Organisation units', COUNT(*)::int FROM org_units x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 3, 'Organisation', 'Locations', COUNT(*)::int FROM locations x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 4, 'Organisation', 'Positions', COUNT(*)::int FROM positions x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 5, 'Organisation', 'Cost centres', COUNT(*)::int FROM cost_centers x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 6, 'Time and leave', 'Leave types', COUNT(*)::int FROM leave_types x WHERE ${q.co("x")} AND x.is_active
      UNION ALL SELECT 7, 'Time and leave', 'Holiday calendars', COUNT(*)::int FROM holiday_calendars x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 8, 'Time and leave', 'Shifts', COUNT(*)::int FROM shifts x WHERE ${q.co("x")}
      UNION ALL SELECT 9, 'Payroll', 'Payroll areas', COUNT(*)::int FROM payroll_areas x WHERE ${q.co("x")} AND x.is_active
      UNION ALL SELECT 10, 'Payroll', 'Published tax profiles', COUNT(*)::int FROM tax_profiles x WHERE ${q.co("x")} AND x.status = 'published'
      UNION ALL SELECT 11, 'Workflow', 'Active workflow templates', COUNT(*)::int FROM workflow_templates x WHERE ${q.co("x")} AND x.is_active
    ) t ORDER BY t.ord`,
  chart: ({ rows }) => (rows.length ? donutChart({ title: "Setup items", unit: "items", rows: [{ label: "Done", n: rows.filter((r) => r.state === "Done").length }, { label: "Missing", n: rows.filter((r) => r.state === "Missing").length }].filter((p) => p.n > 0), labelKey: "label", valueKey: "n" }) : null),
  kpis: ({ rows }) => [count("done", "Items done", rows.filter((r) => r.state === "Done").length), count("missing", "Items missing", rows.filter((r) => r.state === "Missing").length), percent("rate", "Complete", pct(rows.filter((r) => r.state === "Done").length, rows.length))],
  calculation: ["An item is done when at least one active record of that kind exists (or, for the company profile, every listed field is filled in). Whether the records are correct is not judged.", "This is a checklist of common setup, not a statement of what your company is legally required to configure."],
});
