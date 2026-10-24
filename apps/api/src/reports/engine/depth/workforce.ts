import type { ReportSectionSpec } from "../report-spec";
import { DATA_QUALITY_FIELD_ROWS } from "../executors/workforce-people";
import { DEPT } from "../report-spec";
import {
  HEADCOUNT_BY_UNIT_MONTHLY,
  IDENT,
  JOINERS_IN_PERIOD,
  LABEL,
  LEAVERS_IN_PERIOD,
  LEAVING_REASONS,
  MOVEMENT,
  MOVEMENT_BY_UNIT,
  NAME,
  ORG_JOINS,
  TENURE_BANDS,
  byLocation,
  byManager,
  byPosition,
  byType,
  byUnit,
  col,
  employeeRecords,
  headcountBy,
  monthSeries,
  tenureYears,
} from "./common";

/** Extra tables for the workforce and organisation reports (A, B, M). */

const OPEN_POSITION = "p.status NOT IN ('abolished', 'rejected', 'pending_approval')";
const ACTIVE_INCUMBENT = (a: string, today: string) => `${a}.status = 'active' AND ${a}.effective_from <= ${today} AND (${a}.effective_to IS NULL OR ${a}.effective_to >= ${today})`;
const ROSTER = employeeRecords("employees", "Employee records", "Every current employee behind the figures: unit, position, location, type, joining date, years of service and manager.");
const SUBGROUP = headcountBy("by-subgroup", "By employee subgroup", "Current employees in each subgroup.", "Employee subgroup", "sg.name", { from: `${ORG_JOINS} LEFT JOIN employee_subgroups sg ON sg.id = e.employee_subgroup_id` });
const RECENT_JOINERS = (days: number): ReportSectionSpec => ({
  ...employeeRecords("recent-joiners", `Joined in the last ${days} days`, `Everyone who joined in the last ${days} days.`, { where: (q) => `e.date_of_joining > ${q.today} - ${days} AND e.date_of_joining <= ${q.today}`, order: "e.date_of_joining DESC, name" }),
});
const RECENT_LEAVERS = (days: number): ReportSectionSpec => ({
  ...LEAVERS_IN_PERIOD,
  key: "recent-leavers",
  title: `Left in the last ${days} days`,
  description: `Everyone who left in the last ${days} days, with the reason recorded.`,
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, e.termination_date::text AS "left", COALESCE(NULLIF(e.termination_reason, ''), 'Not recorded') AS reason, ${tenureYears(q)} AS tenure,
           COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position, ${LABEL("e.employment_type")} AS type
      FROM employees e ${ORG_JOINS}
     WHERE ${q.emp()} AND e.termination_date > ${q.today} - ${days} AND e.termination_date <= ${q.today}
     ORDER BY e.termination_date DESC, name`,
});

const STATUS_LIST: ReportSectionSpec = employeeRecords("all-statuses", "Every employee by status", "All employees in scope, working and left, with their status.", { currentOnly: false, order: "e.employment_status, name" });
const BY_STATUS: ReportSectionSpec = {
  key: "by-status-unit",
  title: "Status by organisation unit",
  description: "For each unit, how many people are working and how many have left, by employment status.",
  columns: [col("label", "Organisation unit"), col("status", "Employment status"), col("employees", "Employees", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, ${LABEL("e.employment_status")} AS status, COUNT(*)::int AS employees
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()}
     GROUP BY ou.name, e.employment_status ORDER BY label, employees DESC`,
};

// ---------------------------------------------------------------- A. executive overview

const A_UNIT_SCORECARD: ReportSectionSpec = {
  key: "scorecard-by-unit",
  title: "Scorecard by organisation unit",
  description: "For each unit: headcount, joiners and leavers in the last 30 days, leavers in the last 12 months and average years of service.",
  columns: [col("label", "Organisation unit"), col("headcount", "Headcount", "number"), col("joined30", "Joined, last 30 days", "number"), col("left30", "Left, last 30 days", "number"), col("left12", "Left, last 12 months", "number"), col("attrition", "12-month attrition (%)", "percent"), col("tenure", "Average years of service", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*) FILTER (WHERE ${q.current()})::int AS headcount,
           COUNT(*) FILTER (WHERE e.date_of_joining > ${q.today} - 30 AND e.date_of_joining <= ${q.today})::int AS joined30,
           COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 30 AND e.termination_date <= ${q.today})::int AS left30,
           COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 365 AND e.termination_date <= ${q.today})::int AS left12,
           ROUND(COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 365 AND e.termination_date <= ${q.today}) * 100.0
                 / NULLIF((COUNT(*) FILTER (WHERE ${q.current()}) + COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 365 AND e.termination_date <= ${q.today})) / 2.0, 0), 1) AS attrition,
           ROUND(AVG(CASE WHEN ${q.current()} THEN ${tenureYears(q)} END), 1) AS tenure
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()}
     GROUP BY ou.name HAVING COUNT(*) FILTER (WHERE ${q.current()}) > 0 OR COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 365) > 0
     ORDER BY headcount DESC, label`,
};

const MANAGER_TEAMS: ReportSectionSpec = {
  key: "teams",
  title: "Who reports to whom",
  description: "Every current employee with the manager they report to on the active direct reporting line.",
  columns: [col("manager", "Manager"), col("managerNumber", "Manager number"), ...IDENT, col("unit", "Organisation unit"), col("position", "Position")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("m")}, ''), 'No manager on record') AS manager, m.employee_number AS "managerNumber", e.employee_number AS number, ${NAME("e")} AS name,
           COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position
      FROM employees e
      LEFT JOIN org_relationships r ON r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active'
      LEFT JOIN employees m ON m.id = r.manager_employee_id AND m.company_id = e.company_id
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN positions p ON p.id = e.position_id
     WHERE ${q.emp()} AND ${q.current()}
     ORDER BY manager, name`,
};
const SPAN_BANDS: ReportSectionSpec = {
  key: "span-bands",
  title: "Team size bands",
  description: "How many managers lead teams of each size.",
  columns: [col("label", "Direct reports"), col("managers", "Managers", "number"), col("people", "People managed", "number")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS managers, SUM(b.n)::int AS people
      FROM (SELECT CASE WHEN n = 1 THEN '1 (1)' WHEN n <= 3 THEN '2 to 3 (2)' WHEN n <= 6 THEN '4 to 6 (3)' WHEN n <= 10 THEN '7 to 10 (4)' ELSE 'More than 10 (5)' END AS label, n
              FROM (SELECT r.manager_employee_id, COUNT(*) AS n FROM org_relationships r JOIN employees e ON e.id = r.employee_id AND e.company_id = r.company_id
                     WHERE ${q.emp()} AND ${q.current()} AND r.relationship_type = 'direct' AND r.status = 'active' GROUP BY r.manager_employee_id) t) b
     GROUP BY b.label ORDER BY b.label`,
};

const LIFECYCLE_EVENTS: ReportSectionSpec = {
  key: "events",
  title: "Lifecycle events",
  description: "Every applied hire, transfer, promotion, termination and other event whose effective date falls in the period.",
  columns: [col("effective", "Effective", "date"), ...IDENT, col("event", "Event"), col("reason", "Reason"), col("source", "Entered through"), col("unit", "Organisation unit")],
  sql: (q) => `
    SELECT ev.effective_date::text AS effective, e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("ev.action_type")} AS event, COALESCE(NULLIF(ev.reason_code, ''), 'Not recorded') AS reason,
           ${LABEL("COALESCE(ev.source_channel, 'manual')")} AS source, COALESCE(ou.name, 'Not set') AS unit
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
     ORDER BY ev.effective_date DESC, name`,
};
const EVENTS_BY_MONTH: ReportSectionSpec = {
  key: "events-by-month",
  title: "Events by month",
  description: "Applied lifecycle events in each month, by kind.",
  columns: [col("month", "Month"), col("event", "Event"), col("events", "Events", "number")],
  sql: (q) => `
    SELECT to_char(ev.effective_date, 'YYYY-MM') AS month, ${LABEL("ev.action_type")} AS event, COUNT(*)::int AS events
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY 1, ev.action_type ORDER BY 1, events DESC`,
};
const EVENTS_BY_UNIT: ReportSectionSpec = {
  key: "events-by-unit",
  title: "Events by organisation unit",
  description: "Applied lifecycle events for each unit, by kind.",
  columns: [col("label", "Organisation unit"), col("event", "Event"), col("events", "Events", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, ${LABEL("ev.action_type")} AS event, COUNT(*)::int AS events
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY ou.name, ev.action_type ORDER BY label, events DESC`,
};
const PENDING_EVENTS: ReportSectionSpec = {
  key: "pending-events",
  title: "Scheduled and failed lifecycle events",
  description: "Future-dated events waiting to be applied and events that failed, with the reason.",
  columns: [col("effective", "Effective", "date"), ...IDENT, col("event", "Event"), col("status", "Status"), col("failure", "Failure reason")],
  sql: (q) => `
    SELECT ev.effective_date::text AS effective, e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("ev.action_type")} AS event, ${LABEL("ev.status")} AS status, ev.failure_reason AS failure
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
     WHERE ${q.emp()} AND ev.status IN ('scheduled', 'failed') ORDER BY ev.effective_date, name`,
};

const HR_OPS_ONBOARDING: ReportSectionSpec = {
  key: "onboarding-open",
  title: "Onboarding in progress",
  description: "New hires whose onboarding checklist is not complete, with how far they have got.",
  columns: [...IDENT, col("joined", "Joined", "date"), col("done", "Tasks done", "number"), col("total", "Tasks", "number"), col("overdue", "Overdue tasks", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, e.date_of_joining::text AS joined,
           COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done, COUNT(i.id)::int AS total,
           COUNT(i.id) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue
      FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id LEFT JOIN employee_onboarding_items i ON i.onboarding_id = o.id
     WHERE ${q.emp()} AND o.status = 'in_progress' GROUP BY e.id ORDER BY overdue DESC, name`,
};
const HR_OPS_OVERDUE_TASKS: ReportSectionSpec = {
  key: "onboarding-overdue",
  title: "Overdue onboarding tasks",
  description: "Pending onboarding tasks past their due date.",
  columns: [...IDENT, col("task", "Task"), col("due", "Due", "date"), col("late", "Days late", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, i.title AS task, i.due_date::text AS due, (${q.today} - i.due_date)::int AS late
      FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id
     WHERE ${q.emp()} AND i.status = 'pending' AND i.due_date < ${q.today} ORDER BY late DESC, name`,
};
const HR_OPS_OFFBOARDING: ReportSectionSpec = {
  key: "offboarding-open",
  title: "Offboarding in progress",
  description: "Leavers whose exit checklist is not complete, with the exit interview status.",
  columns: [...IDENT, col("left", "Left on", "date"), col("status", "Checklist"), col("interview", "Exit interview")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, e.termination_date::text AS "left", ${LABEL("f.status")} AS status, ${LABEL("COALESCE(f.exit_interview_status, 'not_set')")} AS interview
      FROM employee_offboarding f JOIN employees e ON e.id = f.employee_id AND e.company_id = f.company_id
     WHERE ${q.emp()} AND f.status = 'in_progress' ORDER BY e.termination_date NULLS LAST, name`,
};
const PROBATION_NOW: ReportSectionSpec = {
  key: "on-probation",
  title: "Employees in probation",
  description: "Current employees whose probation end date has not passed.",
  columns: [...IDENT, col("ends", "Probation ends", "date"), col("days", "Days left", "number"), col("unit", "Organisation unit")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, d.date_value::text AS ends, (d.date_value - ${q.today})::int AS days, COALESCE(ou.name, 'Not set') AS unit
      FROM employees e JOIN employee_important_dates d ON d.employee_id = e.id AND d.company_id = e.company_id AND d.date_type = 'probation_end' AND d.status = 'active' AND d.date_value >= ${q.today}
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} ORDER BY d.date_value, name`,
};

const MISSING_FIELDS: ReportSectionSpec = {
  key: "missing-by-employee",
  title: "Employees with missing fields",
  description: "Each current employee who has at least one of the checked fields empty, with the fields named. Values are never shown.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("missing", "Missing fields"), col("count", "Fields missing", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,
           STRING_AGG(v.field, ', ' ORDER BY v.ord) FILTER (WHERE NOT v.ok) AS missing, COUNT(*) FILTER (WHERE NOT v.ok)::int AS count
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     CROSS JOIN LATERAL (VALUES
${DATA_QUALITY_FIELD_ROWS}
     ) AS v(ord, field, ok)
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY e.id, ou.name HAVING COUNT(*) FILTER (WHERE NOT v.ok) > 0 ORDER BY count DESC, name`,
};
const COMPLETENESS_BY_UNIT: ReportSectionSpec = {
  key: "completeness-by-unit",
  title: "Completeness by organisation unit",
  description: "For each unit, the share of the checked fields that are filled in.",
  columns: [col("label", "Organisation unit"), col("employees", "Employees", "number"), col("complete", "Fully complete", "number"), col("score", "Average completeness (%)", "percent")],
  sql: (q) => `
    SELECT t.label, COUNT(*)::int AS employees, COUNT(*) FILTER (WHERE t.score = 100)::int AS complete, ROUND(AVG(t.score), 1) AS score
      FROM (SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*) FILTER (WHERE v.ok) * 100.0 / COUNT(*) AS score
              FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
             CROSS JOIN LATERAL (VALUES
${DATA_QUALITY_FIELD_ROWS}
             ) AS v(ord, field, ok)
             WHERE ${q.emp()} AND ${q.current()} GROUP BY e.id, ou.name) t
     GROUP BY t.label ORDER BY score, label`,
};
const FIELD_BY_UNIT: ReportSectionSpec = {
  key: "field-by-unit",
  title: "Missing fields by organisation unit",
  description: "For each unit and field, how many current employees have it empty.",
  columns: [col("label", "Organisation unit"), col("field", "Field"), col("missing", "Employees missing it", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, v.field, COUNT(*) FILTER (WHERE NOT v.ok)::int AS missing
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     CROSS JOIN LATERAL (VALUES
${DATA_QUALITY_FIELD_ROWS}
     ) AS v(ord, field, ok)
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY ou.name, v.ord, v.field HAVING COUNT(*) FILTER (WHERE NOT v.ok) > 0 ORDER BY label, v.ord`,
};

// ---------------------------------------------------------------- B. employee and organisation

const CHANGES_CTE = (q: { emp: () => string }) => `
  WITH v AS (
    SELECT ev.employee_id, ev.valid_from,
           ev.org_unit_id IS DISTINCT FROM LAG(ev.org_unit_id) OVER w AS c_unit, ev.position_id IS DISTINCT FROM LAG(ev.position_id) OVER w AS c_pos,
           ev.job_id IS DISTINCT FROM LAG(ev.job_id) OVER w AS c_job, ev.location_id IS DISTINCT FROM LAG(ev.location_id) OVER w AS c_loc,
           ev.employee_subgroup_id IS DISTINCT FROM LAG(ev.employee_subgroup_id) OVER w AS c_sub, ev.payroll_area_id IS DISTINCT FROM LAG(ev.payroll_area_id) OVER w AS c_area,
           LAG(ev.valid_from) OVER w IS NOT NULL AS has_prev
      FROM employee_versions ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
     WHERE ${q.emp()}
    WINDOW w AS (PARTITION BY ev.employee_id ORDER BY ev.valid_from, ev.recorded_at))`;
const B02_BY_KIND: ReportSectionSpec = {
  key: "changes-by-kind",
  title: "Changes by kind",
  description: "How many changes of each kind took effect in the period.",
  columns: [col("label", "What changed"), col("changes", "Changes", "number"), col("people", "People", "number")],
  sql: (q) => `${CHANGES_CTE(q)}
    SELECT k.label, COUNT(*)::int AS changes, COUNT(DISTINCT v.employee_id)::int AS people
      FROM v CROSS JOIN LATERAL (VALUES ('Organisation unit', v.c_unit), ('Position', v.c_pos), ('Job', v.c_job), ('Location', v.c_loc), ('Employee subgroup', v.c_sub), ('Payroll area', v.c_area)) AS k(label, hit)
     WHERE v.has_prev AND k.hit AND v.valid_from BETWEEN ${q.from} AND ${q.to}
     GROUP BY k.label ORDER BY changes DESC, k.label`,
};
const B02_BY_MONTH: ReportSectionSpec = {
  key: "changes-by-month",
  title: "Changes by month",
  description: "Changes that took effect in each month of the period.",
  columns: [col("month", "Month"), col("changes", "Changes", "number"), col("people", "People", "number")],
  sql: (q) => `${CHANGES_CTE(q)}
    SELECT to_char(v.valid_from, 'YYYY-MM') AS month, COUNT(*)::int AS changes, COUNT(DISTINCT v.employee_id)::int AS people
      FROM v WHERE v.has_prev AND (v.c_unit OR v.c_pos OR v.c_job OR v.c_loc OR v.c_sub OR v.c_area) AND v.valid_from BETWEEN ${q.from} AND ${q.to}
     GROUP BY 1 ORDER BY 1`,
};
const B02_BY_UNIT: ReportSectionSpec = {
  key: "changes-by-unit",
  title: "Changes by organisation unit",
  description: "Changes in the period grouped by the unit the person sits in now.",
  columns: [col("label", "Organisation unit"), col("changes", "Changes", "number"), col("people", "People", "number")],
  sql: (q) => `${CHANGES_CTE(q)}
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS changes, COUNT(DISTINCT v.employee_id)::int AS people
      FROM v JOIN employees e ON e.id = v.employee_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE v.has_prev AND (v.c_unit OR v.c_pos OR v.c_job OR v.c_loc OR v.c_sub OR v.c_area) AND v.valid_from BETWEEN ${q.from} AND ${q.to}
     GROUP BY ou.name ORDER BY changes DESC, label`,
};
const B02_MOST_CHANGED: ReportSectionSpec = {
  key: "most-changed",
  title: "People with the most changes",
  description: "Employees whose record changed most often in the period.",
  columns: [...IDENT, col("changes", "Changes", "number"), col("last", "Latest change", "date")],
  sql: (q) => `${CHANGES_CTE(q)}
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COUNT(*)::int AS changes, MAX(v.valid_from)::text AS last
      FROM v JOIN employees e ON e.id = v.employee_id
     WHERE v.has_prev AND (v.c_unit OR v.c_pos OR v.c_job OR v.c_loc OR v.c_sub OR v.c_area) AND v.valid_from BETWEEN ${q.from} AND ${q.to}
     GROUP BY e.id ORDER BY changes DESC, name`,
};
const VERSION_HISTORY: ReportSectionSpec = {
  key: "versions",
  title: "Record versions",
  description: "Every dated version of each employee's organisational record in the period: where the person sat from that date.",
  columns: [col("from", "Effective from", "date"), ...IDENT, col("unit", "Organisation unit"), col("position", "Position"), col("location", "Location")],
  sql: (q) => `
    SELECT ev.valid_from::text AS "from", e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, 'Not set') AS position, COALESCE(l.name, 'Not set') AS location
      FROM employee_versions ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
      LEFT JOIN org_units ou ON ou.id = ev.org_unit_id LEFT JOIN positions p ON p.id = ev.position_id LEFT JOIN locations l ON l.id = ev.location_id
     WHERE ${q.emp()} AND ev.valid_from BETWEEN ${q.from} AND ${q.to}
     ORDER BY ev.valid_from DESC, name`,
};

const B03_SCORE_BANDS: ReportSectionSpec = {
  key: "score-bands",
  title: "Employees by completeness band",
  description: "How many current employees fall in each completeness band.",
  columns: [col("label", "Completeness"), col("employees", "Employees", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN s = 100 THEN '100%' WHEN s >= 80 THEN '80 to 99%' WHEN s >= 60 THEN '60 to 79%' ELSE 'Under 60%' END AS label
              FROM (SELECT COUNT(*) FILTER (WHERE v.ok) * 100.0 / COUNT(*) AS s FROM employees e CROSS JOIN LATERAL (VALUES
${DATA_QUALITY_FIELD_ROWS}
                    ) AS v(ord, field, ok) WHERE ${q.emp()} AND ${q.current()} GROUP BY e.id) t) b
     GROUP BY b.label ORDER BY b.label DESC`,
};

const POSITION_RECORDS: ReportSectionSpec = {
  key: "positions",
  title: "Positions",
  description: "Every open position with its unit, approved FTE, FTE filled and who holds it.",
  columns: [col("code", "Code"), col("title", "Position"), col("unit", "Organisation unit"), col("status", "Status"), col("fte", "Approved FTE", "number"), col("filled", "FTE filled", "number"), col("holders", "Held by")],
  sql: (q) => `
    SELECT p.position_code AS code, p.position_title AS title, COALESCE(ou.name, 'No organisation unit') AS unit, ${LABEL("p.status")} AS status, p.headcount_fte AS fte,
           COALESCE((SELECT SUM(pi.fte) FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)}), 0) AS filled,
           (SELECT STRING_AGG(${NAME("he")}, ', ' ORDER BY he.last_name) FROM position_incumbents pi JOIN employees he ON he.id = pi.employee_id WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)}) AS holders
      FROM positions p LEFT JOIN org_units ou ON ou.id = p.org_unit_id
     WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")}
     ORDER BY unit, title`,
};
const POSITIONS_BY_STATUS: ReportSectionSpec = {
  key: "positions-by-status",
  title: "Positions by status",
  description: "Open positions by status, with approved and filled FTE.",
  columns: [col("label", "Status"), col("positions", "Positions", "number"), col("fte", "Approved FTE", "number"), col("filled", "FTE filled", "number")],
  sql: (q) => `
    SELECT ${LABEL("p.status")} AS label, COUNT(*)::int AS positions, ROUND(SUM(p.headcount_fte), 2) AS fte,
           ROUND(SUM(COALESCE((SELECT SUM(pi.fte) FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)}), 0)), 2) AS filled
      FROM positions p WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")} GROUP BY p.status ORDER BY positions DESC, label`,
};
const OVERFILLED: ReportSectionSpec = {
  key: "over-under-filled",
  title: "Positions filled beyond their approved FTE",
  description: "Positions where more FTE is assigned than approved.",
  columns: [col("code", "Code"), col("title", "Position"), col("unit", "Organisation unit"), col("fte", "Approved FTE", "number"), col("filled", "FTE assigned", "number"), col("over", "Over by", "number")],
  sql: (q) => `
    SELECT * FROM (SELECT p.position_code AS code, p.position_title AS title, COALESCE(ou.name, 'No organisation unit') AS unit, p.headcount_fte AS fte,
           COALESCE((SELECT SUM(pi.fte) FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)}), 0) AS filled
      FROM positions p LEFT JOIN org_units ou ON ou.id = p.org_unit_id WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")}) t
     CROSS JOIN LATERAL (SELECT t.filled - t.fte AS over) o WHERE o.over > 0 ORDER BY o.over DESC, title`,
};
const VACANT_BY_UNIT: ReportSectionSpec = {
  key: "vacant-by-unit",
  title: "Vacant positions by organisation unit",
  description: "Positions with nobody in them, grouped by unit.",
  columns: [col("label", "Organisation unit"), col("vacant", "Vacant positions", "number"), col("fte", "Vacant FTE", "number"), col("oldest", "Longest empty (days)", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit') AS label, COUNT(*)::int AS vacant, ROUND(SUM(p.headcount_fte), 2) AS fte,
           MAX(${q.today} - COALESCE((SELECT MAX(pi.effective_to) FROM position_incumbents pi WHERE pi.position_id = p.id), p.created_at::date))::int AS oldest
      FROM positions p LEFT JOIN org_units ou ON ou.id = p.org_unit_id
     WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")} AND NOT EXISTS (SELECT 1 FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)})
     GROUP BY ou.name ORDER BY vacant DESC, label`,
};
const VACANT_AGE_BANDS: ReportSectionSpec = {
  key: "vacant-age",
  title: "How long positions have been empty",
  description: "Vacant positions grouped by how long they have had nobody in them.",
  columns: [col("label", "Empty for"), col("vacant", "Vacant positions", "number"), col("fte", "Vacant FTE", "number")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS vacant, ROUND(SUM(b.fte), 2) AS fte
      FROM (SELECT t.fte, CASE WHEN t.age <= 30 THEN '1 0 to 30 days' WHEN t.age <= 90 THEN '2 31 to 90 days' WHEN t.age <= 180 THEN '3 91 to 180 days' ELSE '4 Over 180 days' END AS label
              FROM (SELECT p.headcount_fte AS fte, (${q.today} - COALESCE((SELECT MAX(pi.effective_to) FROM position_incumbents pi WHERE pi.position_id = p.id), p.created_at::date)) AS age
                      FROM positions p WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")}
                       AND NOT EXISTS (SELECT 1 FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)})) t) b
     GROUP BY b.label ORDER BY b.label`,
};
const UNIT_RECORDS: ReportSectionSpec = {
  key: "units",
  title: "Organisation units",
  description: "Every unit with its type, parent, status, head position, current employees and positions.",
  columns: [col("code", "Code"), col("name", "Unit"), col("type", "Type"), col("parent", "Parent unit"), col("status", "Status"), col("head", "Head position"), col("employees", "Current employees", "number"), col("positions", "Positions", "number")],
  sql: (q) => `
    SELECT ou.code, ou.name, ${LABEL("ou.unit_type")} AS type, par.name AS parent, ${LABEL("ou.status")} AS status, hp.position_title AS head,
           (SELECT COUNT(*) FROM employees e WHERE e.org_unit_id = ou.id AND e.company_id = ou.company_id AND ${q.current()})::int AS employees,
           (SELECT COUNT(*) FROM positions p WHERE p.org_unit_id = ou.id AND p.company_id = ou.company_id AND ${OPEN_POSITION})::int AS positions
      FROM org_units ou LEFT JOIN org_units par ON par.id = ou.parent_id LEFT JOIN positions hp ON hp.id = ou.head_position_id
     WHERE ${q.co("ou")} ORDER BY ou.unit_type, ou.name`,
};
const UNITS_NO_HEAD: ReportSectionSpec = {
  key: "units-attention",
  title: "Units that need attention",
  description: "Units with no current employees or no head position.",
  columns: [col("name", "Unit"), col("type", "Type"), col("issue", "Issue")],
  sql: (q) => `
    SELECT * FROM (
      SELECT ou.name, ${LABEL("ou.unit_type")} AS type, 'No current employees' AS issue FROM org_units ou WHERE ${q.co("ou")} AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.org_unit_id = ou.id AND ${q.current()})
      UNION ALL SELECT ou.name, ${LABEL("ou.unit_type")}, 'No head position' FROM org_units ou WHERE ${q.co("ou")} AND ou.head_position_id IS NULL) t ORDER BY name, issue`,
};
const UNITS_BY_STATUS: ReportSectionSpec = {
  key: "units-by-status",
  title: "Units by status",
  description: "Organisation units by status and type.",
  columns: [col("label", "Status"), col("type", "Type"), col("units", "Units", "number")],
  sql: (q) => `SELECT ${LABEL("ou.status")} AS label, ${LABEL("ou.unit_type")} AS type, COUNT(*)::int AS units FROM org_units ou WHERE ${q.co("ou")} GROUP BY ou.status, ou.unit_type ORDER BY label, units DESC`,
};

const B09_BAND_BY_UNIT: ReportSectionSpec = {
  key: "band-by-unit",
  title: "Band by organisation unit",
  description: "How many current employees in each unit sit in each grade or salary band.",
  columns: [col("label", "Organisation unit"), col("band", "Band"), col("employees", "Employees", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COALESCE(NULLIF(e.salary_band, ''), 'Not set') AS band, COUNT(*)::int AS employees
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${q.current()}
     GROUP BY ou.name, e.salary_band ORDER BY label, band`,
};
const B09_RECORDS: ReportSectionSpec = {
  key: "band-employees",
  title: "Employees and their band",
  description: "Each current employee with their grade or salary band.",
  columns: [...IDENT, col("band", "Band"), col("unit", "Organisation unit"), col("position", "Position"), col("tenure", "Years of service", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(NULLIF(e.salary_band, ''), 'Not set') AS band, COALESCE(ou.name, 'Not set') AS unit,
           COALESCE(p.position_title, e.designation, 'Not set') AS position, ${tenureYears(q)} AS tenure
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN positions p ON p.id = e.position_id
     WHERE ${q.emp()} AND ${q.current()} ORDER BY band, name`,
};
const COST_CENTRE_ASSIGNMENTS: ReportSectionSpec = {
  key: "allocations",
  title: "Cost centre allocations",
  description: "Every active allocation: the person, the cost centre and the percentage of their time.",
  columns: [...IDENT, col("costCentre", "Cost centre"), col("percent", "Allocation (%)", "percent"), col("primary", "Primary"), col("unit", "Organisation unit")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, cc.code || ' - ' || cc.name AS "costCentre", a.allocation_percentage AS percent, CASE WHEN a.is_primary THEN 'Yes' ELSE 'No' END AS "primary", COALESCE(ou.name, 'Not set') AS unit
      FROM employee_cost_allocations a JOIN cost_centers cc ON cc.id = a.cost_center_id JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} AND a.status = 'active' ORDER BY cc.code, name`,
};
const UNALLOCATED: ReportSectionSpec = employeeRecords("unallocated", "Employees with no cost centre", "Current employees with no active cost centre allocation.", {
  where: () => "NOT EXISTS (SELECT 1 FROM employee_cost_allocations a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active')",
});
const ALLOCATION_BAD_TOTAL: ReportSectionSpec = {
  key: "allocation-totals",
  title: "Allocation totals that do not add to 100%",
  description: "Employees whose active cost centre percentages do not total 100.",
  columns: [...IDENT, col("total", "Total allocated (%)", "percent")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, SUM(a.allocation_percentage) AS total
      FROM employee_cost_allocations a JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id
     WHERE ${q.emp()} AND ${q.current()} AND a.status = 'active' GROUP BY e.id HAVING ROUND(SUM(a.allocation_percentage), 2) <> 100 ORDER BY total, name`,
};
const COST_CENTRE_BY_UNIT: ReportSectionSpec = {
  key: "cost-centre-by-unit",
  title: "Cost centre by organisation unit",
  description: "People and FTE for each cost centre inside each unit.",
  columns: [col("label", "Organisation unit"), col("costCentre", "Cost centre"), col("people", "People", "number"), col("fte", "FTE", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, cc.code || ' - ' || cc.name AS "costCentre", COUNT(DISTINCT e.id)::int AS people, ROUND(SUM(a.allocation_percentage) / 100.0, 2) AS fte
      FROM employee_cost_allocations a JOIN cost_centers cc ON cc.id = a.cost_center_id JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} AND a.status = 'active' GROUP BY ou.name, cc.id ORDER BY label, fte DESC`,
};

const ENDING_BY_MONTH = (type: "contract_end" | "probation_end", noun: string): ReportSectionSpec => ({
  key: `${noun}-by-month`,
  title: `${noun[0]?.toUpperCase()}${noun.slice(1)} ending by month`,
  description: `How many ${noun} end in each month of the period.`,
  columns: [col("month", "Month"), col("ending", "Ending", "number")],
  sql: (q) => `
    SELECT to_char(d.date_value, 'YYYY-MM') AS month, COUNT(*)::int AS ending
      FROM employees e JOIN employee_important_dates d ON d.employee_id = e.id AND d.company_id = e.company_id AND d.date_type = '${type}' AND d.status = 'active'
     WHERE ${q.emp()} AND ${q.current()} AND d.date_value BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
});
const ENDING_BY = (type: "contract_end" | "probation_end", key: string, title: string, label: string, expr: string): ReportSectionSpec => ({
  key,
  title,
  description: `${title} in the period.`,
  columns: [col("label", label), col("ending", "Ending", "number"), col("expired", "Already ended", "number"), col("soon", "Ending within 30 days", "number")],
  sql: (q) => `
    SELECT COALESCE(NULLIF((${expr})::text, ''), 'Not set') AS label, COUNT(*)::int AS ending, COUNT(*) FILTER (WHERE d.date_value < ${q.today})::int AS expired,
           COUNT(*) FILTER (WHERE d.date_value >= ${q.today} AND d.date_value <= ${q.today} + 30)::int AS soon
      FROM employees e ${ORG_JOINS} JOIN employee_important_dates d ON d.employee_id = e.id AND d.company_id = e.company_id AND d.date_type = '${type}' AND d.status = 'active'
     WHERE ${q.emp()} AND ${q.current()} AND d.date_value BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY ending DESC, label`,
});

const ANNIV_BY_MONTH: ReportSectionSpec = {
  key: "anniversaries-by-month",
  title: "Anniversaries by month",
  description: "Work anniversaries falling in each month of the window.",
  columns: [col("month", "Month"), col("anniversaries", "Anniversaries", "number")],
  sql: (q) => `
    SELECT to_char(x.d, 'YYYY-MM') AS month, COUNT(*)::int AS anniversaries
      FROM (SELECT (e.date_of_joining + (EXTRACT(YEAR FROM ${q.to}) - EXTRACT(YEAR FROM e.date_of_joining))::int * interval '1 year')::date AS d FROM employees e WHERE ${q.emp()} AND ${q.current()}
            UNION ALL SELECT (e.date_of_joining + (EXTRACT(YEAR FROM ${q.from}) - EXTRACT(YEAR FROM e.date_of_joining))::int * interval '1 year')::date FROM employees e WHERE ${q.emp()} AND ${q.current()} AND EXTRACT(YEAR FROM ${q.from}) <> EXTRACT(YEAR FROM ${q.to})) x
     WHERE x.d BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const ANNIV_MILESTONES: ReportSectionSpec = {
  key: "anniversary-milestones",
  title: "Anniversaries by years completed",
  description: "How many people reach each number of years of service in the window.",
  columns: [col("label", "Years completed"), col("employees", "Employees", "number")],
  sql: (q) => `
    SELECT x.years::text || CASE WHEN x.years = 1 THEN ' year' ELSE ' years' END AS label, COUNT(*)::int AS employees
      FROM (SELECT (EXTRACT(YEAR FROM x.d) - EXTRACT(YEAR FROM e.date_of_joining))::int AS years, x.d
              FROM employees e CROSS JOIN LATERAL (SELECT (e.date_of_joining + ((EXTRACT(YEAR FROM ${q.to}) - EXTRACT(YEAR FROM e.date_of_joining))::int * interval '1 year'))::date AS d
                                                    UNION SELECT (e.date_of_joining + ((EXTRACT(YEAR FROM ${q.from}) - EXTRACT(YEAR FROM e.date_of_joining))::int * interval '1 year'))::date) x(d)
             WHERE ${q.emp()} AND ${q.current()} AND x.d BETWEEN ${q.from} AND ${q.to} AND x.d > e.date_of_joining) x
     GROUP BY x.years ORDER BY x.years`,
};

const EXPIRY_BY_DOC: ReportSectionSpec = {
  key: "expiry-by-document",
  title: "Expiries by document",
  description: "How many documents of each kind expire in the window and how many have already expired.",
  columns: [col("label", "Document"), col("expiring", "Expiring", "number"), col("expired", "Already expired", "number"), col("soon", "Within 30 days", "number")],
  sql: (q) => `
    SELECT t.label, COUNT(*)::int AS expiring, COUNT(*) FILTER (WHERE t.d < ${q.today})::int AS expired, COUNT(*) FILTER (WHERE t.d >= ${q.today} AND t.d <= ${q.today} + 30)::int AS soon
      FROM (SELECT 'Passport' AS label, p.passport_expiry AS d FROM employees e JOIN persons p ON p.id = e.person_id WHERE ${q.emp()} AND ${q.current()} AND p.passport_expiry BETWEEN ${q.from} AND ${q.to}
            UNION ALL SELECT COALESCE(NULLIF(x.title, ''), ${LABEL("x.qualification_type")}), x.expiry_date FROM employees e JOIN employee_qualifications x ON x.employee_id = e.id WHERE ${q.emp()} AND ${q.current()} AND x.status = 'active' AND x.expiry_date BETWEEN ${q.from} AND ${q.to}
            UNION ALL SELECT COALESCE(NULLIF(d.label, ''), 'Document'), d.date_value FROM employees e JOIN employee_important_dates d ON d.employee_id = e.id WHERE ${q.emp()} AND ${q.current()} AND d.date_type = 'document_expiry' AND d.status = 'active' AND d.date_value BETWEEN ${q.from} AND ${q.to}) t
     GROUP BY t.label ORDER BY expiring DESC, t.label`,
};
const EXPIRY_BY_MONTH: ReportSectionSpec = {
  key: "expiry-by-month",
  title: "Expiries by month",
  description: "Document expiries in each month of the window.",
  columns: [col("month", "Month"), col("expiring", "Expiring", "number")],
  sql: (q) => `
    SELECT to_char(t.d, 'YYYY-MM') AS month, COUNT(*)::int AS expiring
      FROM (SELECT p.passport_expiry AS d FROM employees e JOIN persons p ON p.id = e.person_id WHERE ${q.emp()} AND ${q.current()}
            UNION ALL SELECT x.expiry_date FROM employees e JOIN employee_qualifications x ON x.employee_id = e.id WHERE ${q.emp()} AND ${q.current()} AND x.status = 'active'
            UNION ALL SELECT d.date_value FROM employees e JOIN employee_important_dates d ON d.employee_id = e.id WHERE ${q.emp()} AND ${q.current()} AND d.date_type = 'document_expiry' AND d.status = 'active') t
     WHERE t.d BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const EXPIRY_BY_UNIT: ReportSectionSpec = {
  key: "expiry-by-unit",
  title: "Expiries by organisation unit",
  description: "Passport and qualification expiries in the window for each unit.",
  columns: [col("label", "Organisation unit"), col("expiring", "Expiring", "number"), col("expired", "Already expired", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS expiring, COUNT(*) FILTER (WHERE t.d < ${q.today})::int AS expired
      FROM (SELECT e.id AS emp, p.passport_expiry AS d FROM employees e JOIN persons p ON p.id = e.person_id WHERE ${q.emp()} AND ${q.current()} AND p.passport_expiry BETWEEN ${q.from} AND ${q.to}
            UNION ALL SELECT e.id, x.expiry_date FROM employees e JOIN employee_qualifications x ON x.employee_id = e.id WHERE ${q.emp()} AND ${q.current()} AND x.status = 'active' AND x.expiry_date BETWEEN ${q.from} AND ${q.to}) t
      JOIN employees e ON e.id = t.emp LEFT JOIN org_units ou ON ou.id = e.org_unit_id GROUP BY ou.name ORDER BY expiring DESC, label`,
};

const B15_BY_ISSUE: ReportSectionSpec = {
  key: "issues-by-kind",
  title: "Exceptions by kind",
  description: "How many records have each kind of data problem.",
  columns: [col("label", "Issue"), col("records", "Records", "number")],
  sql: (q) => `
    SELECT t.issue AS label, COUNT(*)::int AS records FROM (
      SELECT 'Shared CNIC' AS issue FROM employees e WHERE ${q.emp()} AND e.cnic_bidx IS NOT NULL AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND o.cnic_bidx = e.cnic_bidx AND o.id <> e.id)
      UNION ALL SELECT 'Shared work email' FROM employees e WHERE ${q.emp()} AND COALESCE(e.email, '') <> '' AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND LOWER(o.email) = LOWER(e.email) AND o.id <> e.id)
      UNION ALL SELECT 'Terminated with no date' FROM employees e WHERE ${q.emp()} AND e.employment_status = 'terminated' AND e.termination_date IS NULL
      UNION ALL SELECT 'Working with a termination date' FROM employees e WHERE ${q.emp()} AND e.employment_status <> 'terminated' AND e.termination_date IS NOT NULL
      UNION ALL SELECT 'Leaving before joining' FROM employees e WHERE ${q.emp()} AND e.termination_date IS NOT NULL AND e.termination_date < e.date_of_joining) t
     GROUP BY t.issue ORDER BY records DESC, t.issue`,
};
const B15_BY_UNIT: ReportSectionSpec = {
  key: "issues-by-unit",
  title: "Employees with an exception, by unit",
  description: "How many employees in each unit have a data problem.",
  columns: [col("label", "Organisation unit"), col("employees", "Employees with a problem", "number"), col("share", "Share of the unit (%)", "percent")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label,
           COUNT(*) FILTER (WHERE (e.cnic_bidx IS NOT NULL AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND o.cnic_bidx = e.cnic_bidx AND o.id <> e.id))
                OR (COALESCE(e.email, '') <> '' AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND LOWER(o.email) = LOWER(e.email) AND o.id <> e.id))
                OR (e.employment_status = 'terminated' AND e.termination_date IS NULL) OR (e.employment_status <> 'terminated' AND e.termination_date IS NOT NULL)
                OR (e.termination_date IS NOT NULL AND e.termination_date < e.date_of_joining))::int AS employees,
           ROUND(COUNT(*) FILTER (WHERE (e.employment_status = 'terminated' AND e.termination_date IS NULL) OR (e.employment_status <> 'terminated' AND e.termination_date IS NOT NULL)) * 100.0 / COUNT(*), 1) AS share
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} GROUP BY ou.name ORDER BY employees DESC, label`,
};

// ---------------------------------------------------------------- M. planning

const MOVES_RECORDS: ReportSectionSpec = {
  key: "moves",
  title: "Individual moves",
  description: "Every applied transfer between organisation units in the period.",
  columns: [col("effective", "Effective", "date"), ...IDENT, col("from", "From unit"), col("to", "To unit"), col("event", "Event")],
  sql: (q) => `
    SELECT ev.effective_date::text AS effective, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(fu.name, 'Not set') AS "from", COALESCE(tu.name, 'Not set') AS "to", ${LABEL("ev.action_type")} AS event
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
      LEFT JOIN org_units fu ON fu.id = NULLIF(ev.before_snapshot->>'org_unit_id', '')::uuid LEFT JOIN org_units tu ON tu.id = NULLIF(ev.after_snapshot->>'org_unit_id', '')::uuid
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.action_type IN ('transfer', 'org_unit_change', 'promotion') AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
       AND COALESCE(ev.before_snapshot->>'org_unit_id', '') IS DISTINCT FROM COALESCE(ev.after_snapshot->>'org_unit_id', '')
     ORDER BY ev.effective_date DESC, name`,
};
const MOVES_BY_MONTH: ReportSectionSpec = {
  key: "moves-by-month",
  title: "Moves by month",
  description: "Transfers between units in each month of the period.",
  columns: [col("month", "Month"), col("moves", "Moves", "number"), col("people", "People", "number")],
  sql: (q) => `
    SELECT to_char(ev.effective_date, 'YYYY-MM') AS month, COUNT(*)::int AS moves, COUNT(DISTINCT ev.employee_id)::int AS people
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.action_type IN ('transfer', 'org_unit_change', 'promotion') AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
       AND COALESCE(ev.before_snapshot->>'org_unit_id', '') IS DISTINCT FROM COALESCE(ev.after_snapshot->>'org_unit_id', '') GROUP BY 1 ORDER BY 1`,
};
const NET_FLOW: ReportSectionSpec = {
  key: "net-flow",
  title: "Net movement by organisation unit",
  description: "For each unit: people who moved in, people who moved out and the net change.",
  columns: [col("label", "Organisation unit"), col("in", "Moved in", "number"), col("out", "Moved out", "number"), col("net", "Net", "number")],
  sql: (q) => `
    SELECT u.label, SUM(u.inn)::int AS "in", SUM(u.outt)::int AS "out", (SUM(u.inn) - SUM(u.outt))::int AS net
      FROM (SELECT COALESCE(tu.name, 'Not set') AS label, 1 AS inn, 0 AS outt FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
              LEFT JOIN org_units tu ON tu.id = NULLIF(ev.after_snapshot->>'org_unit_id', '')::uuid
             WHERE ${q.emp()} AND ev.status = 'applied' AND ev.action_type IN ('transfer', 'org_unit_change', 'promotion') AND ev.effective_date BETWEEN ${q.from} AND ${q.to} AND COALESCE(ev.before_snapshot->>'org_unit_id', '') IS DISTINCT FROM COALESCE(ev.after_snapshot->>'org_unit_id', '')
            UNION ALL SELECT COALESCE(fu.name, 'Not set'), 0, 1 FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
              LEFT JOIN org_units fu ON fu.id = NULLIF(ev.before_snapshot->>'org_unit_id', '')::uuid
             WHERE ${q.emp()} AND ev.status = 'applied' AND ev.action_type IN ('transfer', 'org_unit_change', 'promotion') AND ev.effective_date BETWEEN ${q.from} AND ${q.to} AND COALESCE(ev.before_snapshot->>'org_unit_id', '') IS DISTINCT FROM COALESCE(ev.after_snapshot->>'org_unit_id', '')) u
     GROUP BY u.label ORDER BY net DESC, u.label`,
};
const CONTRACTS_ENDING_RECORDS: ReportSectionSpec = {
  key: "contracts-ending",
  title: "Contracts ending",
  description: "Each contract ending in the coming months, soonest first.",
  columns: [col("ends", "Ends", "date"), col("days", "Days left", "number"), ...IDENT, col("unit", "Organisation unit"), col("type", "Employment type")],
  sql: (q) => `
    SELECT d.date_value::text AS ends, (d.date_value - ${q.today})::int AS days, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("e.employment_type")} AS type
      FROM employees e JOIN employee_important_dates d ON d.employee_id = e.id AND d.company_id = e.company_id AND d.date_type = 'contract_end' AND d.status = 'active' LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} AND d.date_value BETWEEN ${q.from} AND ${q.to} ORDER BY d.date_value, name`,
};
const TYPE_MIX_NOW: ReportSectionSpec = {
  key: "type-mix-by-unit",
  title: "Employment type by organisation unit",
  description: "Current headcount in each unit by employment type.",
  columns: [col("label", "Organisation unit"), col("type", "Employment type"), col("employees", "Employees", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, ${LABEL("e.employment_type")} AS type, COUNT(*)::int AS employees
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${q.current()} GROUP BY ou.name, e.employment_type ORDER BY label, employees DESC`,
};
const WORK_PROFILES: ReportSectionSpec = {
  key: "work-profiles",
  title: "Working-hours profiles",
  description: "Each current employee with the working-hours profile in force today. People with no profile are shown too.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("percentage", "Employment percentage", "number"), col("hours", "Weekly hours", "number"), col("partTime", "Part time"), col("recording", "Time recording")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, wp.employment_percentage AS percentage, wp.weekly_hours AS hours,
           CASE WHEN wp.id IS NULL THEN 'No profile' WHEN wp.is_part_time THEN 'Yes' ELSE 'No' END AS "partTime", ${LABEL("wp.time_recording_profile")} AS recording
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
      LEFT JOIN LATERAL (SELECT w.* FROM employee_work_profiles w WHERE w.employee_id = e.id AND w.company_id = e.company_id AND w.effective_from <= ${q.today} AND (w.effective_to IS NULL OR w.effective_to >= ${q.today}) ORDER BY w.effective_from DESC LIMIT 1) wp ON TRUE
     WHERE ${q.emp()} AND ${q.current()} ORDER BY (wp.id IS NULL) DESC, name`,
};
const NO_PROFILE: ReportSectionSpec = employeeRecords("no-profile", "Employees with no working-hours profile", "Current employees who add nothing to FTE or hours because they have no profile.", {
  where: (q) => `NOT EXISTS (SELECT 1 FROM employee_work_profiles w WHERE w.employee_id = e.id AND w.company_id = e.company_id AND w.effective_from <= ${q.today} AND (w.effective_to IS NULL OR w.effective_to >= ${q.today}))`,
});
const CAPACITY_OTHER = (dim: "unit" | "type" | "location"): ReportSectionSpec => {
  const m = {
    unit: { key: "capacity-by-location", title: "Capacity by location", label: "Location", expr: "COALESCE(l.name, 'Not set')" },
    type: { key: "capacity-by-unit", title: "Capacity by organisation unit", label: "Organisation unit", expr: "COALESCE(ou.name, 'Not set')" },
    location: { key: "capacity-by-type", title: "Capacity by employment type", label: "Employment type", expr: LABEL("e.employment_type") },
  }[dim];
  return {
    key: m.key,
    title: m.title,
    description: `Headcount, FTE and weekly hours by ${m.label.toLowerCase()}, from working-hours profiles.`,
    columns: [col("label", m.label), col("headcount", "Headcount", "number"), col("fte", "FTE (from profiles)", "number"), col("hours", "Weekly hours", "number"), col("noProfile", "Without a profile", "number")],
    sql: (q) => `
      SELECT ${m.expr} AS label, COUNT(*)::int AS headcount, ROUND(COALESCE(SUM(wp.employment_percentage), 0) / 100.0, 2) AS fte, ROUND(COALESCE(SUM(wp.weekly_hours), 0), 1) AS hours, (COUNT(*) - COUNT(wp.weekly_hours))::int AS "noProfile"
        FROM employees e ${ORG_JOINS}
        LEFT JOIN LATERAL (SELECT w.employment_percentage, w.weekly_hours FROM employee_work_profiles w WHERE w.employee_id = e.id AND w.company_id = e.company_id AND w.effective_from <= ${q.today} AND (w.effective_to IS NULL OR w.effective_to >= ${q.today}) ORDER BY w.effective_from DESC LIMIT 1) wp ON TRUE
       WHERE ${q.emp()} AND ${q.current()} GROUP BY 1 ORDER BY headcount DESC, label`,
  };
};
const LAYER_RECORDS: ReportSectionSpec = {
  key: "layers",
  title: "People by reporting layer",
  description: "Each person with how many layers sit between them and the top, following direct reporting lines.",
  columns: [col("layer", "Layer", "number"), ...IDENT, col("manager", "Reports to"), col("unit", "Organisation unit")],
  sql: (q) => `
    WITH RECURSIVE t AS (
      SELECT e.id, e.company_id, 1 AS layer, ARRAY[e.id] AS path FROM employees e
       WHERE ${q.co("e")} AND ${q.current()} AND NOT EXISTS (SELECT 1 FROM org_relationships r WHERE r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active')
      UNION ALL
      SELECT c.id, c.company_id, t.layer + 1, t.path || c.id FROM t JOIN org_relationships r ON r.manager_employee_id = t.id AND r.company_id = t.company_id AND r.relationship_type = 'direct' AND r.status = 'active'
        JOIN employees c ON c.id = r.employee_id AND c.company_id = r.company_id AND c.employment_status <> 'terminated' WHERE t.layer < 15 AND NOT c.id = ANY(t.path))
    SELECT t.layer, e.employee_number AS number, ${NAME("e")} AS name, NULLIF(${NAME("mg")}, '') AS manager, COALESCE(ou.name, 'Not set') AS unit
      FROM t JOIN employees e ON e.id = t.id LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN employees mg ON mg.id = e.manager_id AND mg.company_id = e.company_id
     ORDER BY t.layer, name`,
};
const RESTRUCTURE_ITEMS: ReportSectionSpec = {
  key: "change-steps",
  title: "Steps inside each change",
  description: "Every unit action inside the organisation changes of the period, with any failure reason.",
  columns: [col("title", "Change"), col("status", "Change status"), col("effective", "Effective", "date"), col("unit", "Organisation unit"), col("step", "Step"), col("failure", "Failure reason")],
  sql: (q) => `
    SELECT oc.title, ${LABEL("oc.status")} AS status, oc.effective_date::text AS effective, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("i.action")} AS step, i.failure_reason AS failure
      FROM org_changes oc JOIN org_change_items i ON i.org_change_id = oc.id LEFT JOIN org_units ou ON ou.id = i.org_unit_id
     WHERE ${q.co("oc")} AND COALESCE(oc.effective_date, oc.created_at::date) BETWEEN ${q.from} AND ${q.to}
     ORDER BY COALESCE(oc.effective_date, oc.created_at::date) DESC, oc.title`,
};
const RESTRUCTURE_STATUS: ReportSectionSpec = {
  key: "changes-by-status",
  title: "Changes by status",
  description: "Organisation changes grouped by status.",
  columns: [col("label", "Status"), col("changes", "Changes", "number"), col("steps", "Steps", "number"), col("failed", "Failed steps", "number")],
  sql: (q) => `
    SELECT ${LABEL("oc.status")} AS label, COUNT(DISTINCT oc.id)::int AS changes, COUNT(i.id)::int AS steps, COUNT(i.id) FILTER (WHERE i.failure_reason IS NOT NULL)::int AS failed
      FROM org_changes oc LEFT JOIN org_change_items i ON i.org_change_id = oc.id
     WHERE ${q.co("oc")} AND COALESCE(oc.effective_date, oc.created_at::date) BETWEEN ${q.from} AND ${q.to} GROUP BY oc.status ORDER BY changes DESC, label`,
};
const TYPE_MIX_UNIT_MONTHLY: ReportSectionSpec = {
  key: "type-mix-movement",
  title: "Joiners and leavers by employment type",
  description: "Month by month: people who joined and left, for each employment type.",
  columns: [col("month", "Month"), col("type", "Employment type"), col("joined", "Joined", "number"), col("left", "Left", "number")],
  sql: (q) => `
    WITH mo AS (${monthSeries(q)})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, ${LABEL("e.employment_type")} AS type, COUNT(*) FILTER (WHERE e.date_of_joining BETWEEN mo.ms AND mo.me)::int AS joined, COUNT(*) FILTER (WHERE e.termination_date BETWEEN mo.ms AND mo.me)::int AS "left"
      FROM mo JOIN employees e ON ${q.emp()} AND (e.date_of_joining BETWEEN mo.ms AND mo.me OR e.termination_date BETWEEN mo.ms AND mo.me)
     GROUP BY mo.ms, e.employment_type ORDER BY mo.ms, type`,
};
const MOBILITY_RECORDS: ReportSectionSpec = {
  key: "mobility-events",
  title: "Internal moves",
  description: "Every promotion, transfer and other internal move in the period.",
  columns: [col("effective", "Effective", "date"), ...IDENT, col("event", "Event"), col("reason", "Reason"), col("unit", "Organisation unit")],
  sql: (q) => `
    SELECT ev.effective_date::text AS effective, e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("ev.action_type")} AS event, COALESCE(NULLIF(ev.reason_code, ''), 'Not recorded') AS reason, COALESCE(ou.name, 'Not set') AS unit
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.action_type NOT IN ('hire', 'termination', 'rehire') AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
     ORDER BY ev.effective_date DESC, name`,
};

export const WORKFORCE_DEPTH: Record<string, ReportSectionSpec[]> = {
  A01: [ROSTER, byUnit(), byLocation(), byType(), TENURE_BANDS, MOVEMENT, RECENT_JOINERS(30), RECENT_LEAVERS(30), A_UNIT_SCORECARD],
  A03: [ROSTER, byPosition(), byType(), byLocation(), SUBGROUP, TENURE_BANDS, A_UNIT_SCORECARD, MOVEMENT],
  A04: [ROSTER, byUnit(), byType(), byPosition(), TENURE_BANDS, MOVEMENT],
  A05: [ROSTER, byUnit(), byLocation(), SUBGROUP, TENURE_BANDS, MOVEMENT_BY_UNIT],
  A06: [STATUS_LIST, BY_STATUS, byType({ where: () => "TRUE" }), LEAVING_REASONS, LEAVERS_IN_PERIOD],
  A07: [MOVEMENT, HEADCOUNT_BY_UNIT_MONTHLY, MOVEMENT_BY_UNIT, JOINERS_IN_PERIOD, LEAVERS_IN_PERIOD],
  A08: [JOINERS_IN_PERIOD, LEAVERS_IN_PERIOD, LEAVING_REASONS, MOVEMENT_BY_UNIT, MOVEMENT],
  A09: [MOVEMENT, HEADCOUNT_BY_UNIT_MONTHLY, MOVEMENT_BY_UNIT, JOINERS_IN_PERIOD, LEAVERS_IN_PERIOD],
  A10: [MANAGER_TEAMS, SPAN_BANDS, byManager(), byUnit()],
  A11: [byUnit({ tenure: false }), byType({ tenure: false }), TENURE_BANDS],
  A12: [LIFECYCLE_EVENTS, EVENTS_BY_MONTH, EVENTS_BY_UNIT, PENDING_EVENTS],
  A13: [HR_OPS_ONBOARDING, HR_OPS_OVERDUE_TASKS, HR_OPS_OFFBOARDING, PROBATION_NOW, PENDING_EVENTS],
  A14: [MISSING_FIELDS, COMPLETENESS_BY_UNIT, FIELD_BY_UNIT],
  A15: [A_UNIT_SCORECARD, MOVEMENT, ROSTER, RECENT_JOINERS(30), RECENT_LEAVERS(365), LEAVING_REASONS],
  B01: [byUnit(), byLocation(), byType(), byPosition(), SUBGROUP, byManager(), TENURE_BANDS, MOVEMENT],
  B02: [B02_BY_KIND, B02_BY_MONTH, B02_BY_UNIT, B02_MOST_CHANGED, VERSION_HISTORY],
  B03: [B03_SCORE_BANDS, COMPLETENESS_BY_UNIT, FIELD_BY_UNIT, MISSING_FIELDS],
  B04: [ROSTER, byPosition(), byUnit(), byLocation(), byType(), TENURE_BANDS],
  B05: [POSITION_RECORDS, POSITIONS_BY_STATUS, OVERFILLED, VACANT_BY_UNIT],
  B06: [VACANT_BY_UNIT, VACANT_AGE_BANDS, POSITIONS_BY_STATUS, POSITION_RECORDS],
  B07: [UNIT_RECORDS, UNITS_NO_HEAD, UNITS_BY_STATUS],
  B08: [MANAGER_TEAMS, SPAN_BANDS, byManager(), byUnit()],
  B09: [B09_BAND_BY_UNIT, B09_RECORDS, byType(), TENURE_BANDS],
  B10: [COST_CENTRE_ASSIGNMENTS, COST_CENTRE_BY_UNIT, UNALLOCATED, ALLOCATION_BAD_TOTAL],
  B11: [CONTRACTS_ENDING_RECORDS, ENDING_BY_MONTH("contract_end", "contracts"), ENDING_BY("contract_end", "contracts-by-unit", "Contracts ending by organisation unit", "Organisation unit", "ou.name"), ENDING_BY("contract_end", "contracts-by-type", "Contracts ending by employment type", "Employment type", LABEL("e.employment_type"))],
  B12: [ENDING_BY_MONTH("probation_end", "probations"), ENDING_BY("probation_end", "probation-by-unit", "Probations ending by organisation unit", "Organisation unit", "ou.name"), ENDING_BY("probation_end", "probation-by-manager", "Probations ending by manager", "Reports to", NAME("mg")), PROBATION_NOW],
  B13: [ANNIV_BY_MONTH, ANNIV_MILESTONES, byUnit(), TENURE_BANDS],
  B14: [EXPIRY_BY_DOC, EXPIRY_BY_MONTH, EXPIRY_BY_UNIT],
  B15: [B15_BY_ISSUE, B15_BY_UNIT],
  M02: [WORK_PROFILES, NO_PROFILE, CAPACITY_OTHER("unit"), CAPACITY_OTHER("type")],
  M03: [WORK_PROFILES, NO_PROFILE, CAPACITY_OTHER("type"), CAPACITY_OTHER("location")],
  M04: [VACANT_BY_UNIT, VACANT_AGE_BANDS, POSITIONS_BY_STATUS, POSITION_RECORDS],
  M06: [MOVES_RECORDS, MOVES_BY_MONTH, NET_FLOW],
  M07: [ROSTER, byUnit(), byType(), byLocation(), TENURE_BANDS],
  M08: [CONTRACTS_ENDING_RECORDS, ENDING_BY_MONTH("contract_end", "contracts"), ENDING_BY("contract_end", "contracts-by-unit", "Contracts ending by organisation unit", "Organisation unit", "ou.name"), ENDING_BY("contract_end", "contracts-by-type", "Contracts ending by employment type", "Employment type", LABEL("e.employment_type"))],
  M10: [LAYER_RECORDS, MANAGER_TEAMS, SPAN_BANDS],
  M11: [RESTRUCTURE_STATUS, RESTRUCTURE_ITEMS],
  M12: [WORK_PROFILES, NO_PROFILE, CAPACITY_OTHER("unit"), CAPACITY_OTHER("location")],
  M13: [TYPE_MIX_NOW, TYPE_MIX_UNIT_MONTHLY, MOVEMENT, ROSTER],
  M14: [COMPLETENESS_BY_UNIT, FIELD_BY_UNIT, MISSING_FIELDS],
  L13: [MOBILITY_RECORDS, LIFECYCLE_EVENTS, EVENTS_BY_MONTH, EVENTS_BY_UNIT],
};
