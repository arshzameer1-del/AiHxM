import { DEPT, ETYPE, LOC, barChart, count, donutChart, listReport, num, pct, percent, round1, sqlReport, sum, type Q } from "../report-spec";

/**
 * Performance and goals reports (catalog G01 to G15, except G12). Scope is performance_review.view.all (everyone) or
 * performance_review.view.team (direct reports), applied through the employee. Ratings are sensitive: the rating reports
 * need reports.view.sensitive, hide groups too small to be anonymous, and never show free-text assessments or comments.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const STATUS = (col: string) => `INITCAP(REPLACE(${col}, '_', ' ')) `;
const FILTERS = [DEPT, LOC, ETYPE];
const CYCLE_IN_RANGE = (q: Q) => `rc.period_end >= ${q.from} AND rc.period_start <= ${q.to}`;
const REV = `performance_reviews pr JOIN review_cycles rc ON rc.id = pr.review_cycle_id AND rc.company_id = pr.company_id JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id`;
const DONE = "pr.status IN ('completed', 'calibrated', 'released')";
const BEST_RATING = "COALESCE(pr.final_rating, pr.calibration_rating, pr.manager_rating)";
const MIN_GROUP = 5;

export const G01 = sqlReport({
  description: "Each review cycle: its status, the current phase and how many reviews sit at each stage.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["review_cycles", "review_cycle_phases", "performance_reviews", "employees"],
  viz: ["kpi", "table"],
  tags: ["cycles", "status"],
  columns: [
    { key: "cycle", label: "Review cycle", type: "text" },
    { key: "status", label: "Cycle status", type: "text" },
    { key: "phase", label: "Current phase", type: "text" },
    { key: "reviews", label: "Reviews", type: "number" },
    { key: "pending", label: "Not started", type: "number" },
    { key: "inProgress", label: "In progress", type: "number" },
    { key: "completed", label: "Completed", type: "number" },
    { key: "calibrated", label: "Calibrated", type: "number" },
    { key: "released", label: "Released", type: "number" },
  ],
  sql: (q) => `
    SELECT rc.name AS cycle, ${STATUS("rc.status")} AS status,
           COALESCE((SELECT ${STATUS("p.phase_key")} FROM review_cycle_phases p WHERE p.review_cycle_id = rc.id AND ${q.today} BETWEEN p.starts_on AND p.ends_on ORDER BY p.starts_on LIMIT 1), 'No phase today') AS phase,
           COUNT(pr.id)::int AS reviews, COUNT(pr.id) FILTER (WHERE pr.status = 'pending')::int AS pending, COUNT(pr.id) FILTER (WHERE pr.status = 'in_progress')::int AS "inProgress",
           COUNT(pr.id) FILTER (WHERE pr.status = 'completed')::int AS completed, COUNT(pr.id) FILTER (WHERE pr.status = 'calibrated')::int AS calibrated, COUNT(pr.id) FILTER (WHERE pr.status = 'released')::int AS released
      FROM review_cycles rc
      LEFT JOIN (performance_reviews pr JOIN employees e ON e.id = pr.employee_id AND ${q.emp()}) ON pr.review_cycle_id = rc.id
     WHERE ${q.co("rc")} AND ${CYCLE_IN_RANGE(q)}
     GROUP BY rc.id ORDER BY rc.period_start DESC, rc.name`,
  kpis: ({ rows }) => [count("cycles", "Cycles", rows.length), count("active", "Cycles under way", rows.filter((r) => r.status === "Active" || r.status === "Calibration").length), count("reviews", "Reviews", sum(rows, "reviews"))],
  calculation: ["Lists review cycles whose period overlaps the range and counts the reviews of employees in your scope at each status.", "Current phase is the phase whose dates include today; cycles with no phase dates show 'No phase today'."],
});

export const G02 = sqlReport({
  description: "Share of reviews that have reached completed or beyond, for each organisation unit.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["performance_reviews", "review_cycles", "employees", "org_units"],
  viz: ["bar", "kpi", "table"],
  tags: ["completion", "reviews"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "reviews", label: "Reviews", type: "number" },
    { key: "done", label: "Completed or beyond", type: "number" },
    { key: "rate", label: "Completion (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE ${DONE})::int AS done, ROUND(COUNT(*) FILTER (WHERE ${DONE}) * 100.0 / COUNT(*), 1) AS rate
      FROM ${REV} LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)}
     GROUP BY ou.id, ou.name ORDER BY rate ASC, unit`,
  chart: ({ rows }) => barChart({ title: "Review completion by unit", unit: "percent", rows, labelKey: "unit", valueKey: "rate", valueLabel: "Completion (%)", max: 12 }),
  kpis: ({ rows }) => [percent("rate", "Completion", pct(sum(rows, "done"), sum(rows, "reviews"))), count("reviews", "Reviews", sum(rows, "reviews"))],
  calculation: ["Counts reviews in cycles that overlap the range. Completed means the review has reached completed, calibrated or released.", "Completion is completed-or-beyond divided by all reviews, as a percentage."],
});

export const G03 = listReport({
  description: "Reviews where a self-assessment or manager assessment is still outstanding after its phase ended.",
  filters: FILTERS,
  tables: ["performance_reviews", "review_cycle_phases", "review_cycles", "employees"],
  tags: ["overdue", "reviews"],
  countLabel: "Overdue steps",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "cycle", label: "Review cycle", type: "text" },
    { key: "step", label: "Outstanding step", type: "text" },
    { key: "due", label: "Was due", type: "date" },
    { key: "late", label: "Days overdue", type: "number" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT e.employee_number AS number, ${NAME("e")} AS name, rc.name AS cycle, 'Self-assessment' AS step, ph.ends_on::text AS due, (${q.today} - ph.ends_on)::int AS late
        FROM ${REV} JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'self_assessment'
       WHERE ${q.emp()} AND rc.status IN ('active', 'calibration') AND pr.status IN ('pending', 'in_progress') AND pr.self_assessment_submitted_at IS NULL AND ph.ends_on < ${q.today}
      UNION ALL
      SELECT e.employee_number, ${NAME("e")}, rc.name, 'Manager assessment', ph.ends_on::text, (${q.today} - ph.ends_on)::int
        FROM ${REV} JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'manager_assessment'
       WHERE ${q.emp()} AND rc.status IN ('active', 'calibration') AND pr.status IN ('pending', 'in_progress') AND pr.manager_assessment_submitted_at IS NULL AND ph.ends_on < ${q.today}
    ) t ORDER BY late DESC, name`,
  kpis: ({ rows }) => [count("people", "People with an overdue step", new Set(rows.map((r) => r.number)).size), { key: "avgLate", label: "Average days overdue", value: rows.length ? round1(sum(rows, "late") / rows.length) : null, unit: "days" as const }],
  calculation: ["A self-assessment is overdue when the self-assessment phase has ended, the review is not complete and no self-assessment was submitted. The same rule applies to the manager assessment and its phase.", "Only cycles that are active or in calibration are checked."],
});

export const G04 = sqlReport({
  description: "Goals by status with average progress and how many are past their due date.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["goals", "employees"],
  viz: ["donut", "kpi", "table"],
  tags: ["goals", "completion"],
  columns: [
    { key: "status", label: "Status", type: "text" },
    { key: "goals", label: "Goals", type: "number" },
    { key: "share", label: "Share (%)", type: "percent" },
    { key: "progress", label: "Average progress (%)", type: "percent" },
    { key: "pastDue", label: "Past due date", type: "number" },
  ],
  sql: (q) => `
    SELECT ${STATUS("g.status")} AS status, COUNT(*)::int AS goals, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, ROUND(AVG(g.progress_pct), 1) AS progress,
           COUNT(*) FILTER (WHERE g.status NOT IN ('completed', 'cancelled') AND g.due_date < ${q.today})::int AS "pastDue"
      FROM goals g JOIN employees e ON e.id = g.employee_id AND e.company_id = g.company_id
     WHERE ${q.emp()} AND COALESCE(g.due_date, g.created_at::date) BETWEEN ${q.from} AND ${q.to}
     GROUP BY g.status ORDER BY goals DESC, status`,
  chart: ({ rows }) => donutChart({ title: "Goals by status", unit: "goals", rows, labelKey: "status", valueKey: "goals" }),
  kpis: ({ rows }) => {
    const total = sum(rows, "goals");
    const done = num(rows.find((r) => r.status === "Completed") ?? {}, "goals");
    return [count("goals", "Goals", total), percent("done", "Completed", pct(done, total)), count("pastDue", "Past due date", sum(rows, "pastDue"))];
  },
  calculation: ["Includes goals due in the range, or created in the range when they have no due date.", "Past due means not completed or cancelled and a due date before today. Average progress is the simple average of each goal's progress percentage."],
});

export const G05 = sqlReport({
  description: "Goal progress for each organisation unit: goals, average progress, completed and at-risk.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["goals", "goal_updates", "employees", "org_units"],
  viz: ["bar", "table"],
  tags: ["goals", "unit"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "people", label: "People with goals", type: "number" },
    { key: "goals", label: "Goals", type: "number" },
    { key: "progress", label: "Average progress (%)", type: "percent" },
    { key: "completed", label: "Completed", type: "number" },
    { key: "atRisk", label: "At risk or overdue", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(DISTINCT g.employee_id)::int AS people, COUNT(*)::int AS goals, ROUND(AVG(g.progress_pct), 1) AS progress,
           COUNT(*) FILTER (WHERE g.status = 'completed')::int AS completed, COUNT(*) FILTER (WHERE g.status IN ('at_risk', 'overdue'))::int AS "atRisk"
      FROM goals g JOIN employees e ON e.id = g.employee_id AND e.company_id = g.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND g.status <> 'cancelled' AND COALESCE(g.due_date, g.created_at::date) BETWEEN ${q.from} AND ${q.to}
     GROUP BY ou.id, ou.name ORDER BY progress ASC NULLS LAST, unit`,
  chart: ({ rows }) => barChart({ title: "Average goal progress by unit", unit: "percent", rows, labelKey: "unit", valueKey: "progress", valueLabel: "Average progress (%)", max: 12 }),
  kpis: ({ rows }) => [count("goals", "Goals", sum(rows, "goals")), count("atRisk", "At risk or overdue", sum(rows, "atRisk"))],
  calculation: ["Includes goals due in the range (or created in it when they have no due date). Cancelled goals are left out.", "Progress is each goal's recorded progress percentage; the unit figure is the simple average."],
});

export const G06 = listReport({
  description: "Each person's goals: how many, average progress and how many are at risk. Shows only the people in your scope.",
  sensitivity: "sensitive",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["goals", "employees"],
  tags: ["goals", "employee"],
  countLabel: "People with goals",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "goals", label: "Goals", type: "number" },
    { key: "progress", label: "Average progress (%)", type: "percent" },
    { key: "weighted", label: "Weighted progress (%)", type: "percent" },
    { key: "atRisk", label: "At risk or overdue", type: "number" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS goals, ROUND(AVG(g.progress_pct), 1) AS progress,
           ROUND(SUM(g.progress_pct * g.weight) FILTER (WHERE g.weight > 0) / NULLIF(SUM(g.weight) FILTER (WHERE g.weight > 0), 0), 1) AS weighted,
           COUNT(*) FILTER (WHERE g.status IN ('at_risk', 'overdue'))::int AS "atRisk"
      FROM goals g JOIN employees e ON e.id = g.employee_id AND e.company_id = g.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND g.status <> 'cancelled' AND COALESCE(g.due_date, g.created_at::date) BETWEEN ${q.from} AND ${q.to}
     GROUP BY e.id, ou.name ORDER BY "atRisk" DESC, progress ASC NULLS LAST, name`,
  kpis: ({ rows }) => [count("atRisk", "People with an at-risk goal", rows.filter((r) => num(r, "atRisk") > 0).length), percent("avg", "Average progress", rows.length ? round1(sum(rows, "progress") / rows.length) : null)],
  calculation: ["One line per employee with goals due in the range. Cancelled goals are left out.", "Weighted progress weights each goal's progress by its weight; goals with no weight are left out of that column only."],
});

export const G07 = sqlReport({
  description: "How many people received each rating (1 to 5), using the final rating, else the calibrated rating, else the manager's rating. Hidden when fewer than 5 people are rated.",
  sensitivity: "sensitive",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["performance_reviews", "review_cycles", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["ratings", "distribution"],
  columns: [
    { key: "rating", label: "Rating", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "share", label: "Share of rated (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH r AS (SELECT ${BEST_RATING} AS rating FROM ${REV} WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)} AND ${BEST_RATING} IS NOT NULL)
    SELECT s.rating::text AS rating, COUNT(r.rating)::int AS people, ROUND(COUNT(r.rating) * 100.0 / NULLIF((SELECT COUNT(*) FROM r), 0), 1) AS share
      FROM generate_series(1, 5) AS s(rating) LEFT JOIN r ON r.rating = s.rating
     WHERE (SELECT COUNT(*) FROM r) >= ${MIN_GROUP}
     GROUP BY s.rating ORDER BY s.rating`,
  summary: (q) => `SELECT COUNT(*)::int AS rated FROM ${REV} WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)} AND ${BEST_RATING} IS NOT NULL`,
  chart: ({ rows }) => barChart({ title: "People by rating", unit: "people", rows, labelKey: "rating", valueKey: "people", valueLabel: "People" }),
  kpis: ({ rows, summary }) => [count("rated", "People rated", summary.rated ?? 0), { key: "avg", label: "Average rating", value: sum(rows, "people") ? Math.round((rows.reduce((s, r) => s + num(r, "rating") * num(r, "people"), 0) / sum(rows, "people")) * 100) / 100 : null, unit: "count" as const }],
  notes: ({ summary }) => ((summary.rated ?? 0) < MIN_GROUP ? [`Only ${summary.rated ?? 0} ${summary.rated === 1 ? "person has" : "people have"} a rating in this range and scope. With fewer than ${MIN_GROUP} the distribution could identify someone, so it is not shown.`] : []),
  calculation: ["Each review counts once, at its final rating if released, otherwise its calibrated rating, otherwise the manager's rating. Reviews with no rating are not counted.", "The report returns nothing when fewer than 5 people are rated, to protect individuals. Free-text comments are never shown."],
});

export const G08 = listReport({
  description: "Calibration results that deserve a second look: ratings moved by two points or more, calibrated with no comment, not calibrated when they should be, or a final rating that differs from the calibrated one.",
  sensitivity: "sensitive",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["performance_reviews", "review_cycles", "employees"],
  tags: ["calibration", "exceptions"],
  countLabel: "Exceptions",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "cycle", label: "Review cycle", type: "text" },
    { key: "manager", label: "Manager rating", type: "number" },
    { key: "calibrated", label: "Calibrated rating", type: "number" },
    { key: "final", label: "Final rating", type: "number" },
    { key: "issue", label: "Issue", type: "text" },
  ],
  sql: (q) => `
    WITH b AS (
      SELECT e.employee_number AS number, ${NAME("e")} AS name, rc.name AS cycle, rc.status AS cycle_status, pr.manager_rating AS manager, pr.calibration_rating AS calibrated, pr.final_rating AS final, pr.calibration_comment
        FROM ${REV} WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)})
    SELECT number, name, cycle, manager, calibrated, final, issue FROM (
      SELECT *, 'Moved by two points or more' AS issue FROM b WHERE calibrated IS NOT NULL AND manager IS NOT NULL AND ABS(calibrated - manager) >= 2
      UNION ALL SELECT *, 'Calibrated with no comment' FROM b WHERE calibrated IS NOT NULL AND COALESCE(TRIM(calibration_comment), '') = '' AND manager IS DISTINCT FROM calibrated
      UNION ALL SELECT *, 'Not calibrated' FROM b WHERE cycle_status IN ('calibration', 'closed') AND manager IS NOT NULL AND calibrated IS NULL
      UNION ALL SELECT *, 'Final differs from calibrated' FROM b WHERE final IS NOT NULL AND calibrated IS NOT NULL AND final <> calibrated
    ) t ORDER BY issue, name`,
  summary: (q) => `SELECT COUNT(*)::int AS rated FROM ${REV} WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)} AND pr.manager_rating IS NOT NULL`,
  kpis: ({ rows, summary }) => [count("rated", "Reviews with a manager rating", summary.rated ?? 0), count("people", "People affected", new Set(rows.map((r) => r.number)).size)],
  calculation: ["Reviews in cycles overlapping the range are checked against four fixed rules. One review can appear under more than one rule.", "Comments themselves are never shown; the report only notes whether one was recorded."],
});

export const G09 = sqlReport({
  description: "For each manager: reviews on their team, manager assessments submitted, and how many are overdue.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["performance_reviews", "org_relationships", "review_cycle_phases", "employees"],
  viz: ["bar", "table"],
  tags: ["managers", "completion"],
  columns: [
    { key: "manager", label: "Manager", type: "text" },
    { key: "reviews", label: "Reviews to write", type: "number" },
    { key: "submitted", label: "Submitted", type: "number" },
    { key: "overdue", label: "Overdue", type: "number" },
    { key: "rate", label: "Submitted (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("m")}, ''), 'No manager on record') AS manager, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE pr.manager_assessment_submitted_at IS NOT NULL)::int AS submitted,
           COUNT(*) FILTER (WHERE pr.manager_assessment_submitted_at IS NULL AND pr.status IN ('pending', 'in_progress') AND ph.ends_on < ${q.today})::int AS overdue,
           ROUND(COUNT(*) FILTER (WHERE pr.manager_assessment_submitted_at IS NOT NULL) * 100.0 / COUNT(*), 1) AS rate
      FROM ${REV}
      LEFT JOIN org_relationships r ON r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active'
      LEFT JOIN employees m ON m.id = r.manager_employee_id
      LEFT JOIN review_cycle_phases ph ON ph.review_cycle_id = rc.id AND ph.phase_key = 'manager_assessment'
     WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)}
     GROUP BY m.id, m.first_name, m.last_name ORDER BY overdue DESC, rate ASC, manager`,
  chart: ({ rows }) => barChart({ title: "Overdue manager assessments", unit: "reviews", rows: rows.filter((r) => num(r, "overdue") > 0), labelKey: "manager", valueKey: "overdue", valueLabel: "Overdue", max: 12 }),
  kpis: ({ rows }) => [percent("rate", "Submitted", pct(sum(rows, "submitted"), sum(rows, "reviews"))), count("overdue", "Overdue", sum(rows, "overdue"))],
  calculation: ["A review belongs to the person's current direct manager. A manager assessment counts as submitted when it has a submission time.", "Overdue means not submitted, review still pending or in progress, and the manager-assessment phase has ended."],
});

export const G10 = sqlReport({
  description: "How many employees submitted their self-assessment, cycle by cycle.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["performance_reviews", "review_cycles", "employees"],
  viz: ["bar", "table"],
  tags: ["self-assessment", "completion"],
  columns: [
    { key: "cycle", label: "Review cycle", type: "text" },
    { key: "reviews", label: "Reviews", type: "number" },
    { key: "submitted", label: "Self-assessments submitted", type: "number" },
    { key: "rate", label: "Submitted (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT rc.name AS cycle, COUNT(*)::int AS reviews, COUNT(*) FILTER (WHERE pr.self_assessment_submitted_at IS NOT NULL)::int AS submitted,
           ROUND(COUNT(*) FILTER (WHERE pr.self_assessment_submitted_at IS NOT NULL) * 100.0 / COUNT(*), 1) AS rate
      FROM ${REV} WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)} GROUP BY rc.id ORDER BY rc.period_start DESC`,
  chart: ({ rows }) => barChart({ title: "Self-assessments submitted", unit: "percent", rows, labelKey: "cycle", valueKey: "rate", valueLabel: "Submitted (%)", max: 12 }),
  kpis: ({ rows }) => [percent("rate", "Submitted", pct(sum(rows, "submitted"), sum(rows, "reviews"))), count("reviews", "Reviews", sum(rows, "reviews"))],
  calculation: ["A self-assessment counts as submitted when it has a submission time. Reviews in cycles overlapping the range are counted once each."],
});

export const G11 = sqlReport({
  description: "Feedback requests by rater type: how many were asked for, answered, declined or are overdue. Who said what is never shown.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["feedback_requests", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["feedback", "360"],
  columns: [
    { key: "type", label: "Rater type", type: "text" },
    { key: "asked", label: "Requested", type: "number" },
    { key: "submitted", label: "Submitted", type: "number" },
    { key: "declined", label: "Declined", type: "number" },
    { key: "waiting", label: "Waiting", type: "number" },
    { key: "overdue", label: "Waiting and overdue", type: "number" },
    { key: "rate", label: "Response rate (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT ${STATUS("fr.rater_type")} AS type, COUNT(*)::int AS asked, COUNT(*) FILTER (WHERE fr.status = 'submitted')::int AS submitted, COUNT(*) FILTER (WHERE fr.status = 'declined')::int AS declined,
           COUNT(*) FILTER (WHERE fr.status = 'requested')::int AS waiting, COUNT(*) FILTER (WHERE fr.status = 'requested' AND fr.due_date < ${q.today})::int AS overdue,
           ROUND(COUNT(*) FILTER (WHERE fr.status = 'submitted') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE fr.status <> 'cancelled'), 0), 1) AS rate
      FROM feedback_requests fr JOIN employees e ON e.id = fr.subject_employee_id AND e.company_id = fr.company_id
     WHERE ${q.emp()} AND fr.requested_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY fr.rater_type ORDER BY asked DESC, type`,
  chart: ({ rows }) => barChart({ title: "Response rate by rater type", unit: "percent", rows, labelKey: "type", valueKey: "rate", valueLabel: "Response rate (%)" }),
  kpis: ({ rows }) => [percent("rate", "Response rate", pct(sum(rows, "submitted"), sum(rows, "asked"))), count("overdue", "Waiting and overdue", sum(rows, "overdue"))],
  calculation: ["Counts feedback requests made in the range about people in your scope. Response rate is submitted divided by requests that were not cancelled.", "Only counts are shown. Rater names, ratings and comments are never part of this report, so anonymous feedback stays anonymous."],
});

export const G13 = sqlReport({
  description: "Average rating for each competency, split by self and manager, with the gap between them. Competencies with fewer than 3 ratings are hidden.",
  sensitivity: "sensitive",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["review_ratings", "competencies", "performance_reviews", "review_cycles", "employees"],
  viz: ["bar", "table"],
  tags: ["competencies", "gaps"],
  columns: [
    { key: "competency", label: "Competency", type: "text" },
    { key: "category", label: "Category", type: "text" },
    { key: "ratings", label: "Ratings", type: "number" },
    { key: "self", label: "Average self rating", type: "number" },
    { key: "manager", label: "Average manager rating", type: "number" },
    { key: "gap", label: "Self minus manager", type: "number" },
    { key: "average", label: "Average of all ratings", type: "number" },
  ],
  sql: (q) => `
    SELECT c.name AS competency, COALESCE(INITCAP(c.category), 'Not set') AS category, COUNT(*)::int AS ratings, ROUND(AVG(rr.rating) FILTER (WHERE rr.source = 'self'), 2) AS self,
           ROUND(AVG(rr.rating) FILTER (WHERE rr.source = 'manager'), 2) AS manager,
           ROUND(AVG(rr.rating) FILTER (WHERE rr.source = 'self') - AVG(rr.rating) FILTER (WHERE rr.source = 'manager'), 2) AS gap, ROUND(AVG(rr.rating), 2) AS average
      FROM review_ratings rr JOIN competencies c ON c.id = rr.competency_id JOIN performance_reviews pr ON pr.id = rr.review_id JOIN review_cycles rc ON rc.id = pr.review_cycle_id
      JOIN employees e ON e.id = pr.employee_id AND e.company_id = pr.company_id
     WHERE ${q.emp()} AND ${CYCLE_IN_RANGE(q)}
     GROUP BY c.id HAVING COUNT(*) >= 3 ORDER BY average ASC, competency`,
  chart: ({ rows }) => barChart({ title: "Average rating by competency", unit: "rating", rows, labelKey: "competency", valueKey: "average", valueLabel: "Average rating", max: 12 }),
  kpis: ({ rows }) => [count("competencies", "Competencies shown", rows.length)],
  calculation: ["Averages the 1 to 5 ratings given on each competency in reviews in cycles overlapping the range. A positive gap means people rate themselves higher than their managers do.", "Competencies with fewer than 3 ratings are hidden so a single person's rating cannot be read off."],
});

export const G14 = sqlReport({
  description: "Development plans by status, with how many actions are done and how many are past due.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["development_plans", "development_plan_items", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["development", "plans"],
  columns: [
    { key: "status", label: "Plan status", type: "text" },
    { key: "plans", label: "Plans", type: "number" },
    { key: "people", label: "People", type: "number" },
    { key: "items", label: "Actions", type: "number" },
    { key: "done", label: "Actions done", type: "number" },
    { key: "overdue", label: "Actions past due", type: "number" },
    { key: "rate", label: "Actions done (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT ${STATUS("dp.status")} AS status, COUNT(DISTINCT dp.id)::int AS plans, COUNT(DISTINCT dp.employee_id)::int AS people, COUNT(i.id)::int AS items, COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done,
           COUNT(i.id) FILTER (WHERE i.status <> 'done' AND i.due_date < ${q.today})::int AS overdue, ROUND(COUNT(i.id) FILTER (WHERE i.status = 'done') * 100.0 / NULLIF(COUNT(i.id), 0), 1) AS rate
      FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id LEFT JOIN development_plan_items i ON i.plan_id = dp.id
     WHERE ${q.emp()} AND dp.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY dp.status ORDER BY plans DESC, status`,
  chart: ({ rows }) => barChart({ title: "Plans by status", unit: "plans", rows, labelKey: "status", valueKey: "plans", valueLabel: "Plans" }),
  kpis: ({ rows }) => [count("plans", "Plans", sum(rows, "plans")), percent("rate", "Actions done", pct(sum(rows, "done"), sum(rows, "items"))), count("overdue", "Actions past due", sum(rows, "overdue"))],
  calculation: ["Counts development plans created in the range for people in your scope. An action is past due when it is not done and its due date is before today."],
});

export const G15 = sqlReport({
  description: "How long each review cycle took: its phase dates and the average days from a phase opening to people finishing it.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["review_cycles", "review_cycle_phases", "performance_reviews", "employees"],
  viz: ["table"],
  tags: ["cycle", "timeline", "turnaround"],
  columns: [
    { key: "cycle", label: "Review cycle", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "selfOpened", label: "Self-assessment opened", type: "date" },
    { key: "selfDays", label: "Average days to self-assess", type: "number" },
    { key: "managerOpened", label: "Manager assessment opened", type: "date" },
    { key: "managerDays", label: "Average days to assess", type: "number" },
    { key: "releaseOpened", label: "Release opened", type: "date" },
    { key: "releaseDays", label: "Average days to release", type: "number" },
  ],
  sql: (q) => `
    SELECT rc.name AS cycle, ${STATUS("rc.status")} AS status, sp.starts_on::text AS "selfOpened",
           ROUND(AVG(EXTRACT(EPOCH FROM (pr.self_assessment_submitted_at - sp.starts_on::timestamptz)) / 86400.0)::numeric, 1) AS "selfDays", mp.starts_on::text AS "managerOpened",
           ROUND(AVG(EXTRACT(EPOCH FROM (pr.manager_assessment_submitted_at - mp.starts_on::timestamptz)) / 86400.0)::numeric, 1) AS "managerDays", rp.starts_on::text AS "releaseOpened",
           ROUND(AVG(EXTRACT(EPOCH FROM (pr.released_at - rp.starts_on::timestamptz)) / 86400.0)::numeric, 1) AS "releaseDays"
      FROM review_cycles rc
      LEFT JOIN review_cycle_phases sp ON sp.review_cycle_id = rc.id AND sp.phase_key = 'self_assessment'
      LEFT JOIN review_cycle_phases mp ON mp.review_cycle_id = rc.id AND mp.phase_key = 'manager_assessment'
      LEFT JOIN review_cycle_phases rp ON rp.review_cycle_id = rc.id AND rp.phase_key = 'release'
      LEFT JOIN (performance_reviews pr JOIN employees e ON e.id = pr.employee_id AND ${q.emp()}) ON pr.review_cycle_id = rc.id
     WHERE ${q.co("rc")} AND ${CYCLE_IN_RANGE(q)}
     GROUP BY rc.id, sp.starts_on, mp.starts_on, rp.starts_on ORDER BY rc.period_start DESC`,
  kpis: ({ rows }) => [count("cycles", "Cycles", rows.length)],
  calculation: ["For each phase, the average is the time from the phase's start date to the moment each person finished it (self-assessment submitted, manager assessment submitted, rating released). People who have not finished are left out.", "Cycles without phase dates show blanks."],
});
