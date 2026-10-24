import type { Q, ReportSectionSpec } from "../report-spec";
import { LABEL, NAME, col } from "./common";

/**
 * Extra tables for the performance and goals reports (G01 to G15, except G12).
 *
 * Same rules as the reports themselves: scope comes through the employee (everyone, or the caller's direct reports),
 * ratings appear only in the reports that already require the sensitive permission and only for groups of at least 5
 * rated people, and free-text assessments, comments and development notes are never selected. Person-level goal progress
 * appears only under G06 and person-level calibration only under G08.
 */

const REV = "performance_reviews pr JOIN review_cycles rc ON rc.id = pr.review_cycle_id AND rc.company_id = pr.company_id JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id";
/** Cycles overlapping the report's range; a report with no range (G03) looks at the cycles still running. */
const CYC = (q: Q) => (q.ctx.range ? `rc.period_end >= ${q.from} AND rc.period_start <= ${q.to}` : "rc.status IN ('active', 'calibration')");
const RW = (q: Q) => `${q.emp()} AND ${CYC(q)}`;
const DONE = "pr.status IN ('completed', 'calibrated', 'released')";
const BEST = "COALESCE(pr.final_rating, pr.calibration_rating, pr.manager_rating)";
const MIN_RATED = 5;
const GOAL_FROM = "goals g JOIN employees e ON e.id = g.employee_id AND e.company_id = g.company_id";
const GW = (q: Q, withCancelled = false) => `${q.emp()} ${withCancelled ? "" : "AND g.status <> 'cancelled'"} AND COALESCE(g.due_date, g.created_at::date) BETWEEN ${q.from} AND ${q.to}`;
const UNIT = "COALESCE(ou.name, 'No organisation unit set')";
const UNIT_JOIN = "LEFT JOIN org_units ou ON ou.id = e.org_unit_id";
const n = (key: string, label: string) => col(key, label, "number");
const pc = (key: string, label: string) => col(key, label, "percent");

// ---------------------------------------------------------------- reviews: progress (counts only)

const REVIEW_STATUS: ReportSectionSpec = {
  key: "reviews-by-status",
  title: "Reviews by status and cycle",
  description: "How many reviews sit at each stage in each cycle. Counts only.",
  columns: [col("cycle", "Review cycle"), col("cycleStatus", "Cycle status"), n("reviews", "Reviews"), n("pending", "Not started"), n("inProgress", "In progress"), n("completed", "Completed"), n("calibrated", "Calibrated"), n("released", "Released")],
  sql: (q) => `
    SELECT rc.name AS cycle, ${LABEL("rc.status")} AS "cycleStatus", COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE pr.status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE pr.status = 'in_progress')::int AS "inProgress",
           COUNT(*) FILTER (WHERE pr.status = 'completed')::int AS completed, COUNT(*) FILTER (WHERE pr.status = 'calibrated')::int AS calibrated, COUNT(*) FILTER (WHERE pr.status = 'released')::int AS released
      FROM ${REV} WHERE ${RW(q)} GROUP BY rc.id ORDER BY rc.period_start DESC, rc.name`,
};
const REVIEW_BY_UNIT: ReportSectionSpec = {
  key: "reviews-by-unit",
  title: "Reviews by organisation unit",
  description: "For each unit: reviews, self-assessments and manager assessments submitted, and reviews completed.",
  columns: [col("label", "Organisation unit"), n("reviews", "Reviews"), n("self", "Self-assessments submitted"), n("manager", "Manager assessments submitted"), n("done", "Completed or beyond"), pc("rate", "Completion (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE pr.self_assessment_submitted_at IS NOT NULL)::int AS self, COUNT(*) FILTER (WHERE pr.manager_assessment_submitted_at IS NOT NULL)::int AS manager,
           COUNT(*) FILTER (WHERE ${DONE})::int AS done, ROUND(COUNT(*) FILTER (WHERE ${DONE}) * 100.0 / COUNT(*), 1) AS rate
      FROM ${REV} ${UNIT_JOIN} WHERE ${RW(q)} GROUP BY ou.id, ou.name ORDER BY rate ASC, label`,
};
const REVIEW_BY_LOCATION: ReportSectionSpec = {
  key: "reviews-by-location",
  title: "Reviews by location",
  description: "Completion of reviews for each work location.",
  columns: [col("label", "Location"), n("reviews", "Reviews"), n("done", "Completed or beyond"), pc("rate", "Completion (%)")],
  sql: (q) => `
    SELECT COALESCE(l.name, 'No location set') AS label, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE ${DONE})::int AS done, ROUND(COUNT(*) FILTER (WHERE ${DONE}) * 100.0 / COUNT(*), 1) AS rate
      FROM ${REV} LEFT JOIN locations l ON l.id = e.location_id WHERE ${RW(q)} GROUP BY l.id, l.name ORDER BY rate ASC, label`,
};
const REVIEW_PIPELINE: ReportSectionSpec = {
  key: "review-pipeline",
  title: "Where each review stands",
  description: "One row per review: the stage it has reached and the dates each step was done. No ratings and no assessment text.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("cycle", "Review cycle"), col("status", "Review status"), col("self", "Self-assessment submitted", "date"), col("manager", "Manager assessment submitted", "date"), col("calibrated", "Calibrated on", "date"), col("released", "Released on", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, rc.name AS cycle, ${LABEL("pr.status")} AS status, pr.self_assessment_submitted_at::date::text AS self,
           pr.manager_assessment_submitted_at::date::text AS manager, pr.calibrated_at::date::text AS calibrated, pr.released_at::date::text AS released
      FROM ${REV} ${UNIT_JOIN} WHERE ${RW(q)} ORDER BY rc.period_start DESC, name`,
};
const REVIEW_NOT_STARTED: ReportSectionSpec = {
  key: "not-submitted",
  title: "Self-assessment or manager assessment not submitted",
  description: "Reviews in live cycles where one of the two assessments has not been submitted.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("cycle", "Review cycle"), col("selfDone", "Self-assessment submitted"), col("managerDone", "Manager assessment submitted")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, rc.name AS cycle,
           CASE WHEN pr.self_assessment_submitted_at IS NULL THEN 'No' ELSE 'Yes' END AS "selfDone", CASE WHEN pr.manager_assessment_submitted_at IS NULL THEN 'No' ELSE 'Yes' END AS "managerDone"
      FROM ${REV} ${UNIT_JOIN} WHERE ${RW(q)} AND rc.status IN ('active', 'calibration') AND pr.status IN ('pending', 'in_progress') AND (pr.self_assessment_submitted_at IS NULL OR pr.manager_assessment_submitted_at IS NULL)
     ORDER BY rc.period_start DESC, name`,
};
const PHASES: ReportSectionSpec = {
  key: "phase-calendar",
  title: "Phase calendar",
  description: "Every phase of each cycle with its dates and whether it is past, open today or ahead.",
  columns: [col("cycle", "Review cycle"), col("phase", "Phase"), col("starts", "Opens", "date"), col("ends", "Closes", "date"), n("days", "Days open"), col("state", "Today")],
  sql: (q) => `
    SELECT rc.name AS cycle, ${LABEL("ph.phase_key")} AS phase, ph.starts_on::text AS starts, ph.ends_on::text AS ends, (ph.ends_on - ph.starts_on + 1)::int AS days,
           CASE WHEN ph.ends_on < ${q.today} THEN 'Closed' WHEN ph.starts_on > ${q.today} THEN 'Not yet open' ELSE 'Open' END AS state
      FROM review_cycle_phases ph JOIN review_cycles rc ON rc.id = ph.review_cycle_id WHERE ${q.co("rc")} AND ${CYC(q)} AND EXISTS (SELECT 1 FROM performance_reviews pr2 JOIN employees e ON e.id = pr2.employee_id AND e.company_id = pr2.company_id WHERE pr2.review_cycle_id = rc.id AND ${q.emp()}) ORDER BY rc.period_start DESC, ph.starts_on`,
};
const SUBMIT_TIMING: ReportSectionSpec = {
  key: "submission-timing",
  title: "When assessments were submitted",
  description: "Self-assessments and manager assessments submitted before, during and after their phase, for each cycle.",
  columns: [col("cycle", "Review cycle"), col("step", "Step"), n("onTime", "Within the phase"), n("late", "After the phase closed"), n("missing", "Not submitted")],
  sql: (q) => `
    SELECT t.cycle, t.step, COUNT(*) FILTER (WHERE t.at IS NOT NULL AND (t.ends IS NULL OR t.at::date <= t.ends))::int AS "onTime", COUNT(*) FILTER (WHERE t.at IS NOT NULL AND t.ends IS NOT NULL AND t.at::date > t.ends)::int AS late,
           COUNT(*) FILTER (WHERE t.at IS NULL)::int AS missing
      FROM (SELECT rc.name AS cycle, rc.period_start, 'Self-assessment' AS step, pr.self_assessment_submitted_at AS at, ph.ends_on AS ends
              FROM ${REV} LEFT JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'self_assessment' WHERE ${RW(q)}
            UNION ALL
            SELECT rc.name, rc.period_start, 'Manager assessment', pr.manager_assessment_submitted_at, ph.ends_on
              FROM ${REV} LEFT JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'manager_assessment' WHERE ${RW(q)}) t
     GROUP BY t.cycle, t.period_start, t.step ORDER BY t.period_start DESC, t.step`,
};
const BY_MANAGER_CYCLE: ReportSectionSpec = {
  key: "manager-by-cycle",
  title: "Managers by cycle",
  description: "For each manager and cycle: reviews to write, submitted and overdue.",
  columns: [col("manager", "Manager"), col("cycle", "Review cycle"), n("reviews", "Reviews to write"), n("submitted", "Submitted"), n("overdue", "Overdue")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("m")}, ''), 'No manager on record') AS manager, rc.name AS cycle, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE pr.manager_assessment_submitted_at IS NOT NULL)::int AS submitted,
           COUNT(*) FILTER (WHERE pr.manager_assessment_submitted_at IS NULL AND pr.status IN ('pending', 'in_progress') AND ph.ends_on < ${q.today})::int AS overdue
      FROM ${REV}
      LEFT JOIN org_relationships r ON r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active'
      LEFT JOIN employees m ON m.id = r.manager_employee_id
      LEFT JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'manager_assessment'
     WHERE ${RW(q)} GROUP BY m.id, m.first_name, m.last_name, rc.id ORDER BY rc.period_start DESC, overdue DESC, manager`,
};
const OVERDUE_AGE: ReportSectionSpec = {
  key: "overdue-age",
  title: "How overdue the outstanding steps are",
  description: "Outstanding self-assessment and manager-assessment steps grouped by days past their phase end.",
  columns: [col("step", "Outstanding step"), col("label", "Overdue by"), n("steps", "Reviews")],
  sql: (q) => `
    SELECT t.step, substr(t.band, 3) AS label, COUNT(*)::int AS steps
      FROM (SELECT x.step, CASE WHEN x.late <= 7 THEN '0 Up to a week' WHEN x.late <= 14 THEN '1 One to two weeks' WHEN x.late <= 30 THEN '2 Two to four weeks' ELSE '3 Over a month' END AS band
              FROM (SELECT 'Self-assessment' AS step, (${q.today} - ph.ends_on) AS late FROM ${REV} JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'self_assessment'
                     WHERE ${RW(q)} AND rc.status IN ('active', 'calibration') AND pr.status IN ('pending', 'in_progress') AND pr.self_assessment_submitted_at IS NULL AND ph.ends_on < ${q.today}
                    UNION ALL
                    SELECT 'Manager assessment', (${q.today} - ph.ends_on) FROM ${REV} JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'manager_assessment'
                     WHERE ${RW(q)} AND rc.status IN ('active', 'calibration') AND pr.status IN ('pending', 'in_progress') AND pr.manager_assessment_submitted_at IS NULL AND ph.ends_on < ${q.today}) x) t
     GROUP BY t.step, t.band ORDER BY t.step, t.band`,
};
const RELEASE_BY_MONTH: ReportSectionSpec = {
  key: "released-by-month",
  title: "Results released by month",
  description: "How many review results were released to employees each month. Counts only.",
  columns: [col("month", "Month"), n("released", "Released")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', pr.released_at), 'YYYY-MM') AS month, COUNT(*)::int AS released
      FROM ${REV} WHERE ${RW(q)} AND pr.released_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
};
const SELF_BY_UNIT: ReportSectionSpec = {
  key: "self-by-unit",
  title: "Self-assessments by organisation unit",
  description: "Submission of self-assessments for each unit.",
  columns: [col("label", "Organisation unit"), n("reviews", "Reviews"), n("submitted", "Submitted"), pc("rate", "Submitted (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE pr.self_assessment_submitted_at IS NOT NULL)::int AS submitted, ROUND(COUNT(*) FILTER (WHERE pr.self_assessment_submitted_at IS NOT NULL) * 100.0 / COUNT(*), 1) AS rate
      FROM ${REV} ${UNIT_JOIN} WHERE ${RW(q)} GROUP BY ou.id, ou.name ORDER BY rate ASC, label`,
};

// ---------------------------------------------------------------- goals

const GOAL_STATUS_BY_UNIT: ReportSectionSpec = {
  key: "goals-by-unit-status",
  title: "Goals by organisation unit and status",
  description: "For each unit: goals at each status and the average progress.",
  columns: [col("label", "Organisation unit"), n("goals", "Goals"), n("notStarted", "Active, not yet in progress"), n("inProgress", "In progress"), n("atRisk", "At risk or overdue"), n("completed", "Completed"), pc("progress", "Average progress (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS goals, COUNT(*) FILTER (WHERE g.status = 'active')::int AS "notStarted", COUNT(*) FILTER (WHERE g.status = 'in_progress')::int AS "inProgress",
           COUNT(*) FILTER (WHERE g.status IN ('at_risk', 'overdue'))::int AS "atRisk", COUNT(*) FILTER (WHERE g.status = 'completed')::int AS completed, ROUND(AVG(g.progress_pct), 1) AS progress
      FROM ${GOAL_FROM} ${UNIT_JOIN} WHERE ${GW(q, true)} GROUP BY ou.id, ou.name ORDER BY goals DESC, label`,
};
const GOAL_BY_CYCLE: ReportSectionSpec = {
  key: "goals-by-cycle",
  title: "Goals by review cycle",
  description: "Goals tied to each review cycle, with progress. Goals not tied to a cycle are listed separately.",
  columns: [col("label", "Review cycle"), n("goals", "Goals"), n("people", "People"), n("completed", "Completed"), pc("progress", "Average progress (%)")],
  sql: (q) => `
    SELECT COALESCE(rc.name, 'Not tied to a cycle') AS label, COUNT(*)::int AS goals, COUNT(DISTINCT g.employee_id)::int AS people, COUNT(*) FILTER (WHERE g.status = 'completed')::int AS completed, ROUND(AVG(g.progress_pct), 1) AS progress
      FROM ${GOAL_FROM} LEFT JOIN review_cycles rc ON rc.id = g.review_cycle_id WHERE ${GW(q)} GROUP BY rc.id, rc.name ORDER BY goals DESC, label`,
};
const GOAL_PROGRESS_BANDS: ReportSectionSpec = {
  key: "goal-progress-bands",
  title: "Goal progress bands",
  description: "How many goals sit in each band of progress.",
  columns: [col("label", "Progress"), n("goals", "Goals"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS goals, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN COALESCE(g.progress_pct, 0) = 0 THEN '0 Not started' WHEN g.progress_pct < 25 THEN '1 Under 25%' WHEN g.progress_pct < 50 THEN '2 25% to 49%' WHEN g.progress_pct < 75 THEN '3 50% to 74%'
                         WHEN g.progress_pct < 100 THEN '4 75% to 99%' ELSE '5 Complete' END AS band
              FROM ${GOAL_FROM} WHERE ${GW(q)}) b GROUP BY b.band ORDER BY b.band`,
};
const GOAL_DUE_BY_MONTH: ReportSectionSpec = {
  key: "goals-due-by-month",
  title: "Goals by due month",
  description: "Goals falling due each month, how many were completed and how many are still open.",
  columns: [col("month", "Due month"), n("goals", "Goals"), n("completed", "Completed"), n("open", "Still open"), n("pastDue", "Open and past due")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', g.due_date), 'YYYY-MM') AS month, COUNT(*)::int AS goals, COUNT(*) FILTER (WHERE g.status = 'completed')::int AS completed,
           COUNT(*) FILTER (WHERE g.status NOT IN ('completed', 'cancelled'))::int AS open, COUNT(*) FILTER (WHERE g.status NOT IN ('completed', 'cancelled') AND g.due_date < ${q.today})::int AS "pastDue"
      FROM ${GOAL_FROM} WHERE ${GW(q)} AND g.due_date IS NOT NULL GROUP BY 1 ORDER BY 1`,
};
const GOAL_OVERDUE_AGE: ReportSectionSpec = {
  key: "goals-overdue-age",
  title: "How overdue open goals are",
  description: "Open goals past their due date, grouped by how long ago they were due.",
  columns: [col("label", "Overdue by"), n("goals", "Goals"), pc("progress", "Average progress (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS goals, ROUND(AVG(b.progress), 1) AS progress
      FROM (SELECT g.progress_pct AS progress, CASE WHEN ${q.today} - g.due_date <= 30 THEN '0 Up to a month' WHEN ${q.today} - g.due_date <= 90 THEN '1 One to three months' WHEN ${q.today} - g.due_date <= 180 THEN '2 Three to six months' ELSE '3 Over six months' END AS band
              FROM ${GOAL_FROM} WHERE ${GW(q)} AND g.status NOT IN ('completed', 'cancelled') AND g.due_date < ${q.today}) b GROUP BY b.band ORDER BY b.band`,
};
const GOAL_STRUCTURE: ReportSectionSpec = {
  key: "goal-structure",
  title: "Goal setting quality",
  description: "How well goals are set up: how many have a due date, a target, a weight, a parent goal above them, or are tied to a cycle.",
  columns: [col("label", "Check"), n("goals", "Goals"), n("with", "Goals that pass"), pc("share", "Pass (%)")],
  sql: (q) => `
    SELECT t.label, COUNT(*)::int AS goals, COUNT(*) FILTER (WHERE t.ok)::int AS "with", ROUND(COUNT(*) FILTER (WHERE t.ok) * 100.0 / COUNT(*), 1) AS share
      FROM (SELECT x.label, x.ok FROM ${GOAL_FROM}, LATERAL (VALUES ('Has a due date', g.due_date IS NOT NULL), ('Has a measurable target', g.target_value IS NOT NULL), ('Has a weight', COALESCE(g.weight, 0) > 0),
                 ('Aligned to a parent goal', g.parent_goal_id IS NOT NULL), ('Tied to a review cycle', g.review_cycle_id IS NOT NULL)) AS x(label, ok) WHERE ${GW(q)}) t GROUP BY t.label ORDER BY share ASC, t.label`,
};
const GOAL_WEIGHT: ReportSectionSpec = {
  key: "weight-check",
  title: "People whose goal weights do not add up to 100",
  description: "Counts of people whose weighted goals add up to exactly 100, under 100 or over 100.",
  columns: [col("label", "Weights add up to"), n("people", "People")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS people
      FROM (SELECT CASE WHEN w = 100 THEN '1 Exactly 100' WHEN w < 100 THEN '0 Under 100' ELSE '2 Over 100' END AS band
              FROM (SELECT g.employee_id, SUM(COALESCE(g.weight, 0)) AS w FROM ${GOAL_FROM} WHERE ${GW(q)} GROUP BY g.employee_id) x) b GROUP BY b.band ORDER BY b.band`,
};
const GOALS_PER_PERSON: ReportSectionSpec = {
  key: "goals-per-person",
  title: "Goals per person",
  description: "How many people have 1, 2, 3 or more goals. Counts only.",
  columns: [col("label", "Goals held"), n("people", "People")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS people
      FROM (SELECT CASE WHEN c = 1 THEN '0 One goal' WHEN c = 2 THEN '1 Two goals' WHEN c <= 5 THEN '2 Three to five goals' ELSE '3 More than five goals' END AS band
              FROM (SELECT g.employee_id, COUNT(*) AS c FROM ${GOAL_FROM} WHERE ${GW(q)} GROUP BY g.employee_id) x) b GROUP BY b.band ORDER BY b.band`,
};
const PEOPLE_WITHOUT_GOALS: ReportSectionSpec = {
  key: "without-goals-by-unit",
  title: "People with no goals, by organisation unit",
  description: "Current employees in your scope who have no goal in the period. Counts only.",
  columns: [col("label", "Organisation unit"), n("employees", "Current employees"), n("without", "With no goals"), pc("share", "With no goals (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS employees, COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM goals g WHERE g.employee_id = e.id AND g.company_id = e.company_id AND g.status <> 'cancelled'
             AND COALESCE(g.due_date, g.created_at::date) BETWEEN ${q.from} AND ${q.to}))::int AS without,
           ROUND(COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM goals g WHERE g.employee_id = e.id AND g.company_id = e.company_id AND g.status <> 'cancelled' AND COALESCE(g.due_date, g.created_at::date) BETWEEN ${q.from} AND ${q.to})) * 100.0 / COUNT(*), 1) AS share
      FROM employees e ${UNIT_JOIN} WHERE ${q.emp()} AND ${q.current()} GROUP BY ou.id, ou.name ORDER BY without DESC, label`,
};
const GOAL_RECORDS: ReportSectionSpec = {
  key: "goal-records",
  title: "Goals",
  description: "Every goal with its owner, status, weight, target, progress and due date. Goal titles and descriptions are not shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("cycle", "Review cycle"), col("status", "Status"), n("weight", "Weight"), n("target", "Target"), col("unit2", "Target unit"), n("current", "Current value"), pc("progress", "Progress (%)"), col("due", "Due", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COALESCE(rc.name, 'Not tied to a cycle') AS cycle, ${LABEL("g.status")} AS status, g.weight AS weight, g.target_value AS target,
           COALESCE(g.target_unit, '') AS unit2, g.current_value AS current, g.progress_pct AS progress, g.due_date::text AS due
      FROM ${GOAL_FROM} ${UNIT_JOIN} LEFT JOIN review_cycles rc ON rc.id = g.review_cycle_id WHERE ${GW(q)} ORDER BY name, g.due_date NULLS LAST`,
};
const GOAL_AT_RISK: ReportSectionSpec = {
  key: "goals-at-risk",
  title: "Goals at risk or past due",
  description: "Open goals that are at risk, overdue or past their due date.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("status", "Status"), pc("progress", "Progress (%)"), col("due", "Due", "date"), n("late", "Days past due")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("g.status")} AS status, g.progress_pct AS progress, g.due_date::text AS due,
           CASE WHEN g.due_date < ${q.today} THEN (${q.today} - g.due_date)::int END AS late
      FROM ${GOAL_FROM} ${UNIT_JOIN}
     WHERE ${GW(q)} AND g.status NOT IN ('completed', 'cancelled') AND (g.status IN ('at_risk', 'overdue') OR g.due_date < ${q.today}) ORDER BY late DESC NULLS LAST, name`,
};
const GOAL_STATUS_CYCLE: ReportSectionSpec = {
  key: "goal-status-by-month",
  title: "Goals created and completed by month",
  description: "How many goals were set and how many were completed each month.",
  columns: [col("month", "Month"), n("created", "Goals set"), n("completed", "Goals completed")],
  sql: (q) => `
    SELECT m.month, COALESCE(c.n, 0)::int AS created, COALESCE(d.n, 0)::int AS completed
      FROM (SELECT to_char(date_trunc('month', g.created_at), 'YYYY-MM') AS month FROM ${GOAL_FROM} WHERE ${GW(q)}
            UNION SELECT to_char(date_trunc('month', g.completed_at), 'YYYY-MM') FROM ${GOAL_FROM} WHERE ${GW(q)} AND g.completed_at IS NOT NULL) m
      LEFT JOIN (SELECT to_char(date_trunc('month', g.created_at), 'YYYY-MM') AS month, COUNT(*) AS n FROM ${GOAL_FROM} WHERE ${GW(q)} GROUP BY 1) c ON c.month = m.month
      LEFT JOIN (SELECT to_char(date_trunc('month', g.completed_at), 'YYYY-MM') AS month, COUNT(*) AS n FROM ${GOAL_FROM} WHERE ${GW(q)} AND g.completed_at IS NOT NULL GROUP BY 1) d ON d.month = m.month ORDER BY m.month`,
};
const GOAL_PEOPLE_UNIT: ReportSectionSpec = {
  key: "people-by-unit",
  title: "People and goals by organisation unit",
  description: "People with goals, goals held and the weight set, for each unit.",
  columns: [col("label", "Organisation unit"), n("people", "People with goals"), n("goals", "Goals"), n("perPerson", "Goals per person"), n("withTarget", "Goals with a target")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(DISTINCT g.employee_id)::int AS people, COUNT(*)::int AS goals, ROUND(COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT g.employee_id), 0), 1) AS "perPerson", COUNT(*) FILTER (WHERE g.target_value IS NOT NULL)::int AS "withTarget"
      FROM ${GOAL_FROM} ${UNIT_JOIN} WHERE ${GW(q)} GROUP BY ou.id, ou.name ORDER BY goals DESC, label`,
};
const G06_BANDS: ReportSectionSpec = {
  key: "person-progress-bands",
  title: "People by goal progress",
  description: "How many people have their goals in each band of weighted progress.",
  columns: [col("label", "Weighted progress"), n("people", "People")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS people
      FROM (SELECT CASE WHEN p IS NULL THEN '0 No weighted goals' WHEN p < 25 THEN '1 Under 25%' WHEN p < 50 THEN '2 25% to 49%' WHEN p < 75 THEN '3 50% to 74%' WHEN p < 100 THEN '4 75% to 99%' ELSE '5 Complete' END AS band
              FROM (SELECT g.employee_id, SUM(g.progress_pct * g.weight) FILTER (WHERE g.weight > 0) / NULLIF(SUM(g.weight) FILTER (WHERE g.weight > 0), 0) AS p FROM ${GOAL_FROM} WHERE ${GW(q)} GROUP BY g.employee_id) x) b
     GROUP BY b.band ORDER BY b.band`,
};

// ---------------------------------------------------------------- ratings (sensitive reports only; groups of 5 or more)

const RATED = (q: Q) => `${RW(q)} AND ${BEST} IS NOT NULL`;
const RATING_BY_CYCLE: ReportSectionSpec = {
  key: "rating-by-cycle",
  title: "Ratings by cycle",
  description: "Rating distribution for each cycle. A cycle with fewer than 5 rated people is not shown.",
  columns: [col("cycle", "Review cycle"), n("rated", "People rated"), n("r1", "Rating 1"), n("r2", "Rating 2"), n("r3", "Rating 3"), n("r4", "Rating 4"), n("r5", "Rating 5"), n("average", "Average rating")],
  sql: (q) => `
    SELECT rc.name AS cycle, COUNT(*)::int AS rated, COUNT(*) FILTER (WHERE ${BEST} = 1)::int AS r1, COUNT(*) FILTER (WHERE ${BEST} = 2)::int AS r2, COUNT(*) FILTER (WHERE ${BEST} = 3)::int AS r3,
           COUNT(*) FILTER (WHERE ${BEST} = 4)::int AS r4, COUNT(*) FILTER (WHERE ${BEST} = 5)::int AS r5, ROUND(AVG(${BEST}), 2) AS average
      FROM ${REV} WHERE ${RATED(q)} GROUP BY rc.id HAVING COUNT(*) >= ${MIN_RATED} ORDER BY rc.period_start DESC`,
};
const RATING_BY_UNIT: ReportSectionSpec = {
  key: "rating-by-unit",
  title: "Ratings by organisation unit",
  description: "Average rating and distribution for each unit. A unit with fewer than 5 rated people is not shown.",
  columns: [col("label", "Organisation unit"), n("rated", "People rated"), n("average", "Average rating"), n("high", "Rated 4 or 5"), n("low", "Rated 1 or 2"), pc("highShare", "Rated 4 or 5 (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS rated, ROUND(AVG(${BEST}), 2) AS average, COUNT(*) FILTER (WHERE ${BEST} >= 4)::int AS high, COUNT(*) FILTER (WHERE ${BEST} <= 2)::int AS low,
           ROUND(COUNT(*) FILTER (WHERE ${BEST} >= 4) * 100.0 / COUNT(*), 1) AS "highShare"
      FROM ${REV} ${UNIT_JOIN} WHERE ${RATED(q)} GROUP BY ou.id, ou.name HAVING COUNT(*) >= ${MIN_RATED} ORDER BY average DESC, label`,
};
const RATING_BY_LOCATION: ReportSectionSpec = {
  key: "rating-by-location",
  title: "Ratings by location",
  description: "Average rating for each location. A location with fewer than 5 rated people is not shown.",
  columns: [col("label", "Location"), n("rated", "People rated"), n("average", "Average rating"), pc("highShare", "Rated 4 or 5 (%)")],
  sql: (q) => `
    SELECT COALESCE(l.name, 'No location set') AS label, COUNT(*)::int AS rated, ROUND(AVG(${BEST}), 2) AS average, ROUND(COUNT(*) FILTER (WHERE ${BEST} >= 4) * 100.0 / COUNT(*), 1) AS "highShare"
      FROM ${REV} LEFT JOIN locations l ON l.id = e.location_id WHERE ${RATED(q)} GROUP BY l.id, l.name HAVING COUNT(*) >= ${MIN_RATED} ORDER BY average DESC, label`,
};
const RATING_BY_TYPE: ReportSectionSpec = {
  key: "rating-by-employment-type",
  title: "Ratings by employment type",
  description: "Average rating by employment type. A type with fewer than 5 rated people is not shown.",
  columns: [col("label", "Employment type"), n("rated", "People rated"), n("average", "Average rating"), pc("highShare", "Rated 4 or 5 (%)")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(INITCAP(REPLACE(e.employment_type, '_', ' ')), ''), 'Not set') AS label, COUNT(*)::int AS rated, ROUND(AVG(${BEST}), 2) AS average, ROUND(COUNT(*) FILTER (WHERE ${BEST} >= 4) * 100.0 / COUNT(*), 1) AS "highShare"
      FROM ${REV} WHERE ${RATED(q)} GROUP BY 1 HAVING COUNT(*) >= ${MIN_RATED} ORDER BY average DESC, label`,
};
const RATING_BY_TENURE: ReportSectionSpec = {
  key: "rating-by-tenure",
  title: "Ratings by years of service",
  description: "Average rating by length of service at the end of the cycle. A band with fewer than 5 rated people is not shown.",
  columns: [col("label", "Years of service"), n("rated", "People rated"), n("average", "Average rating"), pc("highShare", "Rated 4 or 5 (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS rated, ROUND(AVG(b.rating), 2) AS average, ROUND(COUNT(*) FILTER (WHERE b.rating >= 4) * 100.0 / COUNT(*), 1) AS "highShare"
      FROM (SELECT ${BEST} AS rating, CASE WHEN e.date_of_joining IS NULL THEN '5 Joining date not set' WHEN (rc.period_end - e.date_of_joining) < 365 THEN '0 Under 1 year' WHEN (rc.period_end - e.date_of_joining) < 1095 THEN '1 1 to 3 years'
                     WHEN (rc.period_end - e.date_of_joining) < 1825 THEN '2 3 to 5 years' WHEN (rc.period_end - e.date_of_joining) < 3650 THEN '3 5 to 10 years' ELSE '4 Over 10 years' END AS band
              FROM ${REV} WHERE ${RATED(q)}) b GROUP BY b.band HAVING COUNT(*) >= ${MIN_RATED} ORDER BY b.band`,
};
const RATING_MATRIX: ReportSectionSpec = {
  key: "manager-vs-final",
  title: "Manager rating compared with the final rating",
  description: "How the manager's rating moved to the final rating. Hidden when fewer than 5 people have both.",
  columns: [col("label", "Manager rating"), n("lower", "Final rating lower"), n("same", "Final rating the same"), n("higher", "Final rating higher"), n("total", "People")],
  sql: (q) => `
    SELECT 'Rated ' || pr.manager_rating::text AS label, COUNT(*) FILTER (WHERE COALESCE(pr.final_rating, pr.calibration_rating) < pr.manager_rating)::int AS lower,
           COUNT(*) FILTER (WHERE COALESCE(pr.final_rating, pr.calibration_rating) = pr.manager_rating)::int AS same, COUNT(*) FILTER (WHERE COALESCE(pr.final_rating, pr.calibration_rating) > pr.manager_rating)::int AS higher, COUNT(*)::int AS total
      FROM ${REV} WHERE ${RW(q)} AND pr.manager_rating IS NOT NULL AND COALESCE(pr.final_rating, pr.calibration_rating) IS NOT NULL
       AND (SELECT COUNT(*) FROM ${REV} WHERE ${RW(q)} AND pr.manager_rating IS NOT NULL AND COALESCE(pr.final_rating, pr.calibration_rating) IS NOT NULL) >= ${MIN_RATED}
     GROUP BY pr.manager_rating ORDER BY pr.manager_rating`,
};
const CALIBRATION_MOVE: ReportSectionSpec = {
  key: "calibration-movement",
  title: "Calibration movement by cycle",
  description: "For each cycle: how many ratings calibration raised, lowered or left alone. Hidden for a cycle with fewer than 5 calibrated reviews.",
  columns: [col("cycle", "Review cycle"), n("calibrated", "Calibrated reviews"), n("raised", "Raised"), n("lowered", "Lowered"), n("same", "Unchanged"), n("noComment", "Changed with no comment")],
  sql: (q) => `
    SELECT rc.name AS cycle, COUNT(*)::int AS calibrated, COUNT(*) FILTER (WHERE pr.calibration_rating > pr.manager_rating)::int AS raised, COUNT(*) FILTER (WHERE pr.calibration_rating < pr.manager_rating)::int AS lowered,
           COUNT(*) FILTER (WHERE pr.calibration_rating = pr.manager_rating)::int AS same, COUNT(*) FILTER (WHERE pr.calibration_rating IS DISTINCT FROM pr.manager_rating AND COALESCE(TRIM(pr.calibration_comment), '') = '')::int AS "noComment"
      FROM ${REV} WHERE ${RW(q)} AND pr.calibration_rating IS NOT NULL AND pr.manager_rating IS NOT NULL GROUP BY rc.id HAVING COUNT(*) >= ${MIN_RATED} ORDER BY rc.period_start DESC`,
};
const CALIBRATION_ISSUES_BY_UNIT: ReportSectionSpec = {
  key: "calibration-by-unit",
  title: "Calibration exceptions by organisation unit",
  description: "For each unit: reviews with a calibration exception, without showing which rating. Counts only.",
  columns: [col("label", "Organisation unit"), n("reviews", "Reviews"), n("moved2", "Moved by two points or more"), n("noComment", "Calibrated with no comment"), n("notCalibrated", "Not calibrated"), n("finalDiffers", "Final differs from calibrated")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS reviews,
           COUNT(*) FILTER (WHERE pr.calibration_rating IS NOT NULL AND pr.manager_rating IS NOT NULL AND ABS(pr.calibration_rating - pr.manager_rating) >= 2)::int AS moved2,
           COUNT(*) FILTER (WHERE pr.calibration_rating IS NOT NULL AND COALESCE(TRIM(pr.calibration_comment), '') = '' AND pr.manager_rating IS DISTINCT FROM pr.calibration_rating)::int AS "noComment",
           COUNT(*) FILTER (WHERE rc.status IN ('calibration', 'closed') AND pr.manager_rating IS NOT NULL AND pr.calibration_rating IS NULL)::int AS "notCalibrated",
           COUNT(*) FILTER (WHERE pr.final_rating IS NOT NULL AND pr.calibration_rating IS NOT NULL AND pr.final_rating <> pr.calibration_rating)::int AS "finalDiffers"
      FROM ${REV} ${UNIT_JOIN} WHERE ${RW(q)} GROUP BY ou.id, ou.name ORDER BY moved2 DESC, label`,
};
const CALIBRATION_BY_CYCLE: ReportSectionSpec = {
  key: "calibration-by-cycle",
  title: "Calibration exceptions by cycle",
  description: "For each cycle: how many reviews were rated by the manager, calibrated and released. Counts only.",
  columns: [col("cycle", "Review cycle"), n("managerRated", "Manager rated"), n("calibrated", "Calibrated"), n("finalRated", "Final rating set"), n("released", "Released")],
  sql: (q) => `
    SELECT rc.name AS cycle, COUNT(*) FILTER (WHERE pr.manager_rating IS NOT NULL)::int AS "managerRated", COUNT(*) FILTER (WHERE pr.calibration_rating IS NOT NULL)::int AS calibrated,
           COUNT(*) FILTER (WHERE pr.final_rating IS NOT NULL)::int AS "finalRated", COUNT(*) FILTER (WHERE pr.released_at IS NOT NULL)::int AS released
      FROM ${REV} WHERE ${RW(q)} GROUP BY rc.id ORDER BY rc.period_start DESC`,
};
const COMPETENCY_BY_CATEGORY: ReportSectionSpec = {
  key: "competency-by-category",
  title: "Competencies by category",
  description: "Average self and manager rating for each competency category. Hidden when fewer than 3 ratings.",
  columns: [col("category", "Category"), n("competencies", "Competencies"), n("ratings", "Ratings"), n("self", "Average self rating"), n("manager", "Average manager rating"), n("gap", "Self minus manager")],
  sql: (q) => `
    SELECT COALESCE(INITCAP(c.category), 'Not set') AS category, COUNT(DISTINCT c.id)::int AS competencies, COUNT(*)::int AS ratings, ROUND(AVG(rr.rating) FILTER (WHERE rr.source = 'self'), 2) AS self,
           ROUND(AVG(rr.rating) FILTER (WHERE rr.source = 'manager'), 2) AS manager, ROUND(AVG(rr.rating) FILTER (WHERE rr.source = 'self') - AVG(rr.rating) FILTER (WHERE rr.source = 'manager'), 2) AS gap
      FROM review_ratings rr JOIN competencies c ON c.id = rr.competency_id JOIN performance_reviews pr ON pr.id = rr.review_id JOIN review_cycles rc ON rc.id = pr.review_cycle_id JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id
     WHERE ${RW(q)} GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY category`,
};
const COMPETENCY_BY_UNIT: ReportSectionSpec = {
  key: "competency-by-unit",
  title: "Competencies by organisation unit",
  description: "Average rating for each competency in each unit. Hidden when fewer than 5 ratings.",
  columns: [col("label", "Organisation unit"), col("competency", "Competency"), n("ratings", "Ratings"), n("average", "Average rating")],
  sql: (q) => `
    SELECT ${UNIT} AS label, c.name AS competency, COUNT(*)::int AS ratings, ROUND(AVG(rr.rating), 2) AS average
      FROM review_ratings rr JOIN competencies c ON c.id = rr.competency_id JOIN performance_reviews pr ON pr.id = rr.review_id JOIN review_cycles rc ON rc.id = pr.review_cycle_id JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id ${UNIT_JOIN}
     WHERE ${RW(q)} GROUP BY ou.id, ou.name, c.id HAVING COUNT(*) >= ${MIN_RATED} ORDER BY label, average ASC, competency`,
};
const COMPETENCY_BY_CYCLE: ReportSectionSpec = {
  key: "competency-by-cycle",
  title: "Competencies by cycle",
  description: "Average rating for each competency in each cycle. Hidden when fewer than 3 ratings.",
  columns: [col("cycle", "Review cycle"), col("competency", "Competency"), n("ratings", "Ratings"), n("average", "Average rating")],
  sql: (q) => `
    SELECT rc.name AS cycle, c.name AS competency, COUNT(*)::int AS ratings, ROUND(AVG(rr.rating), 2) AS average
      FROM review_ratings rr JOIN competencies c ON c.id = rr.competency_id JOIN performance_reviews pr ON pr.id = rr.review_id JOIN review_cycles rc ON rc.id = pr.review_cycle_id JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id
     WHERE ${RW(q)} GROUP BY rc.id, c.id HAVING COUNT(*) >= 3 ORDER BY rc.period_start DESC, average ASC, competency`,
};
const COMPETENCY_COVERAGE: ReportSectionSpec = {
  key: "competency-coverage",
  title: "Competencies never rated",
  description: "Active competencies with no rating in the period.",
  columns: [col("code", "Code"), col("competency", "Competency"), col("category", "Category")],
  sql: (q) => `
    SELECT COALESCE(c.code, '') AS code, c.name AS competency, COALESCE(INITCAP(c.category), 'Not set') AS category
      FROM competencies c WHERE ${q.co("c")} AND c.is_active
       AND NOT EXISTS (SELECT 1 FROM review_ratings rr JOIN performance_reviews pr ON pr.id = rr.review_id JOIN review_cycles rc ON rc.id = pr.review_cycle_id JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id
                       WHERE rr.competency_id = c.id AND ${RW(q)}) ORDER BY category, competency`,
};
const CAL_RECORDS: ReportSectionSpec = {
  key: "calibration-records",
  title: "Ratings through the stages",
  description: "For each rated review: the manager rating, calibrated rating and final rating side by side. Comments are not shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("cycle", "Review cycle"), n("manager", "Manager rating"), n("calibrated", "Calibrated rating"), n("final", "Final rating"), col("calibratedOn", "Calibrated on", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, rc.name AS cycle, pr.manager_rating AS manager, pr.calibration_rating AS calibrated, pr.final_rating AS final, pr.calibrated_at::date::text AS "calibratedOn"
      FROM ${REV} ${UNIT_JOIN} WHERE ${RW(q)} AND (pr.manager_rating IS NOT NULL OR pr.calibration_rating IS NOT NULL OR pr.final_rating IS NOT NULL) ORDER BY rc.period_start DESC, name`,
};

// ---------------------------------------------------------------- feedback

const FB_FROM = "feedback_requests fr JOIN employees e ON e.id = fr.subject_employee_id AND e.company_id = fr.company_id";
const FB_W = (q: Q) => `${q.emp()} AND fr.requested_at::date BETWEEN ${q.from} AND ${q.to}`;
const FB_BY_UNIT: ReportSectionSpec = {
  key: "feedback-by-unit",
  title: "Feedback requests by organisation unit",
  description: "For the unit of the person receiving feedback: requests, answers, declines and overdue. Who said what is never shown.",
  columns: [col("label", "Organisation unit"), n("asked", "Requested"), n("submitted", "Submitted"), n("declined", "Declined"), n("overdue", "Waiting and overdue"), pc("rate", "Response rate (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS asked, COUNT(*) FILTER (WHERE fr.status = 'submitted')::int AS submitted, COUNT(*) FILTER (WHERE fr.status = 'declined')::int AS declined,
           COUNT(*) FILTER (WHERE fr.status = 'requested' AND fr.due_date < ${q.today})::int AS overdue, ROUND(COUNT(*) FILTER (WHERE fr.status = 'submitted') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE fr.status <> 'cancelled'), 0), 1) AS rate
      FROM ${FB_FROM} ${UNIT_JOIN} WHERE ${FB_W(q)} GROUP BY ou.id, ou.name ORDER BY asked DESC, label`,
};
const FB_BY_MONTH: ReportSectionSpec = {
  key: "feedback-by-month",
  title: "Feedback requests by month",
  description: "Requests made and answered each month.",
  columns: [col("month", "Month"), n("asked", "Requested"), n("submitted", "Submitted"), n("declined", "Declined"), n("waiting", "Still waiting"), n("anonymous", "Anonymous requests")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', fr.requested_at), 'YYYY-MM') AS month, COUNT(*)::int AS asked, COUNT(*) FILTER (WHERE fr.status = 'submitted')::int AS submitted, COUNT(*) FILTER (WHERE fr.status = 'declined')::int AS declined,
           COUNT(*) FILTER (WHERE fr.status = 'requested')::int AS waiting, COUNT(*) FILTER (WHERE fr.is_anonymous)::int AS anonymous
      FROM ${FB_FROM} WHERE ${FB_W(q)} GROUP BY 1 ORDER BY 1`,
};
const FB_SPEED: ReportSectionSpec = {
  key: "feedback-response-time",
  title: "How quickly feedback is given",
  description: "Days from the request to the answer. Counts only.",
  columns: [col("label", "Answered within"), n("requests", "Requests")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS requests
      FROM (SELECT CASE WHEN d <= 2 THEN '0 Two days' WHEN d <= 7 THEN '1 A week' WHEN d <= 14 THEN '2 Two weeks' ELSE '3 More than two weeks' END AS band
              FROM (SELECT (fr.responded_at::date - fr.requested_at::date) AS d FROM ${FB_FROM} WHERE ${FB_W(q)} AND fr.responded_at IS NOT NULL AND fr.status = 'submitted') x) b GROUP BY b.band ORDER BY b.band`,
};
const FB_PER_SUBJECT: ReportSectionSpec = {
  key: "feedback-per-person",
  title: "Feedback received per person",
  description: "How many people received 0, 1 to 2, 3 to 5 or more answers. Counts only.",
  columns: [col("label", "Answers received"), n("people", "People")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS people
      FROM (SELECT CASE WHEN c = 0 THEN '0 None' WHEN c <= 2 THEN '1 One or two' WHEN c <= 5 THEN '2 Three to five' ELSE '3 More than five' END AS band
              FROM (SELECT fr.subject_employee_id, COUNT(*) FILTER (WHERE fr.status = 'submitted') AS c FROM ${FB_FROM} WHERE ${FB_W(q)} GROUP BY fr.subject_employee_id) x) b GROUP BY b.band ORDER BY b.band`,
};
const FB_OVERDUE_BANDS: ReportSectionSpec = {
  key: "feedback-overdue-age",
  title: "How overdue waiting requests are",
  description: "Requests still waiting after their due date, grouped by days overdue. Counts only.",
  columns: [col("label", "Overdue by"), col("raterType", "Rater type"), n("requests", "Requests")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, b.rater AS "raterType", COUNT(*)::int AS requests
      FROM (SELECT ${LABEL("fr.rater_type")} AS rater, CASE WHEN ${q.today} - fr.due_date <= 7 THEN '0 Up to a week' WHEN ${q.today} - fr.due_date <= 30 THEN '1 One to four weeks' ELSE '2 Over a month' END AS band
              FROM ${FB_FROM} WHERE ${FB_W(q)} AND fr.status = 'requested' AND fr.due_date < ${q.today}) b GROUP BY b.band, b.rater ORDER BY b.band, b.rater`,
};
const FB_BY_CYCLE: ReportSectionSpec = {
  key: "feedback-by-cycle",
  title: "Feedback by review cycle",
  description: "Requests tied to each review cycle and how many were answered.",
  columns: [col("label", "Review cycle"), n("asked", "Requested"), n("submitted", "Submitted"), pc("rate", "Response rate (%)")],
  sql: (q) => `
    SELECT COALESCE(rc.name, 'Not tied to a cycle') AS label, COUNT(*)::int AS asked, COUNT(*) FILTER (WHERE fr.status = 'submitted')::int AS submitted,
           ROUND(COUNT(*) FILTER (WHERE fr.status = 'submitted') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE fr.status <> 'cancelled'), 0), 1) AS rate
      FROM ${FB_FROM} LEFT JOIN performance_reviews pr ON pr.id = fr.review_id LEFT JOIN review_cycles rc ON rc.id = pr.review_cycle_id WHERE ${FB_W(q)} GROUP BY rc.id, rc.name ORDER BY asked DESC, label`,
};

// ---------------------------------------------------------------- development plans

const DP_FROM = "development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id";
const DP_W = (q: Q) => `${q.emp()} AND dp.created_at::date BETWEEN ${q.from} AND ${q.to}`;
const DP_BY_UNIT: ReportSectionSpec = {
  key: "plans-by-unit",
  title: "Development plans by organisation unit",
  description: "For each unit: plans, people, actions and how many actions are done or past due.",
  columns: [col("label", "Organisation unit"), n("plans", "Plans"), n("people", "People"), n("items", "Actions"), n("done", "Actions done"), n("overdue", "Actions past due"), pc("rate", "Actions done (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(DISTINCT dp.id)::int AS plans, COUNT(DISTINCT dp.employee_id)::int AS people, COUNT(i.id)::int AS items, COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done,
           COUNT(i.id) FILTER (WHERE i.status <> 'done' AND i.due_date < ${q.today})::int AS overdue, ROUND(COUNT(i.id) FILTER (WHERE i.status = 'done') * 100.0 / NULLIF(COUNT(i.id), 0), 1) AS rate
      FROM ${DP_FROM} ${UNIT_JOIN} LEFT JOIN development_plan_items i ON i.plan_id = dp.id WHERE ${DP_W(q)} GROUP BY ou.id, ou.name ORDER BY plans DESC, label`,
};
const DP_ITEM_TYPE: ReportSectionSpec = {
  key: "actions-by-type",
  title: "Development actions by type",
  description: "The kinds of action in the plans: courses, stretch tasks, mentoring and so on, with how many are done.",
  columns: [col("label", "Action type"), n("items", "Actions"), n("done", "Done"), n("overdue", "Past due"), pc("rate", "Done (%)")],
  sql: (q) => `
    SELECT ${LABEL("COALESCE(i.item_type, 'other')")} AS label, COUNT(*)::int AS items, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done, COUNT(*) FILTER (WHERE i.status <> 'done' AND i.due_date < ${q.today})::int AS overdue,
           ROUND(COUNT(*) FILTER (WHERE i.status = 'done') * 100.0 / COUNT(*), 1) AS rate
      FROM ${DP_FROM} JOIN development_plan_items i ON i.plan_id = dp.id WHERE ${DP_W(q)} GROUP BY i.item_type ORDER BY items DESC, label`,
};
const DP_COMPETENCY: ReportSectionSpec = {
  key: "actions-by-competency",
  title: "Development actions by competency",
  description: "Which competencies the plans are meant to build, with the number of actions and people.",
  columns: [col("competency", "Competency"), col("category", "Category"), n("items", "Actions"), n("people", "People"), n("done", "Done")],
  sql: (q) => `
    SELECT c.name AS competency, COALESCE(INITCAP(c.category), 'Not set') AS category, COUNT(*)::int AS items, COUNT(DISTINCT dp.employee_id)::int AS people, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done
      FROM ${DP_FROM} JOIN development_plan_items i ON i.plan_id = dp.id JOIN competencies c ON c.id = i.competency_id WHERE ${DP_W(q)} GROUP BY c.id ORDER BY items DESC, competency`,
};
const DP_COURSE: ReportSectionSpec = {
  key: "actions-linked-to-courses",
  title: "Plans that use learning",
  description: "Actions linked to a course in the learning catalogue and how many are done.",
  columns: [col("course", "Course"), n("items", "Actions"), n("people", "People"), n("done", "Done")],
  sql: (q) => `
    SELECT co.title AS course, COUNT(*)::int AS items, COUNT(DISTINCT dp.employee_id)::int AS people, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done
      FROM ${DP_FROM} JOIN development_plan_items i ON i.plan_id = dp.id JOIN courses co ON co.id = i.course_id WHERE ${DP_W(q)} GROUP BY co.id ORDER BY items DESC, course`,
};
const DP_DUE: ReportSectionSpec = {
  key: "actions-due-by-month",
  title: "Actions by due month",
  description: "Development actions falling due each month and how many are done.",
  columns: [col("month", "Due month"), n("items", "Actions"), n("done", "Done"), n("open", "Open"), n("overdue", "Open and past due")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', i.due_date), 'YYYY-MM') AS month, COUNT(*)::int AS items, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done, COUNT(*) FILTER (WHERE i.status <> 'done')::int AS open,
           COUNT(*) FILTER (WHERE i.status <> 'done' AND i.due_date < ${q.today})::int AS overdue
      FROM ${DP_FROM} JOIN development_plan_items i ON i.plan_id = dp.id WHERE ${DP_W(q)} AND i.due_date IS NOT NULL GROUP BY 1 ORDER BY 1`,
};
const DP_PLANS: ReportSectionSpec = {
  key: "plans",
  title: "Development plans",
  description: "Each plan with its owner, status, target date and action counts. Objectives and notes are not shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("status", "Plan status"), col("target", "Target date", "date"), n("items", "Actions"), n("done", "Done"), n("overdue", "Past due")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("dp.status")} AS status, dp.target_date::text AS target, COUNT(i.id)::int AS items,
           COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done, COUNT(i.id) FILTER (WHERE i.status <> 'done' AND i.due_date < ${q.today})::int AS overdue
      FROM ${DP_FROM} ${UNIT_JOIN} LEFT JOIN development_plan_items i ON i.plan_id = dp.id WHERE ${DP_W(q)} GROUP BY dp.id, e.id, ou.name ORDER BY name, dp.created_at DESC`,
};
const DP_NO_ACTIONS: ReportSectionSpec = {
  key: "plans-without-actions",
  title: "Plans with no actions",
  description: "Development plans that have no action yet.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("status", "Plan status"), col("created", "Created", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("dp.status")} AS status, dp.created_at::date::text AS created
      FROM ${DP_FROM} WHERE ${DP_W(q)} AND NOT EXISTS (SELECT 1 FROM development_plan_items i WHERE i.plan_id = dp.id) ORDER BY dp.created_at DESC`,
};

export const PERFORMANCE_DEPTH: Record<string, ReportSectionSpec[]> = {
  G01: [REVIEW_STATUS, REVIEW_BY_UNIT, PHASES, REVIEW_PIPELINE, RELEASE_BY_MONTH],
  G02: [REVIEW_STATUS, REVIEW_BY_LOCATION, REVIEW_PIPELINE, REVIEW_NOT_STARTED, SUBMIT_TIMING],
  G03: [OVERDUE_AGE, BY_MANAGER_CYCLE, REVIEW_BY_UNIT, SUBMIT_TIMING, PHASES],
  G04: [GOAL_STATUS_BY_UNIT, GOAL_BY_CYCLE, GOAL_PROGRESS_BANDS, GOAL_DUE_BY_MONTH, GOAL_OVERDUE_AGE, GOAL_STRUCTURE, GOAL_STATUS_CYCLE],
  G05: [GOAL_PEOPLE_UNIT, GOAL_STATUS_BY_UNIT, GOAL_PROGRESS_BANDS, GOALS_PER_PERSON, PEOPLE_WITHOUT_GOALS, GOAL_WEIGHT, GOAL_BY_CYCLE],
  G06: [GOAL_RECORDS, GOAL_AT_RISK, G06_BANDS, GOAL_WEIGHT, GOAL_STRUCTURE, GOALS_PER_PERSON],
  G07: [RATING_BY_CYCLE, RATING_BY_UNIT, RATING_BY_LOCATION, RATING_BY_TYPE, RATING_BY_TENURE, RATING_MATRIX],
  G08: [CALIBRATION_MOVE, CALIBRATION_ISSUES_BY_UNIT, CALIBRATION_BY_CYCLE, CAL_RECORDS],
  G09: [BY_MANAGER_CYCLE, REVIEW_BY_UNIT, OVERDUE_AGE, SUBMIT_TIMING, REVIEW_NOT_STARTED],
  G10: [SELF_BY_UNIT, SUBMIT_TIMING, REVIEW_NOT_STARTED, REVIEW_BY_LOCATION, PHASES],
  G11: [FB_BY_UNIT, FB_BY_MONTH, FB_SPEED, FB_PER_SUBJECT, FB_OVERDUE_BANDS, FB_BY_CYCLE],
  G13: [COMPETENCY_BY_CATEGORY, COMPETENCY_BY_CYCLE, COMPETENCY_BY_UNIT, COMPETENCY_COVERAGE],
  G14: [DP_BY_UNIT, DP_ITEM_TYPE, DP_COMPETENCY, DP_COURSE, DP_DUE, DP_PLANS, DP_NO_ACTIONS],
  G15: [PHASES, SUBMIT_TIMING, RELEASE_BY_MONTH, REVIEW_STATUS, OVERDUE_AGE],
};
