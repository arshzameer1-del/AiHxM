import type { Q, ReportSectionSpec } from "../report-spec";
import { col } from "./common";

/**
 * Extra tables for the operations reports (N01, N05 to N12) and the reports-about-reports (O01 to O15).
 *
 * Operations tables read only the company's own rows or the narrow app.report_company_*() functions: no secrets, tokens, file
 * names, file keys, recipient addresses or message bodies. The governance tables read report_run_log (safe telemetry only) and
 * the saved-report tables; the names of private saved reports and dashboards are never shown, only that one exists.
 */

const USAGE = "app.report_company_usage()";
const EXPORTS = "app.report_company_exports()";
const HEALTH = "app.report_company_health()";
const INTEGRATIONS = "app.report_company_integrations()";
const LBL = (c: string) => `INITCAP(REPLACE(REPLACE(${c}, '_', ' '), '.', ' - '))`;
const MB = (c: string) => `ROUND(${c} / 1048576.0, 2)`;
const n = (key: string, label: string) => col(key, label, "number");
const pc = (key: string, label: string) => col(key, label, "percent");
const dt = (key: string, label: string) => col(key, label, "date");
const MONTH_OF = (c: string) => `to_char(date_trunc('month', ${c}), 'YYYY-MM')`;
const TZ = (c: string) => `(${c} AT TIME ZONE 'Asia/Karachi')`;
const WEEKDAY = (c: string) => `CASE EXTRACT(isodow FROM ${TZ(c)})::int WHEN 1 THEN '1 Monday' WHEN 2 THEN '2 Tuesday' WHEN 3 THEN '3 Wednesday' WHEN 4 THEN '4 Thursday' WHEN 5 THEN '5 Friday' WHEN 6 THEN '6 Saturday' ELSE '7 Sunday' END`;
const WEEKDAY_OF_DATE = (c: string) => `CASE EXTRACT(isodow FROM ${c})::int WHEN 1 THEN '1 Monday' WHEN 2 THEN '2 Tuesday' WHEN 3 THEN '3 Wednesday' WHEN 4 THEN '4 Thursday' WHEN 5 THEN '5 Friday' WHEN 6 THEN '6 Saturday' ELSE '7 Sunday' END`;
const WHO = (emp: string) => `COALESCE(NULLIF(TRIM(COALESCE(${emp}.first_name, '') || ' ' || COALESCE(${emp}.last_name, '')), ''), 'A user without an employee record')`;
const LOG_USER = (log = "l", emp = "le") => `LEFT JOIN employees ${emp} ON ${emp}.user_account_id = ${log}.user_account_id AND ${emp}.company_id = ${log}.company_id`;
const IN_RANGE = (q: Q, a: string, c = "created_at") => `${a}.${c}::date BETWEEN ${q.from} AND ${q.to}`;
const OWNER = (emp = "oe") => WHO(emp);
const OWNER_JOIN = (alias: string, emp = "oe") => `LEFT JOIN employees ${emp} ON ${emp}.user_account_id = ${alias}.owner_user_account_id AND ${emp}.company_id = ${alias}.company_id`;
/** The report catalog as parallel arrays for unnest(): id, title, category label, domain, status. */
const CATALOG = (q: Q) => {
  const c = q.ctx.catalog;
  return `unnest(${q.bind(c.map((x) => x.id))}::text[], ${q.bind(c.map((x) => x.title))}::text[], ${q.bind(c.map((x) => x.categoryLabel))}::text[], ${q.bind(c.map((x) => x.domain))}::text[], ${q.bind(c.map((x) => x.status))}::text[]) AS cat(id, title, label, domain, status)`;
};
/** Duration bands in seconds, ordered by their number prefix. */
const SECONDS_BAND = (c: string) => `CASE WHEN ${c} IS NULL THEN '9 Not recorded' WHEN ${c} < 60 THEN '1 Under 1 minute' WHEN ${c} < 300 THEN '2 1 to 5 minutes' WHEN ${c} < 900 THEN '3 5 to 15 minutes' WHEN ${c} < 3600 THEN '4 15 to 60 minutes' ELSE '5 Over an hour' END`;
const MS_BAND = (c: string) => `CASE WHEN ${c} < 500 THEN '1 Under 0.5 seconds' WHEN ${c} < 2000 THEN '2 0.5 to 2 seconds' WHEN ${c} < 5000 THEN '3 2 to 5 seconds' WHEN ${c} < 15000 THEN '4 5 to 15 seconds' ELSE '5 Over 15 seconds' END`;

// ================================================================ N01: usage

const N01_WEEKDAY: ReportSectionSpec = {
  key: "usage-by-weekday",
  title: "Usage by day of the week",
  description: "Average API requests and emails on each day of the week, over the days that had any activity.",
  columns: [col("label", "Day"), n("days", "Days with activity"), n("api", "API requests"), n("emails", "Emails sent"), n("avgApi", "Average requests per day")],
  sql: (q) => `
    SELECT substr(x.label, 3) AS label, COUNT(*)::int AS days, SUM(x.api)::int AS api, SUM(x.emails)::int AS emails, ROUND(AVG(x.api), 0)::int AS "avgApi"
      FROM (SELECT ${WEEKDAY_OF_DATE("u.usage_date")} AS label, u.api_request_count AS api, u.email_sent_count AS emails FROM ${USAGE} u WHERE u.usage_date BETWEEN ${q.from} AND ${q.to}) x
     GROUP BY x.label ORDER BY x.label`,
};
const N01_BUSIEST: ReportSectionSpec = {
  key: "busiest-days",
  title: "Busiest days",
  description: "The 25 days with the most API requests in the period.",
  columns: [dt("day", "Day"), n("api", "API requests"), n("emails", "Emails sent")],
  sql: (q) => `
    SELECT u.usage_date::text AS day, u.api_request_count AS api, u.email_sent_count AS emails FROM ${USAGE} u WHERE u.usage_date BETWEEN ${q.from} AND ${q.to} ORDER BY u.api_request_count DESC, u.usage_date DESC LIMIT 25`,
};
const N01_CHANGE: ReportSectionSpec = {
  key: "usage-month-on-month",
  title: "Month on month change",
  description: "Each month against the one before it.",
  columns: [col("month", "Month"), n("api", "API requests"), n("previous", "Previous month"), pc("change", "Change (%)"), n("emails", "Emails sent")],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         m AS (SELECT to_char(mo.ms, 'YYYY-MM') AS month, mo.ms, COALESCE(SUM(u.api_request_count), 0)::int AS api, COALESCE(SUM(u.email_sent_count), 0)::int AS emails
                 FROM mo LEFT JOIN ${USAGE} u ON u.usage_date >= mo.ms AND u.usage_date < mo.ms + interval '1 month' GROUP BY mo.ms)
    SELECT m.month, m.api, LAG(m.api) OVER (ORDER BY m.ms)::int AS previous,
           ROUND((m.api - LAG(m.api) OVER (ORDER BY m.ms)) * 100.0 / NULLIF(LAG(m.api) OVER (ORDER BY m.ms), 0), 1) AS change, m.emails
      FROM m ORDER BY m.ms`,
};
const N01_CAPACITY: ReportSectionSpec = {
  key: "seats-and-storage",
  title: "Seats and storage against the allowance",
  description: "Seats purchased against current employees and logins, and stored documents against the storage allowance.",
  columns: [col("item", "Item"), n("used", "In use"), n("allowance", "Allowance"), n("left", "Left"), pc("pctUsed", "Used (%)")],
  sql: (q) => `
    SELECT t.item, t.used, t.allowance, t.allowance - t.used AS "left", ROUND(t.used * 100.0 / NULLIF(t.allowance, 0), 1) AS "pctUsed" FROM (
      SELECT 1 AS ord, 'Seats (current employees)' AS item,
             (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.current()})::int AS used, COALESCE(c.seats_purchased, 0)::int AS allowance FROM companies c WHERE c.id = ${q.bind(q.ctx.companyId)}::uuid
      UNION ALL
      SELECT 2, 'Storage (MB, employee and candidate documents)',
             ROUND(((SELECT COALESCE(SUM(size_bytes), 0) FROM employee_documents d WHERE ${q.co("d")}) + (SELECT COALESCE(SUM(size_bytes), 0) FROM candidate_documents d WHERE ${q.co("d")}))::numeric / 1048576.0)::int,
             COALESCE(c.storage_quota_mb, 0)::int FROM companies c WHERE c.id = ${q.bind(q.ctx.companyId)}::uuid
    ) t ORDER BY t.ord`,
};

// ================================================================ N05: background jobs

const JOB_RANGE = (q: Q) => `${q.co("j")} AND ${IN_RANGE(q, "j")}`;
const N05_STATUS: ReportSectionSpec = {
  key: "jobs-by-status",
  title: "Jobs by status",
  description: "Where every job in the period stands now, and how many ended in the dead-letter queue after running out of attempts.",
  columns: [col("label", "Status"), n("jobs", "Jobs"), pc("share", "Share (%)"), n("deadLettered", "Gave up after retries"), n("attempts", "Average attempts")],
  sql: (q) => `
    SELECT ${LBL("j.status")} AS label, COUNT(*)::int AS jobs, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, COUNT(*) FILTER (WHERE j.dead_lettered)::int AS "deadLettered", ROUND(AVG(j.attempts), 1) AS attempts
      FROM background_jobs j WHERE ${JOB_RANGE(q)} GROUP BY j.status ORDER BY jobs DESC, label`,
};
const N05_DAY: ReportSectionSpec = {
  key: "jobs-by-day",
  title: "Jobs by day",
  description: "Jobs created each day with their outcome.",
  columns: [dt("day", "Day"), n("jobs", "Jobs"), n("completed", "Completed"), n("failed", "Failed"), n("open", "Waiting or running")],
  sql: (q) => `
    SELECT j.created_at::date::text AS day, COUNT(*)::int AS jobs, COUNT(*) FILTER (WHERE j.status = 'completed')::int AS completed, COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE j.status IN ('queued', 'running'))::int AS open
      FROM background_jobs j WHERE ${JOB_RANGE(q)} GROUP BY 1 ORDER BY 1`,
};
const N05_MONTH: ReportSectionSpec = {
  key: "jobs-by-month",
  title: "Jobs and failure rate by month",
  columns: [col("month", "Month"), n("jobs", "Jobs"), n("failed", "Failed"), pc("rate", "Failed (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("j.created_at")} AS month, COUNT(*)::int AS jobs, COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed, ROUND(COUNT(*) FILTER (WHERE j.status = 'failed') * 100.0 / COUNT(*), 1) AS rate
      FROM background_jobs j WHERE ${JOB_RANGE(q)} GROUP BY 1 ORDER BY 1`,
};
const N05_DURATION: ReportSectionSpec = {
  key: "job-duration",
  title: "How long completed jobs took",
  description: "Completed jobs grouped by the time between starting and finishing.",
  columns: [col("label", "Time taken"), n("jobs", "Jobs"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS jobs, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT ${SECONDS_BAND("EXTRACT(EPOCH FROM (j.finished_at - j.started_at))")} AS band FROM background_jobs j WHERE ${JOB_RANGE(q)} AND j.status = 'completed') x GROUP BY x.band ORDER BY x.band`,
};
const N05_FAILED: ReportSectionSpec = {
  key: "failed-jobs",
  title: "Failed jobs",
  description: "The 100 latest failed jobs: what ran, how many attempts it had and whether it gave up. The error text is not shown.",
  columns: [dt("day", "Created"), col("job", "Job type"), n("attempts", "Attempts"), n("maxAttempts", "Attempts allowed"), col("gaveUp", "Gave up"), n("minutes", "Minutes before failing")],
  sql: (q) => `
    SELECT j.created_at::date::text AS day, ${LBL("j.job_type")} AS job, j.attempts, j.max_attempts AS "maxAttempts", CASE WHEN j.dead_lettered THEN 'Yes' ELSE 'No' END AS "gaveUp",
           ROUND((EXTRACT(EPOCH FROM (j.finished_at - j.started_at)) / 60.0)::numeric, 1) AS minutes
      FROM background_jobs j WHERE ${JOB_RANGE(q)} AND j.status = 'failed' ORDER BY j.created_at DESC LIMIT 100`,
};
const N05_WAITING: ReportSectionSpec = {
  key: "waiting-jobs",
  title: "Jobs still waiting or running",
  description: "How long each open job type has been in the queue.",
  columns: [col("job", "Job type"), col("status", "Status"), n("jobs", "Jobs"), n("oldestHours", "Oldest (hours)"), n("avgProgress", "Average progress (%)")],
  sql: (q) => `
    SELECT ${LBL("j.job_type")} AS job, ${LBL("j.status")} AS status, COUNT(*)::int AS jobs, ROUND(MAX(EXTRACT(EPOCH FROM (now() - j.created_at)) / 3600.0)::numeric, 1) AS "oldestHours", ROUND(AVG(j.progress_percent), 0) AS "avgProgress"
      FROM background_jobs j WHERE ${JOB_RANGE(q)} AND j.status IN ('queued', 'running') GROUP BY j.job_type, j.status ORDER BY "oldestHours" DESC, job`,
};
const N05_RETRY: ReportSectionSpec = {
  key: "job-retries",
  title: "Jobs that needed retries",
  description: "Job types where jobs needed more than one attempt.",
  columns: [col("job", "Job type"), n("jobs", "Jobs"), n("retried", "Needed a retry"), pc("rate", "Retried (%)"), n("maxAttempts", "Most attempts")],
  sql: (q) => `
    SELECT ${LBL("j.job_type")} AS job, COUNT(*)::int AS jobs, COUNT(*) FILTER (WHERE j.attempts > 1)::int AS retried, ROUND(COUNT(*) FILTER (WHERE j.attempts > 1) * 100.0 / COUNT(*), 1) AS rate, MAX(j.attempts)::int AS "maxAttempts"
      FROM background_jobs j WHERE ${JOB_RANGE(q)} GROUP BY j.job_type HAVING COUNT(*) FILTER (WHERE j.attempts > 1) > 0 ORDER BY retried DESC, job`,
};

// ================================================================ N06: scheduled report health

const SCHEDULE_HEALTH = `CASE WHEN sc.status = 'failed' THEN 'Failed' WHEN sc.status = 'paused' THEN 'Paused' WHEN sc.consecutive_failures > 0 THEN 'Failing'
                  WHEN sc.next_run_at IS NOT NULL AND sc.next_run_at < now() - interval '30 minutes' THEN 'Overdue' ELSE 'Healthy' END`;
const N06_HEALTH: ReportSectionSpec = {
  key: "schedule-health",
  title: "Schedules by health",
  columns: [col("label", "Health"), n("schedules", "Schedules"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT ${SCHEDULE_HEALTH} AS label, COUNT(*)::int AS schedules, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM report_schedules sc WHERE ${q.co("sc")} GROUP BY 1 ORDER BY schedules DESC, label`,
};
const N06_FREQUENCY: ReportSectionSpec = {
  key: "schedule-frequency",
  title: "Schedules by frequency and format",
  columns: [col("frequency", "Repeats"), col("format", "Format"), n("schedules", "Schedules"), n("failing", "Failing or failed")],
  sql: (q) => `
    SELECT ${LBL("sc.frequency")} AS frequency, UPPER(sc.format) AS format, COUNT(*)::int AS schedules, COUNT(*) FILTER (WHERE sc.status = 'failed' OR sc.consecutive_failures > 0)::int AS failing
      FROM report_schedules sc WHERE ${q.co("sc")} GROUP BY sc.frequency, sc.format ORDER BY schedules DESC, frequency`,
};
const N06_OWNER: ReportSectionSpec = {
  key: "schedules-by-owner",
  title: "Schedules by owner",
  columns: [col("owner", "Owner"), n("schedules", "Schedules"), n("failing", "Failing or failed"), n("paused", "Paused")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, COUNT(*)::int AS schedules, COUNT(*) FILTER (WHERE sc.status = 'failed' OR sc.consecutive_failures > 0)::int AS failing, COUNT(*) FILTER (WHERE sc.status = 'paused')::int AS paused
      FROM report_schedules sc ${OWNER_JOIN("sc")} WHERE ${q.co("sc")} GROUP BY sc.owner_user_account_id, oe.id, oe.first_name, oe.last_name ORDER BY failing DESC, schedules DESC, owner`,
};
const N06_ERRORS: ReportSectionSpec = {
  key: "delivery-errors",
  title: "Delivery failures in the last 90 days",
  description: "Why scheduled deliveries failed, by error category.",
  columns: [col("category", "Error category"), n("failures", "Failures"), n("schedules", "Schedules affected"), dt("last", "Latest")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(d.error_category, 'unknown')")} AS category, COUNT(*)::int AS failures, COUNT(DISTINCT d.schedule_id)::int AS schedules, MAX(d.run_at)::date::text AS last
      FROM report_deliveries d WHERE ${q.co("d")} AND d.status = 'failed' AND d.run_at::date >= ${q.today} - 90 GROUP BY 1 ORDER BY failures DESC, category`,
};
const N06_HISTORY: ReportSectionSpec = {
  key: "delivery-history",
  title: "Deliveries by month (last 6 months)",
  columns: [col("month", "Month"), n("runs", "Runs"), n("delivered", "Delivered"), n("failed", "Failed"), n("skipped", "Skipped"), pc("success", "Success (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("d.run_at")} AS month, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE d.status IN ('sent', 'stored'))::int AS delivered, COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE d.status = 'skipped')::int AS skipped,
           ROUND(COUNT(*) FILTER (WHERE d.status IN ('sent', 'stored')) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE d.status <> 'skipped'), 0), 1) AS success
      FROM report_deliveries d WHERE ${q.co("d")} AND d.run_at::date >= date_trunc('month', ${q.today} - interval '5 months')::date GROUP BY 1 ORDER BY 1`,
};

// ================================================================ N07: data exports

const N07_STATUS: ReportSectionSpec = {
  key: "exports-by-status",
  title: "Exports by status",
  columns: [col("label", "Status"), n("exports", "Exports"), pc("share", "Share (%)"), n("mb", "Total size (MB)")],
  sql: (q) => `
    SELECT ${LBL("x.status")} AS label, COUNT(*)::int AS exports, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, COALESCE(${MB("SUM(x.size_bytes)")}, 0) AS mb
      FROM ${EXPORTS} x WHERE ${IN_RANGE(q, "x")} GROUP BY x.status ORDER BY exports DESC, label`,
};
const N07_MONTH: ReportSectionSpec = {
  key: "exports-by-month",
  title: "Exports by month",
  columns: [col("month", "Month"), n("exports", "Exports"), n("failed", "Failed"), n("mb", "Total size (MB)"), n("minutes", "Average minutes")],
  sql: (q) => `
    SELECT ${MONTH_OF("x.created_at")} AS month, COUNT(*)::int AS exports, COUNT(*) FILTER (WHERE x.status = 'failed')::int AS failed, COALESCE(${MB("SUM(x.size_bytes)")}, 0) AS mb,
           ROUND((AVG(EXTRACT(EPOCH FROM (x.completed_at - x.created_at)) / 60.0) FILTER (WHERE x.completed_at IS NOT NULL))::numeric, 2) AS minutes
      FROM ${EXPORTS} x WHERE ${IN_RANGE(q, "x")} GROUP BY 1 ORDER BY 1`,
};
const N07_PROTECTION: ReportSectionSpec = {
  key: "export-protection",
  title: "Password protection",
  description: "How many exports were protected with a password.",
  columns: [col("label", "Protection"), n("exports", "Exports"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT CASE WHEN x.is_password_protected THEN 'Password protected' ELSE 'No password' END AS label, COUNT(*)::int AS exports, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM ${EXPORTS} x WHERE ${IN_RANGE(q, "x")} GROUP BY 1 ORDER BY exports DESC`,
};
const N07_LARGEST: ReportSectionSpec = {
  key: "largest-exports",
  title: "Largest exports",
  description: "The 25 biggest exports in the period. File names are not shown.",
  columns: [dt("day", "Requested"), col("scope", "What was exported"), col("format", "Format"), col("status", "Status"), n("mb", "Size (MB)"), n("minutes", "Minutes to prepare")],
  sql: (q) => `
    SELECT x.created_at::date::text AS day, ${LBL("x.scope")} AS scope, UPPER(x.format) AS format, ${LBL("x.status")} AS status, ${MB("x.size_bytes")} AS mb, ROUND((EXTRACT(EPOCH FROM (x.completed_at - x.created_at)) / 60.0)::numeric, 1) AS minutes
      FROM ${EXPORTS} x WHERE ${IN_RANGE(q, "x")} AND x.size_bytes IS NOT NULL ORDER BY x.size_bytes DESC LIMIT 25`,
};
const N07_EXPIRING: ReportSectionSpec = {
  key: "exports-expiring",
  title: "Finished exports about to expire",
  description: "Exports that are ready and expire within 7 days, so they can be downloaded in time.",
  columns: [col("scope", "What was exported"), col("format", "Format"), n("mb", "Size (MB)"), dt("expires", "Expires"), n("daysLeft", "Days left")],
  sql: (q) => `
    SELECT ${LBL("x.scope")} AS scope, UPPER(x.format) AS format, ${MB("x.size_bytes")} AS mb, x.expires_at::date::text AS expires, (x.expires_at::date - ${q.today})::int AS "daysLeft"
      FROM ${EXPORTS} x WHERE x.status = 'completed' AND x.expires_at::date BETWEEN ${q.today} AND ${q.today} + 7 ORDER BY x.expires_at`,
};
const N07_FAILED: ReportSectionSpec = {
  key: "failed-exports",
  title: "Failed exports",
  description: "Exports that failed in the period, with the error text cut to 200 characters.",
  columns: [dt("day", "Requested"), col("scope", "What was exported"), col("format", "Format"), col("error", "Error")],
  sql: (q) => `
    SELECT x.created_at::date::text AS day, ${LBL("x.scope")} AS scope, UPPER(x.format) AS format, COALESCE(NULLIF(LEFT(x.error, 200), ''), 'No error text') AS error
      FROM ${EXPORTS} x WHERE ${IN_RANGE(q, "x")} AND x.status = 'failed' ORDER BY x.created_at DESC LIMIT 100`,
};

// ================================================================ N08: storage

const N08_TYPE: ReportSectionSpec = {
  key: "documents-by-type",
  title: "Employee documents by type",
  columns: [col("label", "Document type"), n("files", "Files"), n("mb", "Size (MB)"), n("avgKb", "Average file size (KB)"), n("employees", "Employees with one")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(d.document_type, 'not_set')")} AS label, COUNT(*)::int AS files, ${MB("SUM(d.size_bytes)")} AS mb, ROUND(AVG(d.size_bytes) / 1024.0, 0) AS "avgKb", COUNT(DISTINCT d.employee_id)::int AS employees
      FROM employee_documents d WHERE ${q.co("d")} GROUP BY d.document_type ORDER BY mb DESC NULLS LAST, label`,
};
const N08_MIME: ReportSectionSpec = {
  key: "documents-by-file-kind",
  title: "Stored files by file kind",
  description: "Employee and candidate documents together, by file type.",
  columns: [col("label", "File kind"), n("files", "Files"), n("mb", "Size (MB)"), pc("share", "Share of stored size (%)")],
  sql: (q) => `
    SELECT x.label, COUNT(*)::int AS files, ${MB("SUM(x.size_bytes)")} AS mb, ROUND(SUM(x.size_bytes) * 100.0 / NULLIF(SUM(SUM(x.size_bytes)) OVER (), 0), 1) AS share FROM (
      SELECT COALESCE(NULLIF(split_part(d.mime_type, '/', 2), ''), 'Unknown') AS label, d.size_bytes::numeric AS size_bytes FROM employee_documents d WHERE ${q.co("d")}
      UNION ALL SELECT COALESCE(NULLIF(split_part(c.mime_type, '/', 2), ''), 'Unknown'), c.size_bytes::numeric FROM candidate_documents c WHERE ${q.co("c")}
    ) x GROUP BY x.label ORDER BY mb DESC NULLS LAST, label`,
};
const N08_MONTH: ReportSectionSpec = {
  key: "storage-growth",
  title: "Storage added by month (last 12 months)",
  description: "Employee and candidate files added each month and the running total.",
  columns: [col("month", "Month"), n("files", "Files added"), n("mb", "Added (MB)"), n("runningMb", "Total stored by month end (MB)")],
  sql: (q) => `
    WITH m AS (
      SELECT ${MONTH_OF("x.created_at")} AS month, COUNT(*)::int AS files, SUM(x.size_bytes)::numeric AS bytes FROM (
        SELECT d.created_at, d.size_bytes FROM employee_documents d WHERE ${q.co("d")}
        UNION ALL SELECT c.created_at, c.size_bytes FROM candidate_documents c WHERE ${q.co("c")}) x GROUP BY 1)
    SELECT m.month, m.files, ${MB("m.bytes")} AS mb, ${MB("SUM(m.bytes) OVER (ORDER BY m.month)")} AS "runningMb"
      FROM m ORDER BY m.month DESC LIMIT 12`,
};
const N08_UNIT: ReportSectionSpec = {
  key: "documents-by-unit",
  title: "Employee documents by organisation unit",
  columns: [col("label", "Organisation unit"), n("employees", "Employees with documents"), n("files", "Files"), n("mb", "Size (MB)")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS label, COUNT(DISTINCT d.employee_id)::int AS employees, COUNT(*)::int AS files, ${MB("SUM(d.size_bytes)")} AS mb
      FROM employee_documents d JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.co("d")} GROUP BY ou.id, ou.name ORDER BY mb DESC NULLS LAST, label`,
};
const N08_LARGE: ReportSectionSpec = {
  key: "largest-files",
  title: "Largest stored files",
  description: "The 25 largest employee and candidate documents by type and size. Names and owners are not shown.",
  columns: [col("source", "From"), col("type", "Document type"), n("mb", "Size (MB)"), dt("added", "Added")],
  sql: (q) => `
    SELECT x.source, x.type, ${MB("x.size_bytes")} AS mb, x.created_at::date::text AS added FROM (
      SELECT 'Employee document' AS source, ${LBL("COALESCE(d.document_type, 'not_set')")} AS type, d.size_bytes::numeric AS size_bytes, d.created_at FROM employee_documents d WHERE ${q.co("d")}
      UNION ALL SELECT 'Candidate document', ${LBL("COALESCE(c.doc_type, 'not_set')")}, c.size_bytes::numeric, c.created_at FROM candidate_documents c WHERE ${q.co("c")}
    ) x ORDER BY x.size_bytes DESC NULLS LAST LIMIT 25`,
};

// ================================================================ N09: notification health

const N09_STATUS: ReportSectionSpec = {
  key: "notifications-by-status",
  title: "Notifications by channel and status",
  columns: [col("channel", "Channel"), col("status", "Status"), n("total", "Notifications"), pc("share", "Share of channel (%)")],
  sql: (q) => `
    SELECT ${LBL("n.channel")} AS channel, ${LBL("n.status")} AS status, COUNT(*)::int AS total, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY n.channel), 1) AS share
      FROM notification_log n WHERE ${q.co("n")} AND ${IN_RANGE(q, "n")} GROUP BY n.channel, n.status ORDER BY channel, total DESC`,
};
const N09_DAY: ReportSectionSpec = {
  key: "notifications-by-day",
  title: "Notifications by day",
  columns: [dt("day", "Day"), n("total", "Notifications"), n("sent", "Sent"), n("failed", "Failed"), pc("rate", "Failed (%)")],
  sql: (q) => `
    SELECT n.created_at::date::text AS day, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed,
           ROUND(COUNT(*) FILTER (WHERE n.status = 'failed') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE n.status IN ('sent', 'failed')), 0), 1) AS rate
      FROM notification_log n WHERE ${q.co("n")} AND ${IN_RANGE(q, "n")} GROUP BY 1 ORDER BY 1`,
};
const N09_TEMPLATE: ReportSectionSpec = {
  key: "notifications-by-template",
  title: "Notifications by template",
  description: "Which message templates are sent most and which fail. Message text and recipients are not shown.",
  columns: [col("template", "Template"), n("total", "Notifications"), n("sent", "Sent"), n("failed", "Failed"), pc("rate", "Failed (%)")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(n.template_key, 'not_set')")} AS template, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed,
           ROUND(COUNT(*) FILTER (WHERE n.status = 'failed') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE n.status IN ('sent', 'failed')), 0), 1) AS rate
      FROM notification_log n WHERE ${q.co("n")} AND ${IN_RANGE(q, "n")} GROUP BY n.template_key ORDER BY failed DESC, total DESC, template`,
};
const N09_HOUR: ReportSectionSpec = {
  key: "notifications-by-hour",
  title: "Notifications by hour of the day",
  columns: [col("hour", "Hour (Pakistan time)"), n("total", "Notifications"), n("failed", "Failed")],
  sql: (q) => `
    SELECT lpad(EXTRACT(hour FROM ${TZ("n.created_at")})::int::text, 2, '0') || ':00' AS hour, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed
      FROM notification_log n WHERE ${q.co("n")} AND ${IN_RANGE(q, "n")} GROUP BY 1 ORDER BY 1`,
};
const N09_RECIPIENTS: ReportSectionSpec = {
  key: "notification-volume",
  title: "Volume against distinct recipients",
  description: "How many different recipients each channel reached. Addresses are not shown.",
  columns: [col("channel", "Channel"), n("total", "Notifications"), n("recipients", "Different recipients"), n("perRecipient", "Per recipient")],
  sql: (q) => `
    SELECT ${LBL("n.channel")} AS channel, COUNT(*)::int AS total, COUNT(DISTINCT n.recipient)::int AS recipients, ROUND(COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT n.recipient), 0), 1) AS "perRecipient"
      FROM notification_log n WHERE ${q.co("n")} AND ${IN_RANGE(q, "n")} GROUP BY n.channel ORDER BY total DESC, channel`,
};

// ================================================================ N10: integrations and health checks

const N10_STATE: ReportSectionSpec = {
  key: "integration-state",
  title: "Integrations at a glance",
  columns: [col("label", "Provider"), col("state", "State"), col("provisioning", "Provisioning"), dt("changed", "Last changed"), n("daysAgo", "Days since changed")],
  sql: (q) => `
    SELECT ${LBL("i.provider_key")} AS label, CASE WHEN i.enabled THEN 'Enabled' ELSE 'Disabled' END AS state, CASE WHEN i.scim_enabled THEN 'On' ELSE 'Off' END AS provisioning, i.updated_at::date::text AS changed, (${q.today} - i.updated_at::date)::int AS "daysAgo"
      FROM ${INTEGRATIONS} i ORDER BY i.enabled DESC, label`,
};
const N10_CHECKS: ReportSectionSpec = {
  key: "health-check-history",
  title: "Health checks over the last 30 days",
  description: "For each check, how many results were healthy and how many were not.",
  columns: [col("check", "Check"), n("results", "Results"), n("ok", "Healthy"), n("notOk", "Not healthy"), dt("last", "Latest result")],
  sql: (q) => `
    SELECT ${LBL("h.check_key")} AS "check", COUNT(*)::int AS results, COUNT(*) FILTER (WHERE LOWER(h.status) = 'ok')::int AS ok, COUNT(*) FILTER (WHERE LOWER(h.status) <> 'ok')::int AS "notOk", MAX(h.checked_at)::date::text AS last
      FROM ${HEALTH} h WHERE h.checked_at::date >= ${q.today} - 30 GROUP BY h.check_key ORDER BY "notOk" DESC, "check"`,
};
const N10_PROBLEMS: ReportSectionSpec = {
  key: "health-problems",
  title: "Checks that were not healthy",
  description: "The 50 latest check results that were not healthy, with the detail cut to 200 characters.",
  columns: [dt("day", "Checked"), col("check", "Check"), col("status", "Result"), col("detail", "Detail")],
  sql: (q) => `
    SELECT h.checked_at::date::text AS day, ${LBL("h.check_key")} AS "check", ${LBL("h.status")} AS status, LEFT(COALESCE(h.detail, ''), 200) AS detail
      FROM ${HEALTH} h WHERE LOWER(h.status) <> 'ok' AND h.checked_at::date >= ${q.today} - 30 ORDER BY h.checked_at DESC LIMIT 50`,
};

// ================================================================ N11: imports and export failures

const N11_TYPE: ReportSectionSpec = {
  key: "imports-by-type",
  title: "Imports by type",
  description: "Every import in the period, not only the problem ones, with rows read, imported and failed.",
  columns: [col("label", "Import type"), n("imports", "Imports"), n("failed", "Failed"), n("rows", "Rows read"), n("imported", "Rows imported"), n("failedRows", "Rows failed"), pc("rate", "Rows imported (%)")],
  sql: (q) => `
    SELECT ${LBL("b.import_type")} AS label, COUNT(*)::int AS imports, COUNT(*) FILTER (WHERE b.status = 'failed')::int AS failed, COALESCE(SUM(b.total_rows), 0)::int AS rows,
           COALESCE(SUM(b.imported_rows), 0)::int AS imported, COALESCE(SUM(b.failed_rows), 0)::int AS "failedRows", ROUND(COALESCE(SUM(b.imported_rows), 0) * 100.0 / NULLIF(SUM(b.total_rows), 0), 1) AS rate
      FROM import_batches b WHERE ${q.co("b")} AND ${IN_RANGE(q, "b")} GROUP BY b.import_type ORDER BY imports DESC, label`,
};
const N11_MONTH: ReportSectionSpec = {
  key: "imports-by-month",
  title: "Imports by month",
  columns: [col("month", "Month"), n("imports", "Imports"), n("failed", "Failed"), n("rows", "Rows read"), n("failedRows", "Rows failed")],
  sql: (q) => `
    SELECT ${MONTH_OF("b.created_at")} AS month, COUNT(*)::int AS imports, COUNT(*) FILTER (WHERE b.status = 'failed')::int AS failed, COALESCE(SUM(b.total_rows), 0)::int AS rows, COALESCE(SUM(b.failed_rows), 0)::int AS "failedRows"
      FROM import_batches b WHERE ${q.co("b")} AND ${IN_RANGE(q, "b")} GROUP BY 1 ORDER BY 1`,
};
const N11_PERSON: ReportSectionSpec = {
  key: "imports-by-person",
  title: "Imports by person",
  columns: [col("person", "Started by"), n("imports", "Imports"), n("failed", "Failed"), n("failedRows", "Rows failed")],
  sql: (q) => `
    SELECT ${WHO("ce")} AS person, COUNT(*)::int AS imports, COUNT(*) FILTER (WHERE b.status = 'failed')::int AS failed, COALESCE(SUM(b.failed_rows), 0)::int AS "failedRows"
      FROM import_batches b LEFT JOIN employees ce ON ce.user_account_id = b.created_by_user_account_id AND ce.company_id = b.company_id
     WHERE ${q.co("b")} AND ${IN_RANGE(q, "b")} GROUP BY b.created_by_user_account_id, ce.id, ce.first_name, ce.last_name ORDER BY imports DESC, person`,
};
const N11_STATUS: ReportSectionSpec = {
  key: "imports-by-status",
  title: "Imports by status and time taken",
  columns: [col("label", "Status"), n("imports", "Imports"), n("minutes", "Average minutes"), n("rows", "Rows read")],
  sql: (q) => `
    SELECT ${LBL("b.status")} AS label, COUNT(*)::int AS imports, ROUND((AVG(EXTRACT(EPOCH FROM (b.finished_at - b.started_at)) / 60.0) FILTER (WHERE b.finished_at IS NOT NULL AND b.started_at IS NOT NULL))::numeric, 2) AS minutes, COALESCE(SUM(b.total_rows), 0)::int AS rows
      FROM import_batches b WHERE ${q.co("b")} AND ${IN_RANGE(q, "b")} GROUP BY b.status ORDER BY imports DESC, label`,
};
const N11_EXPORT_SCOPE: ReportSectionSpec = {
  key: "failed-exports-by-scope",
  title: "Failed exports by scope",
  columns: [col("scope", "What was exported"), col("format", "Format"), n("failed", "Failed"), n("all", "All exports"), pc("rate", "Failed (%)")],
  sql: (q) => `
    SELECT ${LBL("x.scope")} AS scope, UPPER(x.format) AS format, COUNT(*) FILTER (WHERE x.status = 'failed')::int AS failed, COUNT(*)::int AS "all", ROUND(COUNT(*) FILTER (WHERE x.status = 'failed') * 100.0 / COUNT(*), 1) AS rate
      FROM ${EXPORTS} x WHERE ${IN_RANGE(q, "x")} GROUP BY x.scope, x.format HAVING COUNT(*) FILTER (WHERE x.status = 'failed') > 0 ORDER BY failed DESC, scope`,
};

// ================================================================ N12: configuration completeness

const GAP = (key: string, label: string, test: string): string => `SELECT '${key}' AS ord, '${label}' AS label, COUNT(*) FILTER (WHERE ${test})::int AS missing, COUNT(*)::int AS employees`;
const N12_GAPS: ReportSectionSpec = {
  key: "employee-record-gaps",
  title: "Employee records missing a setup link",
  description: "Current employees with no organisation unit, location, position, manager or payroll area. Setup is only useful when employees are linked to it.",
  columns: [col("label", "Missing"), n("missing", "Employees"), n("employees", "Current employees"), pc("rate", "Missing (%)")],
  sql: (q) => `
    SELECT g.label, g.missing, g.employees, ROUND(g.missing * 100.0 / NULLIF(g.employees, 0), 1) AS rate FROM (
      ${GAP("1", "Organisation unit", "e.org_unit_id IS NULL")} FROM employees e WHERE ${q.emp()} AND ${q.current()}
      UNION ALL ${GAP("2", "Location", "e.location_id IS NULL")} FROM employees e WHERE ${q.emp()} AND ${q.current()}
      UNION ALL ${GAP("3", "Position", "e.position_id IS NULL")} FROM employees e WHERE ${q.emp()} AND ${q.current()}
      UNION ALL ${GAP("4", "Manager", "e.manager_id IS NULL")} FROM employees e WHERE ${q.emp()} AND ${q.current()}
      UNION ALL ${GAP("5", "Payroll area", "e.payroll_area_id IS NULL")} FROM employees e WHERE ${q.emp()} AND ${q.current()}
    ) g ORDER BY g.ord`,
};
const N12_STATUS: ReportSectionSpec = {
  key: "setup-active-and-inactive",
  title: "Active and inactive setup records",
  description: "How many records of each kind exist in total and how many are still active.",
  columns: [col("area", "Area"), col("item", "Record"), n("total", "All records"), n("active", "Active"), n("inactive", "Inactive")],
  sql: (q) => `
    SELECT t.area, t.item, t.total, t.active, t.total - t.active AS inactive FROM (
      SELECT 1 AS ord, 'Organisation' AS area, 'Organisation units' AS item, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE x.status = 'active')::int AS active FROM org_units x WHERE ${q.co("x")}
      UNION ALL SELECT 2, 'Organisation', 'Locations', COUNT(*)::int, COUNT(*) FILTER (WHERE x.status = 'active')::int FROM locations x WHERE ${q.co("x")}
      UNION ALL SELECT 3, 'Organisation', 'Positions', COUNT(*)::int, COUNT(*) FILTER (WHERE x.status = 'active')::int FROM positions x WHERE ${q.co("x")}
      UNION ALL SELECT 4, 'Organisation', 'Cost centres', COUNT(*)::int, COUNT(*) FILTER (WHERE x.status = 'active')::int FROM cost_centers x WHERE ${q.co("x")}
      UNION ALL SELECT 5, 'Time and leave', 'Leave types', COUNT(*)::int, COUNT(*) FILTER (WHERE x.is_active)::int FROM leave_types x WHERE ${q.co("x")}
      UNION ALL SELECT 6, 'Time and leave', 'Holiday calendars', COUNT(*)::int, COUNT(*) FILTER (WHERE x.status = 'active')::int FROM holiday_calendars x WHERE ${q.co("x")}
      UNION ALL SELECT 7, 'Payroll', 'Payroll areas', COUNT(*)::int, COUNT(*) FILTER (WHERE x.is_active)::int FROM payroll_areas x WHERE ${q.co("x")}
      UNION ALL SELECT 8, 'Payroll', 'Tax profiles', COUNT(*)::int, COUNT(*) FILTER (WHERE x.status = 'published')::int FROM tax_profiles x WHERE ${q.co("x")}
      UNION ALL SELECT 9, 'Workflow', 'Workflow templates', COUNT(*)::int, COUNT(*) FILTER (WHERE x.is_active)::int FROM workflow_templates x WHERE ${q.co("x")}
    ) t ORDER BY t.ord`,
};
const N12_AREA: ReportSectionSpec = {
  key: "setup-by-area",
  title: "Progress by area",
  columns: [col("area", "Area"), n("items", "Items"), n("done", "Done"), n("missing", "Missing"), pc("rate", "Complete (%)")],
  sql: (q) => `
    SELECT t.area, COUNT(*)::int AS items, COUNT(*) FILTER (WHERE t.n > 0)::int AS done, COUNT(*) FILTER (WHERE t.n = 0)::int AS missing, ROUND(COUNT(*) FILTER (WHERE t.n > 0) * 100.0 / COUNT(*), 1) AS rate FROM (
      SELECT 'Organisation' AS area, COUNT(*)::int AS n FROM org_units x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 'Organisation', COUNT(*)::int FROM locations x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 'Organisation', COUNT(*)::int FROM positions x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 'Organisation', COUNT(*)::int FROM cost_centers x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 'Time and leave', COUNT(*)::int FROM leave_types x WHERE ${q.co("x")} AND x.is_active
      UNION ALL SELECT 'Time and leave', COUNT(*)::int FROM holiday_calendars x WHERE ${q.co("x")} AND x.status = 'active'
      UNION ALL SELECT 'Time and leave', COUNT(*)::int FROM shifts x WHERE ${q.co("x")}
      UNION ALL SELECT 'Payroll', COUNT(*)::int FROM payroll_areas x WHERE ${q.co("x")} AND x.is_active
      UNION ALL SELECT 'Payroll', COUNT(*)::int FROM tax_profiles x WHERE ${q.co("x")} AND x.status = 'published'
      UNION ALL SELECT 'Workflow', COUNT(*)::int FROM workflow_templates x WHERE ${q.co("x")} AND x.is_active
    ) t GROUP BY t.area ORDER BY rate ASC, area`,
};

// ================================================================ O: reports about reports

const RUN_RANGE = (q: Q, a = "l") => `${q.co(a)} AND ${IN_RANGE(q, a)}`;

const O01_FAMILY: ReportSectionSpec = {
  key: "usage-by-data-family",
  title: "Usage by data family",
  description: "Runs, exports, people and errors by the family of data the report reads (payroll, leave, workforce and so on).",
  columns: [col("domain", "Data family"), n("available", "Reports available"), n("runs", "Runs"), n("exports", "Exports"), n("people", "Different people"), n("errors", "Errors")],
  sql: (q) => `
    SELECT INITCAP(cat.domain) AS domain, COUNT(DISTINCT cat.id) FILTER (WHERE cat.status = 'available')::int AS available, COUNT(l.id) FILTER (WHERE l.kind = 'run' AND l.status = 'ok')::int AS runs,
           COUNT(l.id) FILTER (WHERE l.kind = 'export' AND l.status = 'ok')::int AS exports, COUNT(DISTINCT l.user_account_id)::int AS people, COUNT(l.id) FILTER (WHERE l.status = 'error')::int AS errors
      FROM ${CATALOG(q)} LEFT JOIN report_run_log l ON l.report_id = cat.id AND ${RUN_RANGE(q)} GROUP BY cat.domain ORDER BY runs DESC, domain`,
};
const O01_MONTH: ReportSectionSpec = {
  key: "usage-by-month",
  title: "Activity by month",
  columns: [col("month", "Month"), n("runs", "Runs"), n("exports", "Exports"), n("denied", "Refused"), n("errors", "Errors"), n("people", "Different people")],
  sql: (q) => `
    SELECT ${MONTH_OF("l.created_at")} AS month, COUNT(*) FILTER (WHERE l.kind = 'run' AND l.status = 'ok')::int AS runs, COUNT(*) FILTER (WHERE l.kind = 'export' AND l.status = 'ok')::int AS exports,
           COUNT(*) FILTER (WHERE l.status = 'denied')::int AS denied, COUNT(*) FILTER (WHERE l.status = 'error')::int AS errors, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM report_run_log l WHERE ${RUN_RANGE(q)} GROUP BY 1 ORDER BY 1`,
};
const O01_TOP: ReportSectionSpec = {
  key: "most-used-per-category",
  title: "Most used report in each category",
  columns: [col("category", "Category"), col("report", "Report"), col("title", "Title"), n("runs", "Runs"), n("people", "Different people")],
  sql: (q) => `
    SELECT x.category, x.report, x.title, x.runs, x.people FROM (
      SELECT DISTINCT ON (cat.label) cat.label AS category, cat.id AS report, cat.title AS title, COUNT(l.id)::int AS runs, COUNT(DISTINCT l.user_account_id)::int AS people
        FROM ${CATALOG(q)} JOIN report_run_log l ON l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok' AND ${RUN_RANGE(q)}
       GROUP BY cat.label, cat.id, cat.title ORDER BY cat.label, COUNT(l.id) DESC, cat.id) x ORDER BY x.runs DESC, x.category`,
};
const O01_UNUSED: ReportSectionSpec = {
  key: "unused-per-category",
  title: "Available reports nobody ran, by category",
  columns: [col("category", "Category"), n("available", "Reports available"), n("unused", "Never run in the period"), pc("rate", "Unused (%)")],
  sql: (q) => `
    SELECT x.category, x.available, x.unused, ROUND(x.unused * 100.0 / NULLIF(x.available, 0), 1) AS rate FROM (
      SELECT cat.label AS category, COUNT(*)::int AS available,
             COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM report_run_log l WHERE l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok' AND ${RUN_RANGE(q)}))::int AS unused
        FROM ${CATALOG(q)} WHERE cat.status = 'available' GROUP BY cat.label) x ORDER BY rate DESC, x.category`,
};
const O01_OUTCOME: ReportSectionSpec = {
  key: "outcomes",
  title: "Outcomes of every attempt",
  columns: [col("kind", "Kind"), col("status", "Outcome"), n("attempts", "Attempts"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT CASE WHEN l.kind = 'export' THEN 'Export' ELSE 'Run' END AS kind, ${LBL("l.status")} AS status, COUNT(*)::int AS attempts, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM report_run_log l WHERE ${RUN_RANGE(q)} GROUP BY l.kind, l.status ORDER BY kind, attempts DESC`,
};

const O02_PERSON: ReportSectionSpec = {
  key: "runs-by-person",
  title: "Runs by person",
  description: "Who uses reports most, and how many different reports they open.",
  columns: [col("person", "Person"), n("runs", "Runs"), n("exports", "Exports"), n("reports", "Different reports"), dt("last", "Latest")],
  sql: (q) => `
    SELECT ${WHO("le")} AS person, COUNT(*) FILTER (WHERE l.kind = 'run')::int AS runs, COUNT(*) FILTER (WHERE l.kind = 'export')::int AS exports, COUNT(DISTINCT l.report_id)::int AS reports, MAX(l.created_at)::date::text AS last
      FROM report_run_log l ${LOG_USER()} WHERE ${RUN_RANGE(q)} AND l.status = 'ok' GROUP BY l.user_account_id, le.id, le.first_name, le.last_name ORDER BY runs DESC, person LIMIT 100`,
};
const O02_MONTH: ReportSectionSpec = {
  key: "runs-by-month",
  title: "Runs by month",
  columns: [col("month", "Month"), n("runs", "Runs"), n("exports", "Exports"), n("reports", "Different reports"), n("people", "Different people")],
  sql: (q) => `
    SELECT ${MONTH_OF("l.created_at")} AS month, COUNT(*) FILTER (WHERE l.kind = 'run')::int AS runs, COUNT(*) FILTER (WHERE l.kind = 'export')::int AS exports, COUNT(DISTINCT l.report_id)::int AS reports, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' GROUP BY 1 ORDER BY 1`,
};
const O02_WEEKDAY: ReportSectionSpec = {
  key: "runs-by-weekday",
  title: "Runs by day of the week",
  columns: [col("label", "Day"), n("runs", "Runs"), n("exports", "Exports"), n("people", "Different people")],
  sql: (q) => `
    SELECT substr(x.label, 3) AS label, COUNT(*) FILTER (WHERE x.kind = 'run')::int AS runs, COUNT(*) FILTER (WHERE x.kind = 'export')::int AS exports, COUNT(DISTINCT x.user_account_id)::int AS people
      FROM (SELECT ${WEEKDAY("l.created_at")} AS label, l.kind, l.user_account_id FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok') x GROUP BY x.label ORDER BY x.label`,
};
const O02_HOUR: ReportSectionSpec = {
  key: "runs-by-hour",
  title: "Runs by hour of the day",
  columns: [col("hour", "Hour (Pakistan time)"), n("runs", "Runs"), n("people", "Different people")],
  sql: (q) => `
    SELECT lpad(EXTRACT(hour FROM ${TZ("l.created_at")})::int::text, 2, '0') || ':00' AS hour, COUNT(*)::int AS runs, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' AND l.kind = 'run' GROUP BY 1 ORDER BY 1`,
};
const O02_CATEGORY: ReportSectionSpec = {
  key: "runs-by-category",
  title: "Runs by category",
  columns: [col("category", "Category"), n("runs", "Runs"), n("exports", "Exports"), n("reports", "Reports used"), n("people", "Different people")],
  sql: (q) => `
    SELECT cat.label AS category, COUNT(l.id) FILTER (WHERE l.kind = 'run')::int AS runs, COUNT(l.id) FILTER (WHERE l.kind = 'export')::int AS exports, COUNT(DISTINCT l.report_id)::int AS reports, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM ${CATALOG(q)} JOIN report_run_log l ON l.report_id = cat.id AND ${RUN_RANGE(q)} AND l.status = 'ok' GROUP BY cat.label ORDER BY runs DESC, category`,
};
const O02_EXPORT_RATE: ReportSectionSpec = {
  key: "export-rate-by-report",
  title: "How often a run ends in an export",
  columns: [col("report", "Report"), n("runs", "Runs"), n("exports", "Exports"), pc("rate", "Exports per 100 runs")],
  sql: (q) => `
    SELECT l.report_id AS report, COUNT(*) FILTER (WHERE l.kind = 'run')::int AS runs, COUNT(*) FILTER (WHERE l.kind = 'export')::int AS exports,
           ROUND(COUNT(*) FILTER (WHERE l.kind = 'export') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE l.kind = 'run'), 0), 1) AS rate
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' GROUP BY l.report_id HAVING COUNT(*) FILTER (WHERE l.kind = 'export') > 0 ORDER BY rate DESC NULLS LAST, exports DESC, report`,
};

const O03_AGE: ReportSectionSpec = {
  key: "last-run-age",
  title: "How long ago each available report was last run",
  columns: [col("label", "Last run"), n("reports", "Reports"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS reports, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM (
      SELECT CASE WHEN last.d IS NULL THEN '6 Never' WHEN last.d >= ${q.today} - 30 THEN '1 In the last 30 days' WHEN last.d >= ${q.today} - 90 THEN '2 31 to 90 days ago'
                  WHEN last.d >= ${q.today} - 180 THEN '3 91 to 180 days ago' WHEN last.d >= ${q.today} - 365 THEN '4 181 to 365 days ago' ELSE '5 Over a year ago' END AS band
        FROM ${CATALOG(q)}
        LEFT JOIN LATERAL (SELECT MAX(l.created_at)::date AS d FROM report_run_log l WHERE ${q.co("l")} AND l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok') last ON TRUE
       WHERE cat.status = 'available') x GROUP BY x.band ORDER BY x.band`,
};
const O03_CATEGORY: ReportSectionSpec = {
  key: "unused-by-category",
  title: "Reports with no runs in the period, by category",
  columns: [col("category", "Category"), n("available", "Reports available"), n("unused", "No runs in the period"), n("onceOnly", "Run exactly once")],
  sql: (q) => `
    SELECT x.category, COUNT(*)::int AS available, COUNT(*) FILTER (WHERE x.runs = 0)::int AS unused, COUNT(*) FILTER (WHERE x.runs = 1)::int AS "onceOnly" FROM (
      SELECT cat.label AS category, (SELECT COUNT(*)::int FROM report_run_log l WHERE ${q.co("l")} AND l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok' AND ${IN_RANGE(q, "l")}) AS runs
        FROM ${CATALOG(q)} WHERE cat.status = 'available') x GROUP BY x.category ORDER BY unused DESC, x.category`,
};
const O03_FAMILY: ReportSectionSpec = {
  key: "unused-by-data-family",
  title: "Reports with no runs in the period, by data family",
  columns: [col("domain", "Data family"), n("available", "Reports available"), n("unused", "No runs in the period"), pc("rate", "Unused (%)")],
  sql: (q) => `
    SELECT INITCAP(x.domain) AS domain, COUNT(*)::int AS available, COUNT(*) FILTER (WHERE x.runs = 0)::int AS unused, ROUND(COUNT(*) FILTER (WHERE x.runs = 0) * 100.0 / COUNT(*), 1) AS rate FROM (
      SELECT cat.domain, (SELECT COUNT(*)::int FROM report_run_log l WHERE ${q.co("l")} AND l.report_id = cat.id AND l.kind = 'run' AND l.status = 'ok' AND ${IN_RANGE(q, "l")}) AS runs
        FROM ${CATALOG(q)} WHERE cat.status = 'available') x GROUP BY x.domain ORDER BY rate DESC, domain`,
};

const O04_MONTH: ReportSectionSpec = {
  key: "speed-by-month",
  title: "Speed by month",
  columns: [col("month", "Month"), n("runs", "Runs"), n("average", "Average (ms)"), n("p95", "95th percentile (ms)")],
  sql: (q) => `
    SELECT ${MONTH_OF("l.created_at")} AS month, COUNT(*)::int AS runs, ROUND(AVG(l.duration_ms))::int AS average, ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.duration_ms))::int AS p95
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' GROUP BY 1 ORDER BY 1`,
};
const O04_BANDS: ReportSectionSpec = {
  key: "speed-bands",
  title: "How long runs took",
  columns: [col("label", "Time taken"), n("runs", "Runs"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS runs, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT ${MS_BAND("l.duration_ms")} AS band FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' AND l.duration_ms IS NOT NULL) x GROUP BY x.band ORDER BY x.band`,
};
const O04_KIND: ReportSectionSpec = {
  key: "speed-by-kind",
  title: "Runs against exports",
  columns: [col("label", "Kind"), n("attempts", "Attempts"), n("average", "Average (ms)"), n("p95", "95th percentile (ms)"), n("rows", "Average rows")],
  sql: (q) => `
    SELECT CASE WHEN l.kind = 'export' THEN 'Export' ELSE 'Run' END AS label, COUNT(*)::int AS attempts, ROUND(AVG(l.duration_ms))::int AS average, ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.duration_ms))::int AS p95, ROUND(AVG(l.row_count))::int AS rows
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' GROUP BY l.kind ORDER BY label`,
};
const O04_SLOWEST: ReportSectionSpec = {
  key: "slowest-runs",
  title: "Slowest runs",
  description: "The 50 slowest individual runs. Who ran them and what filters they used are not recorded here.",
  columns: [dt("day", "Day"), col("report", "Report"), col("kind", "Kind"), n("ms", "Time (ms)"), n("rows", "Rows")],
  sql: (q) => `
    SELECT l.created_at::date::text AS day, l.report_id AS report, CASE WHEN l.kind = 'export' THEN 'Export' ELSE 'Run' END AS kind, l.duration_ms AS ms, l.row_count AS rows
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' ORDER BY l.duration_ms DESC NULLS LAST LIMIT 50`,
};
const O04_ROWS: ReportSectionSpec = {
  key: "speed-by-size",
  title: "Speed against number of rows",
  columns: [col("label", "Rows returned"), n("runs", "Runs"), n("average", "Average (ms)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS runs, ROUND(AVG(x.duration_ms))::int AS average FROM (
      SELECT l.duration_ms, CASE WHEN l.row_count IS NULL THEN '9 Not recorded' WHEN l.row_count < 50 THEN '1 Under 50' WHEN l.row_count < 500 THEN '2 50 to 499' WHEN l.row_count < 5000 THEN '3 500 to 4,999' ELSE '4 5,000 or more' END AS band
        FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'ok' AND l.duration_ms IS NOT NULL) x GROUP BY x.band ORDER BY x.band`,
};

const O05_CATEGORY: ReportSectionSpec = {
  key: "errors-by-category",
  title: "Failures by cause",
  columns: [col("label", "Cause"), n("failed", "Failed"), n("reports", "Reports affected"), n("people", "People affected"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(l.error_category, 'unknown')")} AS label, COUNT(*)::int AS failed, COUNT(DISTINCT l.report_id)::int AS reports, COUNT(DISTINCT l.user_account_id)::int AS people, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'error' GROUP BY l.error_category ORDER BY failed DESC, label`,
};
const O05_MONTH: ReportSectionSpec = {
  key: "failure-rate-by-month",
  title: "Failure rate by month",
  columns: [col("month", "Month"), n("attempts", "Attempts"), n("failed", "Failed"), pc("rate", "Failed (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("l.created_at")} AS month, COUNT(*)::int AS attempts, COUNT(*) FILTER (WHERE l.status = 'error')::int AS failed, ROUND(COUNT(*) FILTER (WHERE l.status = 'error') * 100.0 / COUNT(*), 1) AS rate
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status IN ('ok', 'error') GROUP BY 1 ORDER BY 1`,
};
const O05_CAUSE_REPORT: ReportSectionSpec = {
  key: "failures-by-report-and-cause",
  title: "Failures by report and cause",
  columns: [col("report", "Report"), col("cause", "Cause"), n("failed", "Failed"), dt("last", "Latest")],
  sql: (q) => `
    SELECT l.report_id AS report, ${LBL("COALESCE(l.error_category, 'unknown')")} AS cause, COUNT(*)::int AS failed, MAX(l.created_at)::date::text AS last
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'error' GROUP BY l.report_id, l.error_category ORDER BY failed DESC, report`,
};
const O05_RECENT: ReportSectionSpec = {
  key: "recent-failures",
  title: "Latest failures",
  columns: [dt("day", "Day"), col("report", "Report"), col("kind", "Kind"), col("cause", "Cause"), n("ms", "Time before failing (ms)")],
  sql: (q) => `
    SELECT l.created_at::date::text AS day, l.report_id AS report, CASE WHEN l.kind = 'export' THEN 'Export' ELSE 'Run' END AS kind, ${LBL("COALESCE(l.error_category, 'unknown')")} AS cause, l.duration_ms AS ms
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'error' ORDER BY l.created_at DESC LIMIT 50`,
};

const O06_KIND: ReportSectionSpec = {
  key: "saved-by-kind",
  title: "Saved reports by kind and visibility",
  columns: [col("kind", "Kind"), col("visibility", "Visibility"), n("reports", "Saved reports"), n("owners", "Different owners")],
  sql: (q) => `
    SELECT CASE WHEN s.kind = 'custom' THEN 'Built in Report Builder' ELSE 'Library report' END AS kind, ${LBL("s.visibility")} AS visibility, COUNT(*)::int AS reports, COUNT(DISTINCT s.owner_user_account_id)::int AS owners
      FROM saved_reports s WHERE ${q.co("s")} AND s.archived_at IS NULL GROUP BY s.kind, s.visibility ORDER BY reports DESC, kind`,
};
const O06_OWNER: ReportSectionSpec = {
  key: "saved-by-owner",
  title: "Saved reports by owner",
  columns: [col("owner", "Owner"), n("reports", "Saved reports"), n("shared", "Shared"), n("scheduled", "With a schedule"), dt("last", "Latest change")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, COUNT(*)::int AS reports, COUNT(*) FILTER (WHERE s.visibility = 'shared')::int AS shared,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM report_schedules sc WHERE sc.saved_report_id = s.id))::int AS scheduled, MAX(s.updated_at)::date::text AS last
      FROM saved_reports s ${OWNER_JOIN("s")} WHERE ${q.co("s")} AND s.archived_at IS NULL GROUP BY s.owner_user_account_id, oe.id, oe.first_name, oe.last_name ORDER BY reports DESC, owner`,
};
const O06_MONTH: ReportSectionSpec = {
  key: "saved-by-month",
  title: "Saved reports created by month (last 12 months)",
  columns: [col("month", "Month"), n("created", "Created"), n("custom", "Built in Report Builder"), n("owners", "Different owners")],
  sql: (q) => `
    SELECT ${MONTH_OF("s.created_at")} AS month, COUNT(*)::int AS created, COUNT(*) FILTER (WHERE s.kind = 'custom')::int AS custom, COUNT(DISTINCT s.owner_user_account_id)::int AS owners
      FROM saved_reports s WHERE ${q.co("s")} AND s.created_at::date >= date_trunc('month', ${q.today} - interval '11 months')::date GROUP BY 1 ORDER BY 1`,
};
const O06_STALE: ReportSectionSpec = {
  key: "saved-staleness",
  title: "How recently saved reports were changed",
  columns: [col("label", "Last changed"), n("reports", "Saved reports"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS reports, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM (
      SELECT CASE WHEN s.updated_at::date >= ${q.today} - 30 THEN '1 In the last 30 days' WHEN s.updated_at::date >= ${q.today} - 90 THEN '2 31 to 90 days ago' WHEN s.updated_at::date >= ${q.today} - 180 THEN '3 91 to 180 days ago' ELSE '4 Over 180 days ago' END AS band
        FROM saved_reports s WHERE ${q.co("s")} AND s.archived_at IS NULL) x GROUP BY x.band ORDER BY x.band`,
};
const O06_SOURCE: ReportSectionSpec = {
  key: "saved-by-source",
  title: "Library reports people saved most",
  columns: [col("report", "Library report"), n("reports", "Saved copies"), n("owners", "Different owners")],
  sql: (q) => `
    SELECT s.report_id AS report, COUNT(*)::int AS reports, COUNT(DISTINCT s.owner_user_account_id)::int AS owners
      FROM saved_reports s WHERE ${q.co("s")} AND s.archived_at IS NULL AND s.kind <> 'custom' AND s.report_id IS NOT NULL GROUP BY s.report_id ORDER BY reports DESC, report LIMIT 50`,
};

const O07_GRANTEE: ReportSectionSpec = {
  key: "shares-by-grantee",
  title: "Shares by who they are given to",
  columns: [col("label", "Shared with"), n("shares", "Shares"), n("reports", "Saved reports"), n("dashboards", "Dashboards")],
  sql: (q) => `
    SELECT CASE WHEN h.grantee_type = 'role' THEN 'Whole role' ELSE 'Individual person' END AS label, COUNT(*)::int AS shares, COUNT(DISTINCT h.saved_report_id)::int AS reports, COUNT(DISTINCT h.dashboard_id)::int AS dashboards
      FROM report_shares h WHERE ${q.co("h")} GROUP BY h.grantee_type ORDER BY shares DESC`,
};
const O07_ROLE: ReportSectionSpec = {
  key: "shares-by-role",
  title: "Roles things are shared with",
  columns: [col("role", "Role"), n("shares", "Shares"), n("reports", "Saved reports"), n("dashboards", "Dashboards")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(h.grantee_role_key, 'not_set')")} AS role, COUNT(*)::int AS shares, COUNT(DISTINCT h.saved_report_id)::int AS reports, COUNT(DISTINCT h.dashboard_id)::int AS dashboards
      FROM report_shares h WHERE ${q.co("h")} AND h.grantee_type = 'role' GROUP BY h.grantee_role_key ORDER BY shares DESC, role`,
};
const O07_SHARER: ReportSectionSpec = {
  key: "shares-by-person",
  title: "Who shares the most",
  columns: [col("owner", "Shared by"), n("items", "Items shared"), n("shares", "Shares given")],
  sql: (q) => `
    SELECT x.owner, COUNT(DISTINCT x.item)::int AS items, COUNT(*)::int AS shares FROM (
      SELECT ${OWNER()} AS owner, s.id AS item, h.id FROM report_shares h JOIN saved_reports s ON s.id = h.saved_report_id ${OWNER_JOIN("s")} WHERE ${q.co("h")} AND s.archived_at IS NULL
      UNION ALL SELECT ${OWNER()}, d.id, h.id FROM report_shares h JOIN dashboards d ON d.id = h.dashboard_id ${OWNER_JOIN("d")} WHERE ${q.co("h")} AND d.archived_at IS NULL) x
     GROUP BY x.owner ORDER BY shares DESC, owner`,
};
const O07_MONTH: ReportSectionSpec = {
  key: "shares-by-month",
  title: "Shares given by month (last 12 months)",
  columns: [col("month", "Month"), n("shares", "Shares"), n("items", "Items shared")],
  sql: (q) => `
    SELECT ${MONTH_OF("h.created_at")} AS month, COUNT(*)::int AS shares, COUNT(DISTINCT COALESCE(h.saved_report_id, h.dashboard_id))::int AS items
      FROM report_shares h WHERE ${q.co("h")} AND h.created_at::date >= date_trunc('month', ${q.today} - interval '11 months')::date GROUP BY 1 ORDER BY 1`,
};
const O07_UNSHARED: ReportSectionSpec = {
  key: "visibility-shared-without-grants",
  title: "Marked shared but given to no one",
  description: "Saved reports marked as shared that have no individual or role grants yet.",
  columns: [col("owner", "Owner"), col("name", "Name"), dt("changed", "Last changed")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, s.name AS name, s.updated_at::date::text AS changed
      FROM saved_reports s ${OWNER_JOIN("s")} WHERE ${q.co("s")} AND s.archived_at IS NULL AND s.visibility = 'shared' AND NOT EXISTS (SELECT 1 FROM report_shares h WHERE h.saved_report_id = s.id) ORDER BY s.updated_at DESC`,
};

const O08_FREQUENCY: ReportSectionSpec = {
  key: "schedules-by-frequency",
  title: "Schedules by frequency, format and status",
  columns: [col("frequency", "Repeats"), col("format", "Format"), col("status", "Status"), n("schedules", "Schedules"), n("recipients", "Recipients in total")],
  sql: (q) => `
    SELECT ${LBL("sc.frequency")} AS frequency, UPPER(sc.format) AS format, ${LBL("sc.status")} AS status, COUNT(*)::int AS schedules, COALESCE(SUM(jsonb_array_length(sc.recipients)), 0)::int AS recipients
      FROM report_schedules sc WHERE ${q.co("sc")} GROUP BY sc.frequency, sc.format, sc.status ORDER BY schedules DESC, frequency`,
};
const O08_OWNER: ReportSectionSpec = {
  key: "schedules-by-owner",
  title: "Schedules by owner",
  columns: [col("owner", "Owner"), n("schedules", "Schedules"), n("active", "Active"), n("recipients", "Recipients in total")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, COUNT(*)::int AS schedules, COUNT(*) FILTER (WHERE sc.status = 'active')::int AS active, COALESCE(SUM(jsonb_array_length(sc.recipients)), 0)::int AS recipients
      FROM report_schedules sc ${OWNER_JOIN("sc")} WHERE ${q.co("sc")} GROUP BY sc.owner_user_account_id, oe.id, oe.first_name, oe.last_name ORDER BY schedules DESC, owner`,
};
const O08_REPORT: ReportSectionSpec = {
  key: "schedules-by-report",
  title: "Which reports are scheduled",
  columns: [col("report", "Report"), n("schedules", "Schedules"), n("owners", "Different owners")],
  sql: (q) => `
    SELECT COALESCE(sc.report_id, 'Saved report') AS report, COUNT(*)::int AS schedules, COUNT(DISTINCT sc.owner_user_account_id)::int AS owners
      FROM report_schedules sc WHERE ${q.co("sc")} GROUP BY 1 ORDER BY schedules DESC, report`,
};
const O08_UPCOMING: ReportSectionSpec = {
  key: "upcoming-runs",
  title: "Runs due in the next 7 days",
  columns: [dt("next", "Next run"), col("owner", "Owner"), col("name", "Schedule"), col("frequency", "Repeats"), n("recipients", "Recipients")],
  sql: (q) => `
    SELECT sc.next_run_at::date::text AS next, ${OWNER()} AS owner, sc.name AS name, ${LBL("sc.frequency")} AS frequency, jsonb_array_length(sc.recipients)::int AS recipients
      FROM report_schedules sc ${OWNER_JOIN("sc")} WHERE ${q.co("sc")} AND sc.status = 'active' AND sc.next_run_at::date BETWEEN ${q.today} AND ${q.today} + 7 ORDER BY sc.next_run_at`,
};
const O08_RECIPIENTS: ReportSectionSpec = {
  key: "schedule-recipient-bands",
  title: "Schedules by number of recipients",
  columns: [col("label", "Recipients"), n("schedules", "Schedules")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS schedules FROM (
      SELECT CASE WHEN jsonb_array_length(sc.recipients) = 0 THEN '1 None' WHEN jsonb_array_length(sc.recipients) = 1 THEN '2 One' WHEN jsonb_array_length(sc.recipients) <= 5 THEN '3 Two to five' ELSE '4 More than five' END AS band
        FROM report_schedules sc WHERE ${q.co("sc")}) x GROUP BY x.band ORDER BY x.band`,
};

const O09_STATUS: ReportSectionSpec = {
  key: "deliveries-by-status",
  title: "Deliveries by outcome",
  columns: [col("label", "Outcome"), n("runs", "Runs"), pc("share", "Share (%)"), n("rows", "Rows delivered"), n("recipients", "Recipients reached")],
  sql: (q) => `
    SELECT ${LBL("d.status")} AS label, COUNT(*)::int AS runs, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, COALESCE(SUM(d.row_count), 0)::int AS rows, COALESCE(SUM(d.recipient_count), 0)::int AS recipients
      FROM report_deliveries d WHERE ${q.co("d")} AND ${IN_RANGE(q, "d", "run_at")} GROUP BY d.status ORDER BY runs DESC, label`,
};
const O09_SCHEDULE: ReportSectionSpec = {
  key: "deliveries-by-schedule",
  title: "Deliveries by schedule",
  columns: [col("owner", "Owner"), col("name", "Schedule"), n("runs", "Runs"), n("delivered", "Delivered"), n("failed", "Failed"), pc("success", "Success (%)")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, sc.name AS name, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE d.status IN ('sent', 'stored'))::int AS delivered, COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed,
           ROUND(COUNT(*) FILTER (WHERE d.status IN ('sent', 'stored')) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE d.status <> 'skipped'), 0), 1) AS success
      FROM report_deliveries d JOIN report_schedules sc ON sc.id = d.schedule_id ${OWNER_JOIN("sc")} WHERE ${q.co("d")} AND ${IN_RANGE(q, "d", "run_at")}
     GROUP BY sc.id, sc.name, oe.id, oe.first_name, oe.last_name ORDER BY failed DESC, runs DESC, name`,
};
const O09_ERRORS: ReportSectionSpec = {
  key: "delivery-failures-by-cause",
  title: "Failures by cause",
  columns: [col("cause", "Cause"), n("failures", "Failures"), n("schedules", "Schedules affected"), dt("last", "Latest")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(d.error_category, 'unknown')")} AS cause, COUNT(*)::int AS failures, COUNT(DISTINCT d.schedule_id)::int AS schedules, MAX(d.run_at)::date::text AS last
      FROM report_deliveries d WHERE ${q.co("d")} AND d.status = 'failed' AND ${IN_RANGE(q, "d", "run_at")} GROUP BY 1 ORDER BY failures DESC, cause`,
};
const O09_SKIPPED: ReportSectionSpec = {
  key: "skipped-recipients",
  title: "Recipients skipped",
  description: "Runs where some recipients were left out, for example because they no longer have access to the report.",
  columns: [col("month", "Month"), n("runs", "Runs with skipped recipients"), n("skipped", "Recipients skipped")],
  sql: (q) => `
    SELECT ${MONTH_OF("d.run_at")} AS month, COUNT(*)::int AS runs, COALESCE(SUM(d.skipped_recipients), 0)::int AS skipped
      FROM report_deliveries d WHERE ${q.co("d")} AND d.skipped_recipients > 0 AND ${IN_RANGE(q, "d", "run_at")} GROUP BY 1 ORDER BY 1`,
};
const O09_SPEED: ReportSectionSpec = {
  key: "delivery-time",
  title: "Time taken to prepare deliveries",
  columns: [col("label", "Time taken"), n("runs", "Runs"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS runs, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT ${MS_BAND("d.duration_ms")} AS band FROM report_deliveries d WHERE ${q.co("d")} AND d.duration_ms IS NOT NULL AND ${IN_RANGE(q, "d", "run_at")}) x GROUP BY x.band ORDER BY x.band`,
};

const O10_REPORT: ReportSectionSpec = {
  key: "exports-by-report",
  title: "Exports by report",
  columns: [col("report", "Report"), n("exports", "Exports"), n("rows", "Rows exported"), n("people", "Different people"), n("largest", "Largest export (rows)")],
  sql: (q) => `
    SELECT l.report_id AS report, COUNT(*)::int AS exports, COALESCE(SUM(l.row_count), 0)::int AS rows, COUNT(DISTINCT l.user_account_id)::int AS people, MAX(l.row_count)::int AS largest
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok' GROUP BY l.report_id ORDER BY exports DESC, report`,
};
const O10_PERSON: ReportSectionSpec = {
  key: "exports-by-person",
  title: "Exports by person",
  columns: [col("person", "Person"), n("exports", "Exports"), n("rows", "Rows exported"), n("reports", "Different reports")],
  sql: (q) => `
    SELECT ${WHO("le")} AS person, COUNT(*)::int AS exports, COALESCE(SUM(l.row_count), 0)::int AS rows, COUNT(DISTINCT l.report_id)::int AS reports
      FROM report_run_log l ${LOG_USER()} WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok' GROUP BY l.user_account_id, le.id, le.first_name, le.last_name ORDER BY exports DESC, rows DESC, person LIMIT 100`,
};
const O10_SIZE: ReportSectionSpec = {
  key: "export-size-bands",
  title: "Exports by size",
  columns: [col("label", "Rows in the export"), n("exports", "Exports"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(x.band, 3) AS label, COUNT(*)::int AS exports, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM (
      SELECT CASE WHEN l.row_count IS NULL THEN '9 Not recorded' WHEN l.row_count < 50 THEN '1 Under 50' WHEN l.row_count < 500 THEN '2 50 to 499' WHEN l.row_count < 5000 THEN '3 500 to 4,999' ELSE '4 5,000 or more' END AS band
        FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok') x GROUP BY x.band ORDER BY x.band`,
};
const O10_WEEKDAY: ReportSectionSpec = {
  key: "exports-by-weekday",
  title: "Exports by day of the week",
  columns: [col("label", "Day"), n("exports", "Exports"), n("rows", "Rows exported")],
  sql: (q) => `
    SELECT substr(x.label, 3) AS label, COUNT(*)::int AS exports, COALESCE(SUM(x.row_count), 0)::int AS rows
      FROM (SELECT ${WEEKDAY("l.created_at")} AS label, l.row_count FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok') x GROUP BY x.label ORDER BY x.label`,
};
const O10_LARGEST: ReportSectionSpec = {
  key: "largest-exports",
  title: "Largest exports",
  description: "The 50 exports with the most rows.",
  columns: [dt("day", "Day"), col("person", "Person"), col("report", "Report"), n("rows", "Rows")],
  sql: (q) => `
    SELECT l.created_at::date::text AS day, ${WHO("le")} AS person, l.report_id AS report, l.row_count AS rows
      FROM report_run_log l ${LOG_USER()} WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok' ORDER BY l.row_count DESC NULLS LAST, l.created_at DESC LIMIT 50`,
};

const O11_REPORT: ReportSectionSpec = {
  key: "denials-by-report",
  title: "Refusals by report",
  columns: [col("report", "Report"), n("denied", "Times refused"), n("people", "Different people"), dt("last", "Latest")],
  sql: (q) => `
    SELECT l.report_id AS report, COUNT(*)::int AS denied, COUNT(DISTINCT l.user_account_id)::int AS people, MAX(l.created_at)::date::text AS last
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'denied' GROUP BY l.report_id ORDER BY denied DESC, report`,
};
const O11_MONTH: ReportSectionSpec = {
  key: "denials-by-month",
  title: "Refusals by month",
  columns: [col("month", "Month"), n("denied", "Times refused"), n("people", "Different people"), n("reports", "Different reports")],
  sql: (q) => `
    SELECT ${MONTH_OF("l.created_at")} AS month, COUNT(*)::int AS denied, COUNT(DISTINCT l.user_account_id)::int AS people, COUNT(DISTINCT l.report_id)::int AS reports
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'denied' GROUP BY 1 ORDER BY 1`,
};
const O11_KIND: ReportSectionSpec = {
  key: "denials-by-kind",
  title: "Refusals when running against exporting",
  columns: [col("kind", "Tried to"), n("denied", "Times refused"), n("people", "Different people")],
  sql: (q) => `
    SELECT CASE WHEN l.kind = 'export' THEN 'Export' ELSE 'Run' END AS kind, COUNT(*)::int AS denied, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'denied' GROUP BY l.kind ORDER BY denied DESC`,
};
const O11_CATEGORY: ReportSectionSpec = {
  key: "denials-by-category",
  title: "Refusals by report category",
  columns: [col("category", "Category"), n("denied", "Times refused"), n("people", "Different people")],
  sql: (q) => `
    SELECT cat.label AS category, COUNT(l.id)::int AS denied, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM ${CATALOG(q)} JOIN report_run_log l ON l.report_id = cat.id AND ${RUN_RANGE(q)} AND l.status = 'denied' GROUP BY cat.label ORDER BY denied DESC, category`,
};

const O12_CATEGORY: ReportSectionSpec = {
  key: "catalog-by-category",
  title: "Catalog by category",
  columns: [col("category", "Category"), n("reports", "Reports"), n("available", "Available"), n("planned", "Planned"), n("blocked", "Blocked (data missing)"), pc("rate", "Available (%)")],
  sql: (q) => `
    SELECT cat.label AS category, COUNT(*)::int AS reports, COUNT(*) FILTER (WHERE cat.status = 'available')::int AS available, COUNT(*) FILTER (WHERE cat.status = 'planned')::int AS planned,
           COUNT(*) FILTER (WHERE cat.status = 'blocked')::int AS blocked, ROUND(COUNT(*) FILTER (WHERE cat.status = 'available') * 100.0 / COUNT(*), 1) AS rate
      FROM ${CATALOG(q)} GROUP BY cat.label ORDER BY rate ASC, category`,
};
const O12_NOT_AVAILABLE: ReportSectionSpec = {
  key: "not-yet-available",
  title: "Reports that are not available yet",
  description: "Every catalog report that is planned, blocked or unavailable, so gaps can be tracked.",
  columns: [col("report", "Report"), col("title", "Title"), col("category", "Category"), col("domain", "Data family"), col("status", "Status")],
  sql: (q) => `
    SELECT cat.id AS report, cat.title AS title, cat.label AS category, INITCAP(cat.domain) AS domain, INITCAP(cat.status) AS status
      FROM ${CATALOG(q)} WHERE cat.status <> 'available' ORDER BY cat.status, cat.id`,
};
const O12_STATUS: ReportSectionSpec = {
  key: "catalog-by-status",
  title: "Catalog by status",
  columns: [col("label", "Status"), n("reports", "Reports"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT INITCAP(cat.status) AS label, COUNT(*)::int AS reports, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM ${CATALOG(q)} GROUP BY cat.status ORDER BY reports DESC, label`,
};

const DEF_ARRAY = (path: string) => `CASE WHEN jsonb_typeof(s.definition->'${path}') = 'array' THEN s.definition->'${path}' ELSE '[]'::jsonb END`;
const O13_DATASET: ReportSectionSpec = {
  key: "builder-by-dataset",
  title: "Report Builder reports by data",
  columns: [col("dataset", "Data"), n("reports", "Saved reports"), n("owners", "Different owners"), n("shared", "Shared"), dt("last", "Latest change")],
  sql: (q) => `
    SELECT INITCAP(REPLACE(COALESCE(s.definition->>'dataset', 'unknown'), '_', ' ')) AS dataset, COUNT(*)::int AS reports, COUNT(DISTINCT s.owner_user_account_id)::int AS owners, COUNT(*) FILTER (WHERE s.visibility = 'shared')::int AS shared, MAX(s.updated_at)::date::text AS last
      FROM saved_reports s WHERE ${q.co("s")} AND s.kind = 'custom' AND s.archived_at IS NULL GROUP BY s.definition->>'dataset' ORDER BY reports DESC, dataset`,
};
const O13_SHAPE: ReportSectionSpec = {
  key: "builder-report-shape",
  title: "How Report Builder reports are put together",
  description: "Average columns, groupings, measures and filters per saved report, by data.",
  columns: [col("dataset", "Data"), n("reports", "Saved reports"), n("columns", "Average columns"), n("groups", "Average groupings"), n("measures", "Average measures"), n("filters", "Average filters")],
  sql: (q) => `
    SELECT INITCAP(REPLACE(COALESCE(s.definition->>'dataset', 'unknown'), '_', ' ')) AS dataset, COUNT(*)::int AS reports,
           ROUND(AVG(jsonb_array_length(${DEF_ARRAY("columns")})), 1) AS columns, ROUND(AVG(jsonb_array_length(${DEF_ARRAY("groupBy")})), 1) AS groups,
           ROUND(AVG(jsonb_array_length(${DEF_ARRAY("measures")})), 1) AS measures, ROUND(AVG(jsonb_array_length(${DEF_ARRAY("filters")})), 1) AS filters
      FROM saved_reports s WHERE ${q.co("s")} AND s.kind = 'custom' AND s.archived_at IS NULL GROUP BY s.definition->>'dataset' ORDER BY reports DESC, dataset`,
};
const O13_OWNER: ReportSectionSpec = {
  key: "builder-by-owner",
  title: "Who builds reports",
  columns: [col("owner", "Owner"), n("reports", "Report Builder reports"), n("shared", "Shared"), dt("last", "Latest change")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, COUNT(*)::int AS reports, COUNT(*) FILTER (WHERE s.visibility = 'shared')::int AS shared, MAX(s.updated_at)::date::text AS last
      FROM saved_reports s ${OWNER_JOIN("s")} WHERE ${q.co("s")} AND s.kind = 'custom' AND s.archived_at IS NULL GROUP BY s.owner_user_account_id, oe.id, oe.first_name, oe.last_name ORDER BY reports DESC, owner`,
};

const O14_DASHBOARD: ReportSectionSpec = {
  key: "dashboards-overview",
  title: "Dashboards",
  description: "Every dashboard with the number of widgets and how it is shared. Private dashboards are shown without their name.",
  columns: [col("owner", "Owner"), col("name", "Name"), col("visibility", "Visibility"), n("widgets", "Widgets"), n("sharedWith", "Shared with"), dt("changed", "Last changed")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, CASE WHEN d.visibility = 'shared' THEN d.name ELSE 'Private dashboard' END AS name, ${LBL("d.visibility")} AS visibility,
           (SELECT COUNT(*)::int FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widgets, (SELECT COUNT(*)::int FROM report_shares h WHERE h.dashboard_id = d.id) AS "sharedWith", d.updated_at::date::text AS changed
      FROM dashboards d ${OWNER_JOIN("d")} WHERE ${q.co("d")} AND d.archived_at IS NULL ORDER BY widgets DESC, d.updated_at DESC`,
};
const O14_TYPE: ReportSectionSpec = {
  key: "widgets-by-type",
  title: "Widgets by type",
  columns: [col("label", "Widget"), n("widgets", "Widgets"), n("dashboards", "Dashboards"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT ${LBL("w.widget_type")} AS label, COUNT(*)::int AS widgets, COUNT(DISTINCT w.dashboard_id)::int AS dashboards, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM dashboard_widgets w JOIN dashboards d ON d.id = w.dashboard_id AND d.archived_at IS NULL WHERE ${q.co("w")} GROUP BY w.widget_type ORDER BY widgets DESC, label`,
};
const O14_OWNER: ReportSectionSpec = {
  key: "dashboards-by-owner",
  title: "Dashboards by owner",
  columns: [col("owner", "Owner"), n("dashboards", "Dashboards"), n("widgets", "Widgets"), n("shared", "Shared")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, COUNT(*)::int AS dashboards, SUM((SELECT COUNT(*) FROM dashboard_widgets w WHERE w.dashboard_id = d.id))::int AS widgets, COUNT(*) FILTER (WHERE d.visibility = 'shared')::int AS shared
      FROM dashboards d ${OWNER_JOIN("d")} WHERE ${q.co("d")} AND d.archived_at IS NULL GROUP BY d.owner_user_account_id, oe.id, oe.first_name, oe.last_name ORDER BY dashboards DESC, owner`,
};
const O14_EMPTY: ReportSectionSpec = {
  key: "empty-dashboards",
  title: "Dashboards with no widgets",
  columns: [col("owner", "Owner"), col("visibility", "Visibility"), dt("created", "Created")],
  sql: (q) => `
    SELECT ${OWNER()} AS owner, ${LBL("d.visibility")} AS visibility, d.created_at::date::text AS created
      FROM dashboards d ${OWNER_JOIN("d")} WHERE ${q.co("d")} AND d.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM dashboard_widgets w WHERE w.dashboard_id = d.id) ORDER BY d.created_at DESC`,
};

const O15_KIND: ReportSectionSpec = {
  key: "exceptions-summary",
  title: "Exceptions by kind",
  columns: [col("exception", "Exception"), n("people", "People or reports"), n("times", "Occurrences")],
  sql: (q) => `
    SELECT t.exception, COUNT(*)::int AS people, SUM(t.times)::int AS times FROM (
      SELECT 'Many exports' AS exception, COUNT(*)::int AS times FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok' GROUP BY l.user_account_id HAVING COUNT(*) >= 10
      UNION ALL SELECT 'Repeated denials', COUNT(*)::int FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'denied' GROUP BY l.user_account_id, l.report_id HAVING COUNT(*) >= 3
      UNION ALL SELECT 'Report failing', COUNT(*)::int FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'error' GROUP BY l.report_id HAVING COUNT(*) >= 3
    ) t GROUP BY t.exception ORDER BY times DESC, t.exception`,
};
const O15_BURST: ReportSectionSpec = {
  key: "export-bursts-by-day",
  title: "Days with several exports by one person",
  description: "A person who exported three or more reports on the same day, with the rows involved.",
  columns: [dt("day", "Day"), col("person", "Person"), n("exports", "Exports"), n("reports", "Different reports"), n("rows", "Rows exported")],
  sql: (q) => `
    SELECT l.created_at::date::text AS day, ${WHO("le")} AS person, COUNT(*)::int AS exports, COUNT(DISTINCT l.report_id)::int AS reports, COALESCE(SUM(l.row_count), 0)::int AS rows
      FROM report_run_log l ${LOG_USER()} WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok'
     GROUP BY l.created_at::date, l.user_account_id, le.id, le.first_name, le.last_name HAVING COUNT(*) >= 3 ORDER BY exports DESC, day DESC LIMIT 100`,
};
const O15_DENIED: ReportSectionSpec = {
  key: "denials-by-report",
  title: "Refusals by report",
  columns: [col("report", "Report"), n("denied", "Times refused"), n("people", "Different people")],
  sql: (q) => `
    SELECT l.report_id AS report, COUNT(*)::int AS denied, COUNT(DISTINCT l.user_account_id)::int AS people
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'denied' GROUP BY l.report_id ORDER BY denied DESC, report LIMIT 50`,
};
const O15_ERRORS: ReportSectionSpec = {
  key: "errors-by-cause",
  title: "Failures by cause",
  columns: [col("cause", "Cause"), n("failed", "Failed"), n("reports", "Reports affected")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(l.error_category, 'unknown')")} AS cause, COUNT(*)::int AS failed, COUNT(DISTINCT l.report_id)::int AS reports
      FROM report_run_log l WHERE ${RUN_RANGE(q)} AND l.status = 'error' GROUP BY l.error_category ORDER BY failed DESC, cause`,
};
const O15_OFFHOURS: ReportSectionSpec = {
  key: "out-of-hours-exports",
  title: "Exports outside working hours",
  description: "Exports made before 7am, after 10pm or at a weekend (Pakistan time).",
  columns: [col("person", "Person"), n("exports", "Exports"), n("rows", "Rows exported"), dt("last", "Latest")],
  sql: (q) => `
    SELECT ${WHO("le")} AS person, COUNT(*)::int AS exports, COALESCE(SUM(l.row_count), 0)::int AS rows, MAX(l.created_at)::date::text AS last
      FROM report_run_log l ${LOG_USER()}
     WHERE ${RUN_RANGE(q)} AND l.kind = 'export' AND l.status = 'ok' AND (EXTRACT(hour FROM ${TZ("l.created_at")}) < 7 OR EXTRACT(hour FROM ${TZ("l.created_at")}) >= 22 OR EXTRACT(isodow FROM ${TZ("l.created_at")}) IN (6, 7))
     GROUP BY l.user_account_id, le.id, le.first_name, le.last_name ORDER BY exports DESC, person LIMIT 50`,
};

export const PLATFORM_GOVERNANCE_DEPTH: Record<string, ReportSectionSpec[]> = {
  N01: [N01_CHANGE, N01_WEEKDAY, N01_BUSIEST, N01_CAPACITY],
  N05: [N05_STATUS, N05_DAY, N05_MONTH, N05_DURATION, N05_FAILED, N05_WAITING, N05_RETRY],
  N06: [N06_HEALTH, N06_FREQUENCY, N06_OWNER, N06_ERRORS, N06_HISTORY],
  N07: [N07_STATUS, N07_MONTH, N07_PROTECTION, N07_LARGEST, N07_EXPIRING, N07_FAILED],
  N08: [N08_TYPE, N08_MIME, N08_MONTH, N08_UNIT, N08_LARGE],
  N09: [N09_STATUS, N09_DAY, N09_TEMPLATE, N09_HOUR, N09_RECIPIENTS],
  N10: [N10_STATE, N10_CHECKS, N10_PROBLEMS],
  N11: [N11_TYPE, N11_MONTH, N11_PERSON, N11_STATUS, N11_EXPORT_SCOPE],
  N12: [N12_AREA, N12_STATUS, N12_GAPS],
  O01: [O01_FAMILY, O01_MONTH, O01_TOP, O01_UNUSED, O01_OUTCOME],
  O02: [O02_PERSON, O02_MONTH, O02_WEEKDAY, O02_HOUR, O02_CATEGORY, O02_EXPORT_RATE],
  O03: [O03_AGE, O03_CATEGORY, O03_FAMILY],
  O04: [O04_MONTH, O04_BANDS, O04_KIND, O04_ROWS, O04_SLOWEST],
  O05: [O05_CATEGORY, O05_MONTH, O05_CAUSE_REPORT, O05_RECENT],
  O06: [O06_KIND, O06_OWNER, O06_MONTH, O06_STALE, O06_SOURCE],
  O07: [O07_GRANTEE, O07_ROLE, O07_SHARER, O07_MONTH, O07_UNSHARED],
  O08: [O08_FREQUENCY, O08_OWNER, O08_REPORT, O08_UPCOMING, O08_RECIPIENTS],
  O09: [O09_STATUS, O09_SCHEDULE, O09_ERRORS, O09_SKIPPED, O09_SPEED],
  O10: [O10_REPORT, O10_PERSON, O10_SIZE, O10_WEEKDAY, O10_LARGEST],
  O11: [O11_REPORT, O11_MONTH, O11_KIND, O11_CATEGORY],
  O12: [O12_CATEGORY, O12_STATUS, O12_NOT_AVAILABLE],
  O13: [O13_DATASET, O13_SHAPE, O13_OWNER],
  O14: [O14_DASHBOARD, O14_TYPE, O14_OWNER, O14_EMPTY],
  O15: [O15_KIND, O15_BURST, O15_DENIED, O15_ERRORS, O15_OFFHOURS],
};
