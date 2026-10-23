import type { ReportRow } from "@aihxm/shared-types";
import { DEPT, ETYPE, LOC, barChart, count, groupedReport, listReport, num, pct, percent, round1, round2, sqlReport, stackedChart, sum, type Q } from "../report-spec";

/** Organisation planning, capacity and talent-movement reports (catalog M, plus onboarding C14/C15 and mobility L13). */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const NOT_DATED_LEAVER = "NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL)";
const ACTIVE_INCUMBENT = (a: string, today: string) => `${a}.status = 'active' AND ${a}.effective_from <= ${today} AND (${a}.effective_to IS NULL OR ${a}.effective_to >= ${today})`;

// ---------------------------------------------------------------- capacity (M02, M03, M12)

const WORK_PROFILE = (q: Q) => `LEFT JOIN LATERAL (
    SELECT w.employment_percentage, w.weekly_hours FROM employee_work_profiles w
     WHERE w.employee_id = e.id AND w.company_id = e.company_id AND w.effective_from <= ${q.today} AND (w.effective_to IS NULL OR w.effective_to >= ${q.today})
     ORDER BY w.effective_from DESC LIMIT 1) wp ON TRUE`;

function capacity(o: { description: string; dimension: string; label: string; join: string; group: string; title: string; tags: string[]; order?: string }) {
  return sqlReport({
    description: o.description,
    filters: [DEPT, LOC, ETYPE],
    tables: ["employees", "employee_work_profiles", "org_units", "locations"],
    viz: ["bar", "kpi", "table"],
    tags: o.tags,
    columns: [
      { key: "label", label: o.dimension, type: "text" },
      { key: "headcount", label: "Headcount", type: "number" },
      { key: "withProfile", label: "With a working-hours profile", type: "number" },
      { key: "noProfile", label: "Without a profile", type: "number" },
      { key: "fte", label: "FTE (from profiles)", type: "number" },
      { key: "hours", label: "Weekly hours (from profiles)", type: "number" },
    ],
    sql: (q) => `
      SELECT ${o.label} AS label, COUNT(*)::int AS headcount, COUNT(wp.weekly_hours)::int AS "withProfile", (COUNT(*) - COUNT(wp.weekly_hours))::int AS "noProfile",
             ROUND(COALESCE(SUM(wp.employment_percentage), 0) / 100.0, 2) AS fte, ROUND(COALESCE(SUM(wp.weekly_hours), 0), 1) AS hours
        FROM employees e ${o.join} ${WORK_PROFILE(q)}
       WHERE ${q.emp()} AND ${q.current()}
       GROUP BY ${o.group} ORDER BY headcount DESC, label`,
    chart: ({ rows }) => barChart({ title: o.title, unit: "FTE", rows, labelKey: "label", valueKey: "fte", valueLabel: "FTE", max: 12 }),
    kpis: ({ rows }) => [count("headcount", "Headcount", sum(rows, "headcount")), { key: "fte", label: "FTE from profiles", value: round2(sum(rows, "fte")), unit: "count" }, count("noProfile", "Without a profile", sum(rows, "noProfile"), "Not assumed to be full time")],
    notes: ({ rows }) => {
      const n = sum(rows, "noProfile");
      return n > 0 ? [`${n} current employee${n === 1 ? " has" : "s have"} no working-hours profile. They add nothing to the FTE or hours columns; they are not assumed to be full time.`] : [];
    },
    calculation: [
      "Headcount is current employees (joined, not terminated). Each is matched to the working-hours profile that is in force today.",
      "FTE is the sum of employment percentage divided by 100. Weekly hours is the sum of weekly hours on the profiles.",
      "An employee with no profile is counted in headcount and in 'Without a profile' only.",
    ],
  });
}

export const M02 = capacity({
  description: "Headcount, FTE and weekly working hours for each organisation unit, using working-hours profiles.",
  dimension: "Organisation unit",
  label: "COALESCE(ou.name, 'No organisation unit set')",
  join: "LEFT JOIN org_units ou ON ou.id = e.org_unit_id",
  group: "ou.id, ou.name",
  title: "FTE by organisation unit",
  tags: ["capacity", "fte"],
});

export const M03 = capacity({
  description: "Headcount, FTE and weekly working hours for each employment type, using working-hours profiles.",
  dimension: "Employment type",
  label: "INITCAP(REPLACE(e.employment_type, '_', ' '))",
  join: "",
  group: "e.employment_type",
  title: "FTE by employment type",
  tags: ["fte", "employment type"],
});

export const M12 = capacity({
  description: "Headcount, FTE and weekly working hours for each work location.",
  dimension: "Location",
  label: "COALESCE(l.name, 'No location set')",
  join: "LEFT JOIN locations l ON l.id = e.location_id",
  group: "l.id, l.name",
  title: "FTE by location",
  tags: ["capacity", "location"],
});

// ---------------------------------------------------------------- M04 vacancy rate

export const M04 = sqlReport({
  description: "Share of positions that are vacant, for each organisation unit.",
  domain: "organization",
  filters: [DEPT],
  tables: ["positions", "position_incumbents", "org_units"],
  viz: ["bar", "kpi", "table"],
  tags: ["vacancy", "positions"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "positions", label: "Positions", type: "number" },
    { key: "vacant", label: "Vacant", type: "number" },
    { key: "frozen", label: "Of which frozen", type: "number" },
    { key: "rate", label: "Vacancy rate (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH occ AS (
      SELECT p.org_unit_id, p.status, EXISTS (SELECT 1 FROM position_incumbents pi WHERE pi.position_id = p.id AND ${ACTIVE_INCUMBENT("pi", q.today)}) AS filled
        FROM positions p WHERE ${q.co("p")} AND p.status NOT IN ('abolished', 'rejected', 'pending_approval') AND ${q.dim(DEPT, "p.org_unit_id")})
    SELECT COALESCE(ou.name, 'No organisation unit') AS unit, COUNT(*)::int AS positions, COUNT(*) FILTER (WHERE NOT filled)::int AS vacant,
           COUNT(*) FILTER (WHERE NOT filled AND occ.status = 'frozen')::int AS frozen,
           ROUND(COUNT(*) FILTER (WHERE NOT filled) * 100.0 / NULLIF(COUNT(*), 0), 1) AS rate
      FROM occ LEFT JOIN org_units ou ON ou.id = occ.org_unit_id GROUP BY ou.id, ou.name ORDER BY rate DESC NULLS LAST, positions DESC, unit`,
  chart: ({ rows }) => barChart({ title: "Vacancy rate by organisation unit", unit: "percent", rows, labelKey: "unit", valueKey: "rate", valueLabel: "Vacancy rate (%)", max: 12 }),
  kpis: ({ rows }) => [percent("rate", "Overall vacancy rate", pct(sum(rows, "vacant"), sum(rows, "positions"))), count("vacant", "Vacant positions", sum(rows, "vacant")), count("frozen", "Of which frozen", sum(rows, "frozen"))],
  calculation: ["Vacancy rate is vacant positions divided by all positions, as a percentage.", "Abolished, rejected and pending-approval positions are left out. A frozen position with nobody in it counts as vacant and is also shown in the frozen column."],
});

// ---------------------------------------------------------------- M06 movement matrix

export const M06 = sqlReport({
  description: "Moves between organisation units in the period: from which unit, to which unit, and how many people.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["employee_job_history", "org_units", "employees"],
  viz: ["bar", "table"],
  tags: ["movement", "transfers", "mobility"],
  columns: [
    { key: "from", label: "From", type: "text" },
    { key: "to", label: "To", type: "text" },
    { key: "moves", label: "Moves", type: "number" },
    { key: "people", label: "People", type: "number" },
  ],
  sql: (q) => `
    WITH h AS (
      SELECT jh.employee_id, jh.effective_date, jh.org_unit_id,
             LAG(jh.org_unit_id) OVER (PARTITION BY jh.employee_id ORDER BY jh.effective_date, jh.created_at) AS prev_unit
        FROM employee_job_history jh JOIN employees e ON e.id = jh.employee_id AND e.company_id = jh.company_id
       WHERE ${q.emp()})
    SELECT f.name AS "from", t.name AS "to", COUNT(*)::int AS moves, COUNT(DISTINCT h.employee_id)::int AS people
      FROM h JOIN org_units f ON f.id = h.prev_unit JOIN org_units t ON t.id = h.org_unit_id
     WHERE h.org_unit_id <> h.prev_unit AND h.effective_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY f.id, f.name, t.id, t.name ORDER BY moves DESC, "from", "to"`,
  chart: ({ rows }) => barChart({ title: "Largest moves between units", unit: "moves", rows: rows.map((r) => ({ label: `${r.from} to ${r.to}`, moves: r.moves })), labelKey: "label", valueKey: "moves", valueLabel: "Moves", max: 12 }),
  kpis: ({ rows }) => [count("moves", "Moves between units", sum(rows, "moves")), count("pairs", "Unit pairs involved", rows.length)],
  calculation: [
    "Reads the job history. A move is an entry whose organisation unit differs from the same person's previous entry.",
    "A first entry (the hire) is not a move, and entries where either unit is not set are skipped.",
    "Moves are placed by the effective date of the new entry. The filters apply to the person's current record.",
  ],
});

// ---------------------------------------------------------------- M07 tenure

export const M07 = groupedReport({
  description: "How long current employees have been with the company, in bands.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees"],
  dimension: "Tenure band",
  valueLabel: "Employees",
  unit: "employees",
  totalLabel: "Employees counted",
  groupsLabel: "Bands",
  tags: ["tenure"],
  sql: (q) => `
    SELECT band AS label, COUNT(*)::int AS n FROM (
      SELECT e.id, CASE WHEN ${q.today} - e.date_of_joining < 365 THEN '1. Under 1 year' WHEN ${q.today} - e.date_of_joining < 3 * 365 THEN '2. 1 to 3 years'
                        WHEN ${q.today} - e.date_of_joining < 5 * 365 THEN '3. 3 to 5 years' WHEN ${q.today} - e.date_of_joining < 10 * 365 THEN '4. 5 to 10 years' ELSE '5. 10 years or more' END AS band
        FROM employees e WHERE ${q.emp()} AND ${q.current()}) t
     GROUP BY band ORDER BY band`,
  calculation: ["Tenure is the time from the joining date to today for current employees. A year is 365 days.", "Rehired people are measured from the joining date on the current record."],
  notes: () => [],
});

// ---------------------------------------------------------------- M08 contract end forecast

export const M08 = sqlReport({
  description: "Contracts due to end in each of the coming months, from the contract-end dates held on employee records. Retirement is not forecast.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "next12Months",
  sensitivity: "sensitive",
  tables: ["employee_important_dates", "employees"],
  viz: ["bar", "table"],
  tags: ["forecast", "contract end"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "ending", label: "Contracts ending", type: "number" },
    { key: "cumulative", label: "Running total", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         c AS (SELECT mo.ms, COUNT(d.id)::int AS ending
                 FROM mo LEFT JOIN (
                   SELECT d.id, d.date_value FROM employee_important_dates d JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id
                    WHERE ${q.emp()} AND ${q.current()} AND d.date_type = 'contract_end' AND d.status = 'active' AND d.date_value BETWEEN ${q.from} AND ${q.to}) d
                   ON d.date_value >= mo.ms AND d.date_value < mo.ms + interval '1 month'
                GROUP BY mo.ms)
    SELECT to_char(ms, 'YYYY-MM') AS month, ending, SUM(ending) OVER (ORDER BY ms)::int AS cumulative FROM c ORDER BY ms`,
  chart: ({ rows }) => barChart({ title: "Contracts ending by month", unit: "contracts", rows, labelKey: "month", valueKey: "ending", valueLabel: "Contracts ending", max: 24 }),
  kpis: ({ rows }) => [count("total", "Contracts ending in range", sum(rows, "ending"))],
  calculation: ["Counts active contract-end dates recorded for current employees, by the month of the date.", "Only recorded dates are used; contracts without an end date are not forecast. Retirement is not forecast because the product does not hold a retirement age rule or usable dates of birth."],
});

// ---------------------------------------------------------------- M10 layers

export const M10 = groupedReport({
  description: "How many reporting layers the organisation has and how many people sit on each, counted down from the top managers.",
  domain: "organization",
  tables: ["org_relationships", "employees"],
  dimension: "Layer",
  valueLabel: "Employees",
  unit: "employees",
  totalLabel: "Employees placed in a layer",
  groupsLabel: "Layers",
  tags: ["layers", "span", "structure"],
  sql: (q) => `
    WITH RECURSIVE tree AS (
      SELECT e.id, 1 AS layer FROM employees e
       WHERE ${q.co("e")} AND ${q.current()}
         AND NOT EXISTS (SELECT 1 FROM org_relationships r JOIN employees mg ON mg.id = r.manager_employee_id
                          WHERE r.employee_id = e.id AND r.relationship_type = 'direct' AND r.status = 'active' AND ${q.current("mg")})
      UNION ALL
      SELECT c.id, t.layer + 1 FROM tree t
        JOIN org_relationships r ON r.manager_employee_id = t.id AND r.relationship_type = 'direct' AND r.status = 'active'
        JOIN employees c ON c.id = r.employee_id AND ${q.current("c")}
       WHERE t.layer < 15)
    SELECT 'Layer ' || layer AS label, COUNT(DISTINCT id)::int AS n FROM tree GROUP BY layer ORDER BY layer`,
  calculation: [
    "Layer 1 is every current employee with no active direct manager who is also a current employee. Each layer below is the direct reports of the layer above.",
    "Only direct reporting lines are followed, to a maximum of 15 layers. People caught in a reporting loop have no top and are not placed in any layer.",
  ],
  notes: () => ["A person whose manager has left appears at layer 1 until a new manager is set."],
});

// ---------------------------------------------------------------- M11 organisation change impact

export const M11 = listReport({
  description: "Organisation restructures: what each change does, its status, effective date and how many units it touches.",
  domain: "organization",
  needs: ["org_change.view.all"],
  defaultRange: "last12Months",
  tables: ["org_changes", "org_change_items"],
  tags: ["restructure", "org change"],
  countLabel: "Changes in range",
  columns: [
    { key: "title", label: "Change", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "effective", label: "Effective date", type: "date" },
    { key: "items", label: "Steps", type: "number" },
    { key: "units", label: "Units touched", type: "number" },
    { key: "failed", label: "Failed steps", type: "number" },
  ],
  sql: (q) => `
    SELECT oc.title, INITCAP(REPLACE(oc.status, '_', ' ')) AS status, oc.effective_date::text AS effective, COUNT(i.id)::int AS items,
           COUNT(DISTINCT i.org_unit_id)::int AS units, COUNT(i.id) FILTER (WHERE i.failure_reason IS NOT NULL)::int AS failed
      FROM org_changes oc LEFT JOIN org_change_items i ON i.org_change_id = oc.id
     WHERE ${q.co("oc")} AND COALESCE(oc.effective_date, oc.created_at::date) BETWEEN ${q.from} AND ${q.to}
     GROUP BY oc.id ORDER BY COALESCE(oc.effective_date, oc.created_at::date) DESC, oc.title`,
  kpis: ({ rows }) => [count("published", "Published", rows.filter((r) => r.status === "Published").length), count("waiting", "Waiting for approval", rows.filter((r) => r.status === "Pending approval").length)],
  calculation: ["Lists organisation changes whose effective date (or creation date when none is set) falls in the range.", "Steps are the individual unit actions inside a change. Failed steps are those that recorded a failure reason."],
});

// ---------------------------------------------------------------- M13 type mix trend

export const M13 = sqlReport({
  description: "Month-end headcount for each employment type, to show how the mix changes over time.",
  filters: [DEPT, LOC],
  defaultRange: "last12Months",
  tables: ["employees"],
  viz: ["stackedBar", "table"],
  tags: ["mix", "trend", "employment type"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "type", label: "Employment type", type: "text" },
    { key: "headcount", label: "Headcount at month end", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, INITCAP(REPLACE(e.employment_type, '_', ' ')) AS type, COUNT(*)::int AS headcount
      FROM mo JOIN employees e ON ${q.emp()} AND e.date_of_joining <= mo.point AND ${NOT_DATED_LEAVER} AND (e.termination_date IS NULL OR e.termination_date > mo.point)
     GROUP BY mo.ms, e.employment_type ORDER BY mo.ms, type`,
  chart: ({ rows }) => {
    const types = [...new Set(rows.map((r) => String(r.type)))];
    const months = [...new Set(rows.map((r) => String(r.month)))];
    const data: ReportRow[] = months.map((m) => {
      const row: ReportRow = { month: m };
      types.forEach((t, i) => (row[`t${i}`] = num(rows.find((r) => r.month === m && r.type === t) ?? {}, "headcount")));
      return row;
    });
    return stackedChart({ title: "Headcount by employment type", unit: "employees", rows: data, xKey: "month", series: types.map((t, i) => ({ key: `t${i}`, label: t })) });
  },
  kpis: ({ rows }) => {
    const months = [...new Set(rows.map((r) => String(r.month)))];
    const last = months[months.length - 1];
    return [count("types", "Employment types in use", new Set(rows.map((r) => r.type)).size), count("latest", `Headcount, ${last ?? ""}`, sum(rows.filter((r) => r.month === last), "headcount"))];
  },
  calculation: ["For each month, counts employees who had joined on or before its last day and had not left by then, grouped by the employment type now on their record.", "A person's type is the one recorded today; the type held in earlier months is not reconstructed.", "Employees marked terminated with no termination date are left out."],
});

// ---------------------------------------------------------------- L13 internal mobility

export const L13 = groupedReport({
  description: "Promotions, transfers, acting assignments and other internal moves in the period.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["employee_job_history", "employees"],
  dimension: "Move type",
  valueLabel: "Moves",
  unit: "moves",
  totalLabel: "Internal moves",
  groupsLabel: "Move types",
  tags: ["mobility", "promotion", "transfer"],
  sql: (q) => `
    SELECT INITCAP(REPLACE(jh.event_type, '_', ' ')) AS label, COUNT(*)::int AS n
      FROM employee_job_history jh JOIN employees e ON e.id = jh.employee_id AND e.company_id = jh.company_id
     WHERE ${q.emp()} AND jh.event_type IN ('promotion', 'transfer', 'demotion', 'position_assignment', 'acting', 'secondment', 'location_change', 'manager_change')
       AND jh.effective_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY jh.event_type ORDER BY n DESC, label`,
  calculation: ["Counts job-history entries of internal move types whose effective date falls in the range. Hires, terminations and reactivations are not internal moves.", "A person with two moves is counted twice."],
});

// ---------------------------------------------------------------- C14 / C15 onboarding

export const C14 = sqlReport({
  description: "How far onboarding tasks have got, by task category, for people whose onboarding started in the period.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["employee_onboarding", "employee_onboarding_items", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["onboarding", "tasks"],
  columns: [
    { key: "category", label: "Category", type: "text" },
    { key: "tasks", label: "Tasks", type: "number" },
    { key: "done", label: "Completed", type: "number" },
    { key: "skipped", label: "Skipped", type: "number" },
    { key: "pending", label: "Pending", type: "number" },
    { key: "overdue", label: "Pending and overdue", type: "number" },
    { key: "rate", label: "Completion (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT UPPER(LEFT(i.category, 1)) || SUBSTRING(i.category FROM 2) AS category, COUNT(*)::int AS tasks, COUNT(*) FILTER (WHERE i.status = 'completed')::int AS done,
           COUNT(*) FILTER (WHERE i.status = 'skipped')::int AS skipped, COUNT(*) FILTER (WHERE i.status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue,
           ROUND(COUNT(*) FILTER (WHERE i.status = 'completed') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE i.status <> 'skipped'), 0), 1) AS rate
      FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id
     WHERE ${q.emp()} AND o.started_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY i.category ORDER BY tasks DESC, category`,
  chart: ({ rows }) => barChart({ title: "Completion by task category", unit: "percent", rows, labelKey: "category", valueKey: "rate", valueLabel: "Completion (%)" }),
  kpis: ({ rows }) => {
    const done = sum(rows, "done");
    const pending = sum(rows, "pending");
    return [count("tasks", "Tasks", sum(rows, "tasks")), percent("rate", "Completion", pct(done, done + pending), "Completed divided by completed plus pending; skipped tasks excluded"), count("overdue", "Pending and overdue", sum(rows, "overdue"))];
  },
  calculation: ["Includes onboarding checklists that started in the range, for employees in your scope.", "Completion is completed tasks divided by completed plus pending tasks. Skipped tasks are left out of the rate.", "Overdue means pending with a due date before today."],
});

export const C15 = listReport({
  description: "Each new hire's onboarding checklist: progress, overdue tasks and status.",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last90Days",
  tables: ["employee_onboarding", "employee_onboarding_items", "employees"],
  tags: ["onboarding", "new hire"],
  countLabel: "Checklists",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "joined", label: "Joined", type: "date" },
    { key: "status", label: "Checklist", type: "text" },
    { key: "done", label: "Tasks done", type: "number" },
    { key: "total", label: "Tasks", type: "number" },
    { key: "progress", label: "Progress (%)", type: "percent" },
    { key: "overdue", label: "Overdue", type: "number" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, e.date_of_joining::text AS joined, INITCAP(REPLACE(o.status, '_', ' ')) AS status,
           COUNT(*) FILTER (WHERE i.status = 'completed')::int AS done, COUNT(i.id) FILTER (WHERE i.status <> 'skipped')::int AS total,
           ROUND(COUNT(*) FILTER (WHERE i.status = 'completed') * 100.0 / NULLIF(COUNT(i.id) FILTER (WHERE i.status <> 'skipped'), 0), 0) AS progress,
           COUNT(*) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue
      FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id LEFT JOIN employee_onboarding_items i ON i.onboarding_id = o.id
     WHERE ${q.emp()} AND o.started_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY o.id, e.id ORDER BY overdue DESC, progress ASC NULLS FIRST, name`,
  kpis: ({ rows }) => [count("inProgress", "Still in progress", rows.filter((r) => r.status === "In progress").length), count("overdue", "With overdue tasks", rows.filter((r) => num(r, "overdue") > 0).length), { key: "avg", label: "Average progress", value: rows.length ? round1(sum(rows, "progress") / rows.length) : null, unit: "percent" }],
  calculation: ["One line per onboarding checklist that started in the range. Skipped tasks are not counted in the total.", "Overdue means pending tasks with a due date before today."],
});
