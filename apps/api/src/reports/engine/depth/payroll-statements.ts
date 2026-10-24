import type { Q, ReportSectionSpec } from "../report-spec";
import { BATCH_WHERE, LOAN_JOIN, LOAN_KIND, LOAN_WHERE, MONTHLY, OTHER, PERIOD_TEXT, SALARY_NOW, SLIPS, SLIP_WHERE, UNIT, UNIT_JOIN } from "../executors/payroll-statements";
import { LABEL, NAME, col } from "./common";

/**
 * Extra tables for the pay statement reports F11 to F30 (salary information, income tax, EOBI, benefits, bank payments,
 * loans and final settlements).
 *
 * Rules: every table applies the same company, payroll-area and team limits as its report (q.emp(), q.area(), q.co());
 * money comes only from finalised payslips; a table that groups people merges any group of fewer than 3 into "Other" so
 * a total or an average cannot be read as one person's pay; a table lists people only inside the Restricted reports;
 * nothing here reads an encrypted value, an account number or a bank's free-text rejection reason.
 */

const n = (key: string, label: string) => col(key, label, "number");
const pct = (key: string, label: string) => col(key, label, "percent");
const MONTH = "to_char(date_trunc('month', pr.period_end), 'YYYY-MM')";
const LOC_JOIN = "LEFT JOIN locations l ON l.id = e.location_id";
const LOC_LABEL = "COALESCE(l.name, 'No location set')";
const TYPE_LABEL = "COALESCE(NULLIF(INITCAP(REPLACE(e.employment_type, '_', ' ')), ''), 'Not set')";
const GRADE_LABEL = "COALESCE(NULLIF(e.salary_band, ''), 'No salary band set')";
const TAX_NOW = (q: Q) =>
  `LEFT JOIN LATERAL (SELECT t.* FROM employee_tax_profiles t WHERE t.company_id = e.company_id AND t.employee_id = e.id AND t.effective_from <= ${q.today} AND (t.effective_to IS NULL OR t.effective_to >= ${q.today}) ORDER BY t.effective_from DESC LIMIT 1) tx ON TRUE`;
const FILER = "COALESCE(INITCAP(REPLACE(tx.filer_status, '_', ' ')), 'No tax profile')";
const SCHEME = "COALESCE(INITCAP(REPLACE(tx.provincial_scheme, '_', ' ')), 'No tax profile')";
const RESIDENCY = "COALESCE(INITCAP(REPLACE(tx.tax_residency, '_', ' ')), 'No tax profile')";
const RUN_TYPE = LABEL("pr.run_type");

// ---------------------------------------------------------------- building blocks

type Measure = [key: string, label: string, expr: string];

/** Finalised payslips grouped by a person attribute (and optionally by month), small groups merged. */
function slipGroup(
  key: string,
  title: string,
  description: string,
  dimLabel: string,
  labelExpr: string,
  join: string | ((q: Q) => string),
  measures: Measure[],
  o: { monthly?: boolean; ratio?: { key: string; label: string; top: number; bottom: number } } = {},
): ReportSectionSpec {
  const m = o.monthly === true;
  return {
    key,
    title,
    description,
    columns: [...(m ? [col("month", "Month")] : []), col("label", dimLabel), n("people", "People paid"), n("payslips", "Payslips"), ...measures.map(([k, l]) => n(k, l)), ...(o.ratio ? [pct(o.ratio.key, o.ratio.label)] : [])],
    sql: (q) => {
      const j = typeof join === "function" ? join(q) : join;
      const inner = measures.map(([, , e], i) => `SUM(${e}) AS m${i}`).join(", ");
      const outer = measures.map(([k], i) => `ROUND(SUM(g.m${i}), 2) AS "${k}"`).join(", ");
      const ratio = o.ratio ? `, CASE WHEN SUM(g.m${o.ratio.bottom}) > 0 THEN ROUND(SUM(g.m${o.ratio.top}) * 100.0 / SUM(g.m${o.ratio.bottom}), 1) END AS "${o.ratio.key}"` : "";
      return `
        SELECT ${m ? "g.month, " : ""}CASE WHEN g.people < 3 AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips, ${outer}${ratio}
          FROM (SELECT ${m ? `${MONTH} AS month, ` : ""}${labelExpr} AS label, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, ${inner}
                  FROM ${SLIPS} ${j} WHERE ${SLIP_WHERE(q)} GROUP BY ${m ? "1, 2" : "1"}) g
         GROUP BY ${m ? "1, 2" : "1"} ORDER BY ${m ? "1, " : ""}SUM(g.m0) DESC NULLS LAST, ${m ? 2 : 1}`;
    },
  };
}

const TAX_MEASURES: Measure[] = [
  ["taxable", "Taxable pay", "ps.taxable_gross_this_period"],
  ["tax", "Tax withheld", "ps.income_tax_monthly"],
];
const TAX_RATIO = { key: "rate", label: "Tax on taxable pay (%)", top: 1, bottom: 0 };
const EOBI_MEASURES: Measure[] = [
  ["eobiEmployee", "EOBI (employee)", "ps.eobi_employee_contribution"],
  ["eobiEmployer", "EOBI (employer)", "ps.eobi_employer_contribution"],
  ["social", "Social security (employer)", "ps.social_security_employer_contribution"],
  ["total", "Total", "ps.eobi_employee_contribution + ps.eobi_employer_contribution + ps.social_security_employer_contribution"],
];

/** Pay statistics of current employees in a group, groups under 3 people merged. */
function salaryGroup(key: string, title: string, description: string, dimLabel: string, labelExpr: string, join: string): ReportSectionSpec {
  return {
    key,
    title,
    description,
    columns: [col("label", dimLabel), n("people", "People with a salary"), n("lowest", "Lowest"), n("median", "Median"), n("average", "Average"), n("highest", "Highest"), n("total", "Total monthly salary")],
    sql: (q) => `
      SELECT x.label, COUNT(*)::int AS people, MIN(x.salary) AS lowest, ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x.salary))::numeric, 0) AS median, ROUND(AVG(x.salary), 0) AS average, MAX(x.salary) AS highest, SUM(x.salary) AS total
        FROM (SELECT CASE WHEN COUNT(*) OVER (PARTITION BY s.label) < 3 AND s.label NOT LIKE 'No %' THEN '${OTHER}' ELSE s.label END AS label, s.salary
                FROM (SELECT ${labelExpr} AS label, ${SALARY_NOW(q)} AS salary FROM employees e ${join} WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}) s
               WHERE s.salary IS NOT NULL) x
       GROUP BY x.label ORDER BY total DESC, label`,
  };
}

const SALARY_BANDS: ReportSectionSpec = {
  key: "salary-bands",
  title: "Salary bands",
  description: "How many current employees earn within each monthly salary range.",
  columns: [col("label", "Monthly salary"), n("employees", "Employees"), pct("share", "Share (%)")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN s IS NULL THEN 'No salary on file' WHEN s < 50000 THEN 'Under 50,000' WHEN s < 100000 THEN '50,000 to 99,999' WHEN s < 200000 THEN '100,000 to 199,999' WHEN s < 400000 THEN '200,000 to 399,999' ELSE '400,000 and over' END AS label,
                   CASE WHEN s IS NULL THEN 6 WHEN s < 50000 THEN 1 WHEN s < 100000 THEN 2 WHEN s < 200000 THEN 3 WHEN s < 400000 THEN 4 ELSE 5 END AS ord
              FROM (SELECT ${SALARY_NOW(q)} AS s FROM employees e WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}) t) b
     GROUP BY b.label, b.ord ORDER BY b.ord`,
};

/** Salary revisions (a record that replaces an earlier one) in the report's range. */
const REVISIONS = (q: Q) => `
  SELECT c.effective_from, c.employee_id, ${UNIT} AS unit, c.monthly_salary - prev.monthly_salary AS change,
         CASE WHEN prev.monthly_salary > 0 THEN (c.monthly_salary - prev.monthly_salary) * 100.0 / prev.monthly_salary END AS pct
    FROM employee_compensation c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id ${UNIT_JOIN}
    JOIN LATERAL (SELECT p.monthly_salary FROM employee_compensation p WHERE p.company_id = c.company_id AND p.employee_id = c.employee_id AND p.effective_from < c.effective_from ORDER BY p.effective_from DESC LIMIT 1) prev ON TRUE
   WHERE ${q.co("c")} AND ${q.emp()} AND ${q.area("e")} AND c.effective_from BETWEEN ${q.from} AND ${q.to}`;

const REVISIONS_BY_UNIT: ReportSectionSpec = {
  key: "revisions-by-unit",
  title: "Revisions by organisation unit",
  description: "Salary revisions in the period for each unit: how many, how many people, the average change and what they add to the monthly salary bill. Units with fewer than 3 people revised are combined.",
  columns: [col("label", "Organisation unit"), n("revisions", "Revisions"), n("people", "People revised"), pct("averagePct", "Average change (%)"), n("added", "Added to monthly salary bill")],
  sql: (q) => `
    WITH r AS (${REVISIONS(q)})
    SELECT CASE WHEN g.people < 3 AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.revisions)::int AS revisions, SUM(g.people)::int AS people,
           ROUND(SUM(g.pct_sum) / NULLIF(SUM(g.pct_n), 0), 1) AS "averagePct", SUM(g.added) AS added
      FROM (SELECT r.unit AS label, COUNT(*) AS revisions, COUNT(DISTINCT r.employee_id) AS people, SUM(r.pct) AS pct_sum, COUNT(r.pct) AS pct_n, SUM(r.change) AS added FROM r GROUP BY r.unit) g
     GROUP BY 1 ORDER BY SUM(g.revisions) DESC, 1`,
};

const REVISION_SIZE: ReportSectionSpec = {
  key: "revision-size",
  title: "Size of revisions",
  description: "Revisions in the period grouped by the size of the change.",
  columns: [col("label", "Change in salary"), n("revisions", "Revisions"), pct("share", "Share (%)")],
  sql: (q) => `
    WITH r AS (${REVISIONS(q)})
    SELECT b.label, COUNT(*)::int AS revisions, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN r.pct IS NULL THEN 'Not comparable' WHEN r.change < 0 THEN 'Decrease' WHEN r.change = 0 THEN 'No change' WHEN r.pct < 5 THEN 'Under 5%' WHEN r.pct < 10 THEN '5% to under 10%' WHEN r.pct < 20 THEN '10% to under 20%' ELSE '20% or more' END AS label,
                   CASE WHEN r.pct IS NULL THEN 7 WHEN r.change < 0 THEN 1 WHEN r.change = 0 THEN 2 WHEN r.pct < 5 THEN 3 WHEN r.pct < 10 THEN 4 WHEN r.pct < 20 THEN 5 ELSE 6 END AS ord FROM r) b
     GROUP BY b.label, b.ord ORDER BY b.ord`,
};

const REVISIONS_BY_MONTH: ReportSectionSpec = {
  key: "revisions-by-month",
  title: "Revisions by month",
  description: "Month by month: revisions, people revised, increases, decreases and the average change.",
  columns: [col("month", "Month"), n("revisions", "Revisions"), n("people", "People revised"), n("increased", "Increases"), n("decreased", "Decreases"), pct("averagePct", "Average change (%)")],
  sql: (q) => `
    WITH mo AS (${q.months()}), r AS (${REVISIONS(q)})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(r.employee_id)::int AS revisions, COUNT(DISTINCT r.employee_id)::int AS people, COUNT(*) FILTER (WHERE r.change > 0)::int AS increased,
           COUNT(*) FILTER (WHERE r.change < 0)::int AS decreased, ROUND(AVG(r.pct), 1) AS "averagePct"
      FROM mo LEFT JOIN r ON r.effective_from >= mo.ms AND r.effective_from < mo.ms + interval '1 month' GROUP BY mo.ms ORDER BY mo.ms`,
};

/** Current employees whose salary has not changed for a year or more (a list of people, without any pay amount). */
const NOT_REVISED: ReportSectionSpec = {
  key: "not-revised",
  title: "Salary not revised for 12 months or more",
  description: "Current employees whose salary record has been in force for at least a year. No pay amounts are shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("joined", "Joined", "date"), col("since", "Salary in force since", "date"), n("months", "Months since last change")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, e.date_of_joining::text AS joined, c.effective_from::text AS since, ROUND((${q.today} - c.effective_from) / 30.4, 0)::int AS months
      FROM employees e ${UNIT_JOIN}
      JOIN LATERAL (SELECT x.effective_from FROM employee_compensation x WHERE x.company_id = e.company_id AND x.employee_id = e.id AND x.effective_from <= ${q.today} AND (x.effective_to IS NULL OR x.effective_to >= ${q.today}) ORDER BY x.effective_from DESC LIMIT 1) c ON TRUE
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND c.effective_from <= ${q.today} - interval '12 months'
     ORDER BY since, name`,
};

const NO_SALARY: ReportSectionSpec = {
  key: "no-salary",
  title: "Current employees with no salary on file",
  description: "People who would not be paid correctly until a salary record is entered. No pay amounts are shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("type", "Employment type"), col("joined", "Joined", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, ${TYPE_LABEL} AS type, e.date_of_joining::text AS joined
      FROM employees e ${UNIT_JOIN}
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND ${SALARY_NOW(q)} IS NULL
     ORDER BY joined DESC NULLS LAST, name`,
};

// ---------------------------------------------------------------- component helpers

const COMPONENT_FROM = (q: Q) => `
  employee_compensation_components x JOIN compensation_components cc ON cc.id = x.component_id JOIN employees e ON e.id = x.employee_id AND e.company_id = x.company_id ${UNIT_JOIN}
  WHERE ${q.co("x")} AND ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND x.effective_from <= ${q.today} AND (x.effective_to IS NULL OR x.effective_to >= ${q.today})`;

const COMPONENT_BY_NAME: ReportSectionSpec = {
  key: "by-component",
  title: "By component",
  description: "Each salary component in force today: how many people have it and the total and average monthly amount.",
  columns: [col("label", "Component"), col("kind", "Kind"), n("people", "People"), n("total", "Total monthly amount"), n("average", "Average per person")],
  sql: (q) => `
    SELECT cc.name AS label, ${LABEL("cc.component_type")} AS kind, COUNT(DISTINCT x.employee_id)::int AS people, ROUND(SUM(${MONTHLY}), 2) AS total, ROUND(SUM(${MONTHLY}) / COUNT(DISTINCT x.employee_id), 2) AS average
      FROM ${COMPONENT_FROM(q)} GROUP BY cc.id, cc.name, cc.component_type ORDER BY total DESC, label`,
};

const COMPONENT_BY_KIND: ReportSectionSpec = {
  key: "by-kind",
  title: "By kind of component",
  description: "Earnings, deductions and employer items in force today.",
  columns: [col("label", "Kind"), n("lines", "Component lines"), n("people", "People"), n("total", "Total monthly amount")],
  sql: (q) => `
    SELECT ${LABEL("cc.component_type")} AS label, COUNT(*)::int AS lines, COUNT(DISTINCT x.employee_id)::int AS people, ROUND(SUM(${MONTHLY}), 2) AS total
      FROM ${COMPONENT_FROM(q)} GROUP BY cc.component_type ORDER BY total DESC, label`,
};

const COMPONENT_TAXABLE: ReportSectionSpec = {
  key: "taxable-split",
  title: "Taxable and non-taxable components",
  description: "How much of the components in force today is taxable.",
  columns: [col("label", "Taxable"), n("lines", "Component lines"), n("people", "People"), n("total", "Total monthly amount")],
  sql: (q) => `
    SELECT CASE WHEN cc.is_taxable THEN 'Taxable' ELSE 'Not taxable' END AS label, COUNT(*)::int AS lines, COUNT(DISTINCT x.employee_id)::int AS people, ROUND(SUM(${MONTHLY}), 2) AS total
      FROM ${COMPONENT_FROM(q)} GROUP BY cc.is_taxable ORDER BY label DESC`,
};

const COMPONENT_BY_UNIT: ReportSectionSpec = {
  key: "by-unit",
  title: "By organisation unit",
  description: "Earning and deduction components in force today for each unit. Units with fewer than 3 people are combined.",
  columns: [col("label", "Organisation unit"), n("people", "People"), n("earnings", "Monthly earnings from components"), n("deductions", "Monthly deductions from components")],
  sql: (q) => `
    SELECT CASE WHEN g.people < 3 AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, ROUND(SUM(g.earnings), 2) AS earnings, ROUND(SUM(g.deductions), 2) AS deductions
      FROM (SELECT ${UNIT} AS label, COUNT(DISTINCT x.employee_id) AS people,
                   COALESCE(SUM(${MONTHLY}) FILTER (WHERE cc.component_type IN ('earning', 'shift_premium')), 0) AS earnings, COALESCE(SUM(${MONTHLY}) FILTER (WHERE cc.component_type = 'deduction'), 0) AS deductions
              FROM ${COMPONENT_FROM(q)} GROUP BY ou.name) g
     GROUP BY 1 ORDER BY SUM(g.earnings) DESC, 1`,
};

// ---------------------------------------------------------------- tax

const TAX_RATE_BANDS: ReportSectionSpec = {
  key: "rate-bands",
  title: "Effective tax rate",
  description: "People grouped by tax withheld as a share of taxable pay over the period.",
  columns: [col("label", "Tax on taxable pay"), n("people", "People"), pct("share", "Share (%)"), n("tax", "Tax withheld")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS people, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, ROUND(SUM(b.tax), 2) AS tax
      FROM (SELECT CASE WHEN t.tax <= 0 OR t.taxable <= 0 THEN 'No tax withheld' WHEN t.tax * 100.0 / t.taxable < 5 THEN 'Under 5%' WHEN t.tax * 100.0 / t.taxable < 10 THEN '5% to under 10%'
                        WHEN t.tax * 100.0 / t.taxable < 20 THEN '10% to under 20%' WHEN t.tax * 100.0 / t.taxable < 30 THEN '20% to under 30%' ELSE '30% or more' END AS label,
                   CASE WHEN t.tax <= 0 OR t.taxable <= 0 THEN 0 WHEN t.tax * 100.0 / t.taxable < 5 THEN 1 WHEN t.tax * 100.0 / t.taxable < 10 THEN 2 WHEN t.tax * 100.0 / t.taxable < 20 THEN 3 WHEN t.tax * 100.0 / t.taxable < 30 THEN 4 ELSE 5 END AS ord, t.tax
              FROM (SELECT ps.employee_id, COALESCE(SUM(ps.taxable_gross_this_period), 0) AS taxable, COALESCE(SUM(ps.income_tax_monthly), 0) AS tax FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} GROUP BY ps.employee_id) t) b
     GROUP BY b.label, b.ord ORDER BY b.ord`,
};

const TAX_LINES: ReportSectionSpec = {
  key: "payslip-lines",
  title: "Tax on each payslip",
  description: "One line per finalised payslip in the period: the month, the run, taxable pay and tax withheld. These add up to the monthly figures.",
  columns: [col("month", "Month"), col("number", "Employee number"), col("name", "Name"), col("runType", "Run type"), n("gross", "Gross pay"), n("taxable", "Taxable pay"), n("tax", "Tax withheld")],
  sql: (q) => `
    SELECT ${MONTH} AS month, e.employee_number AS number, ${NAME("e")} AS name, ${RUN_TYPE} AS "runType", ps.gross_pay AS gross, ps.taxable_gross_this_period AS taxable, ps.income_tax_monthly AS tax
      FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} ORDER BY month DESC, name, number`,
};

const NO_TAX_PROFILE: ReportSectionSpec = {
  key: "no-tax-profile",
  title: "Current employees with no tax profile in force",
  description: "People for whom payroll has no filer status, residency or scheme on file. No pay amounts are shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("type", "Employment type"), col("joined", "Joined", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, ${TYPE_LABEL} AS type, e.date_of_joining::text AS joined
      FROM employees e ${UNIT_JOIN} ${TAX_NOW(q)}
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND tx.id IS NULL ORDER BY joined DESC NULLS LAST, name`,
};

/** People counted by a tax-profile attribute. */
function profileCount(key: string, title: string, description: string, dimLabel: string, labelExpr: string): ReportSectionSpec {
  return {
    key,
    title,
    description,
    columns: [col("label", dimLabel), n("employees", "Employees"), pct("share", "Share (%)")],
    sql: (q) => `
      SELECT g.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
        FROM (SELECT ${labelExpr} AS label FROM employees e ${TAX_NOW(q)} WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}) g
       GROUP BY g.label ORDER BY employees DESC, g.label`,
  };
}

const PREVIOUS_EMPLOYER: ReportSectionSpec = {
  key: "previous-employer",
  title: "Previous employer income and tax on file",
  description: "Current employees whose tax profile carries income or tax from an earlier employer in the same tax year.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), n("previousIncome", "Previous employer income"), n("previousTax", "Previous employer tax"), col("from", "Profile effective from", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, tx.previous_employer_income AS "previousIncome", tx.previous_employer_tax AS "previousTax", tx.effective_from::text AS "from"
      FROM employees e ${UNIT_JOIN} ${TAX_NOW(q)}
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND (COALESCE(tx.previous_employer_income, 0) > 0 OR COALESCE(tx.previous_employer_tax, 0) > 0) ORDER BY name, number`,
};

// ---------------------------------------------------------------- EOBI

const NO_CONTRIBUTION: ReportSectionSpec = {
  key: "no-contribution",
  title: "Payslips with no EOBI or social security",
  description: "Finalised payslips in the period with pay but no EOBI or social security contribution, to check for people who should be covered.",
  columns: [col("month", "Month"), col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), n("gross", "Gross pay")],
  sql: (q) => `
    SELECT ${MONTH} AS month, e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, ps.gross_pay AS gross
      FROM ${SLIPS} ${UNIT_JOIN}
     WHERE ${SLIP_WHERE(q)} AND ps.gross_pay > 0 AND ps.eobi_employee_contribution + ps.eobi_employer_contribution + ps.social_security_employer_contribution = 0
     ORDER BY month DESC, name`,
};

const EOBI_LINES: ReportSectionSpec = {
  key: "payslip-lines",
  title: "Contributions on each payslip",
  description: "One line per finalised payslip in the period, to reconcile against the EOBI or social security challan.",
  columns: [col("month", "Month"), col("number", "Employee number"), col("name", "Name"), col("runType", "Run type"), n("eobiEmployee", "EOBI (employee)"), n("eobiEmployer", "EOBI (employer)"), n("social", "Social security (employer)")],
  sql: (q) => `
    SELECT ${MONTH} AS month, e.employee_number AS number, ${NAME("e")} AS name, ${RUN_TYPE} AS "runType", ps.eobi_employee_contribution AS "eobiEmployee", ps.eobi_employer_contribution AS "eobiEmployer", ps.social_security_employer_contribution AS social
      FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} AND ps.eobi_employee_contribution + ps.eobi_employer_contribution + ps.social_security_employer_contribution <> 0 ORDER BY month DESC, name, number`,
};

// ---------------------------------------------------------------- benefits

const BENEFIT_FROM = (q: Q) => `
  benefit_contributions bc JOIN benefit_plans bp ON bp.id = bc.plan_id AND bp.company_id = bc.company_id LEFT JOIN payroll_runs pr ON pr.id = bc.payroll_run_id
  WHERE ${q.co("bc")} AND bc.period_end BETWEEN ${q.from} AND ${q.to} AND (pr.id IS NULL OR (${q.co("pr")} AND ${q.area("pr")}))`;

const BENEFIT_BY_MONTH: ReportSectionSpec = {
  key: "by-month",
  title: "Contributions by month",
  description: "Accrued benefit contributions for each month: people contributing, employee and employer amounts.",
  columns: [col("month", "Month"), n("contributors", "People contributing"), n("employee", "Employee contributions"), n("employer", "Employer contributions"), n("total", "Total")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', bc.period_end), 'YYYY-MM') AS month, COUNT(DISTINCT bc.employee_id)::int AS contributors, SUM(bc.employee_amount) AS employee, SUM(bc.employer_amount) AS employer, SUM(bc.employee_amount + bc.employer_amount) AS total
      FROM ${BENEFIT_FROM(q)} AND bc.status = 'accrued' GROUP BY 1 ORDER BY 1`,
};

const BENEFIT_BY_TYPE: ReportSectionSpec = {
  key: "by-type",
  title: "By kind of benefit",
  description: "Contributions grouped by the kind of benefit plan (for example provident fund or insurance).",
  columns: [col("label", "Kind of benefit"), n("plans", "Plans"), n("contributors", "People contributing"), n("employee", "Employee contributions"), n("employer", "Employer contributions"), n("total", "Total")],
  sql: (q) => `
    SELECT ${LABEL("bp.benefit_type")} AS label, COUNT(DISTINCT bp.id)::int AS plans, COUNT(DISTINCT bc.employee_id)::int AS contributors, SUM(bc.employee_amount) AS employee, SUM(bc.employer_amount) AS employer, SUM(bc.employee_amount + bc.employer_amount) AS total
      FROM ${BENEFIT_FROM(q)} AND bc.status = 'accrued' GROUP BY bp.benefit_type ORDER BY total DESC, label`,
};

const BENEFIT_STATUS: ReportSectionSpec = {
  key: "by-status",
  title: "Accrued and reversed",
  description: "Contributions that stand and contributions that were reversed with a payroll run.",
  columns: [col("label", "Status"), n("lines", "Contribution lines"), n("employee", "Employee contributions"), n("employer", "Employer contributions"), n("total", "Total")],
  sql: (q) => `
    SELECT ${LABEL("bc.status")} AS label, COUNT(*)::int AS lines, SUM(bc.employee_amount) AS employee, SUM(bc.employer_amount) AS employer, SUM(bc.employee_amount + bc.employer_amount) AS total
      FROM ${BENEFIT_FROM(q)} GROUP BY bc.status ORDER BY label`,
};

const BENEFIT_ENROLMENTS: ReportSectionSpec = {
  key: "enrolments",
  title: "Enrolments by plan and status",
  description: "How many people are enrolled in each plan and in what state.",
  columns: [col("plan", "Plan"), col("status", "Enrolment status"), n("enrolments", "Enrolments")],
  sql: (q) => `
    SELECT bp.name AS plan, ${LABEL("be.status")} AS status, COUNT(*)::int AS enrolments
      FROM benefit_enrolments be JOIN benefit_plans bp ON bp.id = be.plan_id AND bp.company_id = be.company_id
     WHERE ${q.co("be")} GROUP BY bp.id, bp.name, be.status ORDER BY bp.name, be.status`,
};

// ---------------------------------------------------------------- bank payments

const ITEM_FROM = (q: Q) => `
  payroll_payment_items i JOIN payroll_payment_batches b ON b.id = i.batch_id JOIN payroll_runs pr ON pr.id = b.payroll_run_id JOIN employees e ON e.id = i.employee_id AND e.company_id = i.company_id
  WHERE ${BATCH_WHERE(q)} AND ${q.co("i")} AND ${q.emp()}`;

function itemGroup(key: string, title: string, description: string, dimLabel: string, labelExpr: string): ReportSectionSpec {
  return {
    key,
    title,
    description,
    columns: [col("label", dimLabel), n("payments", "Payments"), n("people", "People"), n("amount", "Amount"), n("rejected", "Rejected"), pct("rejectedPct", "Rejected (%)")],
    sql: (q) => `
      SELECT ${labelExpr} AS label, COUNT(*)::int AS payments, COUNT(DISTINCT i.employee_id)::int AS people, SUM(i.amount) AS amount, COUNT(*) FILTER (WHERE i.status = 'rejected')::int AS rejected,
             ROUND(COUNT(*) FILTER (WHERE i.status = 'rejected') * 100.0 / COUNT(*), 1) AS "rejectedPct"
        FROM ${ITEM_FROM(q)} GROUP BY 1 ORDER BY amount DESC NULLS LAST, 1`,
  };
}

const PAY_BY_BANK = itemGroup("by-bank", "By bank", "Salary payments for each receiving bank.", "Bank", "COALESCE(NULLIF(i.bank_name, ''), 'No bank recorded')");
const PAY_BY_METHOD = itemGroup("by-method", "By payment method", "Salary payments by bank transfer, cheque, cash or other method.", "Method", LABEL("i.payment_method"));
const PAY_BY_STATUS = itemGroup("by-status", "By payment status", "Salary payments by where they stand: generated, sent, paid, rejected or reissued.", "Status", LABEL("i.status"));
const PAY_BY_MONTH = itemGroup("by-month", "By month", "Salary payments by the month of the pay period.", "Month", MONTH);

const BATCH_FROM = (q: Q) => `payroll_payment_batches b JOIN payroll_runs pr ON pr.id = b.payroll_run_id LEFT JOIN bank_file_formats f ON f.id = b.format_id WHERE ${BATCH_WHERE(q)}`;

const BATCH_BY_STATUS: ReportSectionSpec = {
  key: "by-status",
  title: "Batches by status",
  description: "How many payment batches sit in each stage, with their payments and total.",
  columns: [col("label", "Batch status"), n("batches", "Batches"), n("payments", "Payments"), n("total", "Total net pay")],
  sql: (q) => `
    SELECT ${LABEL("b.status")} AS label, COUNT(*)::int AS batches, COALESCE(SUM(b.row_count), 0)::int AS payments, COALESCE(SUM(b.total_net_pay), 0) AS total
      FROM ${BATCH_FROM(q)} GROUP BY b.status ORDER BY batches DESC, label`,
};

const BATCH_BY_MONTH: ReportSectionSpec = {
  key: "by-month",
  title: "Batches by month",
  description: "Payment batches by the month of the pay period.",
  columns: [col("month", "Month"), n("batches", "Batches"), n("payments", "Payments"), n("excluded", "Excluded"), n("total", "Total net pay")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*)::int AS batches, COALESCE(SUM(b.row_count), 0)::int AS payments, COALESCE(SUM(b.excluded_count), 0)::int AS excluded, COALESCE(SUM(b.total_net_pay), 0) AS total
      FROM ${BATCH_FROM(q)} GROUP BY 1 ORDER BY 1`,
};

const BATCH_BY_FORMAT: ReportSectionSpec = {
  key: "by-format",
  title: "Batches by bank file format",
  description: "Which bank file formats were used.",
  columns: [col("label", "Bank file format"), n("batches", "Batches"), n("payments", "Payments"), n("total", "Total net pay")],
  sql: (q) => `
    SELECT COALESCE(f.name, 'Default') AS label, COUNT(*)::int AS batches, COALESCE(SUM(b.row_count), 0)::int AS payments, COALESCE(SUM(b.total_net_pay), 0) AS total
      FROM ${BATCH_FROM(q)} GROUP BY f.id, f.name ORDER BY batches DESC, label`,
};

const BATCH_ITEM_STATUS: ReportSectionSpec = {
  key: "payment-status",
  title: "Payments inside the batches",
  description: "Individual payments in these batches by status, as counts and totals only.",
  columns: [col("label", "Payment status"), n("payments", "Payments"), n("amount", "Amount"), pct("share", "Share of payments (%)")],
  sql: (q) => `
    SELECT ${LABEL("i.status")} AS label, COUNT(*)::int AS payments, SUM(i.amount) AS amount, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM payroll_payment_items i JOIN payroll_payment_batches b ON b.id = i.batch_id JOIN payroll_runs pr ON pr.id = b.payroll_run_id
     WHERE ${BATCH_WHERE(q)} AND ${q.co("i")} GROUP BY i.status ORDER BY payments DESC, label`,
};

const BATCH_TURNAROUND: ReportSectionSpec = {
  key: "turnaround",
  title: "Turnaround of each batch",
  description: "Days from generating a batch to approval, release and the bank's acknowledgement.",
  columns: [col("batch", "Batch"), col("period", "Pay period"), col("status", "Status"), n("toApproval", "Days to approval"), n("toRelease", "Days approval to release"), n("toAcknowledgement", "Days release to acknowledgement")],
  sql: (q) => `
    SELECT b.batch_reference AS batch, ${PERIOD_TEXT} AS period, ${LABEL("b.status")} AS status,
           ROUND((EXTRACT(EPOCH FROM (b.approved_at - b.generated_at)) / 86400)::numeric, 1) AS "toApproval",
           ROUND((EXTRACT(EPOCH FROM (b.released_at - b.approved_at)) / 86400)::numeric, 1) AS "toRelease",
           ROUND((EXTRACT(EPOCH FROM (b.acknowledged_at - b.released_at)) / 86400)::numeric, 1) AS "toAcknowledgement"
      FROM ${BATCH_FROM(q)} ORDER BY pr.period_end DESC, b.generated_at DESC`,
};

const ISSUE_BY_BANK: ReportSectionSpec = {
  key: "issues-by-bank",
  title: "Payment problems by bank",
  description: "Rejected, reissued and retried payments for each bank.",
  columns: [col("label", "Bank"), n("rejected", "Rejected"), n("reissued", "Reissued"), n("retried", "Retried"), n("amount", "Amount affected")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(i.bank_name, ''), 'No bank recorded') AS label, COUNT(*) FILTER (WHERE i.status = 'rejected')::int AS rejected, COUNT(*) FILTER (WHERE i.status = 'reissued')::int AS reissued,
           COUNT(*) FILTER (WHERE i.retry_count > 0)::int AS retried, SUM(i.amount) AS amount
      FROM ${ITEM_FROM(q)} AND (i.status IN ('rejected', 'reissued') OR i.retry_count > 0) GROUP BY 1 ORDER BY rejected DESC, amount DESC NULLS LAST, 1`,
};

const ISSUE_BY_MONTH: ReportSectionSpec = {
  key: "issues-by-month",
  title: "Payment problems by month",
  description: "Rejected, reissued and retried payments in each month.",
  columns: [col("month", "Month"), n("rejected", "Rejected"), n("reissued", "Reissued"), n("retried", "Retried"), n("amount", "Amount affected")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(*) FILTER (WHERE i.status = 'rejected')::int AS rejected, COUNT(*) FILTER (WHERE i.status = 'reissued')::int AS reissued,
           COUNT(*) FILTER (WHERE i.retry_count > 0)::int AS retried, SUM(i.amount) AS amount
      FROM ${ITEM_FROM(q)} AND (i.status IN ('rejected', 'reissued') OR i.retry_count > 0) GROUP BY 1 ORDER BY 1`,
};

const UNPAID_BY_RUN: ReportSectionSpec = {
  key: "no-payment-by-run",
  title: "Released payslips without a payment, by pay period",
  description: "For runs already released for payment: finalised payslips with net pay but no payment generated.",
  columns: [col("period", "Pay period"), n("payslips", "Payslips"), n("amount", "Net pay not paid by a batch")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, COUNT(*)::int AS payslips, SUM(ps.net_pay) AS amount
      FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} AND ps.net_pay > 0 AND pr.status IN ('payment_released', 'reconciled', 'closed')
       AND NOT EXISTS (SELECT 1 FROM payroll_payment_items i WHERE i.payslip_id = ps.id AND i.status <> 'voided')
     GROUP BY pr.id, pr.period_start, pr.period_end ORDER BY pr.period_end DESC`,
};

const RETRY_COUNTS: ReportSectionSpec = {
  key: "retries",
  title: "Payments by number of retries",
  description: "How many payments needed no retry, one retry or more.",
  columns: [col("label", "Retries"), n("payments", "Payments"), n("amount", "Amount")],
  sql: (q) => `
    SELECT CASE WHEN i.retry_count = 0 THEN 'No retry' WHEN i.retry_count = 1 THEN 'One retry' ELSE 'Two or more retries' END AS label, COUNT(*)::int AS payments, SUM(i.amount) AS amount
      FROM ${ITEM_FROM(q)} GROUP BY 1 ORDER BY MIN(i.retry_count)`,
};

// ---------------------------------------------------------------- loans

const LOAN_BY_STATUS: ReportSectionSpec = {
  key: "by-status",
  title: "By loan status",
  description: "Loans and advances in each state. States with fewer than 3 borrowers are combined.",
  columns: [col("label", "Status"), n("loans", "Loans"), n("borrowers", "Borrowers"), n("principal", "Principal"), n("outstanding", "Outstanding")],
  sql: (q) => `
    SELECT CASE WHEN g.borrowers < 3 THEN '${OTHER}' ELSE g.label END AS label, SUM(g.loans)::int AS loans, SUM(g.borrowers)::int AS borrowers, SUM(g.principal) AS principal, SUM(g.outstanding) AS outstanding
      FROM (SELECT ${LABEL("l.status")} AS label, COUNT(*) AS loans, COUNT(DISTINCT l.employee_id) AS borrowers, SUM(l.principal_amount) AS principal, SUM(l.outstanding_balance) AS outstanding
              FROM employee_loans l ${LOAN_JOIN} WHERE ${LOAN_WHERE(q)} GROUP BY l.status) g
     GROUP BY 1 ORDER BY SUM(g.loans) DESC, 1`,
};

const LOAN_BY_TYPE: ReportSectionSpec = {
  key: "by-type",
  title: "By loan type",
  description: "All loans by type, with what was lent, recovered and is still outstanding. Types with fewer than 3 borrowers are combined.",
  columns: [col("label", "Loan type"), n("loans", "Loans"), n("borrowers", "Borrowers"), n("principal", "Principal"), n("recovered", "Recovered"), n("outstanding", "Outstanding")],
  sql: (q) => `
    SELECT CASE WHEN g.borrowers < 3 THEN '${OTHER}' ELSE g.label END AS label, SUM(g.loans)::int AS loans, SUM(g.borrowers)::int AS borrowers, SUM(g.principal) AS principal, SUM(g.recovered) AS recovered, SUM(g.outstanding) AS outstanding
      FROM (SELECT ${LOAN_KIND} AS label, COUNT(*) AS loans, COUNT(DISTINCT l.employee_id) AS borrowers, SUM(l.principal_amount) AS principal, SUM(l.principal_amount - l.outstanding_balance) AS recovered, SUM(l.outstanding_balance) AS outstanding
              FROM employee_loans l ${LOAN_JOIN} WHERE ${LOAN_WHERE(q)} GROUP BY ${LOAN_KIND}) g
     GROUP BY 1 ORDER BY SUM(g.principal) DESC, 1`,
};

const LOAN_BY_UNIT: ReportSectionSpec = {
  key: "by-unit",
  title: "Active loans by organisation unit",
  description: "Active and on-hold loans for each unit. Units with fewer than 3 borrowers are combined.",
  columns: [col("label", "Organisation unit"), n("loans", "Loans"), n("borrowers", "Borrowers"), n("outstanding", "Outstanding")],
  sql: (q) => `
    SELECT CASE WHEN g.borrowers < 3 AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.loans)::int AS loans, SUM(g.borrowers)::int AS borrowers, SUM(g.outstanding) AS outstanding
      FROM (SELECT ${UNIT} AS label, COUNT(*) AS loans, COUNT(DISTINCT l.employee_id) AS borrowers, SUM(l.outstanding_balance) AS outstanding
              FROM employee_loans l ${LOAN_JOIN} ${UNIT_JOIN} WHERE ${LOAN_WHERE(q)} AND l.status IN ('active', 'on_hold') GROUP BY ou.name) g
     GROUP BY 1 ORDER BY SUM(g.outstanding) DESC NULLS LAST, 1`,
};

const LOAN_OVERDUE_LIST: ReportSectionSpec = {
  key: "overdue-loans",
  title: "Loans with overdue instalments",
  description: "Active loans where an instalment fell due before today and was not recovered.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("kind", "Loan type"), n("overdue", "Overdue instalments"), n("amount", "Overdue amount"), col("oldest", "Oldest due date", "date"), n("outstanding", "Outstanding balance")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LOAN_KIND} AS kind, COUNT(*)::int AS overdue, SUM(GREATEST(s.amount - COALESCE(s.paid_amount, 0), 0)) AS amount, MIN(s.due_date)::text AS oldest, MAX(l.outstanding_balance) AS outstanding
      FROM loan_schedules s JOIN employee_loans l ON l.id = s.loan_id ${LOAN_JOIN}
     WHERE ${q.co("s")} AND ${LOAN_WHERE(q)} AND l.status = 'active' AND s.status = 'scheduled' AND s.due_date < ${q.today}
     GROUP BY l.id, e.employee_number, e.first_name, e.last_name, lt.name, l.loan_type ORDER BY MIN(s.due_date), name`,
};

const LOAN_ISSUED_BY_MONTH: ReportSectionSpec = {
  key: "issued-by-month",
  title: "Loans issued by month",
  description: "How many loans were issued each month (all months on record), as counts only.",
  columns: [col("month", "Month"), n("loans", "Loans issued"), n("borrowers", "Borrowers")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', l.issued_date), 'YYYY-MM') AS month, COUNT(*)::int AS loans, COUNT(DISTINCT l.employee_id)::int AS borrowers
      FROM employee_loans l ${LOAN_JOIN} WHERE ${LOAN_WHERE(q)} AND l.issued_date IS NOT NULL GROUP BY 1 ORDER BY 1 DESC`,
};

const INSTALMENT_FROM = (q: Q) => `loan_schedules s JOIN employee_loans l ON l.id = s.loan_id ${LOAN_JOIN} WHERE ${q.co("s")} AND ${LOAN_WHERE(q)} AND s.due_date BETWEEN ${q.from} AND ${q.to}`;

const INSTALMENT_BY_MONTH: ReportSectionSpec = {
  key: "by-month",
  title: "Instalments by month due",
  description: "For each month: instalments due, the amount due, what was recovered and the recovery rate.",
  columns: [col("month", "Month"), n("instalments", "Instalments"), n("due", "Amount due"), n("recovered", "Recovered"), pct("rate", "Recovered (%)")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', s.due_date), 'YYYY-MM') AS month, COUNT(*)::int AS instalments, SUM(s.amount) AS due, COALESCE(SUM(s.paid_amount), 0) AS recovered,
           CASE WHEN SUM(s.amount) > 0 THEN ROUND(COALESCE(SUM(s.paid_amount), 0) * 100.0 / SUM(s.amount), 1) END AS rate
      FROM ${INSTALMENT_FROM(q)} GROUP BY 1 ORDER BY 1`,
};

const INSTALMENT_BY_STATUS: ReportSectionSpec = {
  key: "by-status",
  title: "Instalments by status",
  description: "Instalments due in the period by status: scheduled, paid, held, skipped, settled or cancelled.",
  columns: [col("label", "Status"), n("instalments", "Instalments"), n("due", "Amount due"), n("recovered", "Recovered")],
  sql: (q) => `
    SELECT ${LABEL("s.status")} AS label, COUNT(*)::int AS instalments, SUM(s.amount) AS due, COALESCE(SUM(s.paid_amount), 0) AS recovered
      FROM ${INSTALMENT_FROM(q)} GROUP BY s.status ORDER BY instalments DESC, label`,
};

const INSTALMENT_BY_TYPE: ReportSectionSpec = {
  key: "by-type",
  title: "Instalments by loan type",
  description: "Instalments due in the period for each loan type. Types with fewer than 3 borrowers are combined.",
  columns: [col("label", "Loan type"), n("instalments", "Instalments"), n("borrowers", "Borrowers"), n("due", "Amount due"), n("recovered", "Recovered")],
  sql: (q) => `
    SELECT CASE WHEN g.borrowers < 3 THEN '${OTHER}' ELSE g.label END AS label, SUM(g.instalments)::int AS instalments, SUM(g.borrowers)::int AS borrowers, SUM(g.due) AS due, SUM(g.recovered) AS recovered
      FROM (SELECT ${LOAN_KIND} AS label, COUNT(*) AS instalments, COUNT(DISTINCT l.employee_id) AS borrowers, SUM(s.amount) AS due, COALESCE(SUM(s.paid_amount), 0) AS recovered
              FROM ${INSTALMENT_FROM(q)} GROUP BY ${LOAN_KIND}) g
     GROUP BY 1 ORDER BY SUM(g.due) DESC, 1`,
};

/** Overdue instalments (as of today) by how late they are, bands with fewer than 3 borrowers combined. */
const OVERDUE_AGEING: ReportSectionSpec = {
  key: "overdue-ageing",
  title: "Overdue instalments by age",
  description: "Instalments that fell due before today and are still unrecovered, grouped by days past due. Bands with fewer than 3 borrowers are combined.",
  columns: [col("label", "Days past due"), n("instalments", "Instalments"), n("borrowers", "Borrowers"), n("amount", "Amount overdue")],
  sql: (q) => `
    SELECT CASE WHEN g.borrowers < 3 THEN '${OTHER}' ELSE g.label END AS label, SUM(g.instalments)::int AS instalments, SUM(g.borrowers)::int AS borrowers, SUM(g.amount) AS amount
      FROM (SELECT CASE WHEN ${q.today} - s.due_date <= 30 THEN '1 to 30 days' WHEN ${q.today} - s.due_date <= 60 THEN '31 to 60 days' WHEN ${q.today} - s.due_date <= 90 THEN '61 to 90 days' ELSE 'Over 90 days' END AS label,
                   MIN(CASE WHEN ${q.today} - s.due_date <= 30 THEN 1 WHEN ${q.today} - s.due_date <= 60 THEN 2 WHEN ${q.today} - s.due_date <= 90 THEN 3 ELSE 4 END) AS ord,
                   COUNT(*) AS instalments, COUNT(DISTINCT l.employee_id) AS borrowers, SUM(GREATEST(s.amount - COALESCE(s.paid_amount, 0), 0)) AS amount
              FROM loan_schedules s JOIN employee_loans l ON l.id = s.loan_id ${LOAN_JOIN}
             WHERE ${q.co("s")} AND ${LOAN_WHERE(q)} AND l.status = 'active' AND s.status = 'scheduled' AND s.due_date < ${q.today} GROUP BY 1) g
     GROUP BY 1 ORDER BY MIN(g.ord), 1`,
};

// ---------------------------------------------------------------- final settlements

const SETTLEMENT_FROM = (q: Q) => `
  payroll_final_settlements st JOIN employees e ON e.id = st.employee_id AND e.company_id = st.company_id ${UNIT_JOIN}
  LEFT JOIN payroll_final_settlement_lines ln ON ln.settlement_id = st.id AND ln.settle_via <> 'info'
  WHERE ${q.co("st")} AND ${q.emp()} AND ${q.area("e")} AND st.last_working_day BETWEEN ${q.from} AND ${q.to} AND st.status <> 'cancelled'`;

const SETTLEMENT_BY_MONTH: ReportSectionSpec = {
  key: "by-month",
  title: "Settlements by month of leaving",
  description: "For each month: settlements, the net amount and its main parts.",
  columns: [col("month", "Month"), n("settlements", "Settlements"), n("gratuity", "Gratuity"), n("leave", "Leave encashment"), n("recoveries", "Recoveries"), n("net", "Net settlement")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', st.last_working_day), 'YYYY-MM') AS month, COUNT(DISTINCT st.id)::int AS settlements,
           COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'gratuity'), 0) AS gratuity, COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'leave_encashment'), 0) AS leave,
           COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind IN ('notice_recovery', 'loan_outstanding', 'other_deductions')), 0) AS recoveries, COALESCE(SUM(ln.amount), 0) AS net
      FROM ${SETTLEMENT_FROM(q)} GROUP BY 1 ORDER BY 1`,
};

const SETTLEMENT_BY_KIND: ReportSectionSpec = {
  key: "by-kind",
  title: "By part of the settlement",
  description: "Each kind of settlement line, with how many settlements carry it and the total. Deductions are negative.",
  columns: [col("label", "Part of the settlement"), n("settlements", "Settlements"), n("amount", "Amount")],
  sql: (q) => `
    SELECT ${LABEL("ln.kind")} AS label, COUNT(DISTINCT st.id)::int AS settlements, SUM(ln.amount) AS amount
      FROM ${SETTLEMENT_FROM(q)} AND ln.id IS NOT NULL GROUP BY ln.kind ORDER BY amount DESC, label`,
};

const SETTLEMENT_BY_STATUS: ReportSectionSpec = {
  key: "by-status",
  title: "By settlement status",
  description: "Settlements by where they stand.",
  columns: [col("label", "Status"), n("settlements", "Settlements"), n("net", "Net settlement")],
  sql: (q) => `
    SELECT ${LABEL("st.status")} AS label, COUNT(DISTINCT st.id)::int AS settlements, COALESCE(SUM(ln.amount), 0) AS net
      FROM ${SETTLEMENT_FROM(q)} GROUP BY st.status ORDER BY settlements DESC, label`,
};

const SETTLEMENT_BY_UNIT: ReportSectionSpec = {
  key: "by-unit",
  title: "By organisation unit",
  description: "Settlements for each unit. Units with fewer than 3 leavers are combined.",
  columns: [col("label", "Organisation unit"), n("settlements", "Settlements"), n("net", "Net settlement")],
  sql: (q) => `
    SELECT CASE WHEN g.settlements < 3 AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.settlements)::int AS settlements, SUM(g.net) AS net
      FROM (SELECT ${UNIT} AS label, COUNT(DISTINCT st.id) AS settlements, COALESCE(SUM(ln.amount), 0) AS net FROM ${SETTLEMENT_FROM(q)} GROUP BY ou.name) g
     GROUP BY 1 ORDER BY SUM(g.net) DESC, 1`,
};

const SETTLEMENT_LINES: ReportSectionSpec = {
  key: "lines",
  title: "Settlement lines",
  description: "Every line of every settlement in the period: what it is, the amount and how it is settled.",
  columns: [col("lastDay", "Last working day", "date"), col("number", "Employee number"), col("name", "Name"), col("kind", "Part of the settlement"), col("label", "Line"), n("amount", "Amount"), col("via", "Settled through")],
  sql: (q) => `
    SELECT st.last_working_day::text AS "lastDay", e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("ln.kind")} AS kind, ln.label AS label, ln.amount AS amount, ${LABEL("ln.settle_via")} AS via
      FROM ${SETTLEMENT_FROM(q)} AND ln.id IS NOT NULL ORDER BY st.last_working_day DESC, name, ln.line_no`,
};

// ---------------------------------------------------------------- arrears and off-cycle

const OFFCYCLE_WHERE = (q: Q) => `${SLIP_WHERE(q)} AND (pr.run_type = 'off_cycle' OR COALESCE(ps.arrears_amount, 0) <> 0)`;
const REASON = `COALESCE(${LABEL("pr.off_cycle_reason")}, CASE WHEN pr.run_type = 'off_cycle' THEN 'No reason recorded' ELSE 'Arrears or retro in a regular run' END)`;

const OFFCYCLE_BY_REASON: ReportSectionSpec = {
  key: "by-reason",
  title: "By reason",
  description: "Off-cycle payments and arrears by reason, with people, arrears, gross and net pay. Reasons with fewer than 3 people are combined.",
  columns: [col("label", "Reason"), n("people", "People"), n("payslips", "Payslips"), n("arrears", "Arrears and retro"), n("gross", "Gross pay"), n("net", "Net pay")],
  sql: (q) => `
    SELECT CASE WHEN g.people < 3 THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips, SUM(g.arrears) AS arrears, SUM(g.gross) AS gross, SUM(g.net) AS net
      FROM (SELECT ${REASON} AS label, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, COALESCE(SUM(ps.arrears_amount), 0) AS arrears, SUM(ps.gross_pay) AS gross, SUM(ps.net_pay) AS net
              FROM ${SLIPS} WHERE ${OFFCYCLE_WHERE(q)} GROUP BY 1) g
     GROUP BY 1 ORDER BY SUM(g.gross) DESC NULLS LAST, 1`,
};

const OFFCYCLE_BY_MONTH: ReportSectionSpec = {
  key: "by-month",
  title: "By month",
  description: "Off-cycle payments and arrears by month.",
  columns: [col("month", "Month"), n("people", "People"), n("payslips", "Payslips"), n("arrears", "Arrears and retro"), n("gross", "Gross pay"), n("net", "Net pay")],
  sql: (q) => `
    SELECT ${MONTH} AS month, COUNT(DISTINCT ps.employee_id)::int AS people, COUNT(*)::int AS payslips, COALESCE(SUM(ps.arrears_amount), 0) AS arrears, SUM(ps.gross_pay) AS gross, SUM(ps.net_pay) AS net
      FROM ${SLIPS} WHERE ${OFFCYCLE_WHERE(q)} GROUP BY 1 ORDER BY 1`,
};

const OFFCYCLE_BY_UNIT: ReportSectionSpec = {
  key: "by-unit",
  title: "By organisation unit",
  description: "Off-cycle payments and arrears for each unit. Units with fewer than 3 people are combined.",
  columns: [col("label", "Organisation unit"), n("people", "People"), n("payslips", "Payslips"), n("arrears", "Arrears and retro"), n("gross", "Gross pay")],
  sql: (q) => `
    SELECT CASE WHEN g.people < 3 AND g.label NOT LIKE 'No %' THEN '${OTHER}' ELSE g.label END AS label, SUM(g.people)::int AS people, SUM(g.slips)::int AS payslips, SUM(g.arrears) AS arrears, SUM(g.gross) AS gross
      FROM (SELECT ${UNIT} AS label, COUNT(DISTINCT ps.employee_id) AS people, COUNT(*) AS slips, COALESCE(SUM(ps.arrears_amount), 0) AS arrears, SUM(ps.gross_pay) AS gross
              FROM ${SLIPS} ${UNIT_JOIN} WHERE ${OFFCYCLE_WHERE(q)} GROUP BY ou.name) g
     GROUP BY 1 ORDER BY SUM(g.gross) DESC NULLS LAST, 1`,
};

const OFFCYCLE_RUNS: ReportSectionSpec = {
  key: "runs",
  title: "The runs behind these payments",
  description: "Each run that paid an off-cycle amount or arrears: its period, reason, payslips and totals.",
  columns: [col("period", "Pay period"), col("runType", "Run type"), col("reason", "Reason"), n("payslips", "Payslips"), n("arrears", "Arrears and retro"), n("gross", "Gross pay"), n("net", "Net pay")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${RUN_TYPE} AS "runType", ${REASON} AS reason, COUNT(*)::int AS payslips, COALESCE(SUM(ps.arrears_amount), 0) AS arrears, SUM(ps.gross_pay) AS gross, SUM(ps.net_pay) AS net
      FROM ${SLIPS} WHERE ${OFFCYCLE_WHERE(q)} GROUP BY pr.id, pr.period_start, pr.period_end, pr.run_type, pr.off_cycle_reason ORDER BY pr.period_end DESC, pr.created_at DESC`,
};

// ---------------------------------------------------------------- registry

const SALARY_BY_UNIT = salaryGroup("salary-by-unit", "Salary by organisation unit", "Lowest, median, average and highest monthly salary of current employees in each unit. Units with fewer than 3 people are combined.", "Organisation unit", UNIT, UNIT_JOIN);
const SALARY_BY_LOCATION = salaryGroup("salary-by-location", "Salary by location", "Monthly salary of current employees at each work location. Locations with fewer than 3 people are combined.", "Location", LOC_LABEL, LOC_JOIN);
const SALARY_BY_TYPE = salaryGroup("salary-by-type", "Salary by employment type", "Monthly salary of current employees by employment type. Types with fewer than 3 people are combined.", "Employment type", TYPE_LABEL, "");
const SALARY_BY_GRADE = salaryGroup("salary-by-band", "Salary by salary band", "Monthly salary of current employees by the salary band on their record. Bands with fewer than 3 people are combined.", "Salary band", GRADE_LABEL, "");

const TAX_BY_UNIT = slipGroup("tax-by-unit", "Tax by organisation unit", "Tax withheld in the period for each unit. Units with fewer than 3 people are combined.", "Organisation unit", UNIT, UNIT_JOIN, TAX_MEASURES, { ratio: TAX_RATIO });
const TAX_BY_LOCATION = slipGroup("tax-by-location", "Tax by location", "Tax withheld in the period for each work location. Locations with fewer than 3 people are combined.", "Location", LOC_LABEL, LOC_JOIN, TAX_MEASURES, { ratio: TAX_RATIO });
const TAX_BY_FILER = slipGroup("tax-by-filer", "Tax by filer status", "Tax withheld for filers and non-filers, using the tax profile in force today. Groups with fewer than 3 people are combined.", "Filer status", FILER, TAX_NOW, TAX_MEASURES, { ratio: TAX_RATIO });
const TAX_BY_RUN_TYPE = slipGroup("tax-by-run-type", "Tax in regular and off-cycle runs", "Tax withheld in regular runs and in off-cycle runs (bonus, arrears, settlement).", "Run type", RUN_TYPE, "", TAX_MEASURES, { ratio: TAX_RATIO });
const TAX_UNIT_MONTH = slipGroup("tax-by-unit-month", "Organisation unit by month", "Tax withheld for each unit in each month. Groups with fewer than 3 people in a month are combined.", "Organisation unit", UNIT, UNIT_JOIN, TAX_MEASURES, { monthly: true, ratio: TAX_RATIO });

const EOBI_BY_UNIT = slipGroup("contributions-by-unit", "Contributions by organisation unit", "EOBI and social security for each unit. Units with fewer than 3 people are combined.", "Organisation unit", UNIT, UNIT_JOIN, EOBI_MEASURES);
const EOBI_BY_SCHEME = slipGroup("contributions-by-scheme", "Contributions by provincial scheme", "EOBI and social security by the provincial scheme on the tax profile. Schemes with fewer than 3 people are combined.", "Provincial scheme", SCHEME, TAX_NOW, EOBI_MEASURES);
const EOBI_BY_RUN_TYPE = slipGroup("contributions-by-run-type", "Contributions in regular and off-cycle runs", "Contributions recorded in regular and in off-cycle runs.", "Run type", RUN_TYPE, "", EOBI_MEASURES);
const EOBI_BY_LOCATION = slipGroup("contributions-by-location", "Contributions by location", "EOBI and social security for each work location. Locations with fewer than 3 people are combined.", "Location", LOC_LABEL, LOC_JOIN, EOBI_MEASURES);

export const PAYROLL_STATEMENTS_DEPTH: Readonly<Record<string, readonly ReportSectionSpec[]>> = {
  F11: [SALARY_BY_UNIT, SALARY_BY_LOCATION, SALARY_BY_TYPE, SALARY_BY_GRADE, SALARY_BANDS, NOT_REVISED, NO_SALARY],
  F12: [REVISIONS_BY_MONTH, REVISIONS_BY_UNIT, REVISION_SIZE, NOT_REVISED],
  F13: [COMPONENT_BY_NAME, COMPONENT_BY_KIND, COMPONENT_TAXABLE, COMPONENT_BY_UNIT],
  F14: [SALARY_BY_LOCATION, SALARY_BY_TYPE, SALARY_BY_GRADE, SALARY_BANDS],
  F15: [REVISIONS_BY_UNIT, REVISION_SIZE],
  F16: [TAX_BY_UNIT, TAX_UNIT_MONTH, TAX_RATE_BANDS, TAX_BY_RUN_TYPE, TAX_LINES],
  F17: [TAX_BY_UNIT, TAX_BY_FILER, TAX_RATE_BANDS, NO_TAX_PROFILE],
  F18: [TAX_BY_UNIT, TAX_BY_LOCATION, TAX_BY_FILER, TAX_BY_RUN_TYPE],
  F19: [
    profileCount("by-filer", "By filer status", "Current employees by filer status on the tax profile in force today.", "Filer status", FILER),
    profileCount("by-scheme", "By provincial scheme", "Current employees by provincial social security scheme.", "Provincial scheme", SCHEME),
    profileCount("by-residency", "By tax residency", "Current employees by tax residency.", "Tax residency", RESIDENCY),
    NO_TAX_PROFILE,
    PREVIOUS_EMPLOYER,
  ],
  F20: [EOBI_BY_UNIT, EOBI_BY_SCHEME, EOBI_BY_RUN_TYPE, EOBI_LINES, NO_CONTRIBUTION],
  F21: [EOBI_BY_UNIT, EOBI_BY_LOCATION, EOBI_BY_SCHEME, EOBI_BY_RUN_TYPE],
  F22: [BENEFIT_BY_MONTH, BENEFIT_BY_TYPE, BENEFIT_STATUS, BENEFIT_ENROLMENTS],
  F23: [PAY_BY_BANK, PAY_BY_METHOD, PAY_BY_STATUS, PAY_BY_MONTH],
  F24: [BATCH_BY_STATUS, BATCH_BY_MONTH, BATCH_BY_FORMAT, BATCH_ITEM_STATUS, BATCH_TURNAROUND],
  F25: [ISSUE_BY_BANK, ISSUE_BY_MONTH, UNPAID_BY_RUN, RETRY_COUNTS],
  F26: [LOAN_BY_STATUS, LOAN_BY_TYPE, LOAN_BY_UNIT, LOAN_OVERDUE_LIST, LOAN_ISSUED_BY_MONTH],
  F27: [INSTALMENT_BY_MONTH, INSTALMENT_BY_STATUS, INSTALMENT_BY_TYPE, OVERDUE_AGEING],
  F28: [LOAN_BY_STATUS, LOAN_BY_UNIT, OVERDUE_AGEING, LOAN_ISSUED_BY_MONTH],
  F29: [SETTLEMENT_BY_MONTH, SETTLEMENT_BY_KIND, SETTLEMENT_BY_STATUS, SETTLEMENT_BY_UNIT, SETTLEMENT_LINES],
  F30: [OFFCYCLE_BY_REASON, OFFCYCLE_BY_MONTH, OFFCYCLE_BY_UNIT, OFFCYCLE_RUNS],
};
