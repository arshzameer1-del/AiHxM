import { DEPT, LOC, type Q, type ReportSectionSpec } from "../report-spec";
import { LABEL, NAME, col } from "./common";

/**
 * Extra tables for the payroll, compensation and finance-cost reports (F01 to F10, K01 to K15, I05).
 *
 * Rules that hold for every table here: the query starts from payroll_runs and applies the company and payroll-area
 * limit through RUN(q) (the framework refuses a query that does not); only real, non-simulation runs are read; money
 * comes only from approved and finalised runs or beyond; and a table shows pay per person only under F02, the
 * restricted register. Everywhere else, for callers who see only part of the company, groups with fewer than 3 people are merged into "Other" so no one person's pay
 * can be read from an average or a total.
 */

const RUN = (q: Q) => `${q.co("pr")} AND ${q.area("pr")} AND pr.is_simulation = false`;
const FINAL = "pr.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed')";
const LIVE = "pr.status NOT IN ('draft', 'pre_validated', 'calculating', 'cancelled', 'reversed')";
const PERIOD = (q: Q) => `pr.period_end BETWEEN ${q.from} AND ${q.to}`;
const DEDUCTIONS = "('employee_deduction', 'tax', 'statutory_deduction', 'recovery')";
const MONTH = "to_char(date_trunc('month', pr.period_end), 'YYYY-MM')";
const PERIOD_TEXT = "pr.period_start::text || ' to ' || pr.period_end::text";
const SLIP_FROM = "payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id";
const SLIP_OK = "ps.status <> 'voided'";
const runStatusFilter = (q: Q) => {
  const v = q.filter("runStatus");
  return v ? `pr.status = ${q.bind(v)}` : "TRUE";
};
const OTHER = "Other (groups under 3 people combined)";
const n = (key: string, label: string) => col(key, label, "number");

// ---------------------------------------------------------------- runs

const RUN_LIST: ReportSectionSpec = {
  key: "runs",
  title: "Payroll runs",
  description: "Every finalised run in the period with its totals: people, gross, tax, deductions, employer contributions, employer cost and net pay.",
  columns: [col("period", "Pay period"), col("area", "Payroll area"), col("runType", "Run type"), col("status", "Status"), n("employees", "Employees"), n("gross", "Gross pay"), n("tax", "Income tax"), n("deductions", "Employee deductions"), n("contributions", "Employer contributions"), n("cost", "Employer cost"), n("net", "Net pay"), col("finalised", "Finalised on", "date")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, COALESCE(pa.name, 'Default') AS area, ${LABEL("pr.run_type")} AS "runType", ${LABEL("pr.status")} AS status, pr.calculated_count AS employees,
           pr.total_gross AS gross, pr.total_income_tax AS tax, pr.total_employee_deductions AS deductions, pr.total_employer_contributions AS contributions, pr.total_employer_cost AS cost, pr.total_net AS net, pr.finalized_at::date::text AS finalised
      FROM payroll_runs pr LEFT JOIN payroll_areas pa ON pa.id = pr.payroll_area_id WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} ORDER BY pr.period_end DESC, pr.created_at DESC`,
};

const RUNS_BY_AREA: ReportSectionSpec = {
  key: "by-area",
  title: "By payroll area",
  description: "Finalised payroll for each payroll area.",
  columns: [col("label", "Payroll area"), n("runs", "Runs"), n("paid", "Employees paid (person-runs)"), n("gross", "Gross pay"), n("tax", "Income tax"), n("contributions", "Employer contributions"), n("cost", "Employer cost"), n("net", "Net pay")],
  sql: (q) => `
    SELECT COALESCE(pa.name, 'Default') AS label, COUNT(*)::int AS runs, COALESCE(SUM(pr.calculated_count), 0)::int AS paid, ROUND(SUM(pr.total_gross), 2) AS gross, ROUND(SUM(pr.total_income_tax), 2) AS tax,
           ROUND(SUM(pr.total_employer_contributions), 2) AS contributions, ROUND(SUM(pr.total_employer_cost), 2) AS cost, ROUND(SUM(pr.total_net), 2) AS net
      FROM payroll_runs pr LEFT JOIN payroll_areas pa ON pa.id = pr.payroll_area_id WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} GROUP BY pa.id, pa.name ORDER BY cost DESC NULLS LAST, label`,
};

const RUNS_BY_TYPE: ReportSectionSpec = {
  key: "by-run-type",
  title: "Regular and off-cycle runs",
  description: "Finalised payroll split by run type, so a bonus or correction run is not mistaken for a salary change.",
  columns: [col("label", "Run type"), n("runs", "Runs"), n("paid", "Employees paid (person-runs)"), n("gross", "Gross pay"), n("cost", "Employer cost"), n("net", "Net pay")],
  sql: (q) => `
    SELECT ${LABEL("pr.run_type")} AS label, COUNT(*)::int AS runs, COALESCE(SUM(pr.calculated_count), 0)::int AS paid, ROUND(SUM(pr.total_gross), 2) AS gross, ROUND(SUM(pr.total_employer_cost), 2) AS cost, ROUND(SUM(pr.total_net), 2) AS net
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} GROUP BY pr.run_type ORDER BY cost DESC NULLS LAST, label`,
};

const MONTHLY: ReportSectionSpec = {
  key: "by-month",
  title: "By month",
  description: "Finalised payroll for each month: gross, tax, deductions, employer contributions, cost and net pay.",
  columns: [col("month", "Month"), n("runs", "Runs"), n("paid", "Employees paid (person-months)"), n("gross", "Gross pay"), n("tax", "Income tax"), n("deductions", "Employee deductions"), n("contributions", "Employer contributions"), n("cost", "Employer cost"), n("net", "Net pay")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*)::int AS runs, COALESCE(SUM(pr.calculated_count), 0)::int AS paid, ROUND(SUM(pr.total_gross), 2) AS gross, ROUND(SUM(pr.total_income_tax), 2) AS tax,
           ROUND(SUM(pr.total_employee_deductions), 2) AS deductions, ROUND(SUM(pr.total_employer_contributions), 2) AS contributions, ROUND(SUM(pr.total_employer_cost), 2) AS cost, ROUND(SUM(pr.total_net), 2) AS net
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} GROUP BY 1 ORDER BY 1`,
};

const CATEGORY_MONTHLY: ReportSectionSpec = {
  key: "category-by-month",
  title: "Pay categories by month",
  description: "Earnings, tax, statutory and other deductions, recoveries and employer contributions for each month.",
  columns: [col("month", "Month"), col("category", "Category"), n("components", "Components"), n("people", "People"), n("amount", "Amount")],
  sql: (q) => `
    SELECT ${MONTH} AS month, ${LABEL("cr.category")} AS category, COUNT(DISTINCT cr.component_key)::int AS components, COUNT(DISTINCT cr.employee_id)::int AS people,
           ROUND(CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END, 2) AS amount
      FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} GROUP BY 1, cr.category ORDER BY 1, cr.category`,
};

/** One row per month and component for the chosen categories. `where` is a condition on `cr`. */
const componentMonthly = (key: string, title: string, description: string, where: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("month", "Month"), col("category", "Category"), col("component", "Component"), n("people", "People"), n("amount", "Amount")],
  sql: (q) => `
    SELECT ${MONTH} AS month, ${LABEL("cr.category")} AS category, cr.label AS component, COUNT(DISTINCT cr.employee_id)::int AS people,
           ROUND(CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END, 2) AS amount
      FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id
     WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${where} GROUP BY 1, cr.category, cr.label ORDER BY 1, cr.category, amount DESC, cr.label`,
});

const componentByRun = (key: string, title: string, description: string, where: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("period", "Pay period"), col("runType", "Run type"), col("component", "Component"), n("people", "People"), n("amount", "Amount")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", cr.label AS component, COUNT(DISTINCT cr.employee_id)::int AS people,
           ROUND(CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END, 2) AS amount
      FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id
     WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${where} GROUP BY pr.id, cr.component_key, cr.label, cr.category ORDER BY pr.period_end DESC, pr.created_at DESC, amount DESC, component`,
});

const componentByUnit = (key: string, title: string, description: string, where: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("label", "Organisation unit"), col("component", "Component"), n("people", "People"), n("amount", "Amount")],
  sql: (q) => `
    SELECT CASE WHEN g.people < ${q.minGroup} AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, g.component, SUM(g.people)::int AS people, ROUND(SUM(g.amount), 2) AS amount
      FROM (SELECT COALESCE(ou.name, 'No organisation unit set') AS label, cr.label AS component, COUNT(DISTINCT cr.employee_id) AS people,
                   CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END AS amount
              FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id JOIN employees e ON e.id = cr.employee_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
             WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${where} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}
             GROUP BY ou.id, ou.name, cr.label, cr.category) g
     GROUP BY 1, 2 ORDER BY 1, amount DESC, 2`,
});

const STATUTORY_MONTHLY: ReportSectionSpec = {
  key: "statutory-by-month",
  title: "Tax and statutory contributions by month",
  description: "Income tax, EOBI (employee and employer) and social security collected on finalised payslips each month.",
  columns: [col("month", "Month"), n("payslips", "Payslips"), n("tax", "Income tax"), n("eobiEmployee", "EOBI (employee)"), n("eobiEmployer", "EOBI (employer)"), n("socialSecurity", "Social security (employer)")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*)::int AS payslips, ROUND(SUM(ps.income_tax_monthly), 2) AS tax, ROUND(SUM(ps.eobi_employee_contribution), 2) AS "eobiEmployee",
           ROUND(SUM(ps.eobi_employer_contribution), 2) AS "eobiEmployer", ROUND(SUM(COALESCE(ps.social_security_employer_contribution, 0)), 2) AS "socialSecurity"
      FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY 1 ORDER BY 1`,
};

const PAYSLIP_FLAGS: ReportSectionSpec = {
  key: "payslip-flags",
  title: "Payslips with unpaid leave, arrears or no pay",
  description: "How many payslips each month carry unpaid leave, arrears or retro pay, or pay nothing. Counts only.",
  columns: [col("month", "Month"), n("payslips", "Payslips"), n("unpaid", "With unpaid leave"), n("arrears", "With arrears or retro pay"), n("zero", "Net pay of zero or less"), n("partial", "Paid for part of the period")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*)::int AS payslips, COUNT(*) FILTER (WHERE ps.unpaid_leave_days > 0)::int AS unpaid, COUNT(*) FILTER (WHERE COALESCE(ps.arrears_amount, 0) <> 0)::int AS arrears,
           COUNT(*) FILTER (WHERE ps.net_pay <= 0)::int AS zero, COUNT(*) FILTER (WHERE ps.paid_days < ps.days_in_period)::int AS partial
      FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY 1 ORDER BY 1`,
};

const NET_BANDS: ReportSectionSpec = {
  key: "net-pay-bands",
  title: "Net pay bands",
  description: "How many payslips fall in each net pay band. Counts only.",
  columns: [col("label", "Net pay band"), n("payslips", "Payslips"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS payslips, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN ps.net_pay <= 0 THEN '0 Zero or less' WHEN ps.net_pay < 50000 THEN '1 Under 50,000' WHEN ps.net_pay < 100000 THEN '2 50,000 to 99,999' WHEN ps.net_pay < 200000 THEN '3 100,000 to 199,999'
                         WHEN ps.net_pay < 400000 THEN '4 200,000 to 399,999' ELSE '5 400,000 and over' END AS band
              FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)}) b GROUP BY b.band ORDER BY b.band`,
};

/** Pay grouped by an employee attribute, small groups merged. `monthly` adds a month column and groups each month separately. */
function costGroup(key: string, title: string, description: string, dimLabel: string, labelExpr: string, join: string, o: { monthly?: boolean; weight?: string; onlyRegular?: boolean } = {}): ReportSectionSpec {
  const w = o.weight ?? "1";
  const m = o.monthly;
  return {
    key,
    title,
    description,
    columns: [...(m ? [col("month", "Month")] : []), col("label", dimLabel), n("people", "People paid"), n("payslips", "Payslips"), n("gross", "Gross pay"), n("tax", "Income tax"), n("net", "Net pay"), n("cost", "Employer cost"), n("perPerson", "Employer cost per person paid")],
    sql: (q) => `
      SELECT ${m ? "g.month, " : ""}CASE WHEN g.people < ${q.minGroup} AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips, ROUND(SUM(g.gross), 2) AS gross,
             ROUND(SUM(g.tax), 2) AS tax, ROUND(SUM(g.net), 2) AS net, ROUND(SUM(g.cost), 2) AS cost, ROUND(SUM(g.cost) / NULLIF(SUM(g.people), 0), 2) AS "perPerson"
        FROM (SELECT ${m ? `${MONTH} AS month, ` : ""}${labelExpr} AS label, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, SUM(ps.gross_pay * ${w}) AS gross, SUM(ps.income_tax_monthly * ${w}) AS tax,
                     SUM(ps.net_pay * ${w}) AS net, SUM(ps.employer_cost * ${w}) AS cost
                FROM ${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id ${join}
               WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)}${o.onlyRegular ? " AND pr.run_type = 'regular'" : ""} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}
               GROUP BY ${m ? "1, " : ""}${labelExpr}) g
       GROUP BY ${m ? "1, 2" : "1"} ORDER BY ${m ? "1, cost DESC NULLS LAST, label" : "cost DESC NULLS LAST, label"}`,
  };
}

const UNIT_LABEL = "COALESCE(ou.name, 'No organisation unit set')";
const UNIT_JOIN = "LEFT JOIN org_units ou ON ou.id = e.org_unit_id";
const LOC_LABEL = "COALESCE(l.name, 'No location set')";
const LOC_JOIN = "LEFT JOIN locations l ON l.id = e.location_id";
const CC_LABEL = "COALESCE(cc.code || ' - ' || cc.name, 'No cost centre allocated')";
const CC_JOIN = "LEFT JOIN employee_cost_allocations a ON a.employee_id = e.id AND a.status = 'active' LEFT JOIN cost_centers cc ON cc.id = a.cost_center_id";
const CC_WEIGHT = "(COALESCE(a.allocation_percentage, 100) / 100.0)";

const BY_UNIT = costGroup("by-unit", "By organisation unit", "Finalised pay for each unit, where each employee sits today. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "Organisation unit", UNIT_LABEL, UNIT_JOIN);
const BY_UNIT_MONTH = costGroup("by-unit-month", "Organisation unit by month", "Finalised pay for each unit in each month. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "Organisation unit", UNIT_LABEL, UNIT_JOIN, { monthly: true });
const BY_LOCATION = costGroup("by-location", "By location", "Finalised pay for each work location. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "Location", LOC_LABEL, LOC_JOIN);
const BY_LOCATION_MONTH = costGroup("by-location-month", "Location by month", "Finalised pay for each location in each month. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "Location", LOC_LABEL, LOC_JOIN, { monthly: true });
const BY_COST_CENTRE = costGroup("by-cost-centre", "By cost centre (current allocation)", "Pay spread across cost centres by each employee's current allocation. An estimate from today's allocations.", "Cost centre", CC_LABEL, CC_JOIN, { weight: CC_WEIGHT });
const BY_UNIT_REGULAR = costGroup("by-unit-regular", "Regular runs by organisation unit", "Regular runs only, so one-off payments do not distort the unit's usual cost.", "Organisation unit", UNIT_LABEL, UNIT_JOIN, { onlyRegular: true });
const BY_GRADE_BAND: ReportSectionSpec = {
  key: "by-employment-type",
  title: "By employment type",
  description: "Finalised pay by employment type. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.",
  columns: [col("label", "Employment type"), n("people", "People paid"), n("payslips", "Payslips"), n("gross", "Gross pay"), n("cost", "Employer cost"), n("perPerson", "Employer cost per person paid")],
  sql: (q) => `
    SELECT CASE WHEN g.people < ${q.minGroup} AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips, ROUND(SUM(g.gross), 2) AS gross, ROUND(SUM(g.cost), 2) AS cost,
           ROUND(SUM(g.cost) / NULLIF(SUM(g.people), 0), 2) AS "perPerson"
      FROM (SELECT COALESCE(NULLIF(INITCAP(REPLACE(e.employment_type, '_', ' ')), ''), 'No employment type set') AS label, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, SUM(ps.gross_pay) AS gross, SUM(ps.employer_cost) AS cost
              FROM ${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id
             WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")} GROUP BY 1) g
     GROUP BY 1 ORDER BY cost DESC NULLS LAST, label`,
};

// ---------------------------------------------------------------- F01 run progress (counts only)

const F01_BY_STATUS: ReportSectionSpec = {
  key: "by-status",
  title: "Runs by status and type",
  description: "How many runs are in each status, split by regular and off-cycle. Counts only.",
  columns: [col("label", "Status"), n("regular", "Regular"), n("offCycle", "Off-cycle"), n("total", "Total"), n("employees", "Employees in the runs")],
  sql: (q) => `
    SELECT ${LABEL("pr.status")} AS label, COUNT(*) FILTER (WHERE pr.run_type = 'regular')::int AS regular, COUNT(*) FILTER (WHERE pr.run_type <> 'regular')::int AS "offCycle", COUNT(*)::int AS total, COALESCE(SUM(pr.population_count), 0)::int AS employees
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY pr.status ORDER BY total DESC, label`,
};
const F01_BY_AREA: ReportSectionSpec = {
  key: "by-area",
  title: "Runs by payroll area",
  description: "Run progress for each payroll area. Counts only.",
  columns: [col("label", "Payroll area"), n("runs", "Runs"), n("inProgress", "Still in progress"), n("finalised", "Finalised or closed"), n("failed", "People that failed to calculate"), n("warnings", "Warnings")],
  sql: (q) => `
    SELECT COALESCE(pa.name, 'Default') AS label, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE pr.status NOT IN ('finalized', 'closed', 'cancelled', 'reversed'))::int AS "inProgress",
           COUNT(*) FILTER (WHERE pr.status IN ('finalized', 'closed'))::int AS finalised, COALESCE(SUM(pr.failed_count), 0)::int AS failed, COALESCE(SUM(pr.warning_count), 0)::int AS warnings
      FROM payroll_runs pr LEFT JOIN payroll_areas pa ON pa.id = pr.payroll_area_id WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY pa.id, pa.name ORDER BY runs DESC, label`,
};
const F01_TIMELINE: ReportSectionSpec = {
  key: "timeline",
  title: "Run timeline",
  description: "When each run was created, calculated, finalised and closed, and how many days each step took. Dates only.",
  columns: [col("period", "Pay period"), col("runType", "Run type"), col("status", "Status"), col("created", "Created", "date"), col("calculated", "Calculated", "date"), col("finalised", "Finalised", "date"), col("closed", "Closed", "date"), n("daysToFinalise", "Days from creation to finalised")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", ${LABEL("pr.status")} AS status, pr.created_at::date::text AS created, pr.calculated_at::date::text AS calculated, pr.finalized_at::date::text AS finalised,
           pr.closed_at::date::text AS closed, CASE WHEN pr.finalized_at IS NOT NULL THEN (pr.finalized_at::date - pr.created_at::date)::int END AS "daysToFinalise"
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const F01_PROBLEMS: ReportSectionSpec = {
  key: "runs-with-problems",
  title: "Runs with failures, warnings or open exceptions",
  description: "Runs that need attention, with the number of people affected. Counts only.",
  columns: [col("period", "Pay period"), col("runType", "Run type"), col("status", "Status"), n("employees", "Employees"), n("failed", "Failed"), n("warnings", "Warnings"), n("openExceptions", "Open exceptions"), n("failedBatches", "Failed batches")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", ${LABEL("pr.status")} AS status, pr.population_count AS employees, pr.failed_count AS failed, pr.warning_count AS warnings,
           (SELECT COUNT(*) FROM payroll_exceptions x WHERE x.payroll_run_id = pr.id AND x.status = 'open')::int AS "openExceptions",
           (SELECT COUNT(*) FROM payroll_run_partitions p WHERE p.payroll_run_id = pr.id AND p.state = 'failed')::int AS "failedBatches"
      FROM payroll_runs pr
     WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)}
       AND (pr.failed_count > 0 OR pr.warning_count > 0 OR EXISTS (SELECT 1 FROM payroll_exceptions x WHERE x.payroll_run_id = pr.id AND x.status = 'open') OR EXISTS (SELECT 1 FROM payroll_run_partitions p WHERE p.payroll_run_id = pr.id AND p.state = 'failed'))
     ORDER BY pr.period_end DESC`,
};
const F01_BY_MONTH: ReportSectionSpec = {
  key: "by-month",
  title: "Runs by month",
  description: "How many runs ended each month and how many reached final status. Counts only.",
  columns: [col("month", "Month"), n("runs", "Runs"), n("finalised", "Finalised or closed"), n("cancelled", "Cancelled or reversed"), n("offCycle", "Off-cycle")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE pr.status IN ('finalized', 'closed'))::int AS finalised, COUNT(*) FILTER (WHERE pr.status IN ('cancelled', 'reversed'))::int AS cancelled,
           COUNT(*) FILTER (WHERE pr.run_type <> 'regular')::int AS "offCycle"
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY 1 ORDER BY 1`,
};

// ---------------------------------------------------------------- F02 register (restricted: per person)

const REG_FROM = `${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id`;
const REG_WHERE = (q: Q) => `${RUN(q)} AND ${LIVE} AND ${SLIP_OK} AND ${PERIOD(q)} AND ${runStatusFilter(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}`;

const REG_COMPONENTS: ReportSectionSpec = {
  key: "payslip-lines",
  title: "Payslip lines",
  description: "Every earning, deduction and contribution line on each payslip: the component, quantity, rate and amount.",
  columns: [col("period", "Pay period"), col("number", "Employee number"), col("name", "Name"), col("category", "Category"), col("component", "Component"), n("quantity", "Quantity"), col("unit", "Unit"), n("rate", "Rate"), n("amount", "Amount")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("cr.category")} AS category, cr.label AS component, cr.quantity AS quantity, COALESCE(cr.unit, '') AS unit, cr.rate AS rate, cr.amount AS amount
      FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id JOIN employees e ON e.id = cr.employee_id JOIN payslips ps ON ps.id = cr.payslip_id
     WHERE ${REG_WHERE(q)} ORDER BY pr.period_end DESC, e.employee_number, cr.line_no`,
};
const REG_ATTENDANCE_EFFECT: ReportSectionSpec = {
  key: "paid-days",
  title: "Paid days, unpaid leave and arrears",
  description: "For each payslip: days in the period, days paid, unpaid leave days and arrears or retro pay.",
  columns: [col("period", "Pay period"), col("number", "Employee number"), col("name", "Name"), n("days", "Days in period"), n("paid", "Days paid"), n("unpaid", "Unpaid leave days"), n("arrears", "Arrears or retro pay")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, e.employee_number AS number, ${NAME("e")} AS name, ps.days_in_period AS days, ps.paid_days AS paid, ps.unpaid_leave_days AS unpaid, COALESCE(ps.arrears_amount, 0) AS arrears
      FROM ${REG_FROM} WHERE ${REG_WHERE(q)} AND (ps.unpaid_leave_days > 0 OR ps.paid_days < ps.days_in_period OR COALESCE(ps.arrears_amount, 0) <> 0) ORDER BY pr.period_end DESC, e.employee_number`,
};
const REG_CHANGE: ReportSectionSpec = {
  key: "change-from-previous",
  title: "Change from the previous payslip",
  description: "Each person's gross and net pay compared with their previous payslip in the same payroll area. Largest changes first.",
  columns: [col("period", "Pay period"), col("number", "Employee number"), col("name", "Name"), n("gross", "Gross pay"), n("previousGross", "Previous gross pay"), n("change", "Gross change"), col("changePct", "Gross change (%)", "percent"), n("net", "Net pay"), n("netChange", "Net change")],
  sql: (q) => `
    SELECT * FROM (
      SELECT ${PERIOD_TEXT} AS period, e.employee_number AS number, ${NAME("e")} AS name, ps.gross_pay AS gross, LAG(ps.gross_pay) OVER w AS "previousGross", ps.gross_pay - LAG(ps.gross_pay) OVER w AS change,
             CASE WHEN LAG(ps.gross_pay) OVER w > 0 THEN ROUND((ps.gross_pay - LAG(ps.gross_pay) OVER w) * 100.0 / LAG(ps.gross_pay) OVER w, 1) END AS "changePct", ps.net_pay AS net, ps.net_pay - LAG(ps.net_pay) OVER w AS "netChange", pr.period_end AS sort_date
        FROM ${REG_FROM} WHERE ${REG_WHERE(q)} AND pr.run_type = 'regular'
      WINDOW w AS (PARTITION BY ps.employee_id, pr.payroll_area_id ORDER BY pr.period_end, pr.created_at)) t
     WHERE t.change IS NOT NULL AND t.change <> 0 ORDER BY ABS(t.change) DESC, t.number`,
};
const REG_LOW_NET: ReportSectionSpec = {
  key: "low-net-pay",
  title: "Net pay of zero or less",
  description: "Payslips where deductions took everything or more.",
  columns: [col("period", "Pay period"), col("number", "Employee number"), col("name", "Name"), n("gross", "Gross pay"), n("tax", "Income tax"), n("eobi", "EOBI (employee)"), n("net", "Net pay")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, e.employee_number AS number, ${NAME("e")} AS name, ps.gross_pay AS gross, ps.income_tax_monthly AS tax, ps.eobi_employee_contribution AS eobi, ps.net_pay AS net
      FROM ${REG_FROM} WHERE ${REG_WHERE(q)} AND ps.net_pay <= 0 ORDER BY pr.period_end DESC, e.employee_number`,
};
const REG_BY_RUN: ReportSectionSpec = {
  key: "totals-by-run",
  title: "Totals by run",
  description: "Gross, tax, EOBI, net pay and employer cost for each run in the register.",
  columns: [col("period", "Pay period"), col("runType", "Run type"), col("status", "Run status"), n("payslips", "Payslips"), n("gross", "Gross pay"), n("tax", "Income tax"), n("eobi", "EOBI (employee)"), n("net", "Net pay"), n("cost", "Employer cost")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", ${LABEL("pr.status")} AS status, COUNT(*)::int AS payslips, ROUND(SUM(ps.gross_pay), 2) AS gross, ROUND(SUM(ps.income_tax_monthly), 2) AS tax,
           ROUND(SUM(ps.eobi_employee_contribution), 2) AS eobi, ROUND(SUM(ps.net_pay), 2) AS net, ROUND(SUM(ps.employer_cost), 2) AS cost
      FROM ${REG_FROM} WHERE ${REG_WHERE(q)} GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const REG_BY_UNIT: ReportSectionSpec = {
  key: "totals-by-unit",
  title: "Totals by organisation unit",
  description: "Gross, net pay and employer cost for each unit in the register.",
  columns: [col("label", "Organisation unit"), n("people", "People"), n("payslips", "Payslips"), n("gross", "Gross pay"), n("net", "Net pay"), n("cost", "Employer cost")],
  sql: (q) => `
    SELECT ${UNIT_LABEL} AS label, COUNT(DISTINCT ps.employee_id)::int AS people, COUNT(*)::int AS payslips, ROUND(SUM(ps.gross_pay), 2) AS gross, ROUND(SUM(ps.net_pay), 2) AS net, ROUND(SUM(ps.employer_cost), 2) AS cost
      FROM ${REG_FROM} ${UNIT_JOIN} WHERE ${REG_WHERE(q)} GROUP BY ou.id, ou.name ORDER BY cost DESC NULLS LAST, label`,
};
const REG_BANK_READY: ReportSectionSpec = {
  key: "bank-account-on-payslip",
  title: "Payslips with no bank account",
  description: "Payslips that carry no bank account number, so payment would have to be made another way. The number itself is never shown.",
  columns: [col("period", "Pay period"), col("number", "Employee number"), col("name", "Name"), n("net", "Net pay")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, e.employee_number AS number, ${NAME("e")} AS name, ps.net_pay AS net
      FROM ${REG_FROM} WHERE ${REG_WHERE(q)} AND COALESCE(ps.bank_account_number, '') = '' ORDER BY pr.period_end DESC, e.employee_number`,
};

// ---------------------------------------------------------------- F03 variance

const F03_MOVEMENT: ReportSectionSpec = {
  key: "people-movement",
  title: "People joining and leaving payroll between runs",
  description: "For each regular run: how many people were paid for the first time compared with the previous run in the same area, and how many were paid before but not now. Counts only.",
  columns: [col("period", "Pay period"), col("area", "Payroll area"), n("paid", "People paid"), n("added", "Not in the previous run"), n("dropped", "In the previous run, not now")],
  sql: (q) => `
    WITH r AS (
      SELECT pr.id, pr.period_start, pr.period_end, pr.payroll_area_id, LAG(pr.id) OVER (PARTITION BY pr.payroll_area_id ORDER BY pr.period_end, pr.created_at) AS prev
        FROM payroll_runs pr WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular')
    SELECT r.period_start::text || ' to ' || r.period_end::text AS period, COALESCE(pa.name, 'Default') AS area,
           (SELECT COUNT(*) FROM payslips s WHERE s.payroll_run_id = r.id AND s.status <> 'voided')::int AS paid,
           CASE WHEN r.prev IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM payslips s WHERE s.payroll_run_id = r.id AND s.status <> 'voided'
                AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.payroll_run_id = r.prev AND p.employee_id = s.employee_id AND p.status <> 'voided'))::int END AS added,
           CASE WHEN r.prev IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM payslips p WHERE p.payroll_run_id = r.prev AND p.status <> 'voided'
                AND NOT EXISTS (SELECT 1 FROM payslips s WHERE s.payroll_run_id = r.id AND s.employee_id = p.employee_id AND s.status <> 'voided'))::int END AS dropped
      FROM r LEFT JOIN payroll_areas pa ON pa.id = r.payroll_area_id WHERE r.period_end BETWEEN ${q.from} AND ${q.to} ORDER BY r.period_end DESC, area`,
};
const F03_COMPONENT_MOVE: ReportSectionSpec = {
  key: "component-movement",
  title: "Component change from the previous month",
  description: "Each pay component's monthly total and the change from the month before, so the driver of a variance can be found.",
  columns: [col("month", "Month"), col("category", "Category"), col("component", "Component"), n("amount", "Amount"), n("previous", "Previous month"), n("change", "Change")],
  sql: (q) => `
    WITH t AS (
      SELECT date_trunc('month', pr.period_end)::date AS ms, cr.category, cr.label,
             CASE WHEN cr.category IN ${DEDUCTIONS} THEN -SUM(cr.amount) ELSE SUM(cr.amount) END AS amount
        FROM payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} GROUP BY 1, cr.category, cr.label)
    SELECT to_char(t.ms, 'YYYY-MM') AS month, ${LABEL("t.category")} AS category, t.label AS component, ROUND(t.amount, 2) AS amount, ROUND(LAG(t.amount) OVER w, 2) AS previous, ROUND(t.amount - LAG(t.amount) OVER w, 2) AS change
      FROM t WINDOW w AS (PARTITION BY t.category, t.label ORDER BY t.ms) ORDER BY t.ms DESC, ABS(t.amount - COALESCE(LAG(t.amount) OVER w, 0)) DESC, component`,
};

// ---------------------------------------------------------------- F05 net pay

const F05_BY_UNIT: ReportSectionSpec = {
  key: "net-by-unit",
  title: "Net pay by organisation unit",
  description: "Average net pay per payslip and the share paid nothing or less, for each unit. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.",
  columns: [col("label", "Organisation unit"), n("people", "People paid"), n("payslips", "Payslips"), n("total", "Total net pay"), n("avg", "Average net pay"), n("zero", "Net pay of zero or less")],
  sql: (q) => `
    SELECT CASE WHEN g.people < ${q.minGroup} AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips, ROUND(SUM(g.total), 2) AS total,
           ROUND(SUM(g.total) / NULLIF(SUM(g.slips), 0), 2) AS avg, SUM(g.zero)::int AS zero
      FROM (SELECT ${UNIT_LABEL} AS label, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, SUM(ps.net_pay) AS total, COUNT(*) FILTER (WHERE ps.net_pay <= 0) AS zero
              FROM ${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id ${UNIT_JOIN} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY ou.id, ou.name) g
     GROUP BY 1 ORDER BY total DESC NULLS LAST, label`,
};
const F05_BY_MONTH: ReportSectionSpec = {
  key: "net-by-month",
  title: "Net pay by month",
  description: "Total, average and median net pay per payslip for each month.",
  columns: [col("month", "Month"), n("payslips", "Payslips"), n("total", "Total net pay"), n("avg", "Average net pay"), n("median", "Median net pay"), n("zero", "Net pay of zero or less")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*)::int AS payslips, ROUND(SUM(ps.net_pay), 2) AS total, ROUND(AVG(ps.net_pay), 2) AS avg, ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ps.net_pay))::numeric, 2) AS median,
           COUNT(*) FILTER (WHERE ps.net_pay <= 0)::int AS zero
      FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY 1 ORDER BY 1`,
};
const F05_GROSS_TO_NET: ReportSectionSpec = {
  key: "gross-to-net",
  title: "Gross to net",
  description: "Where gross pay went on finalised payslips for each month: tax, EOBI and everything else.",
  columns: [col("month", "Month"), n("gross", "Gross pay"), n("tax", "Income tax"), n("eobi", "EOBI (employee)"), n("other", "Other deductions and adjustments"), n("net", "Net pay"), col("takeHome", "Net as share of gross (%)", "percent")],
  sql: (q) => `
    SELECT ${MONTH} AS month, ROUND(SUM(ps.gross_pay), 2) AS gross, ROUND(SUM(ps.income_tax_monthly), 2) AS tax, ROUND(SUM(ps.eobi_employee_contribution), 2) AS eobi,
           ROUND(SUM(ps.gross_pay - ps.income_tax_monthly - ps.eobi_employee_contribution - ps.net_pay), 2) AS other, ROUND(SUM(ps.net_pay), 2) AS net, ROUND(SUM(ps.net_pay) * 100.0 / NULLIF(SUM(ps.gross_pay), 0), 1) AS "takeHome"
      FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY 1 ORDER BY 1`,
};

// ---------------------------------------------------------------- F06 reconciliation

const RC_FROM = "payroll_reconciliations rc JOIN payroll_runs pr ON pr.id = rc.payroll_run_id";
const F06_BY_KIND: ReportSectionSpec = {
  key: "by-check",
  title: "Results by check",
  description: "For each kind of check: how many matched, how many have a variance, how many are pending, and the total variance.",
  columns: [col("label", "Check"), n("checks", "Checks"), n("matched", "Matched"), n("variance", "Variance"), n("pending", "Pending"), n("variancePkr", "Total variance")],
  sql: (q) => `
    SELECT ${LABEL("rc.kind")} AS label, COUNT(*)::int AS checks, COUNT(*) FILTER (WHERE rc.status = 'matched')::int AS matched, COUNT(*) FILTER (WHERE rc.status = 'variance')::int AS variance,
           COUNT(*) FILTER (WHERE rc.status = 'pending')::int AS pending, ROUND(COALESCE(SUM(rc.variance), 0), 2) AS "variancePkr"
      FROM ${RC_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY rc.kind ORDER BY variance DESC, label`,
};
const F06_BY_RUN: ReportSectionSpec = {
  key: "by-run",
  title: "Results by run",
  description: "For each run: how many checks were made and how many are still open.",
  columns: [col("period", "Pay period"), col("runStatus", "Run status"), n("checks", "Checks"), n("matched", "Matched"), n("open", "Open variances"), n("pending", "Pending"), n("variancePkr", "Total variance")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.status")} AS "runStatus", COUNT(*)::int AS checks, COUNT(*) FILTER (WHERE rc.status = 'matched')::int AS matched, COUNT(*) FILTER (WHERE rc.status = 'variance')::int AS open,
           COUNT(*) FILTER (WHERE rc.status = 'pending')::int AS pending, ROUND(COALESCE(SUM(rc.variance), 0), 2) AS "variancePkr"
      FROM ${RC_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const F06_OPEN_AGE: ReportSectionSpec = {
  key: "open-variance-age",
  title: "Open variances and how long they have been open",
  description: "Variances and pending checks with the days since the check was run.",
  columns: [col("period", "Pay period"), col("kind", "Check"), col("status", "Result"), n("variancePkr", "Variance"), col("ran", "Check run on", "date"), n("daysOpen", "Days open")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("rc.kind")} AS kind, ${LABEL("rc.status")} AS status, rc.variance AS "variancePkr", rc.run_at::date::text AS ran, (${q.today} - rc.run_at::date)::int AS "daysOpen"
      FROM ${RC_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} AND rc.status IN ('variance', 'pending') ORDER BY "daysOpen" DESC, kind`,
};
const F06_RESOLVED: ReportSectionSpec = {
  key: "resolved",
  title: "Resolved variances",
  description: "Variances that were resolved: the check, the amount and how long resolution took.",
  columns: [col("period", "Pay period"), col("kind", "Check"), n("variancePkr", "Variance"), col("resolved", "Resolved on", "date"), n("days", "Days to resolve"), col("note", "Resolution note")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("rc.kind")} AS kind, rc.variance AS "variancePkr", rc.resolved_at::date::text AS resolved, (rc.resolved_at::date - rc.run_at::date)::int AS days, COALESCE(rc.resolution_note, '') AS note
      FROM ${RC_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} AND rc.resolved_at IS NOT NULL ORDER BY rc.resolved_at DESC`,
};

// ---------------------------------------------------------------- F07 cost centre

const PC_FROM = "payroll_costing_results pc JOIN payroll_runs pr ON pr.id = pc.payroll_run_id LEFT JOIN cost_centers cc ON cc.id = pc.cost_center_id";
const F07_BY_MONTH: ReportSectionSpec = {
  key: "centre-by-month",
  title: "Cost centre by month",
  description: "Cost booked to each cost centre for each month.",
  columns: [col("month", "Month"), col("centre", "Cost centre"), n("people", "People"), n("gross", "Gross cost"), n("employer", "Employer cost"), n("total", "Total cost")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COALESCE(cc.code || ' - ' || cc.name, 'Unallocated') AS centre, COUNT(DISTINCT pc.employee_id)::int AS people, ROUND(SUM(pc.gross_cost), 2) AS gross, ROUND(SUM(pc.employer_cost), 2) AS employer, ROUND(SUM(pc.total_cost), 2) AS total
      FROM ${PC_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND pc.status = 'final' GROUP BY 1, cc.id, cc.code, cc.name ORDER BY 1, total DESC, centre`,
};
const F07_STATUS: ReportSectionSpec = {
  key: "costing-status",
  title: "Costing results by status",
  description: "How many costing lines are final, still draft or superseded, by run.",
  columns: [col("period", "Pay period"), col("runStatus", "Run status"), n("final", "Final"), n("draft", "Draft"), n("superseded", "Superseded"), n("unallocated", "Final lines with no cost centre")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.status")} AS "runStatus", COUNT(*) FILTER (WHERE pc.status = 'final')::int AS final, COUNT(*) FILTER (WHERE pc.status = 'draft')::int AS draft,
           COUNT(*) FILTER (WHERE pc.status NOT IN ('final', 'draft'))::int AS superseded, COUNT(*) FILTER (WHERE pc.status = 'final' AND pc.cost_center_id IS NULL)::int AS unallocated
      FROM payroll_costing_results pc JOIN payroll_runs pr ON pr.id = pc.payroll_run_id WHERE ${RUN(q)} AND ${PERIOD(q)} GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const F07_SOURCE: ReportSectionSpec = {
  key: "allocation-source",
  title: "Where the allocation came from",
  description: "Final costing lines by the source of their allocation, for example the employee's own allocation or a default.",
  columns: [col("label", "Allocation source"), n("lines", "Costing lines"), n("people", "People"), n("total", "Total cost")],
  sql: (q) => `
    SELECT ${LABEL("pc.allocation_source")} AS label, COUNT(*)::int AS lines, COUNT(DISTINCT pc.employee_id)::int AS people, ROUND(SUM(pc.total_cost), 2) AS total
      FROM ${PC_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND pc.status = 'final' GROUP BY pc.allocation_source ORDER BY total DESC, label`,
};
const F07_BY_RUN: ReportSectionSpec = {
  key: "centre-by-run",
  title: "Cost by run",
  description: "Costed total for each run, to compare with the run's own employer cost.",
  columns: [col("period", "Pay period"), col("runType", "Run type"), n("costed", "Costed total"), n("runCost", "Run employer cost"), n("people", "People costed")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", ROUND(SUM(pc.total_cost), 2) AS costed, ROUND(MAX(pr.total_employer_cost), 2) AS "runCost", COUNT(DISTINCT pc.employee_id)::int AS people
      FROM payroll_costing_results pc JOIN payroll_runs pr ON pr.id = pc.payroll_run_id WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND pc.status = 'final' GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};

// ---------------------------------------------------------------- F08 / K07 overtime pay

const OT = "cr.source_type = 'overtime' AND cr.category = 'earning'";
const OT_FROM = "payroll_component_results cr JOIN payroll_runs pr ON pr.id = cr.payroll_run_id";
const OT_BY_MONTH: ReportSectionSpec = {
  key: "overtime-by-month",
  title: "Overtime pay by month",
  description: "People paid, hours recorded, overtime pay and its share of all gross pay that month.",
  columns: [col("month", "Month"), n("people", "People paid overtime"), n("hours", "Hours"), n("amount", "Overtime pay"), col("share", "Share of gross pay (%)", "percent")],
  sql: (q) => `
    SELECT o.month, o.people, o.hours, o.amount, ROUND(o.amount * 100.0 / NULLIF(g.gross, 0), 2) AS share
      FROM (SELECT ${MONTH} AS month, COUNT(DISTINCT cr.employee_id)::int AS people, ROUND(COALESCE(SUM(cr.quantity) FILTER (WHERE cr.unit IN ('hours', 'hour')), 0), 1) AS hours, ROUND(SUM(cr.amount), 2) AS amount
              FROM ${OT_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${OT} GROUP BY 1) o
      LEFT JOIN (SELECT ${MONTH} AS month, SUM(ps.gross_pay) AS gross FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY 1) g ON g.month = o.month ORDER BY o.month`,
};
const OT_BY_COMPONENT: ReportSectionSpec = {
  key: "overtime-by-component",
  title: "Overtime pay by component",
  description: "Overtime pay split by pay component, for example weekday and holiday rates.",
  columns: [col("component", "Component"), n("people", "People"), n("hours", "Hours"), n("amount", "Amount"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT cr.label AS component, COUNT(DISTINCT cr.employee_id)::int AS people, ROUND(COALESCE(SUM(cr.quantity) FILTER (WHERE cr.unit IN ('hours', 'hour')), 0), 1) AS hours, ROUND(SUM(cr.amount), 2) AS amount,
           ROUND(SUM(cr.amount) * 100.0 / NULLIF(SUM(SUM(cr.amount)) OVER (), 0), 1) AS share
      FROM ${OT_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${OT} GROUP BY cr.label ORDER BY amount DESC, component`,
};
const OT_BY_RUN: ReportSectionSpec = {
  key: "overtime-by-run",
  title: "Overtime pay by run",
  description: "Overtime paid in each run.",
  columns: [col("period", "Pay period"), col("runType", "Run type"), n("people", "People"), n("hours", "Hours"), n("amount", "Amount")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", COUNT(DISTINCT cr.employee_id)::int AS people, ROUND(COALESCE(SUM(cr.quantity) FILTER (WHERE cr.unit IN ('hours', 'hour')), 0), 1) AS hours, ROUND(SUM(cr.amount), 2) AS amount
      FROM ${OT_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${OT} GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const OT_BANDS: ReportSectionSpec = {
  key: "overtime-hours-bands",
  title: "Overtime hours per payslip",
  description: "How many overtime payments fall in each band of hours. Counts only.",
  columns: [col("label", "Hours on the payslip"), n("payslips", "Payslips")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS payslips
      FROM (SELECT CASE WHEN h <= 10 THEN '0 Up to 10 hours' WHEN h <= 20 THEN '1 10 to 20 hours' WHEN h <= 40 THEN '2 20 to 40 hours' ELSE '3 Over 40 hours' END AS band
              FROM (SELECT cr.payslip_id, COALESCE(SUM(cr.quantity) FILTER (WHERE cr.unit IN ('hours', 'hour')), 0) AS h
                      FROM ${OT_FROM} WHERE ${RUN(q)} AND ${FINAL} AND ${PERIOD(q)} AND ${OT} GROUP BY cr.payslip_id) x) b GROUP BY b.band ORDER BY b.band`,
};
const OT_UNIT: ReportSectionSpec = componentByUnit("overtime-by-unit-component", "Overtime pay by unit and component", "Overtime pay for each unit and component. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", OT);

// ---------------------------------------------------------------- F10 exceptions

const EX_FROM = "payroll_exceptions x JOIN payroll_runs pr ON pr.id = x.payroll_run_id";
const F10_BY_RUN: ReportSectionSpec = {
  key: "exceptions-by-run",
  title: "Exceptions by run",
  description: "For each run: exceptions raised, open, resolved and waived, and how many errors remain open.",
  columns: [col("period", "Pay period"), col("runStatus", "Run status"), n("total", "Raised"), n("open", "Open"), n("openErrors", "Open errors"), n("resolved", "Resolved"), n("waived", "Waived"), n("retries", "Retries")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.status")} AS "runStatus", COUNT(*)::int AS total, COUNT(*) FILTER (WHERE x.status = 'open')::int AS open, COUNT(*) FILTER (WHERE x.status = 'open' AND x.severity = 'error')::int AS "openErrors",
           COUNT(*) FILTER (WHERE x.status = 'resolved')::int AS resolved, COUNT(*) FILTER (WHERE x.status = 'waived')::int AS waived, COALESCE(SUM(x.retry_count), 0)::int AS retries
      FROM ${EX_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const F10_LIST: ReportSectionSpec = {
  key: "exceptions",
  title: "Exceptions",
  description: "Each exception with the run, type, severity, status, the system message and how it was resolved. No pay amounts.",
  columns: [col("period", "Pay period"), col("number", "Employee number"), col("class", "Type"), col("severity", "Severity"), col("status", "Status"), col("message", "Message"), n("retries", "Retries"), col("raised", "Raised on", "date"), col("resolved", "Resolved on", "date"), col("resolution", "Resolution")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, COALESCE(e.employee_number, '') AS number, ${LABEL("x.exception_class")} AS class, ${LABEL("x.severity")} AS severity, ${LABEL("x.status")} AS status, LEFT(x.message, 300) AS message, x.retry_count AS retries,
           x.created_at::date::text AS raised, x.resolved_at::date::text AS resolved, COALESCE(${LABEL("x.resolution")}, '') AS resolution
      FROM ${EX_FROM} LEFT JOIN employees e ON e.id = x.employee_id WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)}
     ORDER BY CASE x.status WHEN 'open' THEN 0 ELSE 1 END, pr.period_end DESC, x.created_at DESC`,
};
const F10_AGE: ReportSectionSpec = {
  key: "open-age",
  title: "How long open exceptions have waited",
  description: "Open exceptions grouped by days since they were raised.",
  columns: [col("label", "Open for"), col("severity", "Severity"), n("exceptions", "Exceptions")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, b.severity, COUNT(*)::int AS exceptions
      FROM (SELECT CASE WHEN ${q.today} - x.created_at::date <= 2 THEN '0 0 to 2 days' WHEN ${q.today} - x.created_at::date <= 7 THEN '1 3 to 7 days' WHEN ${q.today} - x.created_at::date <= 30 THEN '2 8 to 30 days' ELSE '3 Over 30 days' END AS band,
                   ${LABEL("x.severity")} AS severity
              FROM ${EX_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} AND x.status = 'open') b GROUP BY b.band, b.severity ORDER BY b.band, b.severity`,
};
const F10_BATCHES: ReportSectionSpec = {
  key: "calculation-batches",
  title: "Calculation batches",
  description: "How each run's calculation batches ended: completed, failed or still pending, with attempts and the last error.",
  columns: [col("period", "Pay period"), n("batches", "Batches"), n("completed", "Completed"), n("failed", "Failed"), n("pending", "Pending"), n("attempts", "Attempts"), col("lastError", "Last error")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, COUNT(*)::int AS batches, COUNT(*) FILTER (WHERE p.state = 'completed')::int AS completed, COUNT(*) FILTER (WHERE p.state = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE p.state NOT IN ('completed', 'failed'))::int AS pending, COALESCE(SUM(p.attempts), 0)::int AS attempts, COALESCE(LEFT(MAX(p.last_error) FILTER (WHERE p.state = 'failed'), 300), '') AS "lastError"
      FROM payroll_run_partitions p JOIN payroll_runs pr ON pr.id = p.payroll_run_id WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY pr.id ORDER BY pr.period_end DESC, pr.created_at DESC`,
};

// ---------------------------------------------------------------- K05 / K12 per person and headcount

const K05_BANDS: ReportSectionSpec = {
  key: "cost-per-person-bands",
  title: "Employer cost per person bands",
  description: "How many people fall in each band of average monthly employer cost. Counts only.",
  columns: [col("label", "Average monthly employer cost"), n("people", "People"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS people, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN c < 75000 THEN '0 Under 75,000' WHEN c < 150000 THEN '1 75,000 to 149,999' WHEN c < 300000 THEN '2 150,000 to 299,999' WHEN c < 600000 THEN '3 300,000 to 599,999' ELSE '4 600,000 and over' END AS band
              FROM (SELECT ps.employee_id, AVG(ps.employer_cost) AS c
                      FROM ${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id
                     WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular' AND ${SLIP_OK} AND ${PERIOD(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")} GROUP BY ps.employee_id) x) b
     GROUP BY b.band ORDER BY b.band`,
};
const K05_BY_MONTH: ReportSectionSpec = {
  key: "cost-per-person-by-month",
  title: "Cost per person by month",
  description: "Average and median employer cost per payslip each month, regular runs only.",
  columns: [col("month", "Month"), n("people", "People paid"), n("avg", "Average employer cost"), n("median", "Median employer cost")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(DISTINCT ps.employee_id)::int AS people, ROUND(AVG(ps.employer_cost), 2) AS avg, ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ps.employer_cost))::numeric, 2) AS median
      FROM ${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id
     WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular' AND ${SLIP_OK} AND ${PERIOD(q)} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")} GROUP BY 1 ORDER BY 1`,
};

const K12_MOVEMENT: ReportSectionSpec = {
  key: "joiners-leavers",
  title: "Joiners and leavers by month",
  description: "People who joined and left each month in your payroll areas, with the headcount at month end.",
  columns: [col("month", "Month"), n("joined", "Joined"), n("left", "Left"), n("headcount", "Headcount at month end")],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month,
           (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.area("e")} AND date_trunc('month', e.date_of_joining) = mo.ms)::int AS joined,
           (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.area("e")} AND e.termination_date IS NOT NULL AND date_trunc('month', e.termination_date) = mo.ms)::int AS "left",
           (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.area("e")} AND e.date_of_joining <= mo.point AND NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL) AND (e.termination_date IS NULL OR e.termination_date > mo.point))::int AS headcount
      FROM mo ORDER BY mo.ms`,
};
const K12_UNPAID: ReportSectionSpec = {
  key: "headcount-not-paid",
  title: "Headcount not paid",
  description: "For each month: people on the headcount at month end who were not on a finalised regular payslip that month. Counts only.",
  columns: [col("month", "Month"), n("headcount", "Headcount at month end"), n("paid", "Paid"), n("notPaid", "Not paid")],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month,
           (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.area("e")} AND e.date_of_joining <= mo.point AND NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL) AND (e.termination_date IS NULL OR e.termination_date > mo.point))::int AS headcount,
           (SELECT COUNT(DISTINCT ps.employee_id) FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular' AND ${SLIP_OK} AND date_trunc('month', pr.period_end) = mo.ms)::int AS paid,
           GREATEST(0, (SELECT COUNT(*) FROM employees e WHERE ${q.co("e")} AND ${q.area("e")} AND e.date_of_joining <= mo.point AND NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL) AND (e.termination_date IS NULL OR e.termination_date > mo.point))
                 - (SELECT COUNT(DISTINCT ps.employee_id) FROM ${SLIP_FROM} WHERE ${RUN(q)} AND ${FINAL} AND pr.run_type = 'regular' AND ${SLIP_OK} AND date_trunc('month', pr.period_end) = mo.ms))::int AS "notPaid"
      FROM mo ORDER BY mo.ms`,
};
const K12_BY_AREA: ReportSectionSpec = {
  key: "cost-per-head-by-area",
  title: "Cost per head by payroll area",
  description: "Employer cost per person paid for each payroll area and month.",
  columns: [col("month", "Month"), col("area", "Payroll area"), n("paid", "People paid"), n("cost", "Employer cost"), n("perPaid", "Cost per person paid")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COALESCE(pa.name, 'Default') AS area, COUNT(DISTINCT ps.employee_id)::int AS paid, ROUND(SUM(ps.employer_cost), 2) AS cost, ROUND(SUM(ps.employer_cost) / NULLIF(COUNT(DISTINCT ps.employee_id), 0), 2) AS "perPaid"
      FROM ${SLIP_FROM} LEFT JOIN payroll_areas pa ON pa.id = pr.payroll_area_id WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY 1, pa.id, pa.name ORDER BY 1, area`,
};

// ---------------------------------------------------------------- K13 allocation (no date range)

const ALLOC_EMP = (q: Q) => `${q.co("e")} AND ${q.area("e")} AND ${q.current()} AND ${q.dim(DEPT, "e.org_unit_id")} AND ${q.dim(LOC, "e.location_id")}`;
const K13_COVERAGE: ReportSectionSpec = {
  key: "allocation-coverage",
  title: "Allocation coverage",
  description: "How many current employees have no allocation, one cost centre, or several, and how many add up to exactly 100%.",
  columns: [col("label", "Allocation"), n("employees", "Employees"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT substr(t.band, 3) AS label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN x.centres = 0 THEN '0 No cost centre' WHEN ABS(x.total - 100) > 0.01 THEN '1 Does not add up to 100%' WHEN x.centres = 1 THEN '2 One cost centre, 100%' ELSE '3 Split across several cost centres' END AS band
              FROM (SELECT e.id, COUNT(a.id) AS centres, COALESCE(SUM(a.allocation_percentage), 0) AS total
                      FROM employees e LEFT JOIN employee_cost_allocations a ON a.employee_id = e.id AND a.status = 'active' WHERE ${ALLOC_EMP(q)} GROUP BY e.id) x) t
     GROUP BY t.band ORDER BY t.band`,
};
const K13_BY_UNIT: ReportSectionSpec = {
  key: "issues-by-unit",
  title: "Allocation problems by organisation unit",
  description: "For each unit: current employees and how many have an allocation problem.",
  columns: [col("label", "Organisation unit"), n("employees", "Employees"), n("withIssue", "With an allocation problem"), col("share", "With a problem (%)", "percent")],
  sql: (q) => `
    SELECT x.label, COUNT(*)::int AS employees, COUNT(*) FILTER (WHERE x.bad)::int AS "withIssue", ROUND(COUNT(*) FILTER (WHERE x.bad) * 100.0 / COUNT(*), 1) AS share
      FROM (SELECT ${UNIT_LABEL} AS label, (COUNT(a.id) = 0 OR ABS(COALESCE(SUM(a.allocation_percentage), 0) - 100) > 0.01 OR COUNT(a.id) FILTER (WHERE a.is_primary) <> 1) AS bad
              FROM employees e ${UNIT_JOIN} LEFT JOIN employee_cost_allocations a ON a.employee_id = e.id AND a.status = 'active' WHERE ${ALLOC_EMP(q)} GROUP BY e.id, ou.name) x
     GROUP BY x.label ORDER BY "withIssue" DESC, label`,
};
const K13_CENTRES: ReportSectionSpec = {
  key: "centre-load",
  title: "Cost centres and the people allocated",
  description: "Each cost centre with the number of current employees allocated to it and the full-time equivalent of those allocations.",
  columns: [col("centre", "Cost centre"), col("status", "Status"), n("employees", "Employees allocated"), n("fte", "Full-time equivalent")],
  sql: (q) => `
    SELECT cc.code || ' - ' || cc.name AS centre, ${LABEL("cc.status")} AS status, COUNT(DISTINCT e.id)::int AS employees, ROUND(COALESCE(SUM(a.allocation_percentage), 0) / 100.0, 2) AS fte
      FROM cost_centers cc LEFT JOIN employee_cost_allocations a ON a.cost_center_id = cc.id AND a.status = 'active' AND a.company_id = cc.company_id
      LEFT JOIN employees e ON e.id = a.employee_id AND ${q.area("e")} AND ${q.current()}
     WHERE ${q.co("cc")} GROUP BY cc.id ORDER BY employees DESC, centre`,
};
const K13_INACTIVE: ReportSectionSpec = {
  key: "inactive-centres",
  title: "Allocations to inactive cost centres",
  description: "Current employees whose active allocation points at a cost centre that is no longer active.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("centre", "Cost centre"), col("status", "Cost centre status"), n("percentage", "Allocation (%)")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, cc.code || ' - ' || cc.name AS centre, ${LABEL("cc.status")} AS status, a.allocation_percentage AS percentage
      FROM employees e JOIN employee_cost_allocations a ON a.employee_id = e.id AND a.status = 'active' JOIN cost_centers cc ON cc.id = a.cost_center_id
     WHERE ${ALLOC_EMP(q)} AND cc.status <> 'active' ORDER BY centre, number`,
};

// ---------------------------------------------------------------- K14 journals

const J_FROM = "payroll_journals j JOIN payroll_runs pr ON pr.id = j.payroll_run_id";
const K14_BY_STATUS: ReportSectionSpec = {
  key: "journals-by-status",
  title: "Journals by status and kind",
  description: "How many journals are draft, posted or reversed, and their debit and credit totals.",
  columns: [col("kind", "Kind"), col("status", "Status"), n("journals", "Journals"), n("debit", "Debit"), n("credit", "Credit"), n("difference", "Difference")],
  sql: (q) => `
    SELECT ${LABEL("j.journal_kind")} AS kind, ${LABEL("j.status")} AS status, COUNT(*)::int AS journals, ROUND(SUM(j.total_debit), 2) AS debit, ROUND(SUM(j.total_credit), 2) AS credit, ROUND(SUM(j.total_debit - j.total_credit), 2) AS difference
      FROM ${J_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} GROUP BY j.journal_kind, j.status ORDER BY kind, status`,
};
const K14_LINES: ReportSectionSpec = {
  key: "journal-lines-by-account",
  title: "Journal lines by account",
  description: "Debits and credits by account code and line type across the journals in the period.",
  columns: [col("account", "Account"), col("lineKind", "Line type"), n("lines", "Lines"), n("debit", "Debit"), n("credit", "Credit")],
  sql: (q) => `
    SELECT jl.account_code AS account, ${LABEL("jl.line_kind")} AS "lineKind", COUNT(*)::int AS lines, ROUND(SUM(jl.debit), 2) AS debit, ROUND(SUM(jl.credit), 2) AS credit
      FROM payroll_journal_lines jl JOIN payroll_journals j ON j.id = jl.journal_id JOIN payroll_runs pr ON pr.id = j.payroll_run_id
     WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} AND j.status IN ('draft', 'posted') GROUP BY jl.account_code, jl.line_kind ORDER BY account, "lineKind"`,
};
const K14_BY_CENTRE: ReportSectionSpec = {
  key: "journal-lines-by-centre",
  title: "Journal lines by cost centre",
  description: "Debits and credits booked to each cost centre.",
  columns: [col("centre", "Cost centre"), n("lines", "Lines"), n("debit", "Debit"), n("credit", "Credit")],
  sql: (q) => `
    SELECT COALESCE(cc.code || ' - ' || cc.name, 'No cost centre') AS centre, COUNT(*)::int AS lines, ROUND(SUM(jl.debit), 2) AS debit, ROUND(SUM(jl.credit), 2) AS credit
      FROM payroll_journal_lines jl JOIN payroll_journals j ON j.id = jl.journal_id JOIN payroll_runs pr ON pr.id = j.payroll_run_id LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id
     WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} AND j.status IN ('draft', 'posted') GROUP BY cc.id, cc.code, cc.name ORDER BY debit DESC, centre`,
};
const K14_TIMELINE: ReportSectionSpec = {
  key: "journal-timeline",
  title: "Journal timeline",
  description: "When each journal was generated and posted, and how many days posting took.",
  columns: [col("period", "Pay period"), col("number", "Journal"), col("status", "Status"), col("generated", "Generated", "date"), col("posted", "Posted", "date"), n("days", "Days to post"), col("reference", "Posting reference")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, COALESCE(j.journal_number, 'Not numbered') AS number, ${LABEL("j.status")} AS status, j.generated_at::date::text AS generated, j.posted_at::date::text AS posted,
           CASE WHEN j.posted_at IS NOT NULL THEN (j.posted_at::date - j.generated_at::date)::int END AS days, COALESCE(j.posting_reference, '') AS reference
      FROM ${J_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${runStatusFilter(q)} ORDER BY pr.period_end DESC, j.generated_at DESC`,
};

// ---------------------------------------------------------------- K15 finance exceptions

const K15_BY_ISSUE: ReportSectionSpec = {
  key: "issues-by-type",
  title: "Finance issues by type",
  description: "How many open reconciliation variances, pending checks, unbalanced journals and runs without a journal there are.",
  columns: [col("label", "Issue"), n("count", "Count"), n("amount", "Amount")],
  sql: (q) => `
    SELECT t.label, COUNT(*)::int AS count, ROUND(COALESCE(SUM(t.amount), 0), 2) AS amount FROM (
      SELECT 'Reconciliation variance' AS label, rc.variance AS amount FROM ${RC_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND rc.status = 'variance'
      UNION ALL SELECT 'Reconciliation pending', rc.variance FROM ${RC_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND rc.status = 'pending'
      UNION ALL SELECT 'Journal out of balance', j.total_debit - j.total_credit FROM ${J_FROM} WHERE ${RUN(q)} AND ${PERIOD(q)} AND j.status IN ('draft', 'posted') AND j.total_debit <> j.total_credit
      UNION ALL SELECT 'Finalised run with no journal', pr.total_employer_cost FROM payroll_runs pr
        WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${FINAL} AND pr.period_end < ${q.today} - 14 AND NOT EXISTS (SELECT 1 FROM payroll_journals j WHERE j.payroll_run_id = pr.id AND j.status IN ('draft', 'posted'))
    ) t GROUP BY t.label ORDER BY count DESC, t.label`,
};
const K15_RUN_STATUS: ReportSectionSpec = {
  key: "run-finance-status",
  title: "Finance status of each run",
  description: "For each run: its status, whether a journal exists and is posted, and how many reconciliation checks are open.",
  columns: [col("period", "Pay period"), col("runStatus", "Run status"), n("journals", "Journals"), n("posted", "Posted journals"), n("openChecks", "Open reconciliation checks"), n("cost", "Employer cost")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.status")} AS "runStatus", (SELECT COUNT(*) FROM payroll_journals j WHERE j.payroll_run_id = pr.id AND j.status IN ('draft', 'posted'))::int AS journals,
           (SELECT COUNT(*) FROM payroll_journals j WHERE j.payroll_run_id = pr.id AND j.status = 'posted')::int AS posted,
           (SELECT COUNT(*) FROM payroll_reconciliations rc WHERE rc.payroll_run_id = pr.id AND rc.status IN ('variance', 'pending'))::int AS "openChecks", pr.total_employer_cost AS cost
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${FINAL} ORDER BY pr.period_end DESC, pr.created_at DESC`,
};
const K15_AGE: ReportSectionSpec = {
  key: "run-age",
  title: "Finalised runs and days since pay period end",
  description: "How long finalised runs have gone without a posted journal, oldest first.",
  columns: [col("period", "Pay period"), col("runStatus", "Run status"), n("daysSince", "Days since the period ended"), n("posted", "Posted journals")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.status")} AS "runStatus", (${q.today} - pr.period_end)::int AS "daysSince", (SELECT COUNT(*) FROM payroll_journals j WHERE j.payroll_run_id = pr.id AND j.status = 'posted')::int AS posted
      FROM payroll_runs pr WHERE ${RUN(q)} AND ${PERIOD(q)} AND ${FINAL} AND NOT EXISTS (SELECT 1 FROM payroll_journals j WHERE j.payroll_run_id = pr.id AND j.status = 'posted') ORDER BY pr.period_end`,
};

// ---------------------------------------------------------------- I05 payslip access

const I05_LOG = `payslip_access_log l JOIN payslips ps ON ps.id = l.payslip_id JOIN payroll_runs pr ON pr.id = ps.payroll_run_id`;
const I05_BY_AREA: ReportSectionSpec = {
  key: "opened-by-area",
  title: "Payslips opened by payroll area",
  description: "For each payroll area: finalised payslips and how many were opened by the employee. Counts only.",
  columns: [col("label", "Payroll area"), n("payslips", "Finalised payslips"), n("opened", "Opened by the employee"), col("openRate", "Opened (%)", "percent"), n("opens", "Times opened")],
  sql: (q) => `
    SELECT COALESCE(pa.name, 'Default') AS label, COUNT(*)::int AS payslips, COUNT(*) FILTER (WHERE o.opens > 0)::int AS opened, ROUND(COUNT(*) FILTER (WHERE o.opens > 0) * 100.0 / NULLIF(COUNT(*), 0), 1) AS "openRate",
           COALESCE(SUM(o.opens), 0)::int AS opens
      FROM ${SLIP_FROM} LEFT JOIN payroll_areas pa ON pa.id = pr.payroll_area_id
      LEFT JOIN LATERAL (SELECT COUNT(*) AS opens FROM payslip_access_log l WHERE l.payslip_id = ps.id AND l.company_id = ps.company_id) o ON TRUE
     WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY pa.id, pa.name ORDER BY payslips DESC, label`,
};
const I05_NEVER: ReportSectionSpec = {
  key: "never-opened-by-unit",
  title: "Payslips never opened, by organisation unit",
  description: "Where employees have not looked at their payslip. Counts only; no names and no amounts.",
  columns: [col("label", "Organisation unit"), n("payslips", "Finalised payslips"), n("neverOpened", "Never opened"), col("share", "Never opened (%)", "percent")],
  sql: (q) => `
    SELECT CASE WHEN g.payslips < ${q.minGroup} AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.payslips)::int AS payslips, SUM(g.never)::int AS "neverOpened", ROUND(SUM(g.never) * 100.0 / NULLIF(SUM(g.payslips), 0), 1) AS share
      FROM (SELECT ${UNIT_LABEL} AS label, COUNT(*) AS payslips,
                   COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM payslip_access_log l WHERE l.payslip_id = ps.id AND l.company_id = ps.company_id)) AS never
              FROM ${SLIP_FROM} JOIN employees e ON e.id = ps.employee_id ${UNIT_JOIN} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} GROUP BY ou.id, ou.name) g
     GROUP BY 1 ORDER BY "neverOpened" DESC, label`,
};
const I05_WEEKDAY: ReportSectionSpec = {
  key: "opens-by-weekday",
  title: "When payslips are opened",
  description: "Opens by day of the week, in company time.",
  columns: [col("label", "Day"), n("opens", "Times opened")],
  sql: (q) => `
    SELECT trim(to_char(l.created_at AT TIME ZONE 'Asia/Karachi', 'Day')) AS label, COUNT(*)::int AS opens
      FROM ${I05_LOG} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} AND l.company_id = ps.company_id
     GROUP BY 1, EXTRACT(isodow FROM l.created_at AT TIME ZONE 'Asia/Karachi') ORDER BY EXTRACT(isodow FROM l.created_at AT TIME ZONE 'Asia/Karachi')`,
};
const I05_KIND: ReportSectionSpec = {
  key: "opens-by-kind",
  title: "What was opened",
  description: "Opens by kind: the payslip itself or its published document.",
  columns: [col("label", "Kind"), n("opens", "Times opened"), n("payslips", "Payslips opened")],
  sql: (q) => `
    SELECT ${LABEL("l.kind")} AS label, COUNT(*)::int AS opens, COUNT(DISTINCT l.payslip_id)::int AS payslips
      FROM ${I05_LOG} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} AND l.company_id = ps.company_id GROUP BY l.kind ORDER BY opens DESC, label`,
};
const I05_SPEED: ReportSectionSpec = {
  key: "time-to-first-open",
  title: "How soon payslips are first opened",
  description: "Days from the run being finalised to the employee first opening the payslip. Counts only.",
  columns: [col("label", "First opened"), n("payslips", "Payslips")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS payslips
      FROM (SELECT CASE WHEN d <= 0 THEN '0 Same day' WHEN d <= 2 THEN '1 Within 2 days' WHEN d <= 7 THEN '2 Within a week' ELSE '3 Over a week' END AS band
              FROM (SELECT (MIN(l.created_at AT TIME ZONE 'Asia/Karachi')::date - COALESCE(pr.finalized_at AT TIME ZONE 'Asia/Karachi', ps.created_at AT TIME ZONE 'Asia/Karachi')::date) AS d
                      FROM ${I05_LOG} WHERE ${RUN(q)} AND ${FINAL} AND ${SLIP_OK} AND ${PERIOD(q)} AND l.company_id = ps.company_id GROUP BY ps.id, pr.finalized_at, ps.created_at) x) b
     GROUP BY b.band ORDER BY b.band`,
};

// ---------------------------------------------------------------- map

const BASE_MONEY = [RUN_LIST, MONTHLY, RUNS_BY_AREA];

export const PAYROLL_DEPTH: Record<string, ReportSectionSpec[]> = {
  F01: [F01_BY_STATUS, F01_BY_AREA, F01_BY_MONTH, F01_TIMELINE, F01_PROBLEMS],
  F02: [REG_BY_RUN, REG_BY_UNIT, REG_COMPONENTS, REG_ATTENDANCE_EFFECT, REG_CHANGE, REG_LOW_NET, REG_BANK_READY, NET_BANDS],
  F03: [RUN_LIST, F03_MOVEMENT, F03_COMPONENT_MOVE, CATEGORY_MONTHLY, RUNS_BY_TYPE, RUNS_BY_AREA],
  F04: [CATEGORY_MONTHLY, componentMonthly("component-by-month", "Components by month", "Each earning, deduction, tax and contribution component for each month.", "TRUE"), componentByRun("component-by-run", "Components by run", "Each component's total in each run.", "TRUE"), componentByUnit("component-by-unit", "Components by organisation unit", "Each component's total for each unit. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "TRUE"), STATUTORY_MONTHLY],
  F05: [F05_BY_MONTH, F05_GROSS_TO_NET, NET_BANDS, F05_BY_UNIT, PAYSLIP_FLAGS, RUN_LIST],
  F06: [F06_BY_KIND, F06_BY_RUN, F06_OPEN_AGE, F06_RESOLVED],
  F07: [F07_BY_MONTH, F07_BY_RUN, F07_STATUS, F07_SOURCE, BY_COST_CENTRE],
  F08: [OT_BY_MONTH, OT_BY_COMPONENT, OT_BY_RUN, OT_BANDS, OT_UNIT],
  F10: [F10_BY_RUN, F10_LIST, F10_AGE, F10_BATCHES],
  K01: [...BASE_MONEY, CATEGORY_MONTHLY, STATUTORY_MONTHLY, RUNS_BY_TYPE],
  K02: [BY_UNIT_MONTH, BY_UNIT_REGULAR, BY_UNIT, BY_GRADE_BAND, componentByUnit("category-by-unit", "Pay components by organisation unit", "Each component's total for each unit. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "TRUE")],
  K03: [BY_COST_CENTRE, F07_BY_MONTH, F07_SOURCE, F07_STATUS],
  K04: [BY_LOCATION_MONTH, BY_LOCATION, BY_UNIT, BY_GRADE_BAND],
  K05: [K05_BY_MONTH, K05_BANDS, BY_UNIT_REGULAR, BY_GRADE_BAND, BY_LOCATION],
  K07: [OT_BY_MONTH, OT_BY_COMPONENT, OT_BY_RUN, OT_BANDS, OT_UNIT],
  K08: [componentMonthly("contributions-by-month", "Employer contributions by month", "Each employer contribution component for each month.", "cr.category = 'employer_contribution'"), componentByRun("contributions-by-run", "Employer contributions by run", "Employer contributions in each run.", "cr.category = 'employer_contribution'"),
        componentByUnit("contributions-by-unit", "Employer contributions by organisation unit", "Employer contributions for each unit. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "cr.category = 'employer_contribution'"), STATUTORY_MONTHLY, MONTHLY],
  K09: [componentMonthly("allowances-by-month", "Allowances and other earnings by month", "Each allowance and other earning for each month.", "cr.category IN ('earning', 'adjustment') AND cr.component_key <> 'basic_salary'"),
        componentByRun("allowances-by-run", "Allowances by run", "Each allowance's total in each run.", "cr.category IN ('earning', 'adjustment') AND cr.component_key <> 'basic_salary'"),
        componentByUnit("allowances-by-unit", "Allowances by organisation unit", "Each allowance's total for each unit. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", "cr.category IN ('earning', 'adjustment') AND cr.component_key <> 'basic_salary'"), CATEGORY_MONTHLY],
  K10: [componentMonthly("deductions-by-month", "Deductions by month", "Each deduction, tax and recovery for each month.", `cr.category IN ${DEDUCTIONS}`), componentByRun("deductions-by-run", "Deductions by run", "Each deduction's total in each run.", `cr.category IN ${DEDUCTIONS}`),
        componentByUnit("deductions-by-unit", "Deductions by organisation unit", "Each deduction's total for each unit. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.", `cr.category IN ${DEDUCTIONS}`), STATUTORY_MONTHLY, PAYSLIP_FLAGS],
  K11: [F03_COMPONENT_MOVE, CATEGORY_MONTHLY, RUNS_BY_TYPE, MONTHLY],
  K12: [K12_MOVEMENT, K12_UNPAID, K12_BY_AREA, MONTHLY],
  K13: [K13_COVERAGE, K13_BY_UNIT, K13_CENTRES, K13_INACTIVE],
  K14: [K14_BY_STATUS, K14_LINES, K14_BY_CENTRE, K14_TIMELINE],
  K15: [K15_BY_ISSUE, K15_RUN_STATUS, K15_AGE, F06_OPEN_AGE],
  I05: [I05_BY_AREA, I05_NEVER, I05_SPEED, I05_WEEKDAY, I05_KIND],
};
