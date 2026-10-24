import type { ReportColumn } from "@aihxm/shared-types";
import { DEPT, ETYPE, LOC, barChart, count, lineChart, listReport, num, percent, round1, round2, sqlReport, sum, type Q } from "../report-spec";

/**
 * Pay statements: salary information, income tax month by month, EOBI and social security, benefit contributions, bank
 * payments, loans and final settlements (catalog F11 to F30).
 *
 * What is shown here is what payroll recorded: the salary on file, and the tax, EOBI and other amounts on finalised
 * payslips. The reports do not recompute tax, and a tax figure here is not a filed return or a certificate.
 *
 * Reports that list pay per person are Restricted (like F02). The aggregate ones are Sensitive and merge any group of fewer
 * than 3 people into "Other". Nothing here reads or shows an encrypted value: no CNIC, no NTN, no account number or IBAN
 * (a payment advice shows only the last four digits that the payment file already carries), no free text, and no bank rejection text.
 * The company, payroll-area and team limits are applied by q.emp(), q.area() and q.co() as in every other report.
 */

const col = (key: string, label: string, type: ReportColumn["type"] = "text"): ReportColumn => ({ key, label, type });
const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const LABEL = (c: string) => `INITCAP(REPLACE(${c}, '_', ' '))`;
const IDENT = [col("number", "Employee number"), col("name", "Name")];
export const UNIT = "COALESCE(ou.name, 'No organisation unit set')";
export const UNIT_JOIN = "LEFT JOIN org_units ou ON ou.id = e.org_unit_id";
const MONEY_NOTE = "Amounts are in the currency of the payroll runs (PKR for Pakistan payroll).";
const RECORDED_NOTE = "These are the amounts payroll recorded on finalised payslips. They are not recomputed here, and this report is not a filed tax return or an official certificate.";
export const OTHER = "Other (groups under 3 people combined)";

/** Real runs in the caller's company and payroll areas. */
const RUN = (q: Q) => `${q.co("pr")} AND ${q.area("pr")} AND pr.is_simulation = false`;
/** Approved and finalised, or further along: the only runs whose money is final. */
const FINAL = "pr.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed')";
const PERIOD = (q: Q) => `pr.period_end BETWEEN ${q.from} AND ${q.to}`;
export const SLIPS = "payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id JOIN employees e ON e.id = ps.employee_id";
/** Finalised, non-voided payslips of the chosen people in the chosen period. */
export const SLIP_WHERE = (q: Q) => `${RUN(q)} AND ${FINAL} AND ps.status <> 'voided' AND ${PERIOD(q)} AND ${q.emp()}`;
export const PERIOD_TEXT = "pr.period_start::text || ' to ' || pr.period_end::text";

/** The salary row in force today for employee alias `e`. */
export const SALARY_NOW = (q: Q) => `(SELECT c.monthly_salary FROM employee_compensation c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.effective_from <= ${q.today} AND (c.effective_to IS NULL OR c.effective_to >= ${q.today}) ORDER BY c.effective_from DESC LIMIT 1)`;
/** Monthly amount of a compensation component, whether it was entered monthly or yearly. */
export const MONTHLY = "CASE WHEN x.pay_frequency = 'annual' THEN x.amount / 12.0 ELSE x.amount END";
const COMPONENT_NOW = (q: Q, types: string) =>
  `(SELECT COALESCE(SUM(${MONTHLY}), 0) FROM employee_compensation_components x JOIN compensation_components cc ON cc.id = x.component_id
     WHERE x.company_id = e.company_id AND x.employee_id = e.id AND x.effective_from <= ${q.today} AND (x.effective_to IS NULL OR x.effective_to >= ${q.today}) AND cc.component_type IN ${types})`;

// ================================================================ salary information

export const F11 = listReport({
  description: "Every current employee's salary on file: monthly salary, allowances, recurring deductions, the gross package, and the last change. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "employee_compensation", "employee_compensation_components", "compensation_components"],
  tags: ["salary", "compensation", "package"],
  countLabel: "Employees listed",
  columns: [
    ...IDENT,
    col("unit", "Organisation unit"),
    col("position", "Position"),
    col("location", "Location"),
    col("type", "Employment type"),
    col("band", "Salary band"),
    col("salary", "Monthly salary", "number"),
    col("since", "Salary effective from", "date"),
    col("previous", "Previous salary", "number"),
    col("changePct", "Last change (%)", "percent"),
    col("allowances", "Allowances and other earnings", "number"),
    col("gross", "Monthly gross package", "number"),
    col("deductions", "Recurring deductions", "number"),
    col("components", "Components on file", "number"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, COALESCE(p.position_title, 'No position set') AS position, COALESCE(l.name, 'No location set') AS location,
           COALESCE(NULLIF(INITCAP(REPLACE(e.employment_type, '_', ' ')), ''), 'Not set') AS type, e.salary_band AS band,
           cmp.monthly_salary AS salary, cmp.effective_from::text AS since, prev.monthly_salary AS previous,
           CASE WHEN prev.monthly_salary > 0 THEN ROUND((cmp.monthly_salary - prev.monthly_salary) * 100.0 / prev.monthly_salary, 1) END AS "changePct",
           ${COMPONENT_NOW(q, "('earning', 'shift_premium')")} AS allowances,
           CASE WHEN cmp.monthly_salary IS NULL THEN NULL ELSE cmp.monthly_salary + ${COMPONENT_NOW(q, "('earning', 'shift_premium')")} END AS gross,
           ${COMPONENT_NOW(q, "('deduction')")} AS deductions,
           (SELECT COUNT(*)::int FROM employee_compensation_components x WHERE x.company_id = e.company_id AND x.employee_id = e.id AND x.effective_from <= ${q.today} AND (x.effective_to IS NULL OR x.effective_to >= ${q.today})) AS components
      FROM employees e ${UNIT_JOIN}
      LEFT JOIN positions p ON p.id = e.position_id LEFT JOIN locations l ON l.id = e.location_id
      LEFT JOIN LATERAL (SELECT c.* FROM employee_compensation c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.effective_from <= ${q.today} AND (c.effective_to IS NULL OR c.effective_to >= ${q.today}) ORDER BY c.effective_from DESC LIMIT 1) cmp ON TRUE
      LEFT JOIN LATERAL (SELECT c.monthly_salary FROM employee_compensation c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND cmp.effective_from IS NOT NULL AND c.effective_from < cmp.effective_from ORDER BY c.effective_from DESC LIMIT 1) prev ON TRUE
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
     ORDER BY name, number`,
  kpis: ({ rows }) => {
    const paid = rows.filter((r) => r.salary !== null);
    return [
      count("total", "Total monthly salary (PKR)", round2(paid.reduce((s, r) => s + num(r, "salary"), 0)), `${paid.length} of ${rows.length} employees have a salary on file`),
      count("average", "Average monthly salary (PKR)", paid.length ? round2(paid.reduce((s, r) => s + num(r, "salary"), 0) / paid.length) : null),
      count("missing", "No salary on file", rows.length - paid.length),
    ];
  },
  calculation: [
    "One row per current employee. Monthly salary is the dated salary record in force today. Previous salary is the record before it, and Last change is the difference as a percentage of the previous salary.",
    "Allowances and other earnings add the earning components in force today (yearly components are divided by 12). Recurring deductions add the deduction components in force today. The gross package is the monthly salary plus those earnings. Components calculated as a percentage show the amount recorded for them.",
    MONEY_NOTE,
  ],
  notes: ({ rows }) => (rows.some((r) => r.salary === null) ? ["Some employees have no salary on file; they are listed with blank pay."] : []),
});

export const F12 = listReport({
  description: "Every salary revision with its effective date: the old salary, the new salary, the change and who entered it. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["employee_compensation", "employees"],
  tags: ["salary", "increment", "history"],
  countLabel: "Revisions",
  columns: [
    col("effective", "Effective from", "date"),
    ...IDENT,
    col("unit", "Organisation unit"),
    col("previous", "Previous salary", "number"),
    col("salary", "New salary", "number"),
    col("change", "Change", "number"),
    col("changePct", "Change (%)", "percent"),
    col("enteredBy", "Entered by"),
  ],
  sql: (q) => `
    SELECT c.effective_from::text AS effective, e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, prev.monthly_salary AS previous, c.monthly_salary AS salary,
           c.monthly_salary - prev.monthly_salary AS change,
           CASE WHEN prev.monthly_salary > 0 THEN ROUND((c.monthly_salary - prev.monthly_salary) * 100.0 / prev.monthly_salary, 1) END AS "changePct",
           COALESCE(NULLIF(${NAME("ue")}, ''), 'A user without an employee record') AS "enteredBy"
      FROM employee_compensation c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id ${UNIT_JOIN}
      LEFT JOIN LATERAL (SELECT p.monthly_salary FROM employee_compensation p WHERE p.company_id = c.company_id AND p.employee_id = c.employee_id AND p.effective_from < c.effective_from ORDER BY p.effective_from DESC LIMIT 1) prev ON TRUE
      LEFT JOIN employees ue ON ue.user_account_id = c.created_by_user_account_id AND ue.company_id = c.company_id
     WHERE ${q.co("c")} AND ${q.emp()} AND ${q.area("e")} AND c.effective_from BETWEEN ${q.from} AND ${q.to}
     ORDER BY c.effective_from DESC, name`,
  kpis: ({ rows }) => {
    const changes = rows.filter((r) => r.change !== null);
    return [
      count("increase", "Total monthly change (PKR)", round2(changes.reduce((s, r) => s + num(r, "change"), 0)), "Revisions that replace an earlier salary"),
      percent("average", "Average change", changes.length ? round1(changes.reduce((s, r) => s + num(r, "changePct"), 0) / changes.length) : null),
      count("first", "First salary records", rows.length - changes.length),
    ];
  },
  calculation: [
    "One row per salary record whose effective date is in the range, for any employee including those who have left. The previous salary is the record before it for the same person; the first record for a person has nothing to compare with.",
    "Change is the new salary minus the previous one. Entered by is the person who recorded the salary.",
    MONEY_NOTE,
  ],
});

export const F13 = listReport({
  description: "Each employee's salary components in force today: allowances, deductions and employer items, with the amount, how it is calculated and whether it is taxable. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employee_compensation_components", "compensation_components", "employees"],
  tags: ["salary", "components", "allowances"],
  countLabel: "Component lines",
  columns: [
    ...IDENT,
    col("unit", "Organisation unit"),
    col("component", "Component"),
    col("kind", "Kind"),
    col("calculation", "Calculated as"),
    col("amount", "Monthly amount", "number"),
    col("entered", "Amount as entered", "number"),
    col("frequency", "Entered as"),
    col("percentage", "Percentage", "number"),
    col("taxable", "Taxable"),
    col("from", "Effective from", "date"),
    col("to", "Effective to", "date"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, cc.name AS component, ${LABEL("cc.component_type")} AS kind, ${LABEL("cc.calculation_type")} AS calculation,
           ROUND(${MONTHLY}, 2) AS amount, x.entered_amount AS entered, ${LABEL("x.pay_frequency")} AS frequency, x.percentage AS percentage,
           CASE WHEN cc.is_taxable THEN 'Yes' ELSE 'No' END AS taxable, x.effective_from::text AS "from", x.effective_to::text AS "to"
      FROM employee_compensation_components x JOIN compensation_components cc ON cc.id = x.component_id JOIN employees e ON e.id = x.employee_id AND e.company_id = x.company_id ${UNIT_JOIN}
     WHERE ${q.co("x")} AND ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND x.effective_from <= ${q.today} AND (x.effective_to IS NULL OR x.effective_to >= ${q.today})
     ORDER BY name, cc.sort_order, cc.name`,
  kpis: ({ rows }) => [count("people", "Employees with components", new Set(rows.map((r) => r.number)).size), count("monthly", "Total monthly amount (PKR)", round2(sum(rows, "amount")), "All kinds added together")],
  calculation: [
    "One row per component assigned to a current employee and in force today. Monthly amount divides yearly components by 12.",
    "Amounts of components calculated as a percentage or by formula are shown as recorded on the assignment; the exact figure for a month comes from the payslip. " + MONEY_NOTE,
  ],
});

export const F14 = sqlReport({
  description: "How salaries are spread across organisation units: people, lowest, median, average and highest monthly salary. Small groups are merged into Other only for users who see part of the company; HR admin sees every group.",
  filters: [DEPT, LOC, ETYPE],
  sensitivity: "sensitive",
  tables: ["employees", "employee_compensation", "org_units"],
  viz: ["bar", "kpi", "table"],
  tags: ["salary", "distribution", "spread"],
  columns: [col("label", "Organisation unit"), col("people", "People with a salary", "number"), col("lowest", "Lowest", "number"), col("median", "Median", "number"), col("average", "Average", "number"), col("highest", "Highest", "number"), col("total", "Total monthly salary", "number")],
  sql: (q) => `
    SELECT g.label, COUNT(*)::int AS people, MIN(g.salary) AS lowest, ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY g.salary))::numeric, 0) AS median, ROUND(AVG(g.salary), 0) AS average, MAX(g.salary) AS highest, SUM(g.salary) AS total
      FROM (SELECT CASE WHEN COUNT(*) OVER (PARTITION BY ${UNIT}) < ${q.minGroup} THEN '${OTHER}' ELSE ${UNIT} END AS label, ${SALARY_NOW(q)} AS salary
              FROM employees e ${UNIT_JOIN} WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}) g
     WHERE g.salary IS NOT NULL GROUP BY g.label ORDER BY total DESC, label`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Average monthly salary by organisation unit", unit: "PKR", rows, labelKey: "label", valueKey: "average" }) : null),
  kpis: ({ rows }) => [count("people", "People with a salary", sum(rows, "people")), count("total", "Total monthly salary (PKR)", round2(sum(rows, "total"))), count("groups", "Groups", rows.length)],
  calculation: ["Uses each current employee's salary in force today. Median is the middle salary of the group. Small groups are merged into Other only for users who see part of the company (a manager or a payroll-area limit); HR admin sees every group.", MONEY_NOTE],
});

export const F15 = sqlReport({
  description: "Salary increments month by month: how many people were revised, the average change and what the revisions add to the monthly salary bill. Totals only.",
  sensitivity: "sensitive",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["employee_compensation", "employees"],
  viz: ["line", "kpi", "table"],
  tags: ["salary", "increment", "trend"],
  columns: [col("month", "Month"), col("revisions", "Revisions", "number"), col("people", "People revised", "number"), col("increased", "Increases", "number"), col("decreased", "Decreases", "number"), col("averagePct", "Average change (%)", "percent"), col("added", "Added to monthly salary bill", "number")],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         r AS (SELECT c.effective_from, c.employee_id, c.monthly_salary - prev.monthly_salary AS change,
                      CASE WHEN prev.monthly_salary > 0 THEN (c.monthly_salary - prev.monthly_salary) * 100.0 / prev.monthly_salary END AS pct
                 FROM employee_compensation c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id
                 JOIN LATERAL (SELECT p.monthly_salary FROM employee_compensation p WHERE p.company_id = c.company_id AND p.employee_id = c.employee_id AND p.effective_from < c.effective_from ORDER BY p.effective_from DESC LIMIT 1) prev ON TRUE
                WHERE ${q.co("c")} AND ${q.emp()} AND ${q.area("e")} AND c.effective_from BETWEEN ${q.from} AND ${q.to})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(r.employee_id)::int AS revisions, COUNT(DISTINCT r.employee_id)::int AS people, COUNT(*) FILTER (WHERE r.change > 0)::int AS increased,
           COUNT(*) FILTER (WHERE r.change < 0)::int AS decreased, ROUND(AVG(r.pct), 1) AS "averagePct", COALESCE(SUM(r.change), 0) AS added
      FROM mo LEFT JOIN r ON r.effective_from >= mo.ms AND r.effective_from < mo.ms + interval '1 month' GROUP BY mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => lineChart({ title: "Salary revisions by month", unit: "revisions", rows, xKey: "month", series: [{ key: "revisions", label: "Revisions" }] }),
  kpis: ({ rows }) => [count("revisions", "Revisions", sum(rows, "revisions")), count("added", "Added to monthly salary bill (PKR)", round2(sum(rows, "added"))), count("people", "Person-months revised", sum(rows, "people"))],
  calculation: ["Counts salary records that replace an earlier record, by the month they take effect. A person's first salary record is not a revision.", "Added to monthly salary bill is the sum of new minus previous salary for the month. " + MONEY_NOTE],
});

// ================================================================ income tax

const FISCAL_MONTHS: Array<[string, string, number]> = [
  ["jul", "Jul", 7], ["aug", "Aug", 8], ["sep", "Sep", 9], ["oct", "Oct", 10], ["nov", "Nov", 11], ["dec", "Dec", 12],
  ["jan", "Jan", 1], ["feb", "Feb", 2], ["mar", "Mar", 3], ["apr", "Apr", 4], ["may", "May", 5], ["jun", "Jun", 6],
];
const monthColumns = (): ReportColumn[] => FISCAL_MONTHS.map(([k, label]) => col(k, label, "number"));
const monthSums = (expr: string): string => FISCAL_MONTHS.map(([k, , m]) => `COALESCE(SUM(${expr}) FILTER (WHERE EXTRACT(month FROM pr.period_end) = ${m}), 0) AS ${k}`).join(", ");

export const F16 = listReport({
  description: "Income tax withheld from each employee in each month, laid out July to June, with the total. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs", "employees"],
  tags: ["tax", "month-wise", "withholding"],
  countLabel: "Employees",
  columns: [...IDENT, col("unit", "Organisation unit"), ...monthColumns(), col("total", "Total tax", "number"), col("months", "Months with tax", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, ${monthSums("ps.income_tax_monthly")},
           COALESCE(SUM(ps.income_tax_monthly), 0) AS total, COUNT(DISTINCT date_trunc('month', pr.period_end)) FILTER (WHERE ps.income_tax_monthly > 0)::int AS months
      FROM ${SLIPS} ${UNIT_JOIN} WHERE ${SLIP_WHERE(q)} GROUP BY e.id, e.employee_number, e.first_name, e.last_name, ou.name ORDER BY name, number`,
  kpis: ({ rows }) => [count("tax", "Total tax withheld (PKR)", round2(sum(rows, "total"))), count("taxed", "Employees with tax withheld", rows.filter((r) => num(r, "total") > 0).length)],
  calculation: [
    "Adds the income tax on each finalised payslip (regular and off-cycle runs) to the calendar month in which the pay period ends, for runs ending in the range. The columns run July to June, the Pakistan tax year.",
    RECORDED_NOTE,
    MONEY_NOTE,
  ],
  notes: ({ ctx }) => {
    const r = ctx.range;
    return r && (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 > 366 ? ["The range is longer than 12 months, so the same calendar month in different years is added together. Choose a range inside one tax year (1 July to 30 June) for a clean month-by-month view."] : [];
  },
});

export const F17 = listReport({
  description: "A tax summary for each employee over the chosen period: gross pay, taxable pay, tax withheld, EOBI, net pay and the tax profile on file. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs", "employees", "employee_tax_profiles"],
  tags: ["tax", "annual", "statement"],
  countLabel: "Employees",
  columns: [
    ...IDENT,
    col("filer", "Filer status"),
    col("residency", "Tax residency"),
    col("months", "Months paid", "number"),
    col("gross", "Gross pay", "number"),
    col("taxable", "Taxable pay", "number"),
    col("tax", "Tax withheld", "number"),
    col("rate", "Tax on taxable pay (%)", "percent"),
    col("eobi", "EOBI (employee)", "number"),
    col("net", "Net pay", "number"),
    col("previousIncome", "Previous employer income", "number"),
    col("previousTax", "Previous employer tax", "number"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("tx.filer_status")} AS filer, ${LABEL("tx.tax_residency")} AS residency,
           COUNT(DISTINCT date_trunc('month', pr.period_end))::int AS months, SUM(ps.gross_pay) AS gross, SUM(ps.taxable_gross_this_period) AS taxable, SUM(ps.income_tax_monthly) AS tax,
           CASE WHEN SUM(ps.taxable_gross_this_period) > 0 THEN ROUND(SUM(ps.income_tax_monthly) * 100.0 / SUM(ps.taxable_gross_this_period), 1) END AS rate,
           SUM(ps.eobi_employee_contribution) AS eobi, SUM(ps.net_pay) AS net, tx.previous_employer_income AS "previousIncome", tx.previous_employer_tax AS "previousTax"
      FROM ${SLIPS}
      LEFT JOIN LATERAL (SELECT t.* FROM employee_tax_profiles t WHERE t.company_id = e.company_id AND t.employee_id = e.id AND t.effective_from <= ${q.today} AND (t.effective_to IS NULL OR t.effective_to >= ${q.today}) ORDER BY t.effective_from DESC LIMIT 1) tx ON TRUE
     WHERE ${SLIP_WHERE(q)}
     GROUP BY e.id, e.employee_number, e.first_name, e.last_name, tx.filer_status, tx.tax_residency, tx.previous_employer_income, tx.previous_employer_tax ORDER BY name, number`,
  kpis: ({ rows }) => [count("tax", "Total tax withheld (PKR)", round2(sum(rows, "tax"))), count("taxable", "Total taxable pay (PKR)", round2(sum(rows, "taxable"))), count("nonFiler", "Not filers", rows.filter((r) => r.filer === "Non Filer").length)],
  calculation: [
    "Adds the finalised payslips (regular and off-cycle) of each person for runs ending in the range. Taxable pay is the taxable gross recorded on each payslip. Tax on taxable pay is tax withheld divided by taxable pay.",
    "Filer status, residency and previous employer figures come from the tax profile in force today; they are not tied to the months in the range.",
    RECORDED_NOTE,
    MONEY_NOTE,
  ],
});

export const F18 = sqlReport({
  description: "Income tax withheld by month across the company: people paid, people taxed, taxable pay, tax withheld and the share of taxable pay withheld. Totals only.",
  sensitivity: "sensitive",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs"],
  viz: ["line", "kpi", "table"],
  tags: ["tax", "month-wise", "trend"],
  columns: [col("month", "Month"), col("paid", "People paid", "number"), col("taxed", "People with tax withheld", "number"), col("taxable", "Taxable pay", "number"), col("tax", "Tax withheld", "number"), col("rate", "Tax on taxable pay (%)", "percent"), col("average", "Average tax per taxed person", "number")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', pr.period_end), 'YYYY-MM') AS month, COUNT(DISTINCT ps.employee_id)::int AS paid, COUNT(DISTINCT ps.employee_id) FILTER (WHERE ps.income_tax_monthly > 0)::int AS taxed,
           SUM(ps.taxable_gross_this_period) AS taxable, SUM(ps.income_tax_monthly) AS tax,
           CASE WHEN SUM(ps.taxable_gross_this_period) > 0 THEN ROUND(SUM(ps.income_tax_monthly) * 100.0 / SUM(ps.taxable_gross_this_period), 1) END AS rate,
           ROUND(SUM(ps.income_tax_monthly) / NULLIF(COUNT(DISTINCT ps.employee_id) FILTER (WHERE ps.income_tax_monthly > 0), 0), 0) AS average
      FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} GROUP BY 1 ORDER BY 1`,
  chart: ({ rows }) => (rows.length ? lineChart({ title: "Income tax withheld by month", unit: "PKR", rows, xKey: "month", series: [{ key: "tax", label: "Tax withheld" }] }) : null),
  kpis: ({ rows }) => [count("tax", "Total tax withheld (PKR)", round2(sum(rows, "tax"))), count("months", "Months", rows.length), count("taxable", "Taxable pay (PKR)", round2(sum(rows, "taxable")))],
  calculation: ["Adds the finalised payslips whose pay period ends in each month (regular and off-cycle). People paid counts each person once per month.", RECORDED_NOTE, MONEY_NOTE],
});

export const F19 = listReport({
  description: "The tax profile on file for each current employee: filer status, residency, provincial scheme, exemptions and credits claimed, and previous employer figures. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employee_tax_profiles", "tax_profiles", "employees"],
  tags: ["tax", "profile", "exemptions"],
  countLabel: "Employees listed",
  columns: [
    ...IDENT,
    col("unit", "Organisation unit"),
    col("profile", "Tax profile"),
    col("filer", "Filer status"),
    col("residency", "Tax residency"),
    col("scheme", "Provincial scheme"),
    col("exemptions", "Exemptions claimed", "number"),
    col("credits", "Credits claimed", "number"),
    col("previousIncome", "Previous employer income", "number"),
    col("previousTax", "Previous employer tax", "number"),
    col("from", "Effective from", "date"),
    col("state", "State"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, tp.name AS profile, ${LABEL("tx.filer_status")} AS filer, ${LABEL("tx.tax_residency")} AS residency, ${LABEL("tx.provincial_scheme")} AS scheme,
           CASE WHEN jsonb_typeof(tx.claimed_exemptions) = 'array' THEN jsonb_array_length(tx.claimed_exemptions) WHEN jsonb_typeof(tx.claimed_exemptions) = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(tx.claimed_exemptions))::int ELSE 0 END AS exemptions,
           CASE WHEN jsonb_typeof(tx.claimed_credits) = 'array' THEN jsonb_array_length(tx.claimed_credits) WHEN jsonb_typeof(tx.claimed_credits) = 'object' THEN (SELECT COUNT(*) FROM jsonb_object_keys(tx.claimed_credits))::int ELSE 0 END AS credits,
           tx.previous_employer_income AS "previousIncome", tx.previous_employer_tax AS "previousTax", tx.effective_from::text AS "from",
           CASE WHEN tx.id IS NULL THEN 'No tax profile' WHEN tx.filer_status = 'non_filer' THEN 'Non-filer' ELSE 'On file' END AS state
      FROM employees e ${UNIT_JOIN}
      LEFT JOIN LATERAL (SELECT t.* FROM employee_tax_profiles t WHERE t.company_id = e.company_id AND t.employee_id = e.id AND t.effective_from <= ${q.today} AND (t.effective_to IS NULL OR t.effective_to >= ${q.today}) ORDER BY t.effective_from DESC LIMIT 1) tx ON TRUE
      LEFT JOIN tax_profiles tp ON tp.id = tx.tax_profile_id
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
     ORDER BY (tx.id IS NULL) DESC, name, number`,
  kpis: ({ rows }) => [count("none", "No tax profile", rows.filter((r) => r.state === "No tax profile").length), count("nonFiler", "Non-filers", rows.filter((r) => r.state === "Non-filer").length), count("withPrevious", "With previous employer income", rows.filter((r) => num(r, "previousIncome") > 0).length)],
  calculation: ["One row per current employee with the tax profile in force today. The number of exemptions and credits is how many items are claimed, not their value.", "Employees with no tax profile are listed first: payroll cannot withhold tax for them correctly. " + MONEY_NOTE],
});

// ================================================================ EOBI, social security, benefits

export const F20 = listReport({
  description: "EOBI and provincial social security contributions per employee for the period: what the employee paid, what the employer paid, and how many months. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs", "employees", "employee_tax_profiles"],
  tags: ["eobi", "social security", "contributions"],
  countLabel: "Employees",
  columns: [
    ...IDENT,
    col("unit", "Organisation unit"),
    col("scheme", "Provincial scheme"),
    col("months", "Months", "number"),
    col("eobiEmployee", "EOBI (employee)", "number"),
    col("eobiEmployer", "EOBI (employer)", "number"),
    col("social", "Social security (employer)", "number"),
    col("total", "Total contributions", "number"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${UNIT} AS unit, ${LABEL("tx.provincial_scheme")} AS scheme, COUNT(DISTINCT date_trunc('month', pr.period_end))::int AS months,
           SUM(ps.eobi_employee_contribution) AS "eobiEmployee", SUM(ps.eobi_employer_contribution) AS "eobiEmployer", SUM(ps.social_security_employer_contribution) AS social,
           SUM(ps.eobi_employee_contribution + ps.eobi_employer_contribution + ps.social_security_employer_contribution) AS total
      FROM ${SLIPS} ${UNIT_JOIN}
      LEFT JOIN LATERAL (SELECT t.provincial_scheme FROM employee_tax_profiles t WHERE t.company_id = e.company_id AND t.employee_id = e.id AND t.effective_from <= ${q.today} AND (t.effective_to IS NULL OR t.effective_to >= ${q.today}) ORDER BY t.effective_from DESC LIMIT 1) tx ON TRUE
     WHERE ${SLIP_WHERE(q)} GROUP BY e.id, e.employee_number, e.first_name, e.last_name, ou.name, tx.provincial_scheme ORDER BY name, number`,
  kpis: ({ rows }) => [
    count("eobiEmployee", "EOBI paid by employees (PKR)", round2(sum(rows, "eobiEmployee"))),
    count("eobiEmployer", "EOBI paid by employer (PKR)", round2(sum(rows, "eobiEmployer"))),
    count("social", "Social security by employer (PKR)", round2(sum(rows, "social"))),
  ],
  calculation: ["Adds the contributions recorded on finalised payslips for runs ending in the range. The provincial scheme shown is the one on the tax profile today.", "CNIC and EOBI registration numbers are stored encrypted and are not shown. " + MONEY_NOTE],
});

export const F21 = sqlReport({
  description: "EOBI and social security contributions by month across the company: people covered, employee and employer shares and the total. Totals only.",
  sensitivity: "sensitive",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs"],
  viz: ["line", "kpi", "table"],
  tags: ["eobi", "social security", "month-wise"],
  columns: [col("month", "Month"), col("people", "People paid", "number"), col("covered", "People with a contribution", "number"), col("eobiEmployee", "EOBI (employee)", "number"), col("eobiEmployer", "EOBI (employer)", "number"), col("social", "Social security (employer)", "number"), col("total", "Total", "number")],
  sql: (q) => `
    SELECT to_char(date_trunc('month', pr.period_end), 'YYYY-MM') AS month, COUNT(DISTINCT ps.employee_id)::int AS people,
           COUNT(DISTINCT ps.employee_id) FILTER (WHERE ps.eobi_employee_contribution + ps.eobi_employer_contribution + ps.social_security_employer_contribution > 0)::int AS covered,
           SUM(ps.eobi_employee_contribution) AS "eobiEmployee", SUM(ps.eobi_employer_contribution) AS "eobiEmployer", SUM(ps.social_security_employer_contribution) AS social,
           SUM(ps.eobi_employee_contribution + ps.eobi_employer_contribution + ps.social_security_employer_contribution) AS total
      FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} GROUP BY 1 ORDER BY 1`,
  chart: ({ rows }) => (rows.length ? lineChart({ title: "EOBI and social security by month", unit: "PKR", rows, xKey: "month", series: [{ key: "eobiEmployee", label: "EOBI (employee)" }, { key: "eobiEmployer", label: "EOBI (employer)" }, { key: "social", label: "Social security (employer)" }] }) : null),
  kpis: ({ rows }) => [count("total", "Total contributions (PKR)", round2(sum(rows, "total"))), count("months", "Months", rows.length)],
  calculation: ["Adds the finalised payslips whose pay period ends in each month. Use this with the per-employee report (F20) to reconcile a challan.", MONEY_NOTE],
});

export const F22 = sqlReport({
  description: "Contributions to each benefit plan (for example provident fund): enrolled people, employee and employer amounts and reversals. Totals only.",
  sensitivity: "sensitive",
  defaultRange: "last12Months",
  tables: ["benefit_contributions", "benefit_plans", "benefit_enrolments", "payroll_runs"],
  viz: ["bar", "kpi", "table"],
  tags: ["benefits", "provident fund", "contributions"],
  columns: [col("plan", "Plan"), col("type", "Type"), col("enrolled", "Active enrolments", "number"), col("contributors", "People contributing", "number"), col("employee", "Employee contributions", "number"), col("employer", "Employer contributions", "number"), col("total", "Total", "number"), col("reversed", "Reversed", "number")],
  sql: (q) => `
    SELECT bp.name AS plan, ${LABEL("bp.benefit_type")} AS type,
           (SELECT COUNT(*)::int FROM benefit_enrolments be WHERE be.plan_id = bp.id AND be.company_id = bp.company_id AND be.status = 'active') AS enrolled,
           COUNT(DISTINCT bc.employee_id) FILTER (WHERE bc.status = 'accrued')::int AS contributors,
           COALESCE(SUM(bc.employee_amount) FILTER (WHERE bc.status = 'accrued'), 0) AS employee, COALESCE(SUM(bc.employer_amount) FILTER (WHERE bc.status = 'accrued'), 0) AS employer,
           COALESCE(SUM(bc.employee_amount + bc.employer_amount) FILTER (WHERE bc.status = 'accrued'), 0) AS total, COALESCE(SUM(bc.employee_amount + bc.employer_amount) FILTER (WHERE bc.status = 'reversed'), 0) AS reversed
      FROM benefit_plans bp
      LEFT JOIN benefit_contributions bc ON bc.plan_id = bp.id AND bc.company_id = bp.company_id AND bc.period_end BETWEEN ${q.from} AND ${q.to}
      LEFT JOIN payroll_runs pr ON pr.id = bc.payroll_run_id
     WHERE ${q.co("bp")} AND (bc.id IS NULL OR (${q.co("pr")} AND ${q.area("pr")}))
     GROUP BY bp.id, bp.name, bp.benefit_type, bp.company_id ORDER BY total DESC, plan`,
  chart: ({ rows }) => (rows.some((r) => num(r, "total") > 0) ? barChart({ title: "Contributions by plan", unit: "PKR", rows, labelKey: "plan", valueKey: "total" }) : null),
  kpis: ({ rows }) => [count("total", "Total contributions (PKR)", round2(sum(rows, "total"))), count("plans", "Plans", rows.length), count("enrolled", "Active enrolments", sum(rows, "enrolled"))],
  calculation: ["Adds the contributions accrued on payroll runs in the range for each plan. Reversed contributions are shown separately and are not in the totals.", MONEY_NOTE],
});

// ================================================================ bank payments

export const BATCH_WHERE = (q: Q) => `${q.co("b")} AND ${q.co("pr")} AND ${q.area("pr")} AND pr.is_simulation = false AND pr.period_end BETWEEN ${q.from} AND ${q.to}`;

export const F23 = listReport({
  description: "The payment advice for each salary payment: batch, employee, bank, account title, last four digits, amount and status. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last90Days",
  tables: ["payroll_payment_items", "payroll_payment_batches", "payroll_runs", "employees"],
  tags: ["bank", "payment advice", "salary transfer"],
  countLabel: "Payments",
  columns: [
    col("batch", "Batch"),
    col("period", "Pay period"),
    ...IDENT,
    col("method", "Method"),
    col("bank", "Bank"),
    col("title", "Account title"),
    col("last4", "Account ending"),
    col("amount", "Amount", "number"),
    col("status", "Payment status"),
    col("batchStatus", "Batch status"),
    col("reference", "Bank reference"),
    col("acknowledged", "Acknowledged", "date"),
  ],
  sql: (q) => `
    SELECT b.batch_reference AS batch, ${PERIOD_TEXT} AS period, e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("i.payment_method")} AS method, i.bank_name AS bank, i.account_title AS title,
           i.account_last4 AS last4, i.amount AS amount, ${LABEL("i.status")} AS status, ${LABEL("b.status")} AS "batchStatus", i.bank_reference AS reference, i.acknowledged_at::date::text AS acknowledged
      FROM payroll_payment_items i JOIN payroll_payment_batches b ON b.id = i.batch_id JOIN payroll_runs pr ON pr.id = b.payroll_run_id JOIN employees e ON e.id = i.employee_id AND e.company_id = i.company_id
     WHERE ${BATCH_WHERE(q)} AND ${q.co("i")} AND ${q.emp()}
     ORDER BY pr.period_end DESC, b.batch_reference, name`,
  kpis: ({ rows }) => [count("amount", "Total amount (PKR)", round2(sum(rows, "amount"))), count("rejected", "Rejected", rows.filter((r) => r.status === "Rejected").length), count("people", "People paid", new Set(rows.map((r) => r.number)).size)],
  calculation: ["One row per payment item in payment batches for runs ending in the range. Only the last four digits of the account are shown; full account numbers and IBANs are stored encrypted and are never reported.", "Bank rejection text is not shown. " + MONEY_NOTE],
});

export const F24 = sqlReport({
  description: "Payment batches for each payroll run: how many payments, the total, who generated, approved and released it, and whether the bank acknowledged it. No per-person data.",
  sensitivity: "sensitive",
  defaultRange: "last90Days",
  tables: ["payroll_payment_batches", "payroll_payment_items", "payroll_runs", "bank_file_formats"],
  viz: ["bar", "kpi", "table"],
  tags: ["bank", "batches", "payment"],
  columns: [
    col("batch", "Batch"),
    col("period", "Pay period"),
    col("format", "Bank file format"),
    col("status", "Status"),
    col("payments", "Payments", "number"),
    col("excluded", "Excluded", "number"),
    col("rejected", "Payments rejected", "number"),
    col("total", "Total net pay", "number"),
    col("generated", "Generated", "date"),
    col("approved", "Approved", "date"),
    col("released", "Released", "date"),
    col("acknowledged", "Acknowledged", "date"),
  ],
  sql: (q) => `
    SELECT b.batch_reference AS batch, ${PERIOD_TEXT} AS period, COALESCE(f.name, 'Default') AS format, ${LABEL("b.status")} AS status, b.row_count AS payments, b.excluded_count AS excluded,
           (SELECT COUNT(*)::int FROM payroll_payment_items i WHERE i.batch_id = b.id AND i.status = 'rejected') AS rejected, b.total_net_pay AS total,
           b.generated_at::date::text AS generated, b.approved_at::date::text AS approved, b.released_at::date::text AS released, b.acknowledged_at::date::text AS acknowledged
      FROM payroll_payment_batches b JOIN payroll_runs pr ON pr.id = b.payroll_run_id LEFT JOIN bank_file_formats f ON f.id = b.format_id
     WHERE ${BATCH_WHERE(q)} ORDER BY pr.period_end DESC, b.generated_at DESC`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Total net pay by batch", unit: "PKR", rows, labelKey: "batch", valueKey: "total" }) : null),
  kpis: ({ rows }) => [count("batches", "Batches", rows.length), count("total", "Total net pay in batches (PKR)", round2(sum(rows, "total"))), count("rejected", "Payments rejected", sum(rows, "rejected"))],
  calculation: ["One row per payment batch for runs ending in the range, voided batches included so a reissue can be traced. Total net pay is the batch total at the time it was generated.", MONEY_NOTE],
});

export const F25 = listReport({
  description: "Payments that need attention: rejected, retried or reissued payments, and finalised payslips with net pay but no payment generated. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last90Days",
  tables: ["payroll_payment_items", "payroll_payment_batches", "payslips", "payroll_runs", "employees"],
  tags: ["bank", "exceptions", "payment"],
  countLabel: "Exceptions",
  columns: [col("issue", "Issue"), col("period", "Pay period"), ...IDENT, col("batch", "Batch"), col("bank", "Bank"), col("amount", "Amount", "number"), col("status", "Status"), col("retries", "Retries", "number")],
  sql: (q) => `
    SELECT t.issue, t.period, t.number, t.name, t.batch, t.bank, t.amount, t.status, t.retries FROM (
      SELECT CASE WHEN i.status = 'rejected' THEN 'Payment rejected' WHEN i.status = 'reissued' THEN 'Payment reissued' ELSE 'Payment retried' END AS issue, ${PERIOD_TEXT} AS period, pr.period_end AS ord,
             e.employee_number AS number, ${NAME("e")} AS name, b.batch_reference AS batch, i.bank_name AS bank, i.amount AS amount, ${LABEL("i.status")} AS status, i.retry_count AS retries
        FROM payroll_payment_items i JOIN payroll_payment_batches b ON b.id = i.batch_id JOIN payroll_runs pr ON pr.id = b.payroll_run_id JOIN employees e ON e.id = i.employee_id AND e.company_id = i.company_id
       WHERE ${BATCH_WHERE(q)} AND ${q.co("i")} AND ${q.emp()} AND (i.status IN ('rejected', 'reissued') OR i.retry_count > 0)
      UNION ALL
      SELECT 'No payment generated', ${PERIOD_TEXT}, pr.period_end, e.employee_number, ${NAME("e")}, NULL, NULL, ps.net_pay, 'Not paid by a batch', 0
        FROM ${SLIPS}
       WHERE ${SLIP_WHERE(q)} AND ps.net_pay > 0 AND pr.status IN ('payment_released', 'reconciled', 'closed')
         AND NOT EXISTS (SELECT 1 FROM payroll_payment_items i WHERE i.payslip_id = ps.id AND i.status <> 'voided')
    ) t ORDER BY t.ord DESC, t.issue, t.name`,
  kpis: ({ rows }) => [
    count("rejected", "Rejected", rows.filter((r) => r.issue === "Payment rejected").length),
    count("missing", "No payment generated", rows.filter((r) => r.issue === "No payment generated").length),
    count("amount", "Amount affected (PKR)", round2(sum(rows, "amount"))),
  ],
  calculation: [
    "Lists payment items that were rejected or reissued, or needed a retry, in batches for runs ending in the range. Also lists payslips with net pay above zero on runs already released for payment that no active payment item covers.",
    "Bank rejection text is not shown. " + MONEY_NOTE,
  ],
});

// ================================================================ loans and settlements

export const LOAN_WHERE = (q: Q) => `${q.co("l")} AND ${q.emp()} AND ${q.area("e")}`;
export const LOAN_JOIN = "JOIN employees e ON e.id = l.employee_id AND e.company_id = l.company_id LEFT JOIN loan_types lt ON lt.id = l.loan_type_id";
export const LOAN_KIND = "COALESCE(lt.name, " + LABEL("l.loan_type") + ")";

export const F26 = listReport({
  description: "Every loan and salary advance: borrower, type, principal, instalment, amount recovered, outstanding balance, status and next instalment. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employee_loans", "loan_types", "loan_schedules", "employees"],
  tags: ["loans", "advances", "recovery"],
  countLabel: "Loans",
  columns: [
    ...IDENT,
    col("kind", "Loan type"),
    col("status", "Status"),
    col("approval", "Approval"),
    col("issued", "Issued", "date"),
    col("principal", "Principal", "number"),
    col("installment", "Instalment", "number"),
    col("count", "Instalments planned", "number"),
    col("paid", "Instalments paid", "number"),
    col("recovered", "Recovered", "number"),
    col("outstanding", "Outstanding", "number"),
    col("overdue", "Overdue instalments", "number"),
    col("next", "Next instalment due", "date"),
    col("guarantor", "Guarantor"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LOAN_KIND} AS kind, ${LABEL("l.status")} AS status, ${LABEL("l.approval_status")} AS approval, l.issued_date::text AS issued,
           l.principal_amount AS principal, l.installment_amount AS installment, l.installments_count AS count,
           (SELECT COUNT(*)::int FROM loan_schedules s WHERE s.loan_id = l.id AND s.status IN ('paid', 'settled')) AS paid,
           l.principal_amount - l.outstanding_balance AS recovered, l.outstanding_balance AS outstanding,
           (SELECT COUNT(*)::int FROM loan_schedules s WHERE s.loan_id = l.id AND s.status = 'scheduled' AND s.due_date < ${q.today}) AS overdue,
           (SELECT MIN(s.due_date)::text FROM loan_schedules s WHERE s.loan_id = l.id AND s.status IN ('scheduled', 'held') AND s.due_date >= ${q.today}) AS next,
           COALESCE(NULLIF(${NAME("g")}, ''), '') AS guarantor
      FROM employee_loans l ${LOAN_JOIN} LEFT JOIN employees g ON g.id = l.guarantor_employee_id AND g.company_id = l.company_id
     WHERE ${LOAN_WHERE(q)} ORDER BY (l.status = 'active') DESC, name, l.issued_date DESC`,
  kpis: ({ rows }) => [
    count("active", "Active loans", rows.filter((r) => r.status === "Active").length),
    count("outstanding", "Outstanding balance (PKR)", round2(sum(rows.filter((r) => r.status === "Active" || r.status === "On Hold"), "outstanding"))),
    count("overdue", "Overdue instalments", sum(rows, "overdue")),
  ],
  calculation: [
    "One row per loan or salary advance of the chosen people, in every status. Recovered is principal minus the outstanding balance. Overdue counts scheduled instalments whose due date has passed.",
    "Outstanding balance in the tile covers active and on-hold loans only. " + MONEY_NOTE,
  ],
});

export const F27 = listReport({
  description: "Loan instalments due in the period: borrower, instalment number, amount due, whether it was recovered and when. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last90Days",
  tables: ["loan_schedules", "employee_loans", "employees"],
  tags: ["loans", "instalments", "recovery"],
  countLabel: "Instalments",
  columns: [
    col("due", "Due", "date"),
    ...IDENT,
    col("kind", "Loan type"),
    col("installment", "Instalment no.", "number"),
    col("amount", "Amount due", "number"),
    col("status", "Status"),
    col("paidAmount", "Recovered", "number"),
    col("balance", "Not recovered", "number"),
    col("paidOn", "Recovered on", "date"),
  ],
  sql: (q) => `
    SELECT s.due_date::text AS due, e.employee_number AS number, ${NAME("e")} AS name, ${LOAN_KIND} AS kind, s.installment_no AS installment, s.amount AS amount, ${LABEL("s.status")} AS status,
           s.paid_amount AS "paidAmount", GREATEST(s.amount - COALESCE(s.paid_amount, 0), 0) AS balance, s.paid_at::date::text AS "paidOn"
      FROM loan_schedules s JOIN employee_loans l ON l.id = s.loan_id ${LOAN_JOIN}
     WHERE ${q.co("s")} AND ${LOAN_WHERE(q)} AND s.due_date BETWEEN ${q.from} AND ${q.to}
     ORDER BY s.due_date DESC, name, s.installment_no`,
  kpis: ({ rows }) => [
    count("due", "Due in the period (PKR)", round2(sum(rows, "amount"))),
    count("recovered", "Recovered (PKR)", round2(sum(rows, "paidAmount"))),
    count("late", "Past due and not recovered", rows.filter((r) => r.status === "Scheduled" && num(r, "balance") > 0).length),
  ],
  calculation: ["One row per scheduled instalment with a due date in the range. Not recovered is the amount due minus what was recovered. Held, skipped and cancelled instalments are shown with their status.", MONEY_NOTE],
});

export const F28 = sqlReport({
  description: "Loans and advances in total by type: borrowers, principal, recovered, outstanding and overdue. Small groups are merged into Other only for users who see part of the company (a manager or a payroll-area limit); HR admin sees every group.",
  sensitivity: "sensitive",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employee_loans", "loan_types", "loan_schedules", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["loans", "outstanding", "exposure"],
  columns: [col("label", "Loan type"), col("loans", "Active loans", "number"), col("borrowers", "Borrowers", "number"), col("principal", "Principal", "number"), col("recovered", "Recovered", "number"), col("outstanding", "Outstanding", "number"), col("recoveredPct", "Recovered (%)", "percent"), col("overdue", "Overdue instalments", "number")],
  sql: (q) => `
    SELECT CASE WHEN g.borrowers < ${q.minGroup} THEN '${OTHER}' ELSE g.kind END AS label, SUM(g.loans)::int AS loans, SUM(g.borrowers)::int AS borrowers, SUM(g.principal) AS principal, SUM(g.recovered) AS recovered, SUM(g.outstanding) AS outstanding,
           CASE WHEN SUM(g.principal) > 0 THEN ROUND(SUM(g.recovered) * 100.0 / SUM(g.principal), 1) END AS "recoveredPct", SUM(g.overdue)::int AS overdue
      FROM (SELECT ${LOAN_KIND} AS kind, COUNT(*) AS loans, COUNT(DISTINCT l.employee_id) AS borrowers, SUM(l.principal_amount) AS principal, SUM(l.principal_amount - l.outstanding_balance) AS recovered, SUM(l.outstanding_balance) AS outstanding,
                   SUM((SELECT COUNT(*) FROM loan_schedules s WHERE s.loan_id = l.id AND s.status = 'scheduled' AND s.due_date < ${q.today})) AS overdue
              FROM employee_loans l ${LOAN_JOIN} WHERE ${LOAN_WHERE(q)} AND l.status IN ('active', 'on_hold') GROUP BY ${LOAN_KIND}) g
     GROUP BY 1 ORDER BY outstanding DESC NULLS LAST, label`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Outstanding balance by loan type", unit: "PKR", rows, labelKey: "label", valueKey: "outstanding" }) : null),
  kpis: ({ rows }) => [count("loans", "Active loans", sum(rows, "loans")), count("outstanding", "Outstanding (PKR)", round2(sum(rows, "outstanding"))), count("overdue", "Overdue instalments", sum(rows, "overdue"))],
  calculation: ["Covers active and on-hold loans. Recovered is principal minus the outstanding balance. Small groups are merged into Other only for users who see part of the company (a manager or a payroll-area limit); HR admin sees every group.", MONEY_NOTE],
});

export const F29 = listReport({
  description: "Final settlements: each leaver's salary due, leave encashment, gratuity, provident fund, recoveries and tax, with the net settlement and its status. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payroll_final_settlements", "payroll_final_settlement_lines", "employees"],
  tags: ["final settlement", "leavers", "gratuity"],
  countLabel: "Settlements",
  columns: [
    col("lastDay", "Last working day", "date"),
    ...IDENT,
    col("status", "Status"),
    col("salaryDue", "Salary due", "number"),
    col("leave", "Leave encashment", "number"),
    col("gratuity", "Gratuity", "number"),
    col("pf", "Provident fund", "number"),
    col("notice", "Notice recovery", "number"),
    col("loans", "Loans recovered", "number"),
    col("tax", "Tax finalisation", "number"),
    col("other", "Other deductions", "number"),
    col("net", "Net settlement", "number"),
    col("finalised", "Finalised", "date"),
  ],
  sql: (q) => `
    SELECT st.last_working_day::text AS "lastDay", e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("st.status")} AS status,
           COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'salary_due'), 0) AS "salaryDue", COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'leave_encashment'), 0) AS leave,
           COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'gratuity'), 0) AS gratuity, COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'provident_fund'), 0) AS pf,
           COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'notice_recovery'), 0) AS notice, COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'loan_outstanding'), 0) AS loans,
           COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'tax_finalization'), 0) AS tax, COALESCE(SUM(ln.amount) FILTER (WHERE ln.kind = 'other_deductions'), 0) AS other,
           COALESCE(SUM(ln.amount), 0) AS net, st.finalized_at::date::text AS finalised
      FROM payroll_final_settlements st JOIN employees e ON e.id = st.employee_id AND e.company_id = st.company_id
      LEFT JOIN payroll_final_settlement_lines ln ON ln.settlement_id = st.id AND ln.settle_via <> 'info'
     WHERE ${q.co("st")} AND ${q.emp()} AND ${q.area("e")} AND st.last_working_day BETWEEN ${q.from} AND ${q.to} AND st.status <> 'cancelled'
     GROUP BY st.id, e.id, e.employee_number, e.first_name, e.last_name ORDER BY st.last_working_day DESC, name`,
  kpis: ({ rows }) => [count("net", "Net settlements (PKR)", round2(sum(rows, "net"))), count("open", "Not yet finalised", rows.filter((r) => r.status !== "Finalized").length), count("gratuity", "Gratuity (PKR)", round2(sum(rows, "gratuity")))],
  calculation: ["One row per settlement whose last working day is in the range, with the lines added up by kind. Recoveries are negative, as in the settlement. Net settlement is every payable line added together; information-only lines are left out.", "Cancelled settlements are not listed. " + MONEY_NOTE],
});

export const F30 = listReport({
  description: "Payslips that carry arrears or retro pay, and every off-cycle payment (bonus, arrears, final settlement, other), with the amounts. Restricted.",
  sensitivity: "restricted",
  filters: [DEPT, LOC, ETYPE],
  defaultRange: "last12Months",
  tables: ["payslips", "payroll_runs", "employees"],
  tags: ["arrears", "bonus", "off-cycle"],
  countLabel: "Payslips",
  columns: [col("period", "Pay period"), col("runType", "Run type"), col("reason", "Reason"), ...IDENT, col("arrears", "Arrears and retro", "number"), col("gross", "Gross pay", "number"), col("tax", "Income tax", "number"), col("net", "Net pay", "number")],
  sql: (q) => `
    SELECT ${PERIOD_TEXT} AS period, ${LABEL("pr.run_type")} AS "runType", COALESCE(${LABEL("pr.off_cycle_reason")}, CASE WHEN COALESCE(ps.arrears_amount, 0) <> 0 THEN 'Arrears or retro in a regular run' END) AS reason,
           e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ps.arrears_amount, 0) AS arrears, ps.gross_pay AS gross, ps.income_tax_monthly AS tax, ps.net_pay AS net
      FROM ${SLIPS} WHERE ${SLIP_WHERE(q)} AND (pr.run_type = 'off_cycle' OR COALESCE(ps.arrears_amount, 0) <> 0)
     ORDER BY pr.period_end DESC, pr.created_at DESC, name`,
  kpis: ({ rows }) => [count("arrears", "Arrears and retro (PKR)", round2(sum(rows, "arrears"))), count("gross", "Gross pay in these payslips (PKR)", round2(sum(rows, "gross"))), count("people", "People", new Set(rows.map((r) => r.number)).size)],
  calculation: ["Finalised payslips on off-cycle runs, plus payslips on regular runs that carry arrears or retro pay, for runs ending in the range.", MONEY_NOTE],
});
