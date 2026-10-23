import { DEPT, barChart, count, days, listReport, num, pct, percent, round1, sqlReport, sum } from "../report-spec";

/**
 * Workflow and approval reports (catalog H01 to H15). They read the company's own workflow instances and approvals and
 * are limited to people who manage workflow templates (workflow_template.manage.all): there is no team view of
 * approvals as a whole, because an approval's "team" is whoever it was routed to, not a reporting line.
 *
 * Time is measured from the moment a step's approval was created (the step became active) to the moment it was decided,
 * so a request waiting behind an earlier step is not counted as late for the later one.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const LABEL = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const OBJ = LABEL("wi.object_key");
const HOURS = (to: string, from: string) => `EXTRACT(EPOCH FROM (${to} - ${from})) / 3600.0`;
/** The approvals that are waiting for someone right now. */
const OPEN = "a.status IN ('pending', 'escalated') AND si.status = 'pending' AND wi.status = 'in_progress'";
const APPROVALS = `workflow_step_approvals a
      JOIN workflow_step_instances si ON si.id = a.step_instance_id
      JOIN workflow_instances wi ON wi.id = si.workflow_instance_id`;
/** Who the approval is addressed to: the person if known, otherwise the role or rule it was routed by. */
const APPROVER_JOIN = `LEFT JOIN employees pe ON pe.user_account_id = a.user_account_id AND pe.company_id = wi.company_id
      LEFT JOIN roles ro ON ro.id = a.role_id AND (ro.company_id IS NULL OR ro.company_id = wi.company_id)`;
const APPROVER = `COALESCE(NULLIF(${NAME("pe")}, ''), ro.name, ${LABEL("a.approver_type")})`;
const IDLE_DAYS = 7;

export const H01 = sqlReport({
  description: "Approvals waiting for someone today, by workflow: how many, how many are escalated or overdue, and how long the oldest has waited.",
  tables: ["workflow_instances", "workflow_step_instances", "workflow_step_approvals"],
  viz: ["kpi", "bar", "table"],
  tags: ["approvals", "pending", "inbox"],
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "waiting", label: "Waiting", type: "number" },
    { key: "escalated", label: "Escalated", type: "number" },
    { key: "overdue", label: "Past their due time", type: "number" },
    { key: "oldest", label: "Oldest (days)", type: "number" },
    { key: "average", label: "Average wait (days)", type: "number" },
  ],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COUNT(*)::int AS waiting, COUNT(*) FILTER (WHERE a.status = 'escalated')::int AS escalated,
           COUNT(*) FILTER (WHERE a.due_at IS NOT NULL AND a.due_at::date < ${q.today})::int AS overdue,
           MAX(${q.today} - a.created_at::date)::int AS oldest, ROUND(AVG(${q.today} - a.created_at::date), 1) AS average
      FROM ${APPROVALS}
     WHERE ${q.co("wi")} AND ${OPEN}
     GROUP BY wi.object_key ORDER BY waiting DESC, workflow`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Approvals waiting, by workflow", unit: "approvals", rows, labelKey: "workflow", valueKey: "waiting", max: 12 }) : null),
  kpis: ({ rows }) => [count("waiting", "Waiting for approval", sum(rows, "waiting")), count("escalated", "Escalated", sum(rows, "escalated")), count("overdue", "Past their due time", sum(rows, "overdue")), days("oldest", "Oldest wait", rows.length ? Math.max(...rows.map((r) => num(r, "oldest"))) : null)],
  calculation: ["Counts approvals that are pending or escalated, on a step that is currently active, for requests that are still in progress.", "Wait is measured in whole days from when the approval was created to today. An approval is past its due time when it has a due date earlier than today."],
});

export const H02 = sqlReport({
  description: "How long open approvals have been waiting, grouped into age bands.",
  tables: ["workflow_instances", "workflow_step_instances", "workflow_step_approvals"],
  viz: ["bar", "kpi", "table"],
  tags: ["approvals", "ageing"],
  columns: [
    { key: "band", label: "Waiting for", type: "text" },
    { key: "approvals", label: "Approvals", type: "number" },
    { key: "share", label: "Share (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT b.band, b.approvals, ROUND(b.approvals * 100.0 / NULLIF(SUM(b.approvals) OVER (), 0), 1) AS share FROM (
      SELECT x.band, x.ord, COUNT(a.id)::int AS approvals FROM (VALUES ('Under 1 day', 1, 0, 0), ('1 to 2 days', 2, 1, 2), ('3 to 7 days', 3, 3, 7), ('8 to 14 days', 4, 8, 14), ('15 to 30 days', 5, 15, 30), ('Over 30 days', 6, 31, 100000)) AS x(band, ord, lo, hi)
      LEFT JOIN (SELECT a.id, (${q.today} - a.created_at::date) AS age FROM ${APPROVALS} WHERE ${q.co("wi")} AND ${OPEN}) a ON a.age BETWEEN x.lo AND x.hi
      GROUP BY x.band, x.ord
    ) b ORDER BY b.ord`,
  chart: ({ rows }) => (sum(rows, "approvals") > 0 ? barChart({ title: "Open approvals by age", unit: "approvals", rows, labelKey: "band", valueKey: "approvals" }) : null),
  kpis: ({ rows }) => [count("open", "Open approvals", sum(rows, "approvals")), count("old", "Waiting over 7 days", sum(rows.filter((r) => ["8 to 14 days", "15 to 30 days", "Over 30 days"].includes(String(r.band))), "approvals"))],
  calculation: ["Age is whole days from when the approval was created to today, for approvals that are pending or escalated on an active step.", "Bands: under 1 day, 1 to 2, 3 to 7, 8 to 14, 15 to 30 and over 30 days."],
});

export const H03 = sqlReport({
  description: "How long finished requests took from submission to final decision, for each workflow.",
  defaultRange: "last90Days",
  tables: ["workflow_instances", "workflow_templates"],
  viz: ["bar", "kpi", "table"],
  tags: ["turnaround", "workflow"],
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "requests", label: "Finished requests", type: "number" },
    { key: "average", label: "Average (hours)", type: "number" },
    { key: "median", label: "Median (hours)", type: "number" },
    { key: "slowest", label: "Slowest (hours)", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(wt.name, ${OBJ}) AS workflow, COUNT(*)::int AS requests, ROUND(AVG(${HOURS("wi.completed_at", "wi.created_at")})::numeric, 1) AS average,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${HOURS("wi.completed_at", "wi.created_at")}))::numeric, 1) AS median, ROUND(MAX(${HOURS("wi.completed_at", "wi.created_at")})::numeric, 1) AS slowest
      FROM workflow_instances wi LEFT JOIN workflow_templates wt ON wt.id = wi.template_id
     WHERE ${q.co("wi")} AND wi.status IN ('approved', 'rejected') AND wi.completed_at IS NOT NULL AND wi.completed_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY COALESCE(wt.name, ${OBJ}) ORDER BY average DESC, workflow`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Average hours to decision", unit: "hours", rows, labelKey: "workflow", valueKey: "average", max: 12 }) : null),
  kpis: ({ rows }) => {
    const n = sum(rows, "requests");
    const weighted = rows.reduce((s, r) => s + num(r, "average") * num(r, "requests"), 0);
    return [count("requests", "Finished requests", n), { key: "avg", label: "Average time to decision", value: n ? round1(weighted / n) : null, unit: "hours" as const }];
  },
  calculation: ["Includes requests that ended approved or rejected with a completion time inside the range. Cancelled and withdrawn requests are left out.", "Turnaround is the hours from submission to completion. Median and slowest are per workflow; the headline average is weighted by request count."],
});

export const H04 = sqlReport({
  description: "For requests submitted in the range, how many ended approved, rejected or cancelled and how many are still open.",
  defaultRange: "last90Days",
  tables: ["workflow_instances", "workflow_templates"],
  viz: ["bar", "kpi", "table"],
  tags: ["completion", "workflow"],
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "submitted", label: "Submitted", type: "number" },
    { key: "approved", label: "Approved", type: "number" },
    { key: "rejected", label: "Rejected", type: "number" },
    { key: "cancelled", label: "Cancelled", type: "number" },
    { key: "open", label: "Still open", type: "number" },
    { key: "rate", label: "Decided (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(wt.name, ${OBJ}) AS workflow, COUNT(*)::int AS submitted, COUNT(*) FILTER (WHERE wi.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE wi.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE wi.status = 'cancelled')::int AS cancelled, COUNT(*) FILTER (WHERE wi.status IN ('in_progress', 'returned', 'on_hold'))::int AS open,
           ROUND(COUNT(*) FILTER (WHERE wi.status IN ('approved', 'rejected')) * 100.0 / COUNT(*), 1) AS rate
      FROM workflow_instances wi LEFT JOIN workflow_templates wt ON wt.id = wi.template_id
     WHERE ${q.co("wi")} AND wi.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY COALESCE(wt.name, ${OBJ}) ORDER BY submitted DESC, workflow`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Share of requests decided", unit: "percent", rows, labelKey: "workflow", valueKey: "rate", valueLabel: "Decided (%)", max: 12 }) : null),
  kpis: ({ rows }) => [count("submitted", "Submitted", sum(rows, "submitted")), percent("rate", "Decided", pct(sum(rows, "approved") + sum(rows, "rejected"), sum(rows, "submitted"))), count("open", "Still open", sum(rows, "open"))],
  calculation: ["Counts requests created in the range by their current status.", "Decided means ended approved or rejected. Cancelled requests count in Submitted but not as decided; returned and on-hold requests count as still open."],
});

export const H05 = listReport({
  description: "Requests that ended rejected, with who rejected them and the reason they gave.",
  sensitivity: "sensitive",
  defaultRange: "last90Days",
  tables: ["workflow_instances", "workflow_step_instances", "workflow_step_approvals"],
  tags: ["rejections", "reasons"],
  countLabel: "Rejected requests",
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "request", label: "Request", type: "text" },
    { key: "submitted", label: "Submitted", type: "date" },
    { key: "rejected", label: "Rejected", type: "date" },
    { key: "step", label: "Step", type: "text" },
    { key: "by", label: "Rejected by", type: "text" },
    { key: "reason", label: "Reason given", type: "text" },
  ],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, wi.created_at::date::text AS submitted, COALESCE(a.decided_at, wi.completed_at)::date::text AS rejected, si.name AS step,
           COALESCE(NULLIF(${NAME("de")}, ''), ro.name, ${LABEL("a.approver_type")}) AS by, COALESCE(NULLIF(LEFT(a.comment, 200), ''), 'No reason recorded') AS reason
      FROM ${APPROVALS}
      LEFT JOIN employees de ON de.user_account_id = COALESCE(a.decided_by_user_account_id, a.user_account_id) AND de.company_id = wi.company_id
      LEFT JOIN roles ro ON ro.id = a.role_id AND (ro.company_id IS NULL OR ro.company_id = wi.company_id)
     WHERE ${q.co("wi")} AND wi.status = 'rejected' AND a.status = 'rejected' AND COALESCE(a.decided_at, wi.completed_at)::date BETWEEN ${q.from} AND ${q.to}
     ORDER BY COALESCE(a.decided_at, wi.completed_at) DESC`,
  kpis: ({ rows }) => [count("noReason", "Without a reason", rows.filter((r) => r.reason === "No reason recorded").length)],
  calculation: ["Lists requests whose final status is rejected, with the step that rejected them, the approver and the comment they left (first 200 characters).", "A request rejected at a role-routed step shows the role when the approver cannot be tied to a person."],
});

export const H06 = listReport({
  description: "Approvals that were handed to someone else, and how delegations were used in the range.",
  defaultRange: "last90Days",
  tables: ["delegations", "workflow_step_approvals", "workflow_instances"],
  tags: ["delegation", "reassigned"],
  countLabel: "Approvals delegated",
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "request", label: "Request", type: "text" },
    { key: "delegatedOn", label: "Delegated on", type: "date" },
    { key: "from", label: "From", type: "text" },
    { key: "to", label: "To", type: "text" },
    { key: "status", label: "Approval status", type: "text" },
  ],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, a.delegated_at::date::text AS "delegatedOn",
           COALESCE(NULLIF(${NAME("df")}, ''), 'Not recorded') AS "from", COALESCE(NULLIF(${NAME("dt")}, ''), 'Not recorded') AS "to", ${LABEL("a.status")} AS status
      FROM ${APPROVALS}
      LEFT JOIN employees df ON df.user_account_id = a.delegated_from_user_account_id AND df.company_id = wi.company_id
      LEFT JOIN employees dt ON dt.user_account_id = a.delegated_to_user_account_id AND dt.company_id = wi.company_id
     WHERE ${q.co("wi")} AND a.delegated_at IS NOT NULL AND a.delegated_at::date BETWEEN ${q.from} AND ${q.to}
     ORDER BY a.delegated_at DESC`,
  summary: (q) => `
    SELECT COUNT(*)::int AS created, COUNT(*) FILTER (WHERE d.status = 'active')::int AS active, COUNT(*) FILTER (WHERE d.status = 'revoked')::int AS revoked
      FROM delegations d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to}`,
  kpis: ({ summary }) => [count("created", "Delegations set up", summary.created ?? 0), count("active", "Still active", summary.active ?? 0), count("revoked", "Revoked", summary.revoked ?? 0)],
  calculation: ["Lists approvals whose delegation time falls in the range. The delegation tiles count delegation rules created in the same range.", "Who the approval moved from and to comes from the delegation recorded on the approval; a missing name shows 'Not recorded'."],
});

export const H07 = sqlReport({
  description: "Steps that took longer than the hours their workflow template allows, or are still waiting past that limit.",
  defaultRange: "last90Days",
  tables: ["workflow_template_steps", "workflow_step_instances", "workflow_step_approvals", "workflow_instances"],
  viz: ["bar", "kpi", "table"],
  tags: ["sla", "breach"],
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "step", label: "Step", type: "text" },
    { key: "limit", label: "Allowed (hours)", type: "number" },
    { key: "steps", label: "Steps measured", type: "number" },
    { key: "breached", label: "Over the limit", type: "number" },
    { key: "rate", label: "Over the limit (%)", type: "percent" },
    { key: "worst", label: "Longest (hours)", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(wt.name, ${OBJ}) AS workflow, si.name AS step, ts.sla_hours AS "limit", COUNT(*)::int AS steps,
           COUNT(*) FILTER (WHERE m.hours > ts.sla_hours)::int AS breached, ROUND(COUNT(*) FILTER (WHERE m.hours > ts.sla_hours) * 100.0 / COUNT(*), 1) AS rate, ROUND(MAX(m.hours)::numeric, 1) AS worst
      FROM workflow_step_instances si
      JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
      JOIN workflow_template_steps ts ON ts.template_id = wi.template_id AND ts.step_order = si.step_order AND ts.sla_hours IS NOT NULL
      LEFT JOIN workflow_templates wt ON wt.id = wi.template_id
      JOIN LATERAL (
        SELECT ${HOURS("COALESCE(MAX(a.decided_at), now())", "MIN(a.created_at)")} AS hours FROM workflow_step_approvals a WHERE a.step_instance_id = si.id HAVING COUNT(a.id) > 0
      ) m ON TRUE
     WHERE ${q.co("wi")} AND si.status IN ('pending', 'approved', 'rejected', 'returned') AND si.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY COALESCE(wt.name, ${OBJ}), si.name, ts.sla_hours ORDER BY breached DESC, rate DESC, workflow, step`,
  chart: ({ rows }) => (rows.some((r) => num(r, "breached") > 0) ? barChart({ title: "Steps over their time limit", unit: "steps", rows: rows.filter((r) => num(r, "breached") > 0).map((r) => ({ ...r, label: `${r.workflow} - ${r.step}` })), labelKey: "label", valueKey: "breached", max: 12 }) : null),
  kpis: ({ rows }) => [count("measured", "Steps measured", sum(rows, "steps")), count("breached", "Over the limit", sum(rows, "breached")), percent("rate", "Share over the limit", pct(sum(rows, "breached"), sum(rows, "steps")))],
  calculation: ["Only steps whose template defines a time limit (SLA hours) are measured. Time runs from when the step's approvals were created to the last decision, or to now if the step is still waiting.", "A step is over the limit when that time exceeds the allowed hours. Steps from template versions without a matching step order are not measured."],
  notes: () => ["Workflow templates with no time limit set on a step are not included, so this report shows nothing for them rather than guessing a limit."],
});

export const H08 = sqlReport({
  description: "Which workflow steps make requests wait longest: average decision time and what is waiting there now.",
  defaultRange: "last90Days",
  tables: ["workflow_step_instances", "workflow_step_approvals", "workflow_instances", "workflow_templates"],
  viz: ["bar", "table"],
  tags: ["bottleneck", "turnaround"],
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "step", label: "Step", type: "text" },
    { key: "decided", label: "Decisions", type: "number" },
    { key: "average", label: "Average (hours)", type: "number" },
    { key: "median", label: "Median (hours)", type: "number" },
    { key: "waiting", label: "Waiting now", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(wt.name, ${OBJ}) AS workflow, si.name AS step,
           COUNT(*) FILTER (WHERE a.decided_at IS NOT NULL)::int AS decided,
           ROUND((AVG(${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS median,
           COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting
      FROM ${APPROVALS} LEFT JOIN workflow_templates wt ON wt.id = wi.template_id
     WHERE ${q.co("wi")} AND a.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY COALESCE(wt.name, ${OBJ}), si.name HAVING COUNT(*) FILTER (WHERE a.decided_at IS NOT NULL) > 0 OR COUNT(*) FILTER (WHERE ${OPEN}) > 0
     ORDER BY average DESC NULLS LAST, waiting DESC, workflow, step`,
  chart: ({ rows }) => (rows.some((r) => r.average != null) ? barChart({ title: "Slowest steps (average hours to decide)", unit: "hours", rows: rows.filter((r) => r.average != null).map((r) => ({ ...r, label: `${r.workflow} - ${r.step}` })), labelKey: "label", valueKey: "average", max: 10 }) : null),
  kpis: ({ rows }) => [count("steps", "Steps compared", rows.length), { key: "worst", label: "Slowest step average", value: rows.length && rows[0]?.average != null ? num(rows[0], "average") : null, unit: "hours" as const }],
  calculation: ["Groups approvals created in the range by workflow and step. Decision time is hours from approval creation to decision.", "Waiting now counts approvals in that step that are still pending or escalated today, regardless of when they were created in the range."],
});

export const H09 = sqlReport({
  description: "Approvals addressed to people in each organisation unit: how many, how many decided, and how fast.",
  filters: [DEPT],
  defaultRange: "last90Days",
  tables: ["workflow_step_approvals", "employees", "org_units"],
  viz: ["bar", "table"],
  tags: ["approvals", "unit"],
  columns: [
    { key: "unit", label: "Approver's organisation unit", type: "text" },
    { key: "assigned", label: "Approvals assigned", type: "number" },
    { key: "decided", label: "Decided", type: "number" },
    { key: "waiting", label: "Waiting now", type: "number" },
    { key: "average", label: "Average to decide (hours)", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not tied to a person') AS unit, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.decided_at IS NOT NULL)::int AS decided, COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting,
           ROUND((AVG(${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average
      FROM ${APPROVALS} ${APPROVER_JOIN}
      LEFT JOIN org_units ou ON ou.id = pe.org_unit_id
     WHERE ${q.co("wi")} AND a.created_at::date BETWEEN ${q.from} AND ${q.to} AND ${q.dim(DEPT, "pe.org_unit_id")}
     GROUP BY ou.id, ou.name ORDER BY assigned DESC, unit`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Approvals assigned, by approver's unit", unit: "approvals", rows, labelKey: "unit", valueKey: "assigned", max: 12 }) : null),
  kpis: ({ rows }) => [count("assigned", "Approvals assigned", sum(rows, "assigned")), count("waiting", "Waiting now", sum(rows, "waiting"))],
  calculation: ["Each approval is attributed to the organisation unit of the person it is addressed to. Approvals routed to a role or rule, with no person behind them, are grouped as 'Not tied to a person'.", "Average time is hours from approval creation to decision, over decided approvals only."],
});

export const H10 = sqlReport({
  description: "Approvals handled by each manager (line, dotted-line and unit heads): volume, decisions, waiting and speed.",
  defaultRange: "last90Days",
  tables: ["workflow_step_approvals", "workflow_instances", "employees"],
  viz: ["bar", "table"],
  tags: ["approvals", "managers"],
  columns: [
    { key: "manager", label: "Manager", type: "text" },
    { key: "assigned", label: "Approvals assigned", type: "number" },
    { key: "approved", label: "Approved", type: "number" },
    { key: "rejected", label: "Rejected", type: "number" },
    { key: "waiting", label: "Waiting now", type: "number" },
    { key: "average", label: "Average to decide (hours)", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("pe")}, ''), 'Unknown') AS manager, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting, ROUND((AVG(${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average
      FROM ${APPROVALS} ${APPROVER_JOIN}
     WHERE ${q.co("wi")} AND a.approver_type IN ('manager_of_submitter', 'dotted_line_manager', 'org_unit_head') AND a.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY a.user_account_id, pe.id, pe.first_name, pe.last_name ORDER BY assigned DESC, manager`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Approvals assigned, by manager", unit: "approvals", rows, labelKey: "manager", valueKey: "assigned", max: 12 }) : null),
  kpis: ({ rows }) => [count("managers", "Managers", rows.length), count("assigned", "Approvals assigned", sum(rows, "assigned")), count("waiting", "Waiting now", sum(rows, "waiting"))],
  calculation: ["Includes approvals routed by reporting line: manager of the submitter, dotted-line manager and organisation unit head.", "Average time is hours from approval creation to decision, over decided approvals only."],
});

export const H11 = listReport({
  description: "Background jobs that failed or ran out of retries, with the error they reported.",
  domain: "governance",
  sensitivity: "sensitive",
  defaultRange: "last30Days",
  tables: ["background_jobs"],
  tags: ["failures", "jobs", "errors"],
  countLabel: "Failed jobs",
  columns: [
    { key: "job", label: "Job", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "attempts", label: "Attempts", type: "number" },
    { key: "created", label: "Created", type: "date" },
    { key: "finished", label: "Finished", type: "date" },
    { key: "deadLettered", label: "Gave up", type: "text" },
    { key: "error", label: "Error", type: "text" },
  ],
  sql: (q) => `
    SELECT j.job_type AS job, ${LABEL("j.status")} AS status, j.attempts AS attempts, j.created_at::date::text AS created, j.finished_at::date::text AS finished,
           CASE WHEN j.dead_lettered THEN 'Yes' ELSE 'No' END AS "deadLettered", COALESCE(NULLIF(LEFT(j.last_error, 200), ''), 'No error text') AS error
      FROM background_jobs j
     WHERE ${q.co("j")} AND (j.status = 'failed' OR j.dead_lettered) AND j.created_at::date BETWEEN ${q.from} AND ${q.to}
     ORDER BY j.created_at DESC`,
  kpis: ({ rows }) => [count("gaveUp", "Gave up retrying", rows.filter((r) => r.deadLettered === "Yes").length)],
  calculation: ["Lists background jobs created in the range that failed or were dead-lettered, newest first. Error text is cut to 200 characters.", "These are the jobs the platform runs on the company's behalf (for example payroll calculation, imports and exports). A failed approval step is not a job and is not listed here."],
});

export const H12 = listReport({
  description: "Approvals that were escalated because they waited too long, and what happened next.",
  defaultRange: "last90Days",
  tables: ["workflow_step_approvals", "workflow_step_instances", "workflow_instances"],
  tags: ["escalation"],
  countLabel: "Escalations",
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "request", label: "Request", type: "text" },
    { key: "escalatedOn", label: "Escalated on", type: "date" },
    { key: "approver", label: "Original approver", type: "text" },
    { key: "to", label: "Escalated to", type: "text" },
    { key: "status", label: "Approval status", type: "text" },
    { key: "waited", label: "Days since escalation", type: "number" },
  ],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, a.escalated_at::date::text AS "escalatedOn", ${APPROVER} AS approver,
           COALESCE(NULLIF(${NAME("et")}, ''), 'Not recorded') AS "to", ${LABEL("a.status")} AS status, (COALESCE(a.decided_at::date, ${q.today}) - a.escalated_at::date)::int AS waited
      FROM ${APPROVALS} ${APPROVER_JOIN}
      LEFT JOIN employees et ON et.user_account_id = a.escalated_to_user_account_id AND et.company_id = wi.company_id
     WHERE ${q.co("wi")} AND a.escalated_at IS NOT NULL AND a.escalated_at::date BETWEEN ${q.from} AND ${q.to}
     ORDER BY a.escalated_at DESC`,
  kpis: ({ rows }) => [count("still", "Still waiting", rows.filter((r) => r.status === "Escalated" || r.status === "Pending").length)],
  calculation: ["Lists approvals with an escalation time in the range. Days since escalation run to the decision, or to today if the approval is still open."],
});

export const H13 = sqlReport({
  description: "Each workflow template: whether it is active, its version and steps, and how often it was used in the range.",
  defaultRange: "last12Months",
  tables: ["workflow_templates", "workflow_template_steps", "workflow_instances"],
  viz: ["bar", "table"],
  tags: ["configuration", "usage"],
  columns: [
    { key: "template", label: "Template", type: "text" },
    { key: "object", label: "Applies to", type: "text" },
    { key: "active", label: "Active", type: "text" },
    { key: "version", label: "Version", type: "number" },
    { key: "steps", label: "Steps", type: "number" },
    { key: "used", label: "Requests in range", type: "number" },
    { key: "last", label: "Last used", type: "date" },
  ],
  sql: (q) => `
    SELECT wt.name AS template, ${LABEL("wt.object_key")} AS object, CASE WHEN wt.is_active THEN 'Yes' ELSE 'No' END AS active, wt.current_version_no AS version,
           (SELECT COUNT(*)::int FROM workflow_template_steps s WHERE s.template_id = wt.id) AS steps,
           COUNT(wi.id) FILTER (WHERE wi.created_at::date BETWEEN ${q.from} AND ${q.to})::int AS used, MAX(wi.created_at)::date::text AS last
      FROM workflow_templates wt LEFT JOIN workflow_instances wi ON wi.template_id = wt.id AND wi.company_id = wt.company_id
     WHERE ${q.co("wt")}
     GROUP BY wt.id ORDER BY used DESC, template`,
  chart: ({ rows }) => (rows.some((r) => num(r, "used") > 0) ? barChart({ title: "Requests per template", unit: "requests", rows: rows.filter((r) => num(r, "used") > 0), labelKey: "template", valueKey: "used", max: 12 }) : null),
  kpis: ({ rows }) => [count("templates", "Templates", rows.length), count("active", "Active", rows.filter((r) => r.active === "Yes").length), count("unused", "Active and unused in range", rows.filter((r) => r.active === "Yes" && num(r, "used") === 0).length)],
  calculation: ["Lists every workflow template of the company. Requests in range are instances created from that template between the dates. Last used is the latest instance ever created, whatever the range."],
});

export const H14 = sqlReport({
  description: "How the open approvals are spread across approvers, so overloaded people stand out.",
  tables: ["workflow_step_approvals", "workflow_instances", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["load", "approvals"],
  columns: [
    { key: "approver", label: "Approver", type: "text" },
    { key: "open", label: "Open approvals", type: "number" },
    { key: "escalated", label: "Escalated", type: "number" },
    { key: "oldest", label: "Oldest (days)", type: "number" },
    { key: "share", label: "Share of open (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT x.approver, x.open, x.escalated, x.oldest, ROUND(x.open * 100.0 / NULLIF(SUM(x.open) OVER (), 0), 1) AS share FROM (
      SELECT ${APPROVER} AS approver, COUNT(*)::int AS open, COUNT(*) FILTER (WHERE a.status = 'escalated')::int AS escalated, MAX(${q.today} - a.created_at::date)::int AS oldest
        FROM ${APPROVALS} ${APPROVER_JOIN}
       WHERE ${q.co("wi")} AND ${OPEN}
       GROUP BY a.user_account_id, a.role_id, a.approver_type, ro.name, pe.id, pe.first_name, pe.last_name
    ) x ORDER BY x.open DESC, x.approver`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Open approvals per approver", unit: "approvals", rows, labelKey: "approver", valueKey: "open", max: 12 }) : null),
  kpis: ({ rows }) => {
    const total = sum(rows, "open");
    const top3 = rows.slice(0, 3).reduce((s, r) => s + num(r, "open"), 0);
    return [count("approvers", "Approvers holding work", rows.length), count("open", "Open approvals", total), percent("top3", "Held by the top three", pct(top3, total))];
  },
  calculation: ["Counts approvals that are pending or escalated on an active step, per approver. Approvals routed to a role or rule are grouped under the role or rule name.", "Share is each approver's part of all open approvals."],
});

export const H15 = listReport({
  description: `Requests that are open but have not moved for ${IDLE_DAYS} days or more, or are on hold or returned for correction.`,
  tables: ["workflow_instances", "workflow_step_instances", "workflow_step_approvals"],
  tags: ["stuck", "intermediate"],
  countLabel: "Stuck requests",
  columns: [
    { key: "workflow", label: "Workflow", type: "text" },
    { key: "request", label: "Request", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "submitted", label: "Submitted", type: "date" },
    { key: "idle", label: "Days without movement", type: "number" },
    { key: "step", label: "Current step", type: "text" },
    { key: "waitingOn", label: "Waiting on", type: "text" },
  ],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, ${LABEL("wi.status")} AS status, wi.created_at::date::text AS submitted, (${q.today} - wi.updated_at::date)::int AS idle,
           COALESCE((SELECT si.name FROM workflow_step_instances si WHERE si.workflow_instance_id = wi.id AND si.status IN ('pending', 'returned') ORDER BY si.step_order LIMIT 1), 'None open') AS step,
           COALESCE((SELECT string_agg(DISTINCT COALESCE(NULLIF(${NAME("pe")}, ''), ro.name, ${LABEL("a.approver_type")}), ', ')
                       FROM workflow_step_approvals a JOIN workflow_step_instances si2 ON si2.id = a.step_instance_id
                       LEFT JOIN employees pe ON pe.user_account_id = a.user_account_id AND pe.company_id = wi.company_id
                       LEFT JOIN roles ro ON ro.id = a.role_id
                      WHERE si2.workflow_instance_id = wi.id AND a.status IN ('pending', 'escalated')), 'Nobody (returned or on hold)') AS "waitingOn"
      FROM workflow_instances wi
     WHERE ${q.co("wi")} AND ((wi.status = 'in_progress' AND (${q.today} - wi.updated_at::date) >= ${IDLE_DAYS}) OR wi.status IN ('on_hold', 'returned'))
     ORDER BY idle DESC, workflow`,
  kpis: ({ rows }) => [count("onHold", "On hold or returned", rows.filter((r) => r.status === "On Hold" || r.status === "Returned").length), { key: "oldest", label: "Longest without movement", value: rows.length ? Math.max(...rows.map((r) => num(r, "idle"))) : null, unit: "days" as const }],
  calculation: [`A request is stuck when it is in progress and nothing has changed on it for ${IDLE_DAYS} days or more, or when it is on hold or returned for correction (whatever its age).`, "Days without movement run from the request's last update to today. Waiting on lists who holds the open approvals."],
});
