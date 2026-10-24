import { DEPT, type Q, type ReportSectionSpec } from "../report-spec";
import { LABEL, NAME, col } from "./common";

/**
 * Extra tables for the workflow and approval reports (H01 to H15). Like the reports, they read the company's own
 * workflow instances and approvals and are open only to people who manage workflow templates. Comments and hold reasons
 * are free text and are never selected, only whether one was recorded.
 */

const OBJ = LABEL("wi.object_key");
const HOURS = (to: string, from: string) => `EXTRACT(EPOCH FROM (${to} - ${from})) / 3600.0`;
const OPEN = "a.status IN ('pending', 'escalated') AND si.status = 'pending' AND wi.status = 'in_progress'";
const APPROVALS = `workflow_step_approvals a
      JOIN workflow_step_instances si ON si.id = a.step_instance_id
      JOIN workflow_instances wi ON wi.id = si.workflow_instance_id`;
const APPROVER_JOIN = `LEFT JOIN employees pe ON pe.user_account_id = a.user_account_id AND pe.company_id = wi.company_id
      LEFT JOIN roles ro ON ro.id = a.role_id AND (ro.company_id IS NULL OR ro.company_id = wi.company_id)`;
const APPROVER = `COALESCE(NULLIF(${NAME("pe")}, ''), ro.name, ${LABEL("a.approver_type")})`;
const WF_JOIN = "LEFT JOIN workflow_templates wt ON wt.id = wi.template_id";
const WORKFLOW = `COALESCE(wt.name, ${OBJ})`;
const n = (key: string, label: string) => col(key, label, "number");
const pc = (key: string, label: string) => col(key, label, "percent");
const MONTH_OF = (c: string) => `to_char(date_trunc('month', ${c}), 'YYYY-MM')`;
/** A request created in the report's range. */
const CREATED = (q: Q) => `wi.created_at::date BETWEEN ${q.from} AND ${q.to}`;
/** An approval created in the report's range. */
const A_CREATED = (q: Q) => `a.created_at::date BETWEEN ${q.from} AND ${q.to}`;
/** A request finished in the report's range. */
const FINISHED = (q: Q) => `wi.status IN ('approved', 'rejected') AND wi.completed_at IS NOT NULL AND wi.completed_at::date BETWEEN ${q.from} AND ${q.to}`;

// ---------------------------------------------------------------- waiting now (no date range)

const OPEN_LIST: ReportSectionSpec = {
  key: "open-approvals",
  title: "Every open approval",
  description: "Each approval waiting for someone: the request, the step, who it is addressed to, since when and whether it is past its due time.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("priority", "Priority"), col("step", "Step"), col("approver", "Addressed to"), col("status", "Status"), col("since", "Waiting since", "date"), n("days", "Days waiting"), col("overdue", "Past its due time")],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, ${LABEL("COALESCE(wi.priority, 'normal')")} AS priority, si.name AS step, ${APPROVER} AS approver, ${LABEL("a.status")} AS status,
           a.created_at::date::text AS since, (${q.today} - a.created_at::date)::int AS days, CASE WHEN COALESCE(a.due_at, wi.due_at) < now() THEN 'Yes' ELSE 'No' END AS overdue
      FROM ${APPROVALS} ${APPROVER_JOIN} WHERE ${q.co("wi")} AND ${OPEN} ORDER BY a.created_at, workflow`,
};
const OPEN_BY_STEP: ReportSectionSpec = {
  key: "open-by-step",
  title: "Open approvals by workflow step",
  description: "Where the waiting approvals sit: workflow, step, how many and how long the oldest has waited.",
  columns: [col("workflow", "Workflow"), col("step", "Step"), n("waiting", "Waiting"), n("escalated", "Escalated"), n("oldest", "Oldest (days)"), n("average", "Average wait (days)")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, si.name AS step, COUNT(*)::int AS waiting, COUNT(*) FILTER (WHERE a.status = 'escalated')::int AS escalated, MAX(${q.today} - a.created_at::date)::int AS oldest, ROUND(AVG(${q.today} - a.created_at::date), 1) AS average
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${q.co("wi")} AND ${OPEN} GROUP BY 1, si.name, si.step_order ORDER BY waiting DESC, workflow, si.step_order`,
};
const OPEN_BY_PRIORITY: ReportSectionSpec = {
  key: "open-by-priority",
  title: "Open approvals by priority",
  description: "Waiting approvals by the priority of the request.",
  columns: [col("label", "Priority"), n("waiting", "Waiting"), n("escalated", "Escalated"), n("oldest", "Oldest (days)")],
  sql: (q) => `
    SELECT ${LABEL("COALESCE(wi.priority, 'normal')")} AS label, COUNT(*)::int AS waiting, COUNT(*) FILTER (WHERE a.status = 'escalated')::int AS escalated, MAX(${q.today} - a.created_at::date)::int AS oldest
      FROM ${APPROVALS} WHERE ${q.co("wi")} AND ${OPEN} GROUP BY wi.priority ORDER BY waiting DESC, label`,
};
const OPEN_AGE_MATRIX: ReportSectionSpec = {
  key: "age-by-workflow",
  title: "Waiting time by workflow",
  description: "For each workflow: how many open approvals fall in each age band.",
  columns: [col("workflow", "Workflow"), n("d1", "Under 1 day"), n("d2", "1 to 2 days"), n("d7", "3 to 7 days"), n("d14", "8 to 14 days"), n("d30", "15 to 30 days"), n("d31", "Over 30 days")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, COUNT(*) FILTER (WHERE (${q.today} - a.created_at::date) < 1)::int AS d1, COUNT(*) FILTER (WHERE (${q.today} - a.created_at::date) BETWEEN 1 AND 2)::int AS d2,
           COUNT(*) FILTER (WHERE (${q.today} - a.created_at::date) BETWEEN 3 AND 7)::int AS d7, COUNT(*) FILTER (WHERE (${q.today} - a.created_at::date) BETWEEN 8 AND 14)::int AS d14,
           COUNT(*) FILTER (WHERE (${q.today} - a.created_at::date) BETWEEN 15 AND 30)::int AS d30, COUNT(*) FILTER (WHERE (${q.today} - a.created_at::date) > 30)::int AS d31
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${q.co("wi")} AND ${OPEN} GROUP BY 1 ORDER BY COUNT(*) DESC, 1`,
};
const OPEN_OVERDUE: ReportSectionSpec = {
  key: "open-past-due",
  title: "Open approvals past their due time",
  description: "Waiting approvals whose own due time, or the request's due time, has passed.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("step", "Step"), col("approver", "Addressed to"), col("due", "Was due", "date"), n("late", "Days late")],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, si.name AS step, ${APPROVER} AS approver, COALESCE(a.due_at, wi.due_at)::date::text AS due, (${q.today} - COALESCE(a.due_at, wi.due_at)::date)::int AS late
      FROM ${APPROVALS} ${APPROVER_JOIN} WHERE ${q.co("wi")} AND ${OPEN} AND COALESCE(a.due_at, wi.due_at) < now() ORDER BY late DESC, workflow`,
};
const OPEN_BY_APPROVER_TYPE: ReportSectionSpec = {
  key: "open-by-routing",
  title: "Open approvals by how they were routed",
  description: "Whether waiting approvals are addressed to a named person, a role, a manager, a position or a group.",
  columns: [col("label", "Routed to"), n("waiting", "Waiting"), n("escalated", "Escalated"), n("oldest", "Oldest (days)")],
  sql: (q) => `
    SELECT ${LABEL("a.approver_type")} AS label, COUNT(*)::int AS waiting, COUNT(*) FILTER (WHERE a.status = 'escalated')::int AS escalated, MAX(${q.today} - a.created_at::date)::int AS oldest
      FROM ${APPROVALS} WHERE ${q.co("wi")} AND ${OPEN} GROUP BY a.approver_type ORDER BY waiting DESC, label`,
};
const OPEN_BY_APPROVER_WORKFLOW: ReportSectionSpec = {
  key: "approver-by-workflow",
  title: "Each approver's open work by workflow",
  description: "How many approvals each approver is holding in each workflow.",
  columns: [col("approver", "Approver"), col("workflow", "Workflow"), n("open", "Open"), n("escalated", "Escalated"), n("oldest", "Oldest (days)")],
  sql: (q) => `
    SELECT ${APPROVER} AS approver, ${WORKFLOW} AS workflow, COUNT(*)::int AS open, COUNT(*) FILTER (WHERE a.status = 'escalated')::int AS escalated, MAX(${q.today} - a.created_at::date)::int AS oldest
      FROM ${APPROVALS} ${APPROVER_JOIN} ${WF_JOIN} WHERE ${q.co("wi")} AND ${OPEN} GROUP BY a.user_account_id, a.role_id, a.approver_type, ro.name, pe.id, pe.first_name, pe.last_name, 2 ORDER BY open DESC, approver, workflow`,
};
const OPEN_ESCALATED: ReportSectionSpec = {
  key: "open-escalated",
  title: "Open approvals that were escalated",
  description: "Waiting approvals that have already been escalated, to whom, and how long ago.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("step", "Step"), col("approver", "Original approver"), col("to", "Escalated to"), col("escalatedOn", "Escalated on", "date"), n("days", "Days since escalation")],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, si.name AS step, ${APPROVER} AS approver, COALESCE(NULLIF(${NAME("et")}, ''), 'Not recorded') AS "to", a.escalated_at::date::text AS "escalatedOn", (${q.today} - a.escalated_at::date)::int AS days
      FROM ${APPROVALS} ${APPROVER_JOIN} LEFT JOIN employees et ON et.user_account_id = a.escalated_to_user_account_id AND et.company_id = wi.company_id
     WHERE ${q.co("wi")} AND ${OPEN} AND a.escalated_at IS NOT NULL ORDER BY a.escalated_at`,
};

// ---------------------------------------------------------------- finished requests

const TURNAROUND_MONTH: ReportSectionSpec = {
  key: "turnaround-by-month",
  title: "Time to decision by month",
  description: "Finished requests each month with the average, median and slowest time from submission to the final decision.",
  columns: [col("month", "Month finished"), n("requests", "Finished requests"), n("average", "Average (hours)"), n("median", "Median (hours)"), n("slowest", "Slowest (hours)")],
  sql: (q) => `
    SELECT ${MONTH_OF("wi.completed_at")} AS month, COUNT(*)::int AS requests, ROUND(AVG(${HOURS("wi.completed_at", "wi.created_at")})::numeric, 1) AS average,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${HOURS("wi.completed_at", "wi.created_at")}))::numeric, 1) AS median, ROUND(MAX(${HOURS("wi.completed_at", "wi.created_at")})::numeric, 1) AS slowest
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${FINISHED(q)} GROUP BY 1 ORDER BY 1`,
};
const TURNAROUND_BANDS: ReportSectionSpec = {
  key: "turnaround-bands",
  title: "How long requests took",
  description: "Finished requests grouped by the time from submission to final decision.",
  columns: [col("label", "Took"), n("requests", "Requests"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS requests, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN h < 4 THEN '0 Under 4 hours' WHEN h < 24 THEN '1 4 to 24 hours' WHEN h < 72 THEN '2 One to three days' WHEN h < 168 THEN '3 Three to seven days' ELSE '4 Over a week' END AS band
              FROM (SELECT ${HOURS("wi.completed_at", "wi.created_at")} AS h FROM workflow_instances wi WHERE ${q.co("wi")} AND ${FINISHED(q)}) x) b GROUP BY b.band ORDER BY b.band`,
};
const TURNAROUND_PRIORITY: ReportSectionSpec = {
  key: "turnaround-by-priority",
  title: "Time to decision by priority",
  description: "Whether urgent requests are in fact decided faster.",
  columns: [col("label", "Priority"), n("requests", "Finished requests"), n("average", "Average (hours)"), n("median", "Median (hours)")],
  sql: (q) => `
    SELECT ${LABEL("COALESCE(wi.priority, 'normal')")} AS label, COUNT(*)::int AS requests, ROUND(AVG(${HOURS("wi.completed_at", "wi.created_at")})::numeric, 1) AS average,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${HOURS("wi.completed_at", "wi.created_at")}))::numeric, 1) AS median
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${FINISHED(q)} GROUP BY wi.priority ORDER BY requests DESC, label`,
};
const SLOWEST: ReportSectionSpec = {
  key: "slowest-requests",
  title: "Slowest finished requests",
  description: "The requests that took longest from submission to decision.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("outcome", "Outcome"), col("submitted", "Submitted", "date"), col("finished", "Finished", "date"), n("hours", "Hours"), n("steps", "Steps")],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, ${LABEL("wi.status")} AS outcome, wi.created_at::date::text AS submitted, wi.completed_at::date::text AS finished,
           ROUND((${HOURS("wi.completed_at", "wi.created_at")})::numeric, 1) AS hours, (SELECT COUNT(*) FROM workflow_step_instances s WHERE s.workflow_instance_id = wi.id)::int AS steps
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${FINISHED(q)} ORDER BY hours DESC, workflow LIMIT 200`,
};
const OUTCOME_MONTH: ReportSectionSpec = {
  key: "outcome-by-month",
  title: "Requests by month submitted",
  description: "Requests submitted each month and how they ended.",
  columns: [col("month", "Month submitted"), n("submitted", "Submitted"), n("approved", "Approved"), n("rejected", "Rejected"), n("cancelled", "Cancelled"), n("returned", "Returned or on hold"), n("open", "In progress"), pc("approval", "Approved of decided (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("wi.created_at")} AS month, COUNT(*)::int AS submitted, COUNT(*) FILTER (WHERE wi.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE wi.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE wi.status = 'cancelled')::int AS cancelled, COUNT(*) FILTER (WHERE wi.status IN ('returned', 'on_hold'))::int AS returned, COUNT(*) FILTER (WHERE wi.status = 'in_progress')::int AS open,
           ROUND(COUNT(*) FILTER (WHERE wi.status = 'approved') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE wi.status IN ('approved', 'rejected')), 0), 1) AS approval
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${CREATED(q)} GROUP BY 1 ORDER BY 1`,
};
const OUTCOME_PRIORITY: ReportSectionSpec = {
  key: "outcome-by-priority",
  title: "Requests by priority",
  description: "How requests of each priority ended.",
  columns: [col("label", "Priority"), n("submitted", "Submitted"), n("approved", "Approved"), n("rejected", "Rejected"), n("open", "Still open")],
  sql: (q) => `
    SELECT ${LABEL("COALESCE(wi.priority, 'normal')")} AS label, COUNT(*)::int AS submitted, COUNT(*) FILTER (WHERE wi.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE wi.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE wi.status IN ('in_progress', 'returned', 'on_hold'))::int AS open
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${CREATED(q)} GROUP BY wi.priority ORDER BY submitted DESC, label`,
};
const STILL_OPEN_BY_WORKFLOW: ReportSectionSpec = {
  key: "open-from-range",
  title: "Requests from this period still open",
  description: "Requests submitted in the period that have not been decided, with how long they have been open.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("status", "Status"), col("submitted", "Submitted", "date"), n("age", "Days open"), col("step", "Current step")],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, ${LABEL("wi.status")} AS status, wi.created_at::date::text AS submitted, (${q.today} - wi.created_at::date)::int AS age,
           COALESCE((SELECT si.name FROM workflow_step_instances si WHERE si.workflow_instance_id = wi.id AND si.status IN ('pending', 'returned') ORDER BY si.step_order LIMIT 1), 'None open') AS step
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${CREATED(q)} AND wi.status IN ('in_progress', 'returned', 'on_hold') ORDER BY wi.created_at LIMIT 500`,
};
const STEP_TIME_MONTH: ReportSectionSpec = {
  key: "step-time-by-month",
  title: "Decision time by step and month",
  description: "Average hours from an approval becoming active to its decision, for each workflow step and month.",
  columns: [col("month", "Month"), col("workflow", "Workflow"), col("step", "Step"), n("decided", "Decisions"), n("average", "Average (hours)")],
  sql: (q) => `
    SELECT ${MONTH_OF("a.created_at")} AS month, ${WORKFLOW} AS workflow, si.name AS step, COUNT(*)::int AS decided, ROUND(AVG(${HOURS("a.decided_at", "a.created_at")})::numeric, 1) AS average
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${q.co("wi")} AND ${A_CREATED(q)} AND a.decided_at IS NOT NULL GROUP BY 1, 2, si.name, si.step_order ORDER BY 1, workflow, si.step_order`,
};
const STEP_TIME_BANDS: ReportSectionSpec = {
  key: "decision-time-bands",
  title: "How long each decision took",
  description: "Approvals grouped by the time from becoming active to a decision.",
  columns: [col("label", "Decided within"), n("decisions", "Decisions"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS decisions, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN h < 1 THEN '0 One hour' WHEN h < 8 THEN '1 Eight hours' WHEN h < 24 THEN '2 A day' WHEN h < 72 THEN '3 Three days' ELSE '4 More than three days' END AS band
              FROM (SELECT ${HOURS("a.decided_at", "a.created_at")} AS h FROM ${APPROVALS} WHERE ${q.co("wi")} AND ${A_CREATED(q)} AND a.decided_at IS NOT NULL) x) b GROUP BY b.band ORDER BY b.band`,
};
const WAITING_NOW_BY_STEP: ReportSectionSpec = {
  key: "waiting-now",
  title: "Waiting now by step",
  description: "Approvals created in the period that are still waiting, by workflow and step.",
  columns: [col("workflow", "Workflow"), col("step", "Step"), n("waiting", "Waiting now"), n("oldest", "Oldest (days)")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, si.name AS step, COUNT(*)::int AS waiting, MAX(${q.today} - a.created_at::date)::int AS oldest
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${q.co("wi")} AND ${A_CREATED(q)} AND ${OPEN} GROUP BY 1, si.name, si.step_order ORDER BY waiting DESC, workflow, si.step_order`,
};

// ---------------------------------------------------------------- rejections

const REJECT_BY_STEP: ReportSectionSpec = {
  key: "rejections-by-step",
  title: "Rejections by workflow step",
  description: "Where requests are rejected, and how often a reason was recorded. The reasons themselves are not repeated here.",
  columns: [col("workflow", "Workflow"), col("step", "Step"), n("rejections", "Rejections"), n("withReason", "With a reason recorded"), pc("reasonShare", "With a reason (%)")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, si.name AS step, COUNT(*)::int AS rejections, COUNT(*) FILTER (WHERE COALESCE(TRIM(a.comment), '') <> '')::int AS "withReason",
           ROUND(COUNT(*) FILTER (WHERE COALESCE(TRIM(a.comment), '') <> '') * 100.0 / COUNT(*), 1) AS "reasonShare"
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${q.co("wi")} AND wi.status = 'rejected' AND a.status = 'rejected' AND COALESCE(a.decided_at, wi.completed_at)::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY 1, si.name, si.step_order ORDER BY rejections DESC, workflow, si.step_order`,
};
const REJECT_MONTH: ReportSectionSpec = {
  key: "rejections-by-month",
  title: "Rejections by month",
  description: "Rejections each month against requests decided, so a rising rate stands out.",
  columns: [col("month", "Month"), n("decided", "Requests decided"), n("rejected", "Rejected"), pc("rate", "Rejected (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("wi.completed_at")} AS month, COUNT(*)::int AS decided, COUNT(*) FILTER (WHERE wi.status = 'rejected')::int AS rejected, ROUND(COUNT(*) FILTER (WHERE wi.status = 'rejected') * 100.0 / COUNT(*), 1) AS rate
      FROM workflow_instances wi WHERE ${q.co("wi")} AND ${FINISHED(q)} GROUP BY 1 ORDER BY 1`,
};
const REJECT_BY_APPROVER: ReportSectionSpec = {
  key: "rejections-by-approver",
  title: "Rejections by approver",
  description: "Who rejected how many requests, against how many they decided.",
  columns: [col("approver", "Rejected by"), n("decided", "Decisions"), n("rejected", "Rejections"), pc("rate", "Rejected (%)")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("de")}, ''), ro.name, ${LABEL("a.approver_type")}) AS approver, COUNT(*)::int AS decided, COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
           ROUND(COUNT(*) FILTER (WHERE a.status = 'rejected') * 100.0 / COUNT(*), 1) AS rate
      FROM ${APPROVALS}
      LEFT JOIN employees de ON de.user_account_id = COALESCE(a.decided_by_user_account_id, a.user_account_id) AND de.company_id = wi.company_id
      LEFT JOIN roles ro ON ro.id = a.role_id AND (ro.company_id IS NULL OR ro.company_id = wi.company_id)
     WHERE ${q.co("wi")} AND a.status IN ('approved', 'rejected') AND a.decided_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 HAVING COUNT(*) FILTER (WHERE a.status = 'rejected') > 0 ORDER BY rejected DESC, approver`,
};
const REJECT_WORKFLOW: ReportSectionSpec = {
  key: "rejections-by-workflow",
  title: "Rejection rate by workflow",
  description: "For each workflow: requests decided, rejected, and the rate.",
  columns: [col("workflow", "Workflow"), n("decided", "Requests decided"), n("rejected", "Rejected"), pc("rate", "Rejected (%)")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, COUNT(*)::int AS decided, COUNT(*) FILTER (WHERE wi.status = 'rejected')::int AS rejected, ROUND(COUNT(*) FILTER (WHERE wi.status = 'rejected') * 100.0 / COUNT(*), 1) AS rate
      FROM workflow_instances wi ${WF_JOIN} WHERE ${q.co("wi")} AND ${FINISHED(q)} GROUP BY 1 ORDER BY rate DESC, workflow`,
};
const RETURNED: ReportSectionSpec = {
  key: "returned-requests",
  title: "Requests returned or put on hold",
  description: "Requests sent back for correction or put on hold in the period. Hold reasons are not shown.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("status", "Status"), col("returned", "Returned on", "date"), col("held", "Hold started", "date"), n("idle", "Days since last change")],
  sql: (q) => `
    SELECT ${OBJ} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, ${LABEL("wi.status")} AS status, wi.returned_at::date::text AS returned, wi.hold_started_at::date::text AS held, (${q.today} - wi.updated_at::date)::int AS idle
      FROM workflow_instances wi WHERE ${q.co("wi")} AND (wi.returned_at::date BETWEEN ${q.from} AND ${q.to} OR wi.hold_started_at::date BETWEEN ${q.from} AND ${q.to}) ORDER BY idle DESC, workflow LIMIT 500`,
};

// ---------------------------------------------------------------- delegation

const DELEGATIONS: ReportSectionSpec = {
  key: "delegations",
  title: "Delegations",
  description: "Each delegation created in the period: who handed over to whom, what it covers, how long, and its status. The stated reason is not shown.",
  columns: [col("from", "Delegator"), col("to", "Delegate"), col("scope", "Covers"), col("validFrom", "From", "date"), col("validTo", "To", "date"), col("status", "Status"), col("revoked", "Revoked on", "date")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("df")}, ''), 'Not recorded') AS "from", COALESCE(NULLIF(${NAME("dt")}, ''), 'Not recorded') AS "to",
           CASE WHEN COALESCE(array_length(d.scope_object_keys, 1), 0) = 0 THEN 'Everything' ELSE array_to_string(d.scope_object_keys, ', ') END AS scope, d.valid_from::text AS "validFrom", d.valid_to::text AS "validTo",
           ${LABEL("d.status")} AS status, d.revoked_at::date::text AS revoked
      FROM delegations d LEFT JOIN employees df ON df.user_account_id = d.delegator_user_account_id AND df.company_id = d.company_id LEFT JOIN employees dt ON dt.user_account_id = d.delegate_user_account_id AND dt.company_id = d.company_id
     WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} ORDER BY d.created_at DESC`,
};
const DELEGATION_MONTH: ReportSectionSpec = {
  key: "delegations-by-month",
  title: "Delegations and delegated approvals by month",
  description: "Delegations created and approvals actually handed over each month.",
  columns: [col("month", "Month"), n("created", "Delegations created"), n("revoked", "Revoked"), n("approvals", "Approvals handed over")],
  sql: (q) => `
    SELECT m.month, COALESCE(d.created, 0)::int AS created, COALESCE(d.revoked, 0)::int AS revoked, COALESCE(h.approvals, 0)::int AS approvals
      FROM (SELECT ${MONTH_OF("d.created_at")} AS month FROM delegations d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to}
            UNION SELECT ${MONTH_OF("a.delegated_at")} FROM ${APPROVALS} WHERE ${q.co("wi")} AND a.delegated_at::date BETWEEN ${q.from} AND ${q.to}) m
      LEFT JOIN (SELECT ${MONTH_OF("d.created_at")} AS month, COUNT(*) AS created, COUNT(*) FILTER (WHERE d.status = 'revoked') AS revoked FROM delegations d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1) d ON d.month = m.month
      LEFT JOIN (SELECT ${MONTH_OF("a.delegated_at")} AS month, COUNT(*) AS approvals FROM ${APPROVALS} WHERE ${q.co("wi")} AND a.delegated_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1) h ON h.month = m.month ORDER BY m.month`,
};
const DELEGATED_OUTCOME: ReportSectionSpec = {
  key: "delegated-outcomes",
  title: "What happened to delegated approvals",
  description: "Approvals that were handed over, by workflow and how they ended.",
  columns: [col("workflow", "Workflow"), n("delegated", "Handed over"), n("approved", "Approved"), n("rejected", "Rejected"), n("waiting", "Still waiting"), n("average", "Average hours to decide")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, COUNT(*)::int AS delegated, COUNT(*) FILTER (WHERE a.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE a.status IN ('pending', 'escalated'))::int AS waiting, ROUND((AVG(${HOURS("a.decided_at", "a.delegated_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${q.co("wi")} AND a.delegated_at IS NOT NULL AND a.delegated_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY delegated DESC, workflow`,
};
const DELEGATION_STATUS: ReportSectionSpec = {
  key: "delegations-by-status",
  title: "Delegations by status",
  description: "Active and revoked delegations and how long they run for.",
  columns: [col("label", "Status"), n("delegations", "Delegations"), n("avgDays", "Average length (days)"), n("withoutEnd", "With no end date")],
  sql: (q) => `
    SELECT ${LABEL("d.status")} AS label, COUNT(*)::int AS delegations, ROUND(AVG(d.valid_to - d.valid_from), 1) AS "avgDays", COUNT(*) FILTER (WHERE d.valid_to IS NULL)::int AS "withoutEnd"
      FROM delegations d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY d.status ORDER BY delegations DESC, label`,
};

// ---------------------------------------------------------------- service levels and escalations

const SLA_FROM = `workflow_step_instances si
      JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
      JOIN workflow_template_steps ts ON ts.template_id = wi.template_id AND ts.step_order = si.step_order AND ts.sla_hours IS NOT NULL
      LEFT JOIN workflow_templates wt ON wt.id = wi.template_id
      JOIN LATERAL (SELECT ${HOURS("COALESCE(MAX(a.decided_at), now())", "MIN(a.created_at)")} AS hours FROM workflow_step_approvals a WHERE a.step_instance_id = si.id HAVING COUNT(a.id) > 0) m ON TRUE`;
const SLA_W = (q: Q) => `${q.co("wi")} AND si.status IN ('pending', 'approved', 'rejected', 'returned') AND si.created_at::date BETWEEN ${q.from} AND ${q.to}`;
const SLA_MONTH: ReportSectionSpec = {
  key: "sla-by-month",
  title: "Service level by month",
  description: "Steps measured against their allowed hours each month and how many went over.",
  columns: [col("month", "Month"), n("steps", "Steps measured"), n("breached", "Over the limit"), pc("rate", "Over the limit (%)"), n("average", "Average hours")],
  sql: (q) => `
    SELECT ${MONTH_OF("si.created_at")} AS month, COUNT(*)::int AS steps, COUNT(*) FILTER (WHERE m.hours > ts.sla_hours)::int AS breached, ROUND(COUNT(*) FILTER (WHERE m.hours > ts.sla_hours) * 100.0 / COUNT(*), 1) AS rate, ROUND(AVG(m.hours)::numeric, 1) AS average
      FROM ${SLA_FROM} WHERE ${SLA_W(q)} GROUP BY 1 ORDER BY 1`,
};
const SLA_REQUESTS: ReportSectionSpec = {
  key: "sla-breaches",
  title: "Steps that went over their limit",
  description: "Each step that exceeded its allowed hours, longest first.",
  columns: [col("workflow", "Workflow"), col("request", "Request"), col("step", "Step"), n("limit", "Allowed (hours)"), n("took", "Took (hours)"), n("over", "Over by (hours)"), col("status", "Step status")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, COALESCE(NULLIF(wi.title, ''), ${OBJ}) AS request, si.name AS step, ts.sla_hours AS "limit", ROUND(m.hours::numeric, 1) AS took, ROUND((m.hours - ts.sla_hours)::numeric, 1) AS over, ${LABEL("si.status")} AS status
      FROM ${SLA_FROM} WHERE ${SLA_W(q)} AND m.hours > ts.sla_hours ORDER BY over DESC, workflow LIMIT 500`,
};
const SLA_COVERAGE: ReportSectionSpec = {
  key: "sla-coverage",
  title: "Which steps have a time limit",
  description: "Active templates and how many of their steps carry an allowed time. Steps without one are never reported as late.",
  columns: [col("template", "Template"), n("steps", "Steps"), n("withLimit", "With a time limit"), n("withReminder", "With a reminder")],
  sql: (q) => `
    SELECT wt.name AS template, COUNT(s.id)::int AS steps, COUNT(s.id) FILTER (WHERE s.sla_hours IS NOT NULL)::int AS "withLimit", COUNT(s.id) FILTER (WHERE s.reminder_hours IS NOT NULL)::int AS "withReminder"
      FROM workflow_templates wt LEFT JOIN workflow_template_steps s ON s.template_id = wt.id WHERE ${q.co("wt")} AND wt.is_active GROUP BY wt.id ORDER BY steps DESC, template`,
};
const ESC = (q: Q) => `${q.co("wi")} AND a.escalated_at IS NOT NULL AND a.escalated_at::date BETWEEN ${q.from} AND ${q.to}`;
const ESC_BY_WORKFLOW: ReportSectionSpec = {
  key: "escalations-by-workflow",
  title: "Escalations by workflow and step",
  description: "Where approvals are escalated and what happened to them afterwards.",
  columns: [col("workflow", "Workflow"), col("step", "Step"), n("escalations", "Escalations"), n("approved", "Approved afterwards"), n("rejected", "Rejected afterwards"), n("waiting", "Still waiting")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, si.name AS step, COUNT(*)::int AS escalations, COUNT(*) FILTER (WHERE a.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE a.status IN ('pending', 'escalated'))::int AS waiting
      FROM ${APPROVALS} ${WF_JOIN} WHERE ${ESC(q)} GROUP BY 1, si.name, si.step_order ORDER BY escalations DESC, workflow, si.step_order`,
};
const ESC_MONTH: ReportSectionSpec = {
  key: "escalations-by-month",
  title: "Escalations by month",
  description: "Escalations each month and the average time from the approval becoming active to its escalation.",
  columns: [col("month", "Month"), n("escalations", "Escalations"), n("avgHours", "Average hours before escalation")],
  sql: (q) => `
    SELECT ${MONTH_OF("a.escalated_at")} AS month, COUNT(*)::int AS escalations, ROUND(AVG(${HOURS("a.escalated_at", "a.created_at")})::numeric, 1) AS "avgHours" FROM ${APPROVALS} WHERE ${ESC(q)} GROUP BY 1 ORDER BY 1`,
};
const ESC_BY_APPROVER: ReportSectionSpec = {
  key: "escalations-by-approver",
  title: "Approvers whose approvals were escalated",
  description: "Who the approvals were originally addressed to when they had to be escalated.",
  columns: [col("approver", "Original approver"), n("escalations", "Escalations"), n("stillWaiting", "Still waiting")],
  sql: (q) => `
    SELECT ${APPROVER} AS approver, COUNT(*)::int AS escalations, COUNT(*) FILTER (WHERE a.status IN ('pending', 'escalated'))::int AS "stillWaiting"
      FROM ${APPROVALS} ${APPROVER_JOIN} WHERE ${ESC(q)} GROUP BY a.user_account_id, a.role_id, a.approver_type, ro.name, pe.id, pe.first_name, pe.last_name ORDER BY escalations DESC, approver`,
};

// ---------------------------------------------------------------- approvers

const BY_UNIT_WORKFLOW: ReportSectionSpec = {
  key: "unit-by-workflow",
  title: "Approver's unit by workflow",
  description: "Approvals addressed to each unit, split by workflow.",
  columns: [col("unit", "Approver's organisation unit"), col("workflow", "Workflow"), n("assigned", "Assigned"), n("decided", "Decided"), n("waiting", "Waiting now")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not tied to a person') AS unit, ${WORKFLOW} AS workflow, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.decided_at IS NOT NULL)::int AS decided, COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting
      FROM ${APPROVALS} ${APPROVER_JOIN} ${WF_JOIN} LEFT JOIN org_units ou ON ou.id = pe.org_unit_id
     WHERE ${q.co("wi")} AND ${A_CREATED(q)} AND ${q.dim(DEPT, "pe.org_unit_id")} GROUP BY ou.id, ou.name, 2 ORDER BY unit, assigned DESC`,
};
const BY_UNIT_MONTH: ReportSectionSpec = {
  key: "unit-by-month",
  title: "Approver's unit by month",
  description: "Approvals assigned to each unit and the average time to decide, month by month.",
  columns: [col("month", "Month"), col("unit", "Approver's organisation unit"), n("assigned", "Assigned"), n("decided", "Decided"), n("average", "Average to decide (hours)")],
  sql: (q) => `
    SELECT ${MONTH_OF("a.created_at")} AS month, COALESCE(ou.name, 'Not tied to a person') AS unit, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.decided_at IS NOT NULL)::int AS decided,
           ROUND((AVG(${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average
      FROM ${APPROVALS} ${APPROVER_JOIN} LEFT JOIN org_units ou ON ou.id = pe.org_unit_id
     WHERE ${q.co("wi")} AND ${A_CREATED(q)} AND ${q.dim(DEPT, "pe.org_unit_id")} GROUP BY 1, ou.id, ou.name ORDER BY 1, unit`,
};
const BY_UNIT_AGE: ReportSectionSpec = {
  key: "unit-waiting-age",
  title: "How long approvals have waited, by approver's unit",
  description: "Open approvals addressed to each unit and their age.",
  columns: [col("unit", "Approver's organisation unit"), n("waiting", "Waiting now"), n("oldest", "Oldest (days)"), n("average", "Average wait (days)")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not tied to a person') AS unit, COUNT(*)::int AS waiting, MAX(${q.today} - a.created_at::date)::int AS oldest, ROUND(AVG(${q.today} - a.created_at::date), 1) AS average
      FROM ${APPROVALS} ${APPROVER_JOIN} LEFT JOIN org_units ou ON ou.id = pe.org_unit_id WHERE ${q.co("wi")} AND ${OPEN} AND ${q.dim(DEPT, "pe.org_unit_id")} GROUP BY ou.id, ou.name ORDER BY waiting DESC, unit`,
};
const MGR_MONTH: ReportSectionSpec = {
  key: "manager-by-month",
  title: "Manager approvals by month",
  description: "Approvals addressed to managers each month: assigned, approved, rejected and average speed.",
  columns: [col("month", "Month"), n("assigned", "Assigned"), n("approved", "Approved"), n("rejected", "Rejected"), n("waiting", "Waiting now"), n("average", "Average to decide (hours)")],
  sql: (q) => `
    SELECT ${MONTH_OF("a.created_at")} AS month, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting, ROUND((AVG(${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average
      FROM ${APPROVALS} WHERE ${q.co("wi")} AND a.approver_type IN ('manager_of_submitter', 'dotted_line_manager', 'org_unit_head') AND ${A_CREATED(q)} GROUP BY 1 ORDER BY 1`,
};
const MGR_WORKFLOW: ReportSectionSpec = {
  key: "manager-by-workflow",
  title: "Manager approvals by workflow",
  description: "Each manager's approvals in each workflow.",
  columns: [col("manager", "Manager"), col("workflow", "Workflow"), n("assigned", "Assigned"), n("approved", "Approved"), n("rejected", "Rejected"), n("waiting", "Waiting now")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("pe")}, ''), 'Unknown') AS manager, ${WORKFLOW} AS workflow, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting
      FROM ${APPROVALS} ${APPROVER_JOIN} ${WF_JOIN}
     WHERE ${q.co("wi")} AND a.approver_type IN ('manager_of_submitter', 'dotted_line_manager', 'org_unit_head') AND ${A_CREATED(q)} GROUP BY a.user_account_id, pe.id, pe.first_name, pe.last_name, 2 ORDER BY manager, assigned DESC`,
};
const MGR_RELATION: ReportSectionSpec = {
  key: "manager-by-relationship",
  title: "Approvals by kind of manager",
  description: "Line managers, dotted-line managers and unit heads compared.",
  columns: [col("label", "Approver is the submitter's"), n("assigned", "Assigned"), n("decided", "Decided"), n("waiting", "Waiting now"), n("average", "Average to decide (hours)")],
  sql: (q) => `
    SELECT ${LABEL("a.approver_type")} AS label, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.decided_at IS NOT NULL)::int AS decided, COUNT(*) FILTER (WHERE ${OPEN})::int AS waiting,
           ROUND((AVG(${HOURS("a.decided_at", "a.created_at")}) FILTER (WHERE a.decided_at IS NOT NULL))::numeric, 1) AS average
      FROM ${APPROVALS} WHERE ${q.co("wi")} AND a.approver_type IN ('manager_of_submitter', 'dotted_line_manager', 'org_unit_head') AND ${A_CREATED(q)} GROUP BY a.approver_type ORDER BY assigned DESC, label`,
};

// ---------------------------------------------------------------- templates

const TEMPLATE_STEPS: ReportSectionSpec = {
  key: "template-steps",
  title: "Template steps",
  description: "Every step of every template: order, how approval is reached, the quorum, the time limit and reminder.",
  columns: [col("template", "Template"), col("active", "Active"), n("order", "Step"), col("step", "Step name"), col("mode", "Approval mode"), n("quorum", "Approvals needed"), n("sla", "Allowed (hours)"), n("reminder", "Reminder after (hours)"), col("rejectComment", "Comment required on reject")],
  sql: (q) => `
    SELECT wt.name AS template, CASE WHEN wt.is_active THEN 'Yes' ELSE 'No' END AS active, s.step_order AS "order", s.name AS step, ${LABEL("COALESCE(s.approval_mode, 'any')")} AS mode, s.quorum_count AS quorum, s.sla_hours AS sla,
           s.reminder_hours AS reminder, CASE WHEN s.require_comment_on_reject THEN 'Yes' ELSE 'No' END AS "rejectComment"
      FROM workflow_templates wt JOIN workflow_template_steps s ON s.template_id = wt.id WHERE ${q.co("wt")} ORDER BY wt.name, s.step_order`,
};
const TEMPLATE_UNUSED: ReportSectionSpec = {
  key: "unused-templates",
  title: "Templates not used in the period",
  description: "Templates that no request used in the period, and when each was last used.",
  columns: [col("template", "Template"), col("object", "Applies to"), col("active", "Active"), col("last", "Last used", "date")],
  sql: (q) => `
    SELECT wt.name AS template, ${LABEL("wt.object_key")} AS object, CASE WHEN wt.is_active THEN 'Yes' ELSE 'No' END AS active, (SELECT MAX(wi.created_at)::date::text FROM workflow_instances wi WHERE wi.template_id = wt.id AND wi.company_id = wt.company_id) AS last
      FROM workflow_templates wt WHERE ${q.co("wt")} AND NOT EXISTS (SELECT 1 FROM workflow_instances wi WHERE wi.template_id = wt.id AND wi.company_id = wt.company_id AND wi.created_at::date BETWEEN ${q.from} AND ${q.to}) ORDER BY wt.name`,
};
const TEMPLATE_BY_MONTH: ReportSectionSpec = {
  key: "template-use-by-month",
  title: "Template use by month",
  description: "Requests started from each template in each month.",
  columns: [col("month", "Month"), col("template", "Template"), n("requests", "Requests"), n("approved", "Approved"), n("rejected", "Rejected")],
  sql: (q) => `
    SELECT ${MONTH_OF("wi.created_at")} AS month, ${WORKFLOW} AS template, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE wi.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE wi.status = 'rejected')::int AS rejected
      FROM workflow_instances wi ${WF_JOIN} WHERE ${q.co("wi")} AND ${CREATED(q)} GROUP BY 1, 2 ORDER BY 1, requests DESC, template`,
};
const TEMPLATE_BY_OBJECT: ReportSectionSpec = {
  key: "templates-by-object",
  title: "Templates by what they apply to",
  description: "How many templates exist for each kind of record and how many requests they handled.",
  columns: [col("label", "Applies to"), n("templates", "Templates"), n("active", "Active templates"), n("requests", "Requests in the period")],
  sql: (q) => `
    SELECT ${LABEL("wt.object_key")} AS label, COUNT(DISTINCT wt.id)::int AS templates, COUNT(DISTINCT wt.id) FILTER (WHERE wt.is_active)::int AS active,
           COUNT(wi.id) FILTER (WHERE wi.created_at::date BETWEEN ${q.from} AND ${q.to})::int AS requests
      FROM workflow_templates wt LEFT JOIN workflow_instances wi ON wi.template_id = wt.id AND wi.company_id = wt.company_id WHERE ${q.co("wt")} GROUP BY wt.object_key ORDER BY requests DESC, label`,
};

// ---------------------------------------------------------------- stuck requests (no range)

const STUCK_BY_WORKFLOW: ReportSectionSpec = {
  key: "stuck-by-workflow",
  title: "Stuck requests by workflow and status",
  description: "Open requests that have not moved, on hold or returned, by workflow.",
  columns: [col("workflow", "Workflow"), n("inProgress", "In progress, not moving"), n("onHold", "On hold"), n("returned", "Returned"), n("oldest", "Longest without movement (days)")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, COUNT(*) FILTER (WHERE wi.status = 'in_progress')::int AS "inProgress", COUNT(*) FILTER (WHERE wi.status = 'on_hold')::int AS "onHold", COUNT(*) FILTER (WHERE wi.status = 'returned')::int AS returned,
           MAX(${q.today} - wi.updated_at::date)::int AS oldest
      FROM workflow_instances wi ${WF_JOIN} WHERE ${q.co("wi")} AND ((wi.status = 'in_progress' AND (${q.today} - wi.updated_at::date) >= 7) OR wi.status IN ('on_hold', 'returned')) GROUP BY 1 ORDER BY oldest DESC NULLS LAST, workflow`,
};
const STUCK_BANDS: ReportSectionSpec = {
  key: "stuck-age",
  title: "How long requests have been stuck",
  description: "Stuck requests grouped by days without movement.",
  columns: [col("label", "Without movement for"), n("requests", "Requests")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS requests
      FROM (SELECT CASE WHEN d < 14 THEN '0 Under two weeks' WHEN d < 30 THEN '1 Two to four weeks' WHEN d < 90 THEN '2 One to three months' ELSE '3 Over three months' END AS band
              FROM (SELECT (${q.today} - wi.updated_at::date) AS d FROM workflow_instances wi WHERE ${q.co("wi")} AND ((wi.status = 'in_progress' AND (${q.today} - wi.updated_at::date) >= 7) OR wi.status IN ('on_hold', 'returned'))) x) b
     GROUP BY b.band ORDER BY b.band`,
};
const STUCK_BY_STEP: ReportSectionSpec = {
  key: "stuck-by-step",
  title: "Stuck requests by current step",
  description: "The step each stuck request is sitting at.",
  columns: [col("workflow", "Workflow"), col("step", "Current step"), n("requests", "Requests"), n("oldest", "Longest without movement (days)")],
  sql: (q) => `
    SELECT ${WORKFLOW} AS workflow, COALESCE(cs.name, 'None open') AS step, COUNT(*)::int AS requests, MAX(${q.today} - wi.updated_at::date)::int AS oldest
      FROM workflow_instances wi ${WF_JOIN}
      LEFT JOIN LATERAL (SELECT si.name FROM workflow_step_instances si WHERE si.workflow_instance_id = wi.id AND si.status IN ('pending', 'returned') ORDER BY si.step_order LIMIT 1) cs ON TRUE
     WHERE ${q.co("wi")} AND ((wi.status = 'in_progress' AND (${q.today} - wi.updated_at::date) >= 7) OR wi.status IN ('on_hold', 'returned')) GROUP BY 1, 2 ORDER BY requests DESC, workflow, step`,
};
const STUCK_WAITING_ON: ReportSectionSpec = {
  key: "stuck-waiting-on",
  title: "Who stuck requests are waiting on",
  description: "Approvers holding the stuck requests.",
  columns: [col("approver", "Waiting on"), n("requests", "Stuck requests"), n("oldest", "Longest without movement (days)")],
  sql: (q) => `
    SELECT ${APPROVER} AS approver, COUNT(DISTINCT wi.id)::int AS requests, MAX(${q.today} - wi.updated_at::date)::int AS oldest
      FROM ${APPROVALS} ${APPROVER_JOIN} WHERE ${q.co("wi")} AND a.status IN ('pending', 'escalated') AND wi.status = 'in_progress' AND (${q.today} - wi.updated_at::date) >= 7
     GROUP BY a.user_account_id, a.role_id, a.approver_type, ro.name, pe.id, pe.first_name, pe.last_name ORDER BY requests DESC, approver`,
};

// ---------------------------------------------------------------- background jobs (H11)

const JOB_TYPES: ReportSectionSpec = {
  key: "jobs-by-type",
  title: "Jobs by type",
  description: "All background jobs in the period by type: how many ran, failed, gave up and how long they took.",
  columns: [col("label", "Job"), n("jobs", "Jobs"), n("done", "Completed"), n("failed", "Failed"), n("gaveUp", "Gave up"), n("avgSeconds", "Average seconds to finish")],
  sql: (q) => `
    SELECT j.job_type AS label, COUNT(*)::int AS jobs, COUNT(*) FILTER (WHERE j.status IN ('completed', 'succeeded', 'done'))::int AS done, COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE j.dead_lettered)::int AS "gaveUp", ROUND((AVG(EXTRACT(EPOCH FROM (j.finished_at - j.started_at))) FILTER (WHERE j.finished_at IS NOT NULL AND j.started_at IS NOT NULL))::numeric, 1) AS "avgSeconds"
      FROM background_jobs j WHERE ${q.co("j")} AND j.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY j.job_type ORDER BY failed DESC, jobs DESC, label`,
};
const JOB_DAY: ReportSectionSpec = {
  key: "jobs-by-day",
  title: "Failed jobs by day",
  description: "Jobs created and failed each day, to show whether failures cluster around an incident.",
  columns: [col("day", "Day", "date"), n("jobs", "Jobs"), n("failed", "Failed"), n("gaveUp", "Gave up")],
  sql: (q) => `
    SELECT j.created_at::date::text AS day, COUNT(*)::int AS jobs, COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE j.dead_lettered)::int AS "gaveUp"
      FROM background_jobs j WHERE ${q.co("j")} AND j.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1 DESC`,
};
const JOB_STATUS: ReportSectionSpec = {
  key: "jobs-by-status",
  title: "Jobs by status",
  description: "Every job status in the period with the average number of attempts.",
  columns: [col("label", "Status"), n("jobs", "Jobs"), n("avgAttempts", "Average attempts"), n("maxAttempts", "Most attempts")],
  sql: (q) => `
    SELECT ${LABEL("j.status")} AS label, COUNT(*)::int AS jobs, ROUND(AVG(j.attempts), 1) AS "avgAttempts", MAX(j.attempts)::int AS "maxAttempts"
      FROM background_jobs j WHERE ${q.co("j")} AND j.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY j.status ORDER BY jobs DESC, label`,
};
const JOB_ERRORS: ReportSectionSpec = {
  key: "job-errors",
  title: "Most common errors",
  description: "The first line of the error text for failed jobs, grouped so a repeating cause stands out.",
  columns: [col("error", "Error"), col("job", "Job"), n("jobs", "Jobs"), col("last", "Last seen", "date")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(LEFT(split_part(j.last_error, E'\\n', 1), 160), ''), 'No error text') AS error, j.job_type AS job, COUNT(*)::int AS jobs, MAX(j.created_at)::date::text AS last
      FROM background_jobs j WHERE ${q.co("j")} AND (j.status = 'failed' OR j.dead_lettered) AND j.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1, 2 ORDER BY jobs DESC, error`,
};

export const WORKFLOW_DEPTH: Record<string, ReportSectionSpec[]> = {
  H01: [OPEN_LIST, OPEN_BY_STEP, OPEN_BY_PRIORITY, OPEN_AGE_MATRIX, OPEN_BY_APPROVER_TYPE, OPEN_ESCALATED],
  H02: [OPEN_AGE_MATRIX, OPEN_OVERDUE, OPEN_LIST, OPEN_BY_STEP, OPEN_BY_PRIORITY],
  H03: [TURNAROUND_MONTH, TURNAROUND_BANDS, TURNAROUND_PRIORITY, STEP_TIME_BANDS, SLOWEST],
  H04: [OUTCOME_MONTH, OUTCOME_PRIORITY, REJECT_WORKFLOW, STILL_OPEN_BY_WORKFLOW, RETURNED],
  H05: [REJECT_BY_STEP, REJECT_MONTH, REJECT_BY_APPROVER, REJECT_WORKFLOW],
  H06: [DELEGATIONS, DELEGATION_MONTH, DELEGATED_OUTCOME, DELEGATION_STATUS],
  H07: [SLA_MONTH, SLA_REQUESTS, SLA_COVERAGE, TURNAROUND_BANDS],
  H08: [STEP_TIME_MONTH, STEP_TIME_BANDS, WAITING_NOW_BY_STEP, SLA_MONTH],
  H09: [BY_UNIT_WORKFLOW, BY_UNIT_MONTH, BY_UNIT_AGE],
  H10: [MGR_MONTH, MGR_WORKFLOW, MGR_RELATION, STEP_TIME_BANDS],
  H11: [JOB_TYPES, JOB_DAY, JOB_STATUS, JOB_ERRORS],
  H12: [ESC_BY_WORKFLOW, ESC_MONTH, ESC_BY_APPROVER, OPEN_ESCALATED],
  H13: [TEMPLATE_STEPS, TEMPLATE_BY_MONTH, TEMPLATE_BY_OBJECT, TEMPLATE_UNUSED, SLA_COVERAGE],
  H14: [OPEN_BY_APPROVER_WORKFLOW, OPEN_BY_APPROVER_TYPE, OPEN_LIST, OPEN_AGE_MATRIX],
  H15: [STUCK_BY_WORKFLOW, STUCK_BANDS, STUCK_BY_STEP, STUCK_WAITING_ON],
};
