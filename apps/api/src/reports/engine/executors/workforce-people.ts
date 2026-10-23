import type { ReportRow } from "@aihxm/shared-types";
import { DEPT, ETYPE, LOC, barChart, count, donutChart, groupedReport, lineChart, listReport, num, pct, percent, round1, sqlReport, sum } from "../report-spec";

/**
 * Workforce overview and people-analytics reports (catalog A and M). Every query is built from the framework's scope
 * helpers, so tenant / team scope, the company limit and the chosen filters are applied by construction.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const NOT_DATED_LEAVER = "NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL)";

// ---------------------------------------------------------------- A. executive overview

export const A09 = sqlReport({
  description: "Month-end headcount with the change and the percentage growth from the previous month.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  viz: ["line", "kpi", "table"],
  tags: ["headcount", "growth", "trend"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "headcount", label: "Headcount at month end", type: "number" },
    { key: "change", label: "Change from previous month", type: "number" },
    { key: "growth", label: "Growth from previous month (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         h AS (SELECT mo.ms, COUNT(e.id)::int AS headcount
                 FROM mo LEFT JOIN employees e
                   ON ${q.emp()} AND e.date_of_joining <= mo.point AND ${NOT_DATED_LEAVER}
                  AND (e.termination_date IS NULL OR e.termination_date > mo.point)
                GROUP BY mo.ms)
    SELECT to_char(ms, 'YYYY-MM') AS month, headcount,
           headcount - LAG(headcount) OVER (ORDER BY ms) AS change,
           CASE WHEN LAG(headcount) OVER (ORDER BY ms) > 0
                THEN ROUND((headcount - LAG(headcount) OVER (ORDER BY ms)) * 100.0 / LAG(headcount) OVER (ORDER BY ms), 1) END AS growth
      FROM h ORDER BY ms`,
  chart: ({ rows }) => lineChart({ title: "Headcount growth from the previous month", unit: "percent", rows: rows.filter((r) => r.growth !== null), xKey: "month", series: [{ key: "growth", label: "Growth (%)" }] }),
  kpis: ({ rows }) => {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const s = first ? num(first, "headcount") : null;
    const e = last ? num(last, "headcount") : null;
    return [
      count("start", `Headcount, ${first?.month ?? ""}`, s),
      count("end", `Headcount, ${last?.month ?? ""}`, e),
      percent("growth", "Growth over the range", s !== null && e !== null ? pct(e - s, s) : null, s === 0 ? "No headcount at the start, so no percentage" : "Change divided by starting headcount"),
    ];
  },
  calculation: [
    "Headcount for a month is everyone who had joined on or before its last day and had not left by then. The current month is measured as of today.",
    "Growth for a month is its change from the previous month divided by the previous month's headcount. The first month has no previous month.",
    "Employees marked terminated with no termination date are left out of every month, because the month they left is unknown.",
  ],
});

export const A10 = groupedReport({
  description: "How many current employees report to each manager, using the active direct reporting line.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "org_relationships"],
  dimension: "Manager",
  valueLabel: "Direct reports",
  unit: "employees",
  totalLabel: "Employees counted",
  groupsLabel: "Managers",
  tags: ["manager", "span"],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("m")}, ''), 'Unknown manager') || COALESCE(' (' || m.employee_number || ')', '') AS label, COUNT(*)::int AS n
      FROM employees e
      LEFT JOIN org_relationships r ON r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active'
      LEFT JOIN employees m ON m.id = r.manager_employee_id
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY m.id, m.first_name, m.last_name, m.employee_number
     ORDER BY (m.id IS NULL), n DESC, label`,
  calculation: [
    "Counts current employees (joined, not terminated) under the manager named on their active direct reporting relationship.",
    "Employees with no active direct manager are grouped under 'Unknown manager' rather than dropped.",
    "Dotted-line, matrix and acting relationships are not counted here.",
  ],
});

export const A11 = sqlReport({
  description: "Gender and marital-status mix of the current workforce. Small groups are combined so no individual can be picked out.",
  filters: [DEPT, LOC, ETYPE],
  sensitivity: "sensitive",
  tables: ["employees"],
  viz: ["donut", "table"],
  tags: ["diversity", "demographics"],
  columns: [
    { key: "dimension", label: "Measure", type: "text" },
    { key: "label", label: "Group", type: "text" },
    { key: "n", label: "Employees", type: "number" },
    { key: "share", label: "Share within measure (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH base AS (
      SELECT 'Gender' AS dimension, COALESCE(NULLIF(INITCAP(e.gender), ''), 'Not recorded') AS label FROM employees e WHERE ${q.emp()} AND ${q.current()}
      UNION ALL
      SELECT 'Marital status', COALESCE(NULLIF(INITCAP(e.marital_status), ''), 'Not recorded') FROM employees e WHERE ${q.emp()} AND ${q.current()}),
    g AS (SELECT dimension, label, COUNT(*)::int AS n FROM base GROUP BY 1, 2),
    c AS (SELECT dimension, CASE WHEN n < 5 AND label <> 'Not recorded' THEN 'Other (groups under 5 combined)' ELSE label END AS label, n FROM g)
    SELECT dimension, label, SUM(n)::int AS n, ROUND(SUM(n) * 100.0 / SUM(SUM(n)) OVER (PARTITION BY dimension), 1) AS share
      FROM c GROUP BY dimension, label ORDER BY dimension, n DESC`,
  chart: ({ rows }) => donutChart({ title: "Gender mix", unit: "employees", rows: rows.filter((r) => r.dimension === "Gender"), labelKey: "label", valueKey: "n" }),
  kpis: ({ rows }) => [count("total", "Employees counted", sum(rows.filter((r) => r.dimension === "Gender"), "n"))],
  calculation: [
    "Current employees only (joined, not terminated). Values come from the employee record as entered.",
    "A group with fewer than 5 people is merged into 'Other (groups under 5 combined)' so a small count cannot identify someone.",
    "'Not recorded' means the field is empty on the record; it is shown as its own group, never guessed.",
    "Age is not reported because dates of birth are stored encrypted and cannot be aggregated.",
  ],
});

export const A12 = groupedReport({
  description: "How many employee lifecycle events of each kind took effect in the period: hires, transfers, promotions, terminations and so on.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["employee_lifecycle_events", "employees"],
  dimension: "Event type",
  valueLabel: "Events",
  unit: "events",
  totalLabel: "Events applied",
  groupsLabel: "Event types",
  tags: ["lifecycle", "events"],
  sql: (q) => `
    SELECT INITCAP(REPLACE(ev.action_type, '_', ' ')) AS label, COUNT(*)::int AS n
      FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
     WHERE ${q.emp()} AND ev.status = 'applied' AND ev.effective_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY ev.action_type ORDER BY n DESC, label`,
  calculation: [
    "Counts lifecycle events with status 'applied' whose effective date falls in the range. Scheduled, failed and cancelled events are excluded.",
    "One person with several events is counted once per event.",
  ],
});

export const A13 = sqlReport({
  description: "Open HR operations work: onboarding and offboarding in progress, overdue tasks, exit interviews, scheduled and failed lifecycle events, and organisation changes waiting.",
  domain: "organization",
  tables: ["employee_onboarding", "employee_offboarding", "employee_lifecycle_events", "employee_important_dates", "org_changes"],
  viz: ["kpi", "table"],
  tags: ["operations", "hr"],
  columns: [
    { key: "measure", label: "Measure", type: "text" },
    { key: "value", label: "Count", type: "number" },
    { key: "meaning", label: "What it counts", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT 1 AS ord, 'Onboarding in progress' AS measure, COUNT(*)::int AS value, 'New hires whose onboarding checklist is not complete' AS meaning
        FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id WHERE ${q.emp()} AND o.status = 'in_progress'
      UNION ALL
      SELECT 2, 'Overdue onboarding tasks', COUNT(*)::int, 'Pending onboarding tasks past their due date'
        FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id
       WHERE ${q.emp()} AND i.status = 'pending' AND i.due_date < ${q.today}
      UNION ALL
      SELECT 3, 'Offboarding in progress', COUNT(*)::int, 'Leavers whose exit checklist is not complete'
        FROM employee_offboarding f JOIN employees e ON e.id = f.employee_id WHERE ${q.emp()} AND f.status = 'in_progress'
      UNION ALL
      SELECT 4, 'Exit interviews pending', COUNT(*)::int, 'Exit interviews marked pending'
        FROM employee_offboarding f JOIN employees e ON e.id = f.employee_id WHERE ${q.emp()} AND f.exit_interview_status = 'pending'
      UNION ALL
      SELECT 5, 'Employees in a probation period', COUNT(*)::int, 'Current employees with a probation end date that has not passed'
        FROM employees e WHERE ${q.emp()} AND ${q.current()} AND EXISTS (SELECT 1 FROM employee_important_dates d WHERE d.employee_id = e.id AND d.date_type = 'probation_end' AND d.status = 'active' AND d.date_value >= ${q.today})
      UNION ALL
      SELECT 6, 'Scheduled lifecycle events', COUNT(*)::int, 'Future-dated changes waiting to be applied'
        FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id WHERE ${q.emp()} AND ev.status = 'scheduled'
      UNION ALL
      SELECT 7, 'Failed lifecycle events', COUNT(*)::int, 'Changes that could not be applied and need attention'
        FROM employee_lifecycle_events ev JOIN employees e ON e.id = ev.employee_id WHERE ${q.emp()} AND ev.status = 'failed'
      UNION ALL
      SELECT 8, 'Organisation changes awaiting approval', COUNT(*)::int, 'Organisation restructures submitted and not yet approved'
        FROM org_changes oc WHERE ${q.co("oc")} AND oc.status = 'pending_approval'
    ) t ORDER BY ord`,
  kpis: ({ rows }) => rows.slice(0, 4).map((r) => count(String(r.measure).toLowerCase().replace(/[^a-z]+/g, "_"), String(r.measure), num(r, "value"))),
  calculation: ["Each measure is a live count of open work as of now; nothing is estimated.", "Employee-level measures count only records for employees in your scope."],
});

export const A14 = sqlReport({
  description: "How completely key fields are filled in across current employees, field by field.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "org_relationships", "employee_addresses"],
  viz: ["bar", "kpi", "table"],
  tags: ["data quality", "completeness"],
  columns: [
    { key: "field", label: "Field", type: "text" },
    { key: "total", label: "Employees", type: "number" },
    { key: "filled", label: "Filled in", type: "number" },
    { key: "missing", label: "Missing", type: "number" },
    { key: "completeness", label: "Completeness (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT v.field, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE v.ok)::int AS filled, COUNT(*) FILTER (WHERE NOT v.ok)::int AS missing,
           ROUND(COUNT(*) FILTER (WHERE v.ok) * 100.0 / NULLIF(COUNT(*), 0), 1) AS completeness
      FROM employees e
     CROSS JOIN LATERAL (VALUES
        (1, 'Organisation unit', e.org_unit_id IS NOT NULL),
        (2, 'Position', e.position_id IS NOT NULL),
        (3, 'Work location', e.location_id IS NOT NULL),
        (4, 'Reporting manager', EXISTS (SELECT 1 FROM org_relationships r WHERE r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active')),
        (5, 'Email address', COALESCE(e.email, '') <> ''),
        (6, 'Phone number', COALESCE(e.phone, '') <> ''),
        (7, 'Date of birth', e.date_of_birth_enc IS NOT NULL OR e.date_of_birth IS NOT NULL),
        (8, 'National ID (CNIC)', e.cnic_bidx IS NOT NULL OR COALESCE(e.cnic, '') <> ''),
        (9, 'Address on file', EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active'))
     ) AS v(ord, field, ok)
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY v.ord, v.field ORDER BY v.ord`,
  chart: ({ rows }) => barChart({ title: "Completeness by field", unit: "percent", rows, labelKey: "field", valueKey: "completeness", valueLabel: "Completeness (%)", max: 12 }),
  kpis: ({ rows }) => [percent("avg", "Average completeness", rows.length ? round1(sum(rows, "completeness") / rows.length) : null, "Simple average across the fields listed"), count("fields", "Fields checked", rows.length)],
  calculation: [
    "Looks at current employees (joined, not terminated) and checks whether each field has a value. It never shows the value itself.",
    "Reporting manager is filled when the employee has an active direct reporting relationship. Address is filled when an active address exists.",
    "Completeness is filled divided by employees, to one decimal place.",
  ],
});

export const A15 = sqlReport({
  description: "One-page scorecard: headcount, 30-day joiners and leavers, 12-month attrition, average tenure, probation share and key data gaps.",
  filters: [DEPT, LOC, ETYPE],
  viz: ["kpi", "table"],
  tags: ["executive", "scorecard", "attrition"],
  columns: [
    { key: "measure", label: "Measure", type: "text" },
    { key: "value", label: "Value", type: "number" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "meaning", label: "How it is measured", type: "text" },
  ],
  sql: (q) => `
    WITH s AS (
      SELECT COUNT(*) FILTER (WHERE ${q.current()})::numeric AS headcount,
             COUNT(*) FILTER (WHERE e.date_of_joining > ${q.today} - 30 AND e.date_of_joining <= ${q.today})::numeric AS joiners30,
             COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 30 AND e.termination_date <= ${q.today})::numeric AS leavers30,
             COUNT(*) FILTER (WHERE e.termination_date > ${q.today} - 365 AND e.termination_date <= ${q.today})::numeric AS leavers12,
             COUNT(*) FILTER (WHERE e.date_of_joining <= ${q.today} - 365 AND ${NOT_DATED_LEAVER} AND (e.termination_date IS NULL OR e.termination_date > ${q.today} - 365))::numeric AS headcount_year_ago,
             COALESCE(AVG((${q.today} - e.date_of_joining) / 365.25) FILTER (WHERE ${q.current()}), 0)::numeric AS tenure_years,
             COUNT(*) FILTER (WHERE ${q.current()} AND EXISTS (SELECT 1 FROM employee_important_dates d WHERE d.employee_id = e.id AND d.date_type = 'probation_end' AND d.status = 'active' AND d.date_value >= ${q.today}))::numeric AS probation,
             COUNT(*) FILTER (WHERE ${q.current()} AND e.org_unit_id IS NULL)::numeric AS no_unit
        FROM employees e WHERE ${q.emp()})
    SELECT * FROM (
      SELECT 1 AS ord, 'Headcount today' AS measure, headcount AS value, 'employees' AS unit, 'Joined and not terminated' AS meaning FROM s
      UNION ALL SELECT 2, 'Joined, last 30 days', joiners30, 'employees', 'Joining date in the last 30 days' FROM s
      UNION ALL SELECT 3, 'Left, last 30 days', leavers30, 'employees', 'Termination date in the last 30 days' FROM s
      UNION ALL SELECT 4, 'Attrition, last 12 months', CASE WHEN headcount + headcount_year_ago > 0 THEN ROUND(leavers12 * 100.0 / ((headcount + headcount_year_ago) / 2), 1) END, 'percent', 'Leavers in 12 months divided by the average of headcount now and a year ago' FROM s
      UNION ALL SELECT 5, 'Average tenure', ROUND(tenure_years, 1), 'years', 'Mean time since joining, current employees' FROM s
      UNION ALL SELECT 6, 'In a probation period', probation, 'employees', 'Current employees with a probation end date that has not passed' FROM s
      UNION ALL SELECT 7, 'No organisation unit set', no_unit, 'employees', 'Current employees not placed in the organisation' FROM s
    ) t ORDER BY ord`,
  kpis: ({ rows }) =>
    rows.slice(0, 5).map((r) => {
      const unit = r.unit === "percent" ? "percent" : "count";
      return { key: String(r.measure).toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: String(r.measure), value: r.value === null ? null : num(r, "value"), unit, ...(r.unit === "years" ? { note: "years" } : {}) };
    }),
  notes: ({ rows }) => (rows.find((r) => r.measure === "Attrition, last 12 months")?.value === null ? ["Attrition cannot be worked out because there is no headcount now or a year ago."] : []),
  calculation: [
    "All measures use company-time 'today'. Headcount counts employees who have joined and are not terminated.",
    "Attrition is leavers in the last 12 months divided by the average of today's headcount and the headcount a year ago, as a percentage. It is a point-in-time estimate, not an annualised monthly average.",
    "Employees terminated with no termination date cannot be placed in a period and are left out of leaver counts.",
  ],
});

// ---------------------------------------------------------------- B. employee and organisation

export const B01 = listReport({
  description: "Current employees with their number, unit, position, location and type. Contact details, ID numbers and pay are not included.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "org_units", "positions", "locations"],
  tags: ["directory"],
  countLabel: "Employees listed",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "position", label: "Position", type: "text" },
    { key: "location", label: "Location", type: "text" },
    { key: "type", label: "Employment type", type: "text" },
    { key: "joined", label: "Joined", type: "date" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position,
           COALESCE(l.name, 'Not set') AS location, INITCAP(REPLACE(e.employment_type, '_', ' ')) AS type, e.date_of_joining::text AS joined
      FROM employees e
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
      LEFT JOIN positions p ON p.id = e.position_id
      LEFT JOIN locations l ON l.id = e.location_id
     WHERE ${q.emp()} AND ${q.current()}
     ORDER BY name, number`,
  calculation: ["Lists employees who have joined and are not terminated, sorted by name.", "Only fields every HR viewer already sees on the employee card are shown. Email, phone, CNIC, bank and pay fields are never included."],
});

export const B02 = listReport({
  description: "Changes to an employee's organisation unit, position, job, location, subgroup or payroll area, taken from the dated record history.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last90Days",
  tables: ["employee_versions", "employees"],
  tags: ["changes", "history"],
  countLabel: "Changes in range",
  columns: [
    { key: "effective", label: "Effective from", type: "date" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "changed", label: "What changed", type: "text" },
  ],
  sql: (q) => `
    WITH v AS (
      SELECT ev.employee_id, ev.valid_from,
             ev.org_unit_id IS DISTINCT FROM LAG(ev.org_unit_id) OVER w AS c_unit,
             ev.position_id IS DISTINCT FROM LAG(ev.position_id) OVER w AS c_pos,
             ev.job_id IS DISTINCT FROM LAG(ev.job_id) OVER w AS c_job,
             ev.location_id IS DISTINCT FROM LAG(ev.location_id) OVER w AS c_loc,
             ev.employee_subgroup_id IS DISTINCT FROM LAG(ev.employee_subgroup_id) OVER w AS c_sub,
             ev.payroll_area_id IS DISTINCT FROM LAG(ev.payroll_area_id) OVER w AS c_area,
             LAG(ev.valid_from) OVER w IS NOT NULL AS has_prev
        FROM employee_versions ev JOIN employees e ON e.id = ev.employee_id AND e.company_id = ev.company_id
       WHERE ${q.emp()}
      WINDOW w AS (PARTITION BY ev.employee_id ORDER BY ev.valid_from, ev.recorded_at))
    SELECT v.valid_from::text AS effective, e.employee_number AS number, ${NAME("e")} AS name,
           CONCAT_WS('; ', CASE WHEN v.c_unit THEN 'Organisation unit' END, CASE WHEN v.c_pos THEN 'Position' END, CASE WHEN v.c_job THEN 'Job' END,
                     CASE WHEN v.c_loc THEN 'Location' END, CASE WHEN v.c_sub THEN 'Employee subgroup' END, CASE WHEN v.c_area THEN 'Payroll area' END) AS changed
      FROM v JOIN employees e ON e.id = v.employee_id
     WHERE v.has_prev AND (v.c_unit OR v.c_pos OR v.c_job OR v.c_loc OR v.c_sub OR v.c_area) AND v.valid_from BETWEEN ${q.from} AND ${q.to}
     ORDER BY v.valid_from DESC, number`,
  calculation: [
    "Each employee has dated versions of their organisational record. A change is a version whose value differs from the version before it.",
    "A first version (the record being created) is not a change. Pay, grade and personal details are deliberately not compared here.",
    "The date is the day the new version takes effect, not the day it was typed in.",
  ],
});

export const B03 = listReport({
  description: "Each current employee's profile completeness, lowest first, with what is missing.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "employee_addresses", "org_relationships"],
  tags: ["completeness", "data quality"],
  countLabel: "Employees checked",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "score", label: "Complete (%)", type: "percent" },
    { key: "missing", label: "Missing", type: "text" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,
           ROUND(COUNT(*) FILTER (WHERE v.ok) * 100.0 / COUNT(*), 0) AS score,
           COALESCE(NULLIF(STRING_AGG(v.field, ', ' ORDER BY v.ord) FILTER (WHERE NOT v.ok), ''), 'Nothing') AS missing
      FROM employees e
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     CROSS JOIN LATERAL (VALUES
        (1, 'Organisation unit', e.org_unit_id IS NOT NULL), (2, 'Position', e.position_id IS NOT NULL), (3, 'Location', e.location_id IS NOT NULL),
        (4, 'Reporting manager', EXISTS (SELECT 1 FROM org_relationships r WHERE r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active')),
        (5, 'Email', COALESCE(e.email, '') <> ''), (6, 'Phone', COALESCE(e.phone, '') <> ''),
        (7, 'Date of birth', e.date_of_birth_enc IS NOT NULL OR e.date_of_birth IS NOT NULL), (8, 'CNIC', e.cnic_bidx IS NOT NULL OR COALESCE(e.cnic, '') <> ''),
        (9, 'Address', EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active'))
     ) AS v(ord, field, ok)
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY e.id, ou.name
     ORDER BY score ASC, name`,
  kpis: ({ rows }) => [
    percent("avg", "Average completeness", rows.length ? round1(sum(rows, "score") / rows.length) : null),
    count("complete", "Fully complete", rows.filter((r) => num(r, "score") === 100).length),
    count("incomplete", "Need attention", rows.filter((r) => num(r, "score") < 100).length),
  ],
  calculation: ["Nine fields are checked for each current employee: unit, position, location, reporting manager, email, phone, date of birth, CNIC and address.", "The score is fields filled divided by nine. Only whether a field is filled is read, never its value."],
});

export const B04 = sqlReport({
  description: "Headcount for every organisation unit and position title.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "org_units", "positions"],
  viz: ["bar", "table"],
  tags: ["headcount", "positions"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "position", label: "Position", type: "text" },
    { key: "headcount", label: "Headcount", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COALESCE(p.position_title, NULLIF(e.designation, ''), 'No position set') AS position, COUNT(*)::int AS headcount
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN positions p ON p.id = e.position_id
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY ou.name, COALESCE(p.position_title, NULLIF(e.designation, ''), 'No position set')
     ORDER BY headcount DESC, unit, position`,
  chart: ({ rows }) => barChart({ title: "Largest unit and position groups", unit: "employees", rows: rows.map((r) => ({ label: `${r.unit} - ${r.position}`, headcount: r.headcount })), labelKey: "label", valueKey: "headcount", valueLabel: "Headcount", max: 12 }),
  kpis: ({ rows }) => [count("headcount", "Headcount", sum(rows, "headcount")), count("groups", "Unit and position groups", rows.length)],
  calculation: ["Current employees (joined, not terminated) are counted once under their organisation unit and position.", "Where no position is linked the job title on the employee record is used; where neither exists the group is 'No position set'."],
});

const ACTIVE_INCUMBENT = (a: string, today: string) => `${a}.status = 'active' AND ${a}.effective_from <= ${today} AND (${a}.effective_to IS NULL OR ${a}.effective_to >= ${today})`;
const OPEN_POSITION = "p.status NOT IN ('abolished', 'rejected', 'pending_approval')";

export const B05 = sqlReport({
  description: "For every organisation unit: how many positions exist, how many are filled, and the FTE capacity against the FTE filled.",
  domain: "organization",
  filters: [DEPT],
  tables: ["positions", "position_incumbents", "org_units"],
  viz: ["bar", "table"],
  tags: ["positions", "occupancy"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "positions", label: "Positions", type: "number" },
    { key: "filled", label: "Filled", type: "number" },
    { key: "vacant", label: "Vacant", type: "number" },
    { key: "capacity", label: "FTE capacity", type: "number" },
    { key: "occupied", label: "FTE filled", type: "number" },
    { key: "occupancy", label: "FTE occupancy (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH occ AS (
      SELECT p.org_unit_id, p.headcount_fte,
             COALESCE((SELECT SUM(pi.fte) FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)}), 0) AS filled_fte
        FROM positions p WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")})
    SELECT COALESCE(ou.name, 'No organisation unit') AS unit, COUNT(*)::int AS positions, COUNT(*) FILTER (WHERE occ.filled_fte > 0)::int AS filled,
           COUNT(*) FILTER (WHERE occ.filled_fte = 0)::int AS vacant, ROUND(SUM(occ.headcount_fte), 2) AS capacity,
           ROUND(SUM(LEAST(occ.filled_fte, occ.headcount_fte)), 2) AS occupied,
           ROUND(SUM(LEAST(occ.filled_fte, occ.headcount_fte)) * 100.0 / NULLIF(SUM(occ.headcount_fte), 0), 1) AS occupancy
      FROM occ LEFT JOIN org_units ou ON ou.id = occ.org_unit_id
     GROUP BY ou.id, ou.name ORDER BY positions DESC, unit`,
  chart: ({ rows }) => barChart({ title: "Positions by organisation unit", unit: "positions", rows, labelKey: "unit", valueKey: "positions", valueLabel: "Positions", max: 12 }),
  kpis: ({ rows }) => {
    const cap = sum(rows, "capacity");
    return [count("positions", "Positions", sum(rows, "positions")), count("vacant", "Vacant", sum(rows, "vacant")), percent("occupancy", "FTE occupancy", pct(sum(rows, "occupied"), cap), "FTE filled divided by FTE capacity")];
  },
  calculation: [
    "Positions that are abolished, rejected or still waiting for approval are left out. Frozen positions are counted as positions.",
    "A position is filled when it has an active incumbent today. FTE filled is capped at the position's own FTE so an over-assignment cannot push occupancy above 100%.",
  ],
});

export const B06 = listReport({
  description: "Positions with nobody in them today, with how long they have been empty.",
  domain: "organization",
  filters: [DEPT],
  tables: ["positions", "position_incumbents", "org_units"],
  tags: ["vacancy", "positions"],
  countLabel: "Vacant positions",
  columns: [
    { key: "code", label: "Position code", type: "text" },
    { key: "title", label: "Position", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "status", label: "Position status", type: "text" },
    { key: "fte", label: "FTE", type: "number" },
    { key: "since", label: "Empty since", type: "date" },
    { key: "age", label: "Days empty", type: "number" },
  ],
  sql: (q) => `
    SELECT p.position_code AS code, p.position_title AS title, COALESCE(ou.name, 'No organisation unit') AS unit, INITCAP(p.status) AS status, p.headcount_fte AS fte,
           COALESCE(last_inc.ended, p.created_at::date)::text AS since, (${q.today} - COALESCE(last_inc.ended, p.created_at::date))::int AS age
      FROM positions p
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
      LEFT JOIN LATERAL (SELECT MAX(pi.effective_to) AS ended FROM position_incumbents pi WHERE pi.position_id = p.id) last_inc ON TRUE
     WHERE ${q.co("p")} AND ${OPEN_POSITION} AND ${q.dim(DEPT, "p.org_unit_id")}
       AND NOT EXISTS (SELECT 1 FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)})
     ORDER BY age DESC, title`,
  kpis: ({ rows }) => [{ key: "avgAge", label: "Average days empty", value: rows.length ? round1(sum(rows, "age") / rows.length) : null, unit: "days" }],
  calculation: ["A position is vacant when it is not abolished, rejected or pending approval and has no active incumbent today.", "Empty since is the end date of its last incumbent, or the day the position was created when it never had one."],
});

export const B07 = sqlReport({
  description: "How the organisation is structured: units of each type, how many are active, and how many have no people or no head position.",
  domain: "organization",
  tables: ["org_units", "employees"],
  viz: ["bar", "table"],
  tags: ["organisation", "structure"],
  columns: [
    { key: "type", label: "Unit type", type: "text" },
    { key: "units", label: "Units", type: "number" },
    { key: "active", label: "Active", type: "number" },
    { key: "empty", label: "With no current employees", type: "number" },
    { key: "nohead", label: "With no head position", type: "number" },
  ],
  sql: (q) => `
    SELECT INITCAP(REPLACE(ou.unit_type, '_', ' ')) AS type, COUNT(*)::int AS units, COUNT(*) FILTER (WHERE ou.status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.org_unit_id = ou.id AND ${q.current()}))::int AS empty,
           COUNT(*) FILTER (WHERE ou.head_position_id IS NULL)::int AS nohead
      FROM org_units ou WHERE ${q.co("ou")}
     GROUP BY ou.unit_type ORDER BY units DESC, type`,
  chart: ({ rows }) => barChart({ title: "Organisation units by type", unit: "units", rows, labelKey: "type", valueKey: "units", valueLabel: "Units" }),
  kpis: ({ rows }) => [count("units", "Organisation units", sum(rows, "units")), count("empty", "With no current employees", sum(rows, "empty")), count("nohead", "With no head position", sum(rows, "nohead"))],
  calculation: ["Counts organisation units grouped by their unit type.", "A unit has no current employees when nobody who has joined and is not terminated is placed directly in it (people in child units are not counted toward the parent)."],
});

export const B08 = sqlReport({
  description: "How many current employees report directly to each manager, with the managers who have the largest teams.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["org_relationships", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["manager", "span of control"],
  columns: [
    { key: "number", label: "Manager number", type: "text" },
    { key: "manager", label: "Manager", type: "text" },
    { key: "reports", label: "Direct reports", type: "number" },
    { key: "band", label: "Team size band", type: "text" },
  ],
  sql: (q) => `
    SELECT m.employee_number AS number, ${NAME("m")} AS manager, COUNT(*)::int AS reports,
           CASE WHEN COUNT(*) <= 3 THEN '1-3' WHEN COUNT(*) <= 7 THEN '4-7' WHEN COUNT(*) <= 12 THEN '8-12' ELSE 'Over 12' END AS band
      FROM employees e
      JOIN org_relationships r ON r.employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active'
      JOIN employees m ON m.id = r.manager_employee_id
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY m.id, m.employee_number, m.first_name, m.last_name
     ORDER BY reports DESC, manager`,
  chart: ({ rows }) => barChart({ title: "Direct reports per manager", unit: "employees", rows, labelKey: "manager", valueKey: "reports", valueLabel: "Direct reports", max: 12 }),
  kpis: ({ rows }) => [
    count("managers", "Managers", rows.length),
    { key: "avg", label: "Average team size", value: rows.length ? round1(sum(rows, "reports") / rows.length) : null, unit: "count" },
    count("largest", "Largest team", rows.length ? Math.max(...rows.map((r) => num(r, "reports"))) : null),
  ],
  calculation: ["Counts current employees by the manager on their active direct reporting relationship. Dotted-line and matrix lines are not counted.", "A manager is anyone with at least one current direct report."],
});

export const B09 = groupedReport({
  description: "Current headcount by grade or salary band. Needs permission to view sensitive employee fields.",
  filters: [DEPT, LOC, ETYPE],
  sensitivity: "sensitive",
  needs: ["employee.view_sensitive.all"],
  tables: ["employees", "hr_reference_catalog_items"],
  dimension: "Grade / band",
  valueLabel: "Headcount",
  unit: "employees",
  totalLabel: "Employees counted",
  tags: ["grade", "band"],
  sql: (q) => `
    SELECT COALESCE(NULLIF(cat.label, ''), NULLIF(e.salary_band, ''), 'No band set') AS label, COUNT(*)::int AS n
      FROM employees e LEFT JOIN hr_reference_catalog_items cat ON cat.id = e.salary_band_catalog_item_id
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY 1 ORDER BY (COALESCE(NULLIF(cat.label, ''), NULLIF(e.salary_band, ''), 'No band set') = 'No band set'), n DESC, label`,
  calculation: ["Current employees are counted under the grade or band on their record. No pay amounts are shown.", "Employees with no band are grouped as 'No band set'."],
});

export const B10 = sqlReport({
  description: "People and FTE assigned to each cost centre through active cost allocations, plus employees with no allocation.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employee_cost_allocations", "cost_centers", "employees"],
  viz: ["bar", "table"],
  tags: ["cost centre", "allocation"],
  columns: [
    { key: "label", label: "Cost centre", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "fte", label: "Allocated FTE", type: "number" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT cc.code || ' - ' || cc.name AS label, COUNT(DISTINCT e.id)::int AS people, ROUND(SUM(a.allocation_percentage) / 100.0, 2) AS fte, 0 AS ord
        FROM employee_cost_allocations a JOIN cost_centers cc ON cc.id = a.cost_center_id JOIN employees e ON e.id = a.employee_id
       WHERE ${q.emp()} AND ${q.current()} AND a.status = 'active'
       GROUP BY cc.id, cc.code, cc.name
      UNION ALL
      SELECT 'No cost centre allocated', COUNT(*)::int, 0, 1
        FROM employees e WHERE ${q.emp()} AND ${q.current()} AND NOT EXISTS (SELECT 1 FROM employee_cost_allocations a WHERE a.employee_id = e.id AND a.status = 'active')
    ) t WHERE people > 0 ORDER BY ord, fte DESC, label`,
  chart: ({ rows }) => barChart({ title: "Allocated FTE by cost centre", unit: "FTE", rows, labelKey: "label", valueKey: "fte", valueLabel: "FTE", max: 12 }),
  kpis: ({ rows }) => [count("unallocated", "Employees with no allocation", num(rows.find((r) => r.label === "No cost centre allocated") ?? {}, "people")), count("centres", "Cost centres in use", rows.filter((r) => r.label !== "No cost centre allocated").length)],
  calculation: ["Each active allocation contributes its percentage divided by 100 as FTE to its cost centre. A person split across two centres appears in both.", "Current employees with no active allocation are shown on their own line, not hidden."],
});

export const B11 = listReport({
  description: "Contracts ending in the window, from the contract-end dates held on employee records. Includes recently lapsed contracts.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "pastAndNext90Days",
  tables: ["employee_important_dates", "employees"],
  tags: ["contract", "watchlist"],
  countLabel: "Contracts in window",
  columns: [
    { key: "ends", label: "Contract ends", type: "date" },
    { key: "days", label: "Days to go", type: "number" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "type", label: "Employment type", type: "text" },
  ],
  sql: (q) => `
    SELECT d.date_value::text AS ends, (d.date_value - ${q.today})::int AS days, e.employee_number AS number, ${NAME("e")} AS name,
           COALESCE(ou.name, 'Not set') AS unit, INITCAP(REPLACE(e.employment_type, '_', ' ')) AS type
      FROM employee_important_dates d JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} AND d.date_type = 'contract_end' AND d.status = 'active' AND d.date_value BETWEEN ${q.from} AND ${q.to}
     ORDER BY d.date_value, number`,
  kpis: ({ rows }) => [count("lapsed", "Already passed", rows.filter((r) => num(r, "days") < 0).length), count("soon", "Ending within 30 days", rows.filter((r) => num(r, "days") >= 0 && num(r, "days") <= 30).length)],
  calculation: ["Uses the active 'contract end' date recorded for each current employee. A negative 'days to go' means the date has already passed and the person is still current.", "Employees without a contract-end date are not listed; the report does not guess an end date."],
});

export const B12 = listReport({
  description: "Probation periods ending in the window, from the probation-end dates held on employee records.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "pastAndNext90Days",
  tables: ["employee_important_dates", "employees"],
  tags: ["probation", "watchlist"],
  countLabel: "Probations in window",
  columns: [
    { key: "ends", label: "Probation ends", type: "date" },
    { key: "days", label: "Days to go", type: "number" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "status", label: "Employment status", type: "text" },
  ],
  sql: (q) => `
    SELECT d.date_value::text AS ends, (d.date_value - ${q.today})::int AS days, e.employee_number AS number, ${NAME("e")} AS name,
           COALESCE(ou.name, 'Not set') AS unit, INITCAP(e.employment_status) AS status
      FROM employee_important_dates d JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} AND d.date_type = 'probation_end' AND d.status = 'active' AND d.date_value BETWEEN ${q.from} AND ${q.to}
     ORDER BY d.date_value, number`,
  kpis: ({ rows }) => [count("overdue", "Past end date, still current", rows.filter((r) => num(r, "days") < 0).length), count("soon", "Ending within 30 days", rows.filter((r) => num(r, "days") >= 0 && num(r, "days") <= 30).length)],
  calculation: ["Uses the active 'probation end' date recorded for each current employee. A negative 'days to go' means the date has passed and the person is still current, so a confirmation decision may be overdue.", "Employees with no probation-end date are not listed."],
});

export const B13 = listReport({
  description: "Work anniversaries falling in the window, with the number of years completed.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "next90Days",
  tables: ["employees"],
  tags: ["anniversary", "tenure"],
  countLabel: "Anniversaries in window",
  columns: [
    { key: "date", label: "Anniversary", type: "date" },
    { key: "years", label: "Years completed", type: "number" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "joined", label: "Joined", type: "date" },
  ],
  sql: (q) => `
    SELECT a.ann::text AS date, a.years, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, e.date_of_joining::text AS joined
      FROM employees e
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     CROSS JOIN LATERAL (
        SELECT (e.date_of_joining + make_interval(years => y.yr - EXTRACT(year FROM e.date_of_joining)::int))::date AS ann, (y.yr - EXTRACT(year FROM e.date_of_joining)::int) AS years
          FROM generate_series(EXTRACT(year FROM ${q.from})::int, EXTRACT(year FROM ${q.to})::int) AS y(yr)) a
     WHERE ${q.emp()} AND ${q.current()} AND a.years >= 1 AND a.ann BETWEEN ${q.from} AND ${q.to}
     ORDER BY a.ann, number`,
  calculation: ["For each current employee the anniversary is their joining date moved to each year in the window. A 29 February joining date is observed on 28 February in other years.", "Years completed is the number of full years since joining, so the joining day itself is not an anniversary."],
});

export const B14 = listReport({
  description: "Passport and certificate expiry dates falling in the window, and expiry dates recorded against employee documents. Document numbers are not shown.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "pastAndNext90Days",
  sensitivity: "sensitive",
  tables: ["persons", "employee_qualifications", "employee_important_dates", "employees"],
  tags: ["expiry", "documents", "watchlist"],
  countLabel: "Documents in window",
  columns: [
    { key: "expires", label: "Expires", type: "date" },
    { key: "days", label: "Days to go", type: "number" },
    { key: "document", label: "Document", type: "text" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT p.passport_expiry::text AS expires, (p.passport_expiry - ${q.today})::int AS days, 'Passport' AS document, e.employee_number AS number, ${NAME("e")} AS name
        FROM employees e JOIN persons p ON p.id = e.person_id
       WHERE ${q.emp()} AND ${q.current()} AND p.passport_expiry BETWEEN ${q.from} AND ${q.to}
      UNION ALL
      SELECT x.expiry_date::text, (x.expiry_date - ${q.today})::int, COALESCE(NULLIF(x.title, ''), INITCAP(x.qualification_type)), e.employee_number, ${NAME("e")}
        FROM employees e JOIN employee_qualifications x ON x.employee_id = e.id
       WHERE ${q.emp()} AND ${q.current()} AND x.status = 'active' AND x.expiry_date BETWEEN ${q.from} AND ${q.to}
      UNION ALL
      SELECT d.date_value::text, (d.date_value - ${q.today})::int, COALESCE(NULLIF(d.label, ''), 'Document'), e.employee_number, ${NAME("e")}
        FROM employees e JOIN employee_important_dates d ON d.employee_id = e.id
       WHERE ${q.emp()} AND ${q.current()} AND d.date_type = 'document_expiry' AND d.status = 'active' AND d.date_value BETWEEN ${q.from} AND ${q.to}
    ) t ORDER BY expires, number`,
  kpis: ({ rows }) => [count("expired", "Already expired", rows.filter((r) => num(r, "days") < 0).length), count("soon", "Expiring within 30 days", rows.filter((r) => num(r, "days") >= 0 && num(r, "days") <= 30).length)],
  calculation: ["Combines three sources of expiry dates for current employees: passport expiry, active certificates and qualifications, and 'document expiry' dates on the employee record.", "Files stored in the document vault carry no expiry date, so they are not covered. Passport numbers and file contents are never shown."],
});

export const B15 = listReport({
  description: "Records that look wrong: a CNIC or work email shared by two people, terminated staff with no termination date, and working staff with one.",
  filters: [DEPT, LOC, ETYPE],
  sensitivity: "sensitive",
  tables: ["employees"],
  tags: ["data quality", "exceptions", "duplicates"],
  countLabel: "Exceptions found",
  columns: [
    { key: "issue", label: "Issue", type: "text" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "detail", label: "Detail", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT 'Shared CNIC' AS issue, e.employee_number AS number, ${NAME("e")} AS name, 'Another employee record has the same CNIC' AS detail
        FROM employees e WHERE ${q.emp()} AND e.cnic_bidx IS NOT NULL
         AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND o.cnic_bidx = e.cnic_bidx AND o.id <> e.id)
      UNION ALL
      SELECT 'Shared work email', e.employee_number, ${NAME("e")}, 'Another employee record has the same email address'
        FROM employees e WHERE ${q.emp()} AND COALESCE(e.email, '') <> ''
         AND EXISTS (SELECT 1 FROM employees o WHERE o.company_id = e.company_id AND LOWER(o.email) = LOWER(e.email) AND o.id <> e.id)
      UNION ALL
      SELECT 'Terminated with no date', e.employee_number, ${NAME("e")}, 'Status is terminated but no termination date is recorded'
        FROM employees e WHERE ${q.emp()} AND e.employment_status = 'terminated' AND e.termination_date IS NULL
      UNION ALL
      SELECT 'Working with a termination date', e.employee_number, ${NAME("e")}, 'Termination date ' || e.termination_date::text || ' but status is ' || e.employment_status
        FROM employees e WHERE ${q.emp()} AND e.employment_status <> 'terminated' AND e.termination_date IS NOT NULL
      UNION ALL
      SELECT 'Leaving before joining', e.employee_number, ${NAME("e")}, 'Termination date is earlier than the joining date'
        FROM employees e WHERE ${q.emp()} AND e.termination_date IS NOT NULL AND e.termination_date < e.date_of_joining
    ) t ORDER BY issue, number`,
  chart: ({ rows }) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(String(r.issue), (m.get(String(r.issue)) ?? 0) + 1);
    return barChart({ title: "Exceptions by type", unit: "records", rows: [...m].map(([issue, n]) => ({ issue, n })) as ReportRow[], labelKey: "issue", valueKey: "n", valueLabel: "Records" });
  },
  calculation: ["Runs five fixed checks across all employee records in your scope, including people who have left.", "Duplicate checks compare a blind index of the CNIC and the lower-cased email; the values themselves are never shown."],
});
