import { DEPT, ETYPE, LOC, barChart, count, listReport, pct, percent, round1, sqlReport, sum } from "../report-spec";

/**
 * Learning and development reports (catalog L01, L02, L04, L05, L09, L10, L15). They cover courses and enrolments,
 * certifications and development plans for the people in the caller's scope.
 *
 * Skills and succession data do not exist in the product yet, so reports that
 * need them (L07, L08, L11, L12, L14) stay blocked in the catalog rather than being approximated.
 *
 * "Overdue" is derived, never stored: not completed and a due date before today.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const LABEL = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const FILTERS = [DEPT, LOC, ETYPE];
const ENROL = `course_enrollments ce JOIN courses c ON c.id = ce.course_id AND c.company_id = ce.company_id JOIN employees e ON e.id = ce.employee_id AND e.company_id = ce.company_id`;

export const L01 = sqlReport({
  description: "Each course: how many people were enrolled in the period and where they stand.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["course_enrollments", "courses", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["training", "enrolment"],
  columns: [
    { key: "course", label: "Course", type: "text" },
    { key: "category", label: "Category", type: "text" },
    { key: "enrolled", label: "Enrolled", type: "number" },
    { key: "assigned", label: "Not started", type: "number" },
    { key: "inProgress", label: "In progress", type: "number" },
    { key: "completed", label: "Completed", type: "number" },
  ],
  sql: (q) => `
    SELECT c.title AS course, ${LABEL("c.category")} AS category, COUNT(*)::int AS enrolled, COUNT(*) FILTER (WHERE ce.status = 'assigned')::int AS assigned,
           COUNT(*) FILTER (WHERE ce.status = 'in_progress')::int AS "inProgress", COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed
      FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY c.id, c.title, c.category ORDER BY enrolled DESC, course`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Enrolments per course", unit: "enrolments", rows, labelKey: "course", valueKey: "enrolled", max: 12 }) : null),
  kpis: ({ rows }) => [count("enrolled", "Enrolments", sum(rows, "enrolled")), count("people", "Courses used", rows.length), count("completed", "Completed", sum(rows, "completed"))],
  calculation: ["Counts enrolments created in the range for employees in your scope, by course and where each enrolment stands today."],
});

export const L02 = sqlReport({
  description: "Share of enrolments completed, by course category, and how long completion took.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["course_enrollments", "courses", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["training", "completion"],
  columns: [
    { key: "category", label: "Category", type: "text" },
    { key: "enrolled", label: "Enrolled", type: "number" },
    { key: "completed", label: "Completed", type: "number" },
    { key: "rate", label: "Completion (%)", type: "percent" },
    { key: "daysToFinish", label: "Average days to complete", type: "number" },
  ],
  sql: (q) => `
    SELECT ${LABEL("c.category")} AS category, COUNT(*)::int AS enrolled, COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed,
           ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * 100.0 / COUNT(*), 1) AS rate,
           ROUND((AVG(EXTRACT(EPOCH FROM (ce.completed_at - ce.created_at)) / 86400.0) FILTER (WHERE ce.status = 'completed'))::numeric, 1) AS "daysToFinish"
      FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY c.category ORDER BY rate ASC, category`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Completion by category", unit: "percent", rows, labelKey: "category", valueKey: "rate", valueLabel: "Completion (%)" }) : null),
  kpis: ({ rows }) => [count("enrolled", "Enrolments", sum(rows, "enrolled")), percent("rate", "Completed", pct(sum(rows, "completed"), sum(rows, "enrolled")))],
  calculation: ["Enrolments created in the range. Completed means status completed. Days to complete run from enrolment to the completion time."],
});

export const L04 = listReport({
  description: "Enrolments not completed whose due date has passed.",
  filters: FILTERS,
  tables: ["course_enrollments", "courses", "employees"],
  tags: ["training", "overdue"],
  countLabel: "Overdue enrolments",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "course", label: "Course", type: "text" },
    { key: "category", label: "Category", type: "text" },
    { key: "due", label: "Was due", type: "date" },
    { key: "late", label: "Days overdue", type: "number" },
    { key: "progress", label: "Progress (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, c.title AS course, ${LABEL("c.category")} AS category, ce.due_date::text AS due, (${q.today} - ce.due_date)::int AS late, ce.progress_percent AS progress
      FROM ${ENROL} WHERE ${q.emp()} AND ${q.current()} AND ce.status <> 'completed' AND ce.due_date < ${q.today}
     ORDER BY late DESC, name`,
  kpis: ({ rows }) => [count("people", "People with overdue training", new Set(rows.map((r) => r.number)).size), { key: "avg", label: "Average days overdue", value: rows.length ? round1(sum(rows, "late") / rows.length) : null, unit: "days" as const }],
  calculation: ["Lists enrolments of current employees in your scope that are not completed and have a due date before today."],
});

export const L05 = sqlReport({
  description: "Training hours completed in the period, by organisation unit.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["course_enrollments", "courses", "employees", "org_units"],
  viz: ["bar", "kpi", "table"],
  tags: ["training", "hours"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "people", label: "People trained", type: "number" },
    { key: "completions", label: "Courses completed", type: "number" },
    { key: "hours", label: "Training hours", type: "number" },
    { key: "perPerson", label: "Hours per person trained", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(DISTINCT ce.employee_id)::int AS people, COUNT(*)::int AS completions, ROUND(SUM(c.duration_minutes) / 60.0, 1) AS hours,
           ROUND(SUM(c.duration_minutes) / 60.0 / COUNT(DISTINCT ce.employee_id), 1) AS "perPerson"
      FROM ${ENROL} LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ce.status = 'completed' AND ce.completed_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY ou.id, ou.name ORDER BY hours DESC, unit`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Training hours by unit", unit: "hours", rows, labelKey: "unit", valueKey: "hours", max: 12 }) : null),
  kpis: ({ rows }) => [{ key: "hours", label: "Training hours", value: round1(sum(rows, "hours")), unit: "count" as const }, count("completions", "Courses completed", sum(rows, "completions"))],
  calculation: ["Counts completed enrolments whose completion time is in the range. Hours are each course's planned duration, not time actually spent."],
});

export const L09 = listReport({
  description: "Certifications and other qualifications that have expired or will expire soon.",
  filters: FILTERS,
  defaultRange: "pastAndNext90Days",
  tables: ["employee_qualifications", "employees"],
  tags: ["certification", "expiry"],
  countLabel: "Expiring or expired",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "title", label: "Qualification", type: "text" },
    { key: "authority", label: "Issued by", type: "text" },
    { key: "expiry", label: "Expires", type: "date" },
    { key: "left", label: "Days left", type: "number" },
    { key: "state", label: "State", type: "text" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("qf.qualification_type")} AS type, qf.title AS title, COALESCE(qf.issuing_authority, '-') AS authority, qf.expiry_date::text AS expiry,
           (qf.expiry_date - ${q.today})::int AS left, CASE WHEN qf.expiry_date < ${q.today} THEN 'Expired' ELSE 'Expires soon' END AS state
      FROM employee_qualifications qf JOIN employees e ON e.id = qf.employee_id AND e.company_id = qf.company_id
     WHERE ${q.emp()} AND ${q.current()} AND qf.status = 'active' AND qf.expiry_date IS NOT NULL AND qf.expiry_date BETWEEN ${q.from} AND ${q.to}
     ORDER BY qf.expiry_date, name`,
  kpis: ({ rows }) => [count("expired", "Already expired", rows.filter((r) => r.state === "Expired").length), count("soon", "Expiring soon", rows.filter((r) => r.state === "Expires soon").length)],
  calculation: ["Lists active qualifications of current employees with an expiry date inside the range. Days left is negative for qualifications that have already expired.", "Qualifications with no expiry date are not listed."],
});

export const L10 = listReport({
  description: "Each development plan: its status, target date and how many of its actions are done.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["development_plans", "development_plan_items", "employees"],
  tags: ["development", "plans", "progress"],
  countLabel: "Plans",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "plan", label: "Plan", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "target", label: "Target date", type: "date" },
    { key: "done", label: "Actions done", type: "number" },
    { key: "total", label: "Actions", type: "number" },
    { key: "progress", label: "Progress (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, dp.title AS plan, ${LABEL("dp.status")} AS status, dp.target_date::text AS target,
           COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done, COUNT(i.id)::int AS total, ROUND(COUNT(i.id) FILTER (WHERE i.status = 'done') * 100.0 / NULLIF(COUNT(i.id), 0), 0) AS progress
      FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id LEFT JOIN development_plan_items i ON i.plan_id = dp.id AND i.company_id = dp.company_id
     WHERE ${q.emp()} AND dp.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY dp.id, e.id ORDER BY progress ASC NULLS FIRST, name`,
  kpis: ({ rows }) => [{ key: "avg", label: "Average progress", value: rows.length ? round1(sum(rows.filter((r) => r.progress != null), "progress") / Math.max(1, rows.filter((r) => r.progress != null).length)) : null, unit: "percent" as const }],
  calculation: ["One line per development plan created in the range for people in your scope. Progress is actions done divided by all actions; plans with no actions show no progress."],
});

export const L15 = listReport({
  description: "Development plans that need attention: no actions, a target date that has passed, or actions overdue.",
  filters: FILTERS,
  tables: ["development_plans", "development_plan_items", "employees"],
  tags: ["development", "exceptions"],
  countLabel: "Exceptions",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "plan", label: "Plan", type: "text" },
    { key: "exception", label: "Exception", type: "text" },
    { key: "detail", label: "Detail", type: "text" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, dp.title AS plan, x.exception, x.detail
      FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id
      CROSS JOIN LATERAL (
        SELECT 'No actions' AS exception, 'The plan has no actions yet' AS detail WHERE NOT EXISTS (SELECT 1 FROM development_plan_items i WHERE i.plan_id = dp.id)
        UNION ALL
        SELECT 'Target date passed', 'Target was ' || dp.target_date::text WHERE dp.status NOT IN ('completed', 'cancelled') AND dp.target_date < ${q.today}
        UNION ALL
        SELECT 'Actions overdue', COUNT(*)::text || ' action(s) past due, oldest ' || MIN(i.due_date)::text FROM development_plan_items i
         WHERE i.plan_id = dp.id AND i.status <> 'done' AND i.due_date < ${q.today} HAVING COUNT(*) > 0
      ) x
     WHERE ${q.emp()} AND dp.status NOT IN ('completed', 'cancelled')
     ORDER BY x.exception, name`,
  kpis: ({ rows }) => [count("plans", "Plans with an exception", new Set(rows.map((r) => `${r.number}|${r.plan}`)).size), count("overdue", "With overdue actions", rows.filter((r) => r.exception === "Actions overdue").length)],
  calculation: ["Checks every plan that is not completed or cancelled. A plan can appear more than once if it has more than one exception.", "An action is overdue when it is not done and its due date is before today."],
});

export const L03 = sqlReport({
  description: "For each mandatory course, how many current employees have completed it, are working on it, or have not started, and how many are past their due date.",
  filters: FILTERS,
  tables: ["courses", "course_enrollments", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["training", "compliance", "mandatory"],
  columns: [
    { key: "course", label: "Mandatory course", type: "text" },
    { key: "required", label: "Employees", type: "number" },
    { key: "completed", label: "Completed", type: "number" },
    { key: "inProgress", label: "In progress", type: "number" },
    { key: "notStarted", label: "Assigned, not started", type: "number" },
    { key: "notAssigned", label: "Not assigned yet", type: "number" },
    { key: "overdue", label: "Past due date", type: "number" },
    { key: "compliance", label: "Compliance (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT c.title AS course, COUNT(*)::int AS required,
           COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed,
           COUNT(*) FILTER (WHERE ce.status = 'in_progress')::int AS "inProgress",
           COUNT(*) FILTER (WHERE ce.status = 'assigned')::int AS "notStarted",
           COUNT(*) FILTER (WHERE ce.id IS NULL)::int AS "notAssigned",
           COUNT(*) FILTER (WHERE ce.status IN ('assigned', 'in_progress') AND ce.due_date < ${q.today})::int AS overdue,
           ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * 100.0 / COUNT(*), 1) AS compliance
      FROM courses c
      CROSS JOIN employees e
      LEFT JOIN course_enrollments ce ON ce.course_id = c.id AND ce.employee_id = e.id AND ce.company_id = c.company_id
     WHERE ${q.co("c")} AND c.is_mandatory AND c.is_active AND ${q.emp()} AND ${q.current()}
     GROUP BY c.id, c.title ORDER BY compliance ASC, course`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Compliance by mandatory course", unit: "percent", rows, labelKey: "course", valueKey: "compliance", valueLabel: "Compliance (%)", max: 12 }) : null),
  kpis: ({ rows }) => {
    const required = sum(rows, "required");
    const done = sum(rows, "completed");
    return [percent("overall", "Overall compliance", required ? round1((done * 100) / required) : null, "Completed assignments across all mandatory courses"), count("courses", "Mandatory courses", rows.length), count("overdue", "Past due date", sum(rows, "overdue"))];
  },
  notes: ({ rows }) => (rows.length === 0 ? ["No active course is marked mandatory yet. Tick “Mandatory” when adding a course in Learning."] : []),
  calculation: [
    "Takes every active course marked mandatory and every current employee in your scope (joined, not terminated), so each course is measured against the same people.",
    "An employee with no enrolment in the course counts under Not assigned yet and is not compliant.",
    "Past due date means assigned or in progress with a due date before today. Compliance is completed divided by employees, to one decimal place.",
  ],
});

export const L06 = sqlReport({
  description: "What training cost in the period: for each course, enrolments, completions, cost per participant and the total cost of those enrolments.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["courses", "course_enrollments", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["training", "cost"],
  columns: [
    { key: "course", label: "Course", type: "text" },
    { key: "category", label: "Category", type: "text" },
    { key: "enrolled", label: "Enrolled", type: "number" },
    { key: "completed", label: "Completed", type: "number" },
    { key: "costEach", label: "Cost per participant", type: "number" },
    { key: "totalCost", label: "Cost of enrolments", type: "number" },
    { key: "completedCost", label: "Cost of completions", type: "number" },
  ],
  sql: (q) => `
    SELECT c.title AS course, ${LABEL("c.category")} AS category, COUNT(*)::int AS enrolled, COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed,
           c.cost_amount AS "costEach",
           ROUND(COUNT(*) * c.cost_amount, 2) AS "totalCost",
           ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * c.cost_amount, 2) AS "completedCost"
      FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY c.id, c.title, c.category, c.cost_amount ORDER BY "totalCost" DESC NULLS LAST, course`,
  chart: ({ rows }) => {
    const costed = rows.filter((r) => r.totalCost !== null);
    return costed.length ? barChart({ title: "Cost of enrolments by course", unit: "PKR", rows: costed, labelKey: "course", valueKey: "totalCost", valueLabel: "Cost", max: 12 }) : null;
  },
  kpis: ({ rows }) => [count("total", "Cost of enrolments", round1(sum(rows.filter((r) => r.totalCost !== null), "totalCost"))), count("people", "Enrolments", sum(rows, "enrolled")), count("uncosted", "Courses with no cost recorded", rows.filter((r) => r.costEach === null).length)],
  notes: ({ rows }) => {
    const missing = rows.filter((r) => r.costEach === null).length;
    return missing ? [`${missing} course(s) used in this period have no cost recorded, so they add nothing to the totals. Costs are never estimated.`] : [];
  },
  calculation: [
    "Cost per participant is the figure entered on the course. Cost of enrolments is enrolments created in the range times that figure; cost of completions counts only those completed.",
    "Courses with no cost recorded show no cost and add nothing to the totals. Amounts are in the company currency (PKR for Pakistan).",
  ],
});
