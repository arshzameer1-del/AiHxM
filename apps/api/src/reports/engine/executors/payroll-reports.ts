import { DEPT, LOC, barChart, count, lineChart, listReport, num, percent, round1, round2, sqlReport, sum, type Q } from "../report-spec";

/**
 * Payroll, compensation and finance-cost reports (catalog F02 to F10 and K01 to K15; F01 is the original run-status report).
 *
 * Scope: a caller with payroll.*.all sees every payroll area, a caller with payroll.*.scoped only their areas. Every query
 * starts from payroll_runs and applies the area limit through q.area(), and the framework refuses to run a query that
 * does not. Only real (non-simulation) runs are read. Money reports use runs that are approved and finalised or beyond;
 * calculated or draft figures are never mixed in. Per-person amounts appear only in F02, the register, which is restricted.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const STATUS = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const RUN = (q: Q) => `${q.co("pr")} AND ${q.area("pr")} AND pr.is_simulation = false`;
/** Approved and finalised, or further along. The only runs whose money is final. */
const FINAL = "pr.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed')";
/** Runs that have calculated payslips and are still live (not draft, cancelled or reversed). */
const LIVE = "pr.status NOT IN ('draft', 'pre_validated', 'calculating', 'cancelled', 'reversed')";
const PERIOD = (q: Q) => `pr.period_end BETWEEN ${q.from} AND ${q.to}`;
const DEDUCTIONS = "('employee_deduction', 'tax', 'statutory_deduction', 'recovery')";
const runStatus = (q: Q) => {
  const v = q.filter("runStatus");
  return v ? `pr.status = ${q.bind(v)}` : "TRUE";
};
const MONEY_NOTE = "Amounts are in the currency of the payroll runs (PKR for Pakistan payroll). Runs in different currencies would be added together unchanged.";
const FINAL_NOTE = "Only approved and finalised runs (including those beyond finalised: accounting, payment released, reconciled, closed) are included. Draft, calculated, cancelled and reversed runs are not.";

// ---------------------------------------------------------------- F02 register

export const F02 = listReport({
  description: "Each employee's payslip for the runs in the period: gross pay, tax, EOBI, other deductions, net pay and employer cost. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, "runStatus"],
  defaultRange: "last90Days",
  tables: ["payslips", "payroll_runs", "employees"],
  tags: ["register", "payslips"],
  countLabel: "Payslips",
  columns: [
    { key: "period", label: "Pay period", type: "text" },
    { key: "runType", label: "Run type", type: "text" },
    { key: "runStatus", label: "Run status", type: "text" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "gross", label: "Gross pay", type: "number" },
    { key: "tax", label: "Income tax", type: "number" },
    { key: "eobi", label: "EOBI (employee)", type: "number" },
    { key: "other", label: "Other deductions and adjustments", type: "number" },
    { key: "net", label: "Net pay", type: "number" },
    { key: "employerCost", label: "Employer cost", type: "number" },
  ],
  sql: (q) => `
    SELECT pr.period_start::text || ' to ' || pr.period_end::text AS period, ${STATUS("pr.run_type")} AS "runType", ${STATUS("pr.status")} AS "runStatus", e.employee_number AS number, ${NAME("e")} AS name,
           ps.gross_pay AS gross, ps.income_tax_monthly AS tax, ps.eobi_employee_contribution AS eobi,
           ROUND(ps.gross_pay - ps.income_tax_monthly - ps.eobi_employee_contribution - ps.net_pay, 2) AS other, ps.net_pay AS net, ps.employer_cost AS "employerCost"
      FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
     WHERE ${RUN(q)} AND ${LIVE} AND ps.status <> 'voided' AND ${PERIOD(q)} AND ${runStatus(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}
     ORDER BY pr.period_end DESC, e.employee_number`,
  summary: (q) => `
    SELECT COUNT(*)::int AS slips, COALESCE(SUM(ps.gross_pay), 0) AS gross, COALESCE(SUM(ps.net_pay), 0) AS net, COALESCE(SUM(ps.employer_cost), 0) AS cost
      FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
     WHERE ${RUN(q)} AND ${LIVE} AND ps.status <> 'voided' AND ${PERIOD(q)} AND ${runStatus(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}`,
  kpis: ({ summary }) => [count("gross", "Total gross pay", round2(summary.gross ?? 0)), count("net", "Total net pay", round2(summary.net ?? 0)), count("cost", "Total employer cost", round2(summary.cost ?? 0))],
  calculation: [
    "One line per payslip on runs whose pay period ends in the range. Voided payslips and runs that are draft, cancelled or reversed are excluded. Choose a run status to narrow it.",
    "Other deductions and adjustments is the balancing figure: gross pay minus tax, EOBI and net pay. It carries loan recoveries, unpaid leave effects and any additions or retro amounts.",
    "Totals above cover every matching payslip, not just the rows on screen. " + MONEY_NOTE,
  ],
  notes: () => ["Calculated runs that are not yet finalised can still change. Filter by run status to see finalised pay only."],
});

// ---------------------------------------------------------------- F03 variance

export const F03 = sqlReport({
  description: "How each finalised regular run differs from the one before it in the same payroll area: employees, gross and net pay.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_runs", "payroll_areas"],
  viz: ["line", "table"],
  tags: ["variance", "period over period"],
  columns: [
    { key: "period", label: "Pay period", type: "text" },
    { key: "area", label: "Payroll area", type: "text" },
    { key: "employees", label: "Employees paid", type: "number" },
    { key: "employeesChange", label: "Employees change", type: "number" },
    { key: "gross", label: "Gross pay", type: "number" },
    { key: "grossChange", label: "Gross change", type: "number" },
    { key: "grossPct", label: "Gross change (%)", type: "percent" },
    { key: "net", label: "Net pay", type: "number" },
    { key: "netPct", label: "Net change (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH r AS (
      SELECT pr.id, pr.payroll_area_id, pr.period_start, pr.period_end, pr.calculated_count AS emps, pr.total_gross AS gross, pr.total_net AS net,
             LAG(pr.calculated_count) OVER w AS p_emps, LAG(pr.total_gross) OVER w AS p_gross, LAG(pr.total_net) OVER w AS p_net
        FROM payroll_runs pr WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular'
      WINDOW w AS (PARTITION BY pr.payroll_area_id ORDER BY pr.period_end, pr.created_at))
    SELECT r.period_start::text || ' to ' || r.period_end::text AS period, COALESCE(pa.name, 'Default') AS area, r.emps AS employees, r.emps - r.p_emps AS "employeesChange",
           r.gross AS gross, r.gross - r.p_gross AS "grossChange", CASE WHEN r.p_gross > 0 THEN ROUND((r.gross - r.p_gross) * 100.0 / r.p_gross, 1) END AS "grossPct",
           r.net AS net, CASE WHEN r.p_net > 0 THEN ROUND((r.net - r.p_net) * 100.0 / r.p_net, 1) END AS "netPct"
      FROM r LEFT JOIN payroll_areas pa ON pa.id = r.payroll_area_id
     WHERE r.period_end BETWEEN ${q.from} AND ${q.to}
     ORDER BY r.period_end DESC, area`,
  chart: ({ rows }) => lineChart({ title: "Gross and net pay by run", unit: "PKR", rows: [...rows].reverse(), xKey: "period", series: [{ key: "gross", label: "Gross pay" }, { key: "net", label: "Net pay" }] }),
  kpis: ({ rows }) => {
    const latest = rows[0];
    return [count("runs", "Runs compared", rows.length), percent("grossPct", "Latest gross change", latest ? (latest.grossPct as number | null) : null, latest ? String(latest.period) : undefined)];
  },
  calculation: ["Uses the totals stored on each finalised regular run. Each run is compared with the previous finalised regular run in the same payroll area; the first run in an area has nothing to compare with.", "Off-cycle runs are excluded so a bonus run does not look like a salary change. " + FINAL_NOTE, MONEY_NOTE],
});

// ---------------------------------------------------------------- F04 / K10 / K08 / K09 components

function components(o: {
  description: string;
  categoryFilter: string;
  tags: string[];
  title: string;
  deduction: boolean;
  calc: string[];
  extraWhere?: string;
  tables?: string[];
}) {
  return sqlReport({
    description: o.description,
    filters: [],
    defaultRange: "last12Months",
    tables: o.tables ?? ["payroll_component_results", "payroll_runs"],
    viz: ["bar", "kpi", "table"],
    tags: o.tags,
    columns: [
      { key: "category", label: "Category", type: "text" },
      { key: "component", label: "Component", type: "text" },
      { key: "employees", label: "Employees", type: "number" },
      { key: "amount", label: "Amount", type: "number" },
      { key: "share", label: "Share of category (%)", type: "percent" },
    ],
    sql: (q) => `
      SELECT t.category, t.component, t.employees, t.amount, CASE WHEN SUM(t.amount) OVER (PARTITION BY t.category) <> 0 THEN ROUND(t.amount * 100.0 / SUM(t.amount) OVER (PARTITION BY t.category), 1) END AS share
        FROM (
          SELECT ${STATUS("cr.category")} AS category, cr.label AS component, COUNT(DISTINCT cr.employee_id)::int AS employees,
                 ROUND(CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END, 2) AS amount, MIN(CASE cr.category WHEN 'earning' THEN 1 WHEN 'adjustment' THEN 2 WHEN 'employer_contribution' THEN 6 ELSE 3 END) AS ord
            FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id
           WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${o.categoryFilter} ${o.extraWhere ? `AND ${o.extraWhere}` : ""}
           GROUP BY cr.category, cr.label) t
       ORDER BY t.ord, t.amount DESC, t.component`,
    chart: ({ rows }) => barChart({ title: o.title, unit: "PKR", rows: rows.map((r) => ({ label: String(r.component), amount: r.amount })), labelKey: "label", valueKey: "amount", valueLabel: "Amount", max: 12 }),
    kpis: ({ rows }) => [count("amount", "Total", round2(sum(rows, "amount"))), count("components", "Components", rows.length)],
    calculation: [...o.calc, FINAL_NOTE, MONEY_NOTE],
  });
}

export const F04 = components({
  description: "Earnings, deductions, tax and employer contributions on finalised payroll, by component.",
  categoryFilter: "TRUE",
  tags: ["earnings", "deductions", "breakdown"],
  title: "Largest components",
  deduction: false,
  calc: ["Sums every payroll component result on in-range runs, grouped by category and component. Deduction, tax and recovery amounts are shown as positive amounts taken from pay.", "'Total' adds all rows, so it mixes earnings, deductions and employer contributions. Read it with the category column."],
});

export const K10 = components({
  description: "What was taken from pay: income tax, EOBI and other statutory deductions, employee deductions and recoveries.",
  categoryFilter: `cr.category IN ${DEDUCTIONS}`,
  tags: ["deductions"],
  title: "Deductions by component",
  deduction: true,
  calc: ["Sums component results in the tax, statutory deduction, employee deduction and recovery categories. Amounts are shown as positive amounts taken from pay."],
});

export const K08 = components({
  description: "What the employer paid on top of salary: EOBI, social security and any other employer contributions.",
  categoryFilter: "cr.category = 'employer_contribution'",
  tags: ["employer contributions", "statutory"],
  title: "Employer contributions by component",
  deduction: false,
  calc: ["Sums component results in the employer contribution category. These add to employer cost but are not part of the employee's gross pay."],
});

export const K09 = components({
  description: "Allowances and other earnings beyond basic salary: house rent, medical, bonuses and so on. Benefit plan costs held outside payroll are not included.",
  categoryFilter: "cr.category IN ('earning', 'adjustment')",
  extraWhere: "cr.component_key <> 'basic_salary'",
  tags: ["allowances", "earnings"],
  title: "Allowances and other earnings",
  deduction: false,
  calc: ["Sums earning and adjustment components other than basic salary. Basic salary is excluded so this shows what is paid on top.", "Benefit plan enrolments are not a payroll component here; their cost is not part of this figure."],
});

// ---------------------------------------------------------------- F05 net pay

export const F05 = sqlReport({
  description: "For each finalised run: employees paid, total and average net pay, and anyone paid nothing or less.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs"],
  viz: ["line", "table"],
  tags: ["net pay"],
  columns: [
    { key: "period", label: "Pay period", type: "text" },
    { key: "runType", label: "Run type", type: "text" },
    { key: "employees", label: "Employees paid", type: "number" },
    { key: "total", label: "Total net pay", type: "number" },
    { key: "avg", label: "Average net pay", type: "number" },
    { key: "median", label: "Median net pay", type: "number" },
    { key: "zeroOrLess", label: "Net pay of zero or less", type: "number" },
  ],
  sql: (q) => `
    SELECT pr.period_start::text || ' to ' || pr.period_end::text AS period, ${STATUS("pr.run_type")} AS "runType", COUNT(*)::int AS employees, ROUND(SUM(ps.net_pay), 2) AS total, ROUND(AVG(ps.net_pay), 2) AS avg,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ps.net_pay))::numeric, 2) AS median, COUNT(*) FILTER (WHERE ps.net_pay <= 0)::int AS "zeroOrLess"
      FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
     WHERE ${RUN(q)} AND ${FINAL} AND ps.status <> 'voided' AND ${PERIOD(q)}
     GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
  chart: ({ rows }) => lineChart({ title: "Total net pay by run", unit: "PKR", rows: [...rows].reverse(), xKey: "period", series: [{ key: "total", label: "Total net pay" }] }),
  kpis: ({ rows }) => [count("total", "Total net pay", round2(sum(rows, "total"))), count("zero", "Payslips with net pay of zero or less", sum(rows, "zeroOrLess")), count("runs", "Runs", rows.length)],
  calculation: ["Reads the net pay on each non-voided payslip of in-range runs. Median is the middle payslip when sorted by net pay.", FINAL_NOTE, MONEY_NOTE],
});

// ---------------------------------------------------------------- F06 reconciliation

export const F06 = listReport({
  description: "Payroll reconciliation checks: what was expected, what was found, and whether a variance is still open.",
  filters: ["runStatus"],
  defaultRange: "last12Months",
  tables: ["payroll_reconciliations", "payroll_runs"],
  tags: ["reconciliation", "variance"],
  countLabel: "Checks",
  columns: [
    { key: "period", label: "Pay period", type: "text" },
    { key: "kind", label: "Check", type: "text" },
    { key: "status", label: "Result", type: "text" },
    { key: "expected", label: "Expected", type: "number" },
    { key: "actual", label: "Actual", type: "number" },
    { key: "variance", label: "Variance", type: "number" },
    { key: "resolved", label: "Resolved on", type: "date" },
  ],
  sql: (q) => `
    SELECT pr.period_start::text || ' to ' || pr.period_end::text AS period, ${STATUS("rc.kind")} AS kind, ${STATUS("rc.status")} AS status, rc.expected_amount AS expected, rc.actual_amount AS actual,
           rc.variance, rc.resolved_at::date::text AS resolved
      FROM payroll_reconciliations rc JOIN payroll_runs pr ON pr.id = rc.payroll_run_id
     WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatus(q)}
     ORDER BY CASE rc.status WHEN 'variance' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, pr.period_end DESC, kind`,
  kpis: ({ rows }) => [count("variance", "Open variances", rows.filter((r) => r.status === "Variance").length), count("pending", "Pending", rows.filter((r) => r.status === "Pending").length), count("matched", "Matched", rows.filter((r) => r.status === "Matched").length)],
  calculation: ["Lists reconciliation checks recorded against runs whose pay period ends in the range. Open variances and pending checks come first.", "Expected and actual are the two amounts the check compared; variance is the difference stored by the check."],
});

// ---------------------------------------------------------------- F07 / K03 cost centre, K02 unit, K04 location

export const F07 = sqlReport({
  description: "Cost booked to each cost centre by the payroll costing step on finalised runs: gross cost, employer cost and total cost.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_costing_results", "payroll_runs", "cost_centers"],
  viz: ["bar", "kpi", "table"],
  tags: ["costing", "cost centre"],
  columns: [
    { key: "centre", label: "Cost centre", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "gross", label: "Gross cost", type: "number" },
    { key: "employer", label: "Employer cost", type: "number" },
    { key: "total", label: "Total cost", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(cc.code || ' - ' || cc.name, 'Unallocated') AS centre, COUNT(DISTINCT pc.employee_id)::int AS people, ROUND(SUM(pc.gross_cost), 2) AS gross, ROUND(SUM(pc.employer_cost), 2) AS employer, ROUND(SUM(pc.total_cost), 2) AS total
      FROM payroll_costing_results pc JOIN payroll_runs pr ON pr.id = pc.payroll_run_id LEFT JOIN cost_centers cc ON cc.id = pc.cost_center_id
     WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND pc.status = 'final'
     GROUP BY cc.id, cc.code, cc.name ORDER BY total DESC, centre`,
  chart: ({ rows }) => barChart({ title: "Total cost by cost centre", unit: "PKR", rows, labelKey: "centre", valueKey: "total", valueLabel: "Total cost", max: 12 }),
  kpis: ({ rows }) => [count("total", "Total cost", round2(sum(rows, "total"))), count("centres", "Cost centres", rows.filter((r) => r.centre !== "Unallocated").length)],
  notes: ({ rows }) => (rows.length === 0 ? ["No final costing results exist in this range. Costing is created when a run is posted to accounting; runs finalised before that step was used have none."] : []),
  calculation: ["Sums the final costing results created by payroll when a run is costed. Each result splits one payslip's cost across cost centres by allocation.", "Superseded and draft costing results are ignored. People with no allocation are shown as Unallocated. " + MONEY_NOTE],
});

function costBy(o: { dimension: string; label: string; join: string; group: string; weight: string; description: string; title: string; tags: string[]; id: string; calc: string[]; tables: string[] }) {
  return sqlReport({
    description: o.description,
    filters: [DEPT, LOC],
    defaultRange: "last12Months",
    tables: o.tables,
    viz: ["bar", "kpi", "table"],
    tags: o.tags,
    columns: [
      { key: "label", label: o.dimension, type: "text" },
      { key: "people", label: "People paid", type: "number" },
      { key: "gross", label: "Gross pay", type: "number" },
      { key: "employer", label: "Total employer cost", type: "number" },
      { key: "perPerson", label: "Employer cost per person paid", type: "number" },
    ],
    sql: (q) => `
      SELECT CASE WHEN g.people < 3 AND g.label NOT LIKE 'No %' THEN 'Other (groups under 3 people combined)' ELSE g.label END AS label, SUM(g.people)::int AS people, ROUND(SUM(g.gross), 2) AS gross, ROUND(SUM(g.employer), 2) AS employer,
             ROUND(SUM(g.employer) / NULLIF(SUM(g.people), 0), 2) AS "perPerson"
        FROM (
          SELECT ${o.label} AS label, COUNT(DISTINCT ps.employee_id) AS people, SUM(ps.gross_pay * ${o.weight}) AS gross, SUM(ps.employer_cost * ${o.weight}) AS employer
            FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id ${o.join}
           WHERE ${RUN(q)} AND ${FINAL} AND ps.status <> 'voided' AND ${PERIOD(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}
           GROUP BY ${o.group}) g
       GROUP BY 1 ORDER BY employer DESC, label`,
    chart: ({ rows }) => barChart({ title: o.title, unit: "PKR", rows, labelKey: "label", valueKey: "employer", valueLabel: "Employer cost", max: 12 }),
    kpis: ({ rows }) => [count("employer", "Total employer cost", round2(sum(rows, "employer"))), count("gross", "Gross pay", round2(sum(rows, "gross"))), count("groups", `${o.dimension}s`, rows.length)],
    calculation: [...o.calc, "A group with fewer than 3 people is merged into 'Other' so one person's pay cannot be read off. Employer cost is gross pay plus employer contributions. " + FINAL_NOTE, MONEY_NOTE],
  });
}

export const K02 = costBy({
  id: "K02",
  dimension: "Organisation unit",
  label: "COALESCE(ou.name, 'No organisation unit set')",
  join: "LEFT JOIN org_units ou ON ou.id = e.org_unit_id",
  group: "ou.id, ou.name",
  weight: "1",
  description: "Gross pay and employer cost for each organisation unit, from finalised payslips and where each employee sits now.",
  title: "Employer cost by unit",
  tags: ["cost", "unit"],
  tables: ["payslips", "payroll_runs", "employees", "org_units"],
  calc: ["Adds each payslip to the organisation unit the employee is in today, not where they were when paid."],
});

export const K03 = costBy({
  id: "K03",
  dimension: "Cost centre",
  label: "COALESCE(cc.code || ' - ' || cc.name, 'No cost centre allocated')",
  join: "LEFT JOIN employee_cost_allocations a ON a.employee_id = e.id AND a.status = 'active' LEFT JOIN cost_centers cc ON cc.id = a.cost_center_id",
  group: "cc.id, cc.code, cc.name",
  weight: "(COALESCE(a.allocation_percentage, 100) / 100.0)",
  description: "Gross pay and employer cost spread across cost centres by each employee's current allocation percentages.",
  title: "Employer cost by cost centre",
  tags: ["cost", "cost centre"],
  tables: ["payslips", "payroll_runs", "employees", "employee_cost_allocations", "cost_centers"],
  calc: ["Each payslip is split across the employee's active cost-centre allocations in proportion to their percentages; with no allocation the whole payslip sits under 'No cost centre allocated'.", "This is an estimate from today's allocations. The official booked cost is in the payroll costing report (F07)."],
});

export const K04 = costBy({
  id: "K04",
  dimension: "Location",
  label: "COALESCE(l.name, 'No location set')",
  join: "LEFT JOIN locations l ON l.id = e.location_id",
  group: "l.id, l.name",
  weight: "1",
  description: "Gross pay and employer cost for each work location, from finalised payslips.",
  title: "Employer cost by location",
  tags: ["cost", "location"],
  tables: ["payslips", "payroll_runs", "employees", "locations"],
  calc: ["Adds each payslip to the location the employee is assigned to today."],
});

// ---------------------------------------------------------------- K01 / K12 monthly cost

export const K01 = sqlReport({
  description: "Gross pay, employer contributions and total employer cost for each month of finalised payroll.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_runs"],
  viz: ["line", "kpi", "table"],
  tags: ["cost", "trend"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "runs", label: "Runs", type: "number" },
    { key: "paid", label: "Employees paid (person-months)", type: "number" },
    { key: "gross", label: "Gross pay", type: "number" },
    { key: "contributions", label: "Employer contributions", type: "number" },
    { key: "cost", label: "Total employer cost", type: "number" },
    { key: "net", label: "Net pay", type: "number" },
  ],
  sql: (q) => `
    SELECT to_char(date_trunc('month', pr.period_end), 'YYYY-MM') AS month, COUNT(*)::int AS runs, COALESCE(SUM(pr.calculated_count), 0)::int AS paid, ROUND(SUM(pr.total_gross), 2) AS gross,
           ROUND(SUM(pr.total_employer_contributions), 2) AS contributions, ROUND(SUM(pr.total_employer_cost), 2) AS cost, ROUND(SUM(pr.total_net), 2) AS net
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)}
     GROUP BY 1 ORDER BY 1`,
  chart: ({ rows }) => lineChart({ title: "Total employer cost by month", unit: "PKR", rows, xKey: "month", series: [{ key: "cost", label: "Total employer cost" }, { key: "gross", label: "Gross pay" }] }),
  kpis: ({ rows }) => [count("cost", "Total employer cost", round2(sum(rows, "cost"))), count("gross", "Gross pay", round2(sum(rows, "gross"))), count("months", "Months", rows.length)],
  calculation: ["Adds the totals stored on each finalised run (regular and off-cycle) by the month its pay period ends in.", FINAL_NOTE, MONEY_NOTE],
});

export const K12 = sqlReport({
  description: "Each month: how many employees were paid, how many were on the headcount, and what the employer cost per head was.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_runs", "payslips", "employees"],
  viz: ["line", "table"],
  tags: ["headcount", "cost per head"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "headcount", label: "Headcount at month end", type: "number" },
    { key: "paid", label: "Employees paid", type: "number" },
    { key: "cost", label: "Total employer cost", type: "number" },
    { key: "perPaid", label: "Cost per employee paid", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         p AS (SELECT date_trunc('month', pr.period_end)::date AS ms, COUNT(DISTINCT ps.employee_id)::int AS paid, SUM(ps.employer_cost) AS cost
                 FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
                WHERE ${RUN(q)} AND ${FINAL} AND ps.status <> 'voided' AND ${PERIOD(q)} GROUP BY 1),
         h AS (SELECT mo.ms, COUNT(e.id)::int AS headcount FROM mo
                 LEFT JOIN employees e ON ${q.co("e")} AND ${q.area("e")} AND e.date_of_joining <= mo.point AND NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL)
                  AND (e.termination_date IS NULL OR e.termination_date > mo.point) GROUP BY mo.ms)
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, h.headcount, COALESCE(p.paid, 0) AS paid, ROUND(COALESCE(p.cost, 0), 2) AS cost, ROUND(p.cost / NULLIF(p.paid, 0), 2) AS "perPaid"
      FROM mo JOIN h ON h.ms = mo.ms LEFT JOIN p ON p.ms = mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => lineChart({ title: "Employer cost per employee paid", unit: "PKR", rows: rows.filter((r) => r.perPaid !== null), xKey: "month", series: [{ key: "perPaid", label: "Cost per employee paid" }] }),
  kpis: ({ rows }) => [count("cost", "Total employer cost", round2(sum(rows, "cost"))), { key: "perPaid", label: "Latest cost per employee paid", value: ([...rows].reverse().find((r) => r.perPaid !== null)?.perPaid as number | undefined) ?? null, unit: "count" as const }],
  calculation: ["Headcount counts employees in your payroll areas who had joined and not left by month end. Employees paid and cost come from finalised payslips with a pay period ending in the month.", "Cost per employee paid is cost divided by distinct employees paid that month. Months with no finalised payroll show no cost.", MONEY_NOTE],
});

// ---------------------------------------------------------------- overtime pay: F08, K07

export const F08 = sqlReport({
  description: "Overtime pay that went through payroll, by organisation unit: people, amount and share of the unit's gross pay.",
  filters: [DEPT, LOC],
  defaultRange: "last12Months",
  tables: ["payroll_component_results", "payroll_runs", "employees", "org_units"],
  viz: ["bar", "table"],
  tags: ["overtime", "pay"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "people", label: "People with overtime pay", type: "number" },
    { key: "amount", label: "Overtime pay", type: "number" },
    { key: "grossShare", label: "Share of the unit's gross pay (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH o AS (
      SELECT e.org_unit_id, COUNT(DISTINCT cr.employee_id)::int AS people, SUM(cr.amount) AS amount
        FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id JOIN employees e ON e.id = cr.employee_id
       WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND cr.source_type = 'overtime' AND cr.category = 'earning' AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")} GROUP BY 1),
    g AS (
      SELECT e.org_unit_id, SUM(ps.gross_pay) AS gross
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id
       WHERE ${RUN(q)} AND ${FINAL} AND ps.status <> 'voided' AND ${PERIOD(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")} GROUP BY 1)
    SELECT CASE WHEN m.people < 3 AND m.unit NOT LIKE 'No %' THEN 'Other (groups under 3 people combined)' ELSE m.unit END AS unit, SUM(m.people)::int AS people, ROUND(SUM(m.amount), 2) AS amount,
           ROUND(SUM(m.amount) * 100.0 / NULLIF(SUM(m.gross), 0), 2) AS "grossShare"
      FROM (SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, o.people, o.amount, g.gross
              FROM o LEFT JOIN g ON g.org_unit_id IS NOT DISTINCT FROM o.org_unit_id LEFT JOIN org_units ou ON ou.id = o.org_unit_id) m
     GROUP BY 1 ORDER BY amount DESC, unit`,
  chart: ({ rows }) => barChart({ title: "Overtime pay by unit", unit: "PKR", rows, labelKey: "unit", valueKey: "amount", valueLabel: "Overtime pay", max: 12 }),
  kpis: ({ rows }) => [count("amount", "Overtime pay", round2(sum(rows, "amount"))), count("people", "People paid overtime", sum(rows, "people"))],
  calculation: ["Sums payroll component results that came from overtime records, on finalised runs in the range, by the unit the employee is in today. Units with fewer than 3 people are combined.", "Share of gross divides by all gross pay paid to that unit in the same runs. " + FINAL_NOTE, MONEY_NOTE],
});

export const K07 = sqlReport({
  description: "Overtime pay by month, with the hours behind it where the payroll line records hours.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_component_results", "payroll_runs"],
  viz: ["line", "table"],
  tags: ["overtime", "trend", "cost"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "people", label: "People paid overtime", type: "number" },
    { key: "hours", label: "Hours", type: "number" },
    { key: "amount", label: "Overtime pay", type: "number" },
  ],
  sql: (q) => `
    SELECT to_char(date_trunc('month', pr.period_end), 'YYYY-MM') AS month, COUNT(DISTINCT cr.employee_id)::int AS people,
           ROUND(COALESCE(SUM(cr.quantity) FILTER (WHERE cr.unit IN ('hours', 'hour')), 0), 1) AS hours, ROUND(SUM(cr.amount), 2) AS amount
      FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id
     WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND cr.source_type = 'overtime' AND cr.category = 'earning'
     GROUP BY 1 ORDER BY 1`,
  chart: ({ rows }) => lineChart({ title: "Overtime pay by month", unit: "PKR", rows, xKey: "month", series: [{ key: "amount", label: "Overtime pay" }] }),
  kpis: ({ rows }) => [count("amount", "Overtime pay", round2(sum(rows, "amount"))), { key: "hours", label: "Hours recorded", value: round1(sum(rows, "hours")), unit: "count" as const }],
  calculation: ["Sums payroll lines whose source is overtime, on finalised runs, by the month the pay period ends. Hours are only those lines that record hours as their unit.", FINAL_NOTE, MONEY_NOTE],
});

// ---------------------------------------------------------------- F10 exceptions

export const F10 = sqlReport({
  description: "Payroll calculation problems by type and severity, and how many are still open. No pay amounts are shown.",
  sensitivity: "internal",
  filters: ["runStatus"],
  defaultRange: "last12Months",
  tables: ["payroll_exceptions", "payroll_run_partitions", "payroll_runs"],
  viz: ["bar", "kpi", "table"],
  tags: ["exceptions", "failures"],
  columns: [
    { key: "class", label: "Type", type: "text" },
    { key: "severity", label: "Severity", type: "text" },
    { key: "open", label: "Open", type: "number" },
    { key: "resolved", label: "Resolved", type: "number" },
    { key: "waived", label: "Waived", type: "number" },
    { key: "superseded", label: "Superseded", type: "number" },
    { key: "total", label: "Total", type: "number" },
  ],
  sql: (q) => `
    SELECT ${STATUS("x.exception_class")} AS class, ${STATUS("x.severity")} AS severity, COUNT(*) FILTER (WHERE x.status = 'open')::int AS open, COUNT(*) FILTER (WHERE x.status = 'resolved')::int AS resolved,
           COUNT(*) FILTER (WHERE x.status = 'waived')::int AS waived, COUNT(*) FILTER (WHERE x.status = 'superseded')::int AS superseded, COUNT(*)::int AS total
      FROM payroll_exceptions x JOIN payroll_runs pr ON pr.id = x.payroll_run_id
     WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatus(q)}
     GROUP BY x.exception_class, x.severity ORDER BY open DESC, total DESC, class`,
  summary: (q) => `
    SELECT COUNT(*) FILTER (WHERE p.state = 'failed')::int AS failedPartitions
      FROM payroll_run_partitions p JOIN payroll_runs pr ON pr.id = p.payroll_run_id WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatus(q)}`,
  chart: ({ rows }) => barChart({ title: "Open exceptions by type", unit: "exceptions", rows: rows.filter((r) => num(r, "open") > 0), labelKey: "class", valueKey: "open", valueLabel: "Open" }),
  kpis: ({ rows, summary }) => [count("open", "Open exceptions", sum(rows, "open")), count("errors", "Open errors", sum(rows.filter((r) => r.severity === "Error"), "open")), count("failed", "Failed calculation batches", summary.failedpartitions ?? 0)],
  calculation: ["Counts payroll exceptions raised on runs whose pay period ends in the range, by type, severity and current status.", "Failed calculation batches are partitions of a run that stopped with an error."],
});

// ---------------------------------------------------------------- K05 cost per employee

export const K05 = sqlReport({
  description: "Average monthly employer cost per employee for each organisation unit. Small groups are combined so no one person's pay is exposed.",
  filters: [DEPT, LOC],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs", "employees", "org_units"],
  viz: ["bar", "table"],
  tags: ["cost per employee"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "payslips", label: "Payslips", type: "number" },
    { key: "avgCost", label: "Average employer cost per payslip", type: "number" },
    { key: "avgGross", label: "Average gross pay per payslip", type: "number" },
  ],
  sql: (q) => `
    SELECT CASE WHEN g.people < 3 AND g.unit NOT LIKE 'No %' THEN 'Other (groups under 3 people combined)' ELSE g.unit END AS unit, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips,
           ROUND(SUM(g.cost) / NULLIF(SUM(g.slips), 0), 2) AS "avgCost", ROUND(SUM(g.gross) / NULLIF(SUM(g.slips), 0), 2) AS "avgGross"
      FROM (
        SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, SUM(ps.employer_cost) AS cost, SUM(ps.gross_pay) AS gross
          FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
         WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular' AND ps.status <> 'voided' AND ${PERIOD(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}
         GROUP BY ou.id, ou.name) g
     GROUP BY 1 ORDER BY "avgCost" DESC NULLS LAST, unit`,
  chart: ({ rows }) => barChart({ title: "Average employer cost per payslip", unit: "PKR", rows, labelKey: "unit", valueKey: "avgCost", valueLabel: "Average employer cost", max: 12 }),
  kpis: ({ rows }) => {
    const slips = sum(rows, "payslips");
    return [count("people", "People", sum(rows, "people")), { key: "avg", label: "Average employer cost per payslip", value: slips ? round2(rows.reduce((s, r) => s + num(r, "avgCost") * num(r, "payslips"), 0) / slips) : null, unit: "count" as const }];
  },
  calculation: ["Averages employer cost (gross pay plus employer contributions) and gross pay over regular finalised payslips, by the unit each employee is in today.", "Units with fewer than 3 people are combined so an average cannot be traced to one person. Off-cycle runs are excluded. " + MONEY_NOTE],
});

// ---------------------------------------------------------------- K11 variance drivers

export const K11 = sqlReport({
  description: "What moved payroll cost between the last two months in the range: each pay component's amount then and now.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_component_results", "payroll_runs"],
  viz: ["bar", "table"],
  tags: ["variance", "drivers"],
  columns: [
    { key: "category", label: "Category", type: "text" },
    { key: "component", label: "Component", type: "text" },
    { key: "previous", label: "Previous month", type: "number" },
    { key: "latest", label: "Latest month", type: "number" },
    { key: "change", label: "Change", type: "number" },
    { key: "changePct", label: "Change (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH t AS (
      SELECT date_trunc('month', pr.period_end)::date AS ms, cr.category, cr.label,
             CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END AS amount
        FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id
       WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} GROUP BY 1, cr.category, cr.label),
    m AS (SELECT MAX(ms) AS latest FROM t),
    c AS (
      SELECT t.category, t.label, COALESCE(SUM(t.amount) FILTER (WHERE t.ms = m.latest), 0) AS latest,
             COALESCE(SUM(t.amount) FILTER (WHERE t.ms = (m.latest - interval '1 month')::date), 0) AS previous
        FROM t CROSS JOIN m GROUP BY t.category, t.label)
    SELECT ${STATUS("c.category")} AS category, c.label AS component, ROUND(c.previous, 2) AS previous, ROUND(c.latest, 2) AS latest, ROUND(c.latest - c.previous, 2) AS change,
           CASE WHEN c.previous <> 0 THEN ROUND((c.latest - c.previous) * 100.0 / ABS(c.previous), 1) END AS "changePct"
      FROM c WHERE c.latest <> c.previous ORDER BY ABS(c.latest - c.previous) DESC, component`,
  chart: ({ rows }) => barChart({ title: "Largest changes", unit: "PKR", rows: rows.map((r) => ({ label: String(r.component), change: r.change })), labelKey: "label", valueKey: "change", valueLabel: "Change", max: 12 }),
  kpis: ({ rows }) => [count("components", "Components that moved", rows.length)],
  notes: ({ rows }) => (rows.length === 0 ? ["Nothing changed between the last two months in range, or there is only one month of finalised payroll."] : []),
  calculation: ["Finds the latest month with finalised payroll in the range and the month before it, then totals each component in both. Only components whose total changed are listed.", "Deductions and tax are shown as positive amounts. Change is latest minus previous; the percentage divides by the size of the previous amount.", FINAL_NOTE, MONEY_NOTE],
});

// ---------------------------------------------------------------- K13 allocation exceptions

export const K13 = listReport({
  description: "Employees whose active cost-centre allocations do not add up to 100%, have no primary, or are missing altogether.",
  sensitivity: "internal",
  filters: [DEPT, LOC],
  tables: ["employee_cost_allocations", "cost_centers", "employees"],
  tags: ["allocation", "exceptions"],
  countLabel: "Exceptions",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "total", label: "Allocated (%)", type: "percent" },
    { key: "centres", label: "Cost centres", type: "number" },
    { key: "issue", label: "Issue", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(SUM(a.allocation_percentage), 0) AS total, COUNT(a.id)::int AS centres,
             CASE WHEN COUNT(a.id) = 0 THEN 'No cost centre allocated' WHEN ABS(SUM(a.allocation_percentage) - 100) > 0.01 THEN 'Allocations do not add up to 100%' WHEN COUNT(a.id) FILTER (WHERE a.is_primary) <> 1 THEN 'No single primary allocation' END AS issue
        FROM employees e LEFT JOIN employee_cost_allocations a ON a.employee_id = e.id AND a.status = 'active'
       WHERE ${q.co("e")} AND ${q.area("e")} AND ${q.current()} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}
       GROUP BY e.id) t WHERE issue IS NOT NULL ORDER BY issue, number`,
  summary: (q) => `SELECT COUNT(*)::int AS checked FROM employees e WHERE ${q.co("e")} AND ${q.area("e")} AND ${q.current()} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}`,
  kpis: ({ summary }) => [count("checked", "Employees checked", summary.checked ?? 0)],
  calculation: ["Checks every current employee in your payroll areas. Their active allocation percentages must add up to 100 and exactly one must be marked primary.", "An employee with no allocation is listed because their pay cannot be charged to a cost centre."],
});

// ---------------------------------------------------------------- K14 / K15 journals

export const K14 = listReport({
  description: "Payroll accounting journals for runs in the range: status, posting date and whether debits equal credits.",
  filters: ["runStatus"],
  defaultRange: "last12Months",
  tables: ["payroll_journals", "payroll_runs"],
  tags: ["journals", "posting"],
  countLabel: "Journals",
  columns: [
    { key: "period", label: "Pay period", type: "text" },
    { key: "number", label: "Journal", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "posted", label: "Posting date", type: "date" },
    { key: "debit", label: "Debit", type: "number" },
    { key: "credit", label: "Credit", type: "number" },
    { key: "difference", label: "Difference", type: "number" },
  ],
  sql: (q) => `
    SELECT pr.period_start::text || ' to ' || pr.period_end::text AS period, COALESCE(j.journal_number, 'Not numbered') AS number, ${STATUS("j.journal_kind")} AS kind, ${STATUS("j.status")} AS status,
           j.posting_date::text AS posted, j.total_debit AS debit, j.total_credit AS credit, ROUND(j.total_debit - j.total_credit, 2) AS difference
      FROM payroll_journals j JOIN payroll_runs pr ON pr.id = j.payroll_run_id
     WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatus(q)}
     ORDER BY pr.period_end DESC, j.generated_at DESC`,
  kpis: ({ rows }) => [count("posted", "Posted", rows.filter((r) => r.status === "Posted").length), count("draft", "Draft", rows.filter((r) => r.status === "Draft").length), count("unbalanced", "Out of balance", rows.filter((r) => num(r, "difference") !== 0).length)],
  notes: ({ rows }) => (rows.length === 0 ? ["No payroll journals exist for these runs. Journals are created when a run is sent to accounting."] : []),
  calculation: ["Lists journals created for runs whose pay period ends in the range. Difference is total debit minus total credit and should be zero for a posted journal."],
});

export const K15 = listReport({
  description: "Finance problems to chase: open reconciliation variances, journals that do not balance, and finalised runs with no journal.",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payroll_reconciliations", "payroll_journals", "payroll_runs"],
  tags: ["finance", "exceptions", "reconciliation"],
  countLabel: "Exceptions",
  columns: [
    { key: "period", label: "Pay period", type: "text" },
    { key: "issue", label: "Issue", type: "text" },
    { key: "detail", label: "Detail", type: "text" },
    { key: "amount", label: "Amount", type: "number" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT pr.period_start::text || ' to ' || pr.period_end::text AS period, 'Reconciliation ' || LOWER(rc.status) AS issue, INITCAP(rc.kind) || ' check' AS detail, rc.variance AS amount, pr.period_end AS sort_date
        FROM payroll_reconciliations rc JOIN payroll_runs pr ON pr.id = rc.payroll_run_id
       WHERE ${RUN(q)} AND ${PERIOD(q)} AND rc.status IN ('variance', 'pending')
      UNION ALL
      SELECT pr.period_start::text || ' to ' || pr.period_end::text, 'Journal out of balance', COALESCE(j.journal_number, 'Draft journal'), ROUND(j.total_debit - j.total_credit, 2), pr.period_end
        FROM payroll_journals j JOIN payroll_runs pr ON pr.id = j.payroll_run_id
       WHERE ${RUN(q)} AND ${PERIOD(q)} AND j.status IN ('draft', 'posted') AND j.total_debit <> j.total_credit
      UNION ALL
      SELECT pr.period_start::text || ' to ' || pr.period_end::text, 'Finalised run with no journal', 'Status ' || pr.status, pr.total_employer_cost, pr.period_end
        FROM payroll_runs pr
       WHERE ${RUN(q)} AND ${PERIOD(q)} AND pr.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed') AND pr.period_end < ${q.today} - 14
         AND NOT EXISTS (SELECT 1 FROM payroll_journals j WHERE j.payroll_run_id = pr.id AND j.status IN ('draft', 'posted'))
    ) t ORDER BY sort_date DESC, issue`,
  kpis: ({ rows }) => [count("unbalanced", "Journals out of balance", rows.filter((r) => r.issue === "Journal out of balance").length), count("noJournal", "Runs with no journal", rows.filter((r) => r.issue === "Finalised run with no journal").length)],
  calculation: ["Combines three checks over runs ending in the range: reconciliation checks that are variance or pending, draft or posted journals where debit and credit differ, and finalised runs more than 14 days old with no draft or posted journal.", "Amount is the variance, the journal difference, or the run's total employer cost for a missing journal."],
});


// ---------------------------------------------------------------- I05 payslip access (metadata only)

export const I05 = sqlReport({
  description: "How many finalised payslips each month were opened by the employee, and how many times. Counts only; no amounts and no names.",
  domain: "payroll",
  filters: [],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs", "payslip_access_log"],
  viz: ["line", "kpi", "table"],
  tags: ["payslip", "self service", "access"],
  columns: [
    { key: "month", label: "Pay period month", type: "text" },
    { key: "payslips", label: "Finalised payslips", type: "number" },
    { key: "opened", label: "Opened by the employee", type: "number" },
    { key: "openRate", label: "Opened (%)", type: "percent" },
    { key: "opens", label: "Times opened", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         p AS (SELECT date_trunc('month', pr.period_end)::date AS ms, ps.id,
                      (SELECT COUNT(*) FROM payslip_access_log l WHERE l.payslip_id = ps.id AND ${q.co("l")}) AS opens
                 FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
                WHERE ${RUN(q)} AND ${FINAL} AND ps.status <> 'voided' AND ${PERIOD(q)})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(p.id)::int AS payslips, COUNT(p.id) FILTER (WHERE p.opens > 0)::int AS opened,
           ROUND(COUNT(p.id) FILTER (WHERE p.opens > 0) * 100.0 / NULLIF(COUNT(p.id), 0), 1) AS "openRate", COALESCE(SUM(p.opens), 0)::int AS opens
      FROM mo LEFT JOIN p ON p.ms = mo.ms GROUP BY mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => lineChart({ title: "Payslips opened by the employee (%)", unit: "percent", rows: rows.filter((r) => r.openRate !== null), xKey: "month", series: [{ key: "openRate", label: "Opened (%)" }] }),
  kpis: ({ rows }) => {
    const slips = sum(rows, "payslips");
    return [percent("rate", "Opened by the employee", slips ? round1((sum(rows, "opened") * 100) / slips) : null, "Finalised payslips in the period"), count("opens", "Times opened", sum(rows, "opens"))];
  },
  notes: () => ["Opens are recorded from the day this report was introduced. Earlier months show 0 opened because nothing was recorded then, not because nobody looked."],
  calculation: [
    "Takes finalised payslips (and beyond) for pay periods ending in the month, in your payroll areas, and counts those the employee opened at least once.",
    "Only the employee opening their own payslip or published payslip document counts. Payroll staff and managers viewing it do not. Opening the same payslip again within ten minutes counts once.",
    "Nothing about the payslip content is stored here. Payslips hidden from employees count as not opened.",
  ],
});
