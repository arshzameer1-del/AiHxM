import type { ReportColumn } from "@aihxm/shared-types";
import type { Q, ReportSectionSpec } from "../report-spec";

/**
 * Building blocks for the extra tables ("sections") under each report. A section is held to the same scope rules as its
 * report, so every builder starts from `q.emp()` (company, team scope and the chosen filters) or `q.co()`.
 */

export const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
export const LABEL = (c: string) => `INITCAP(REPLACE(${c}, '_', ' '))`;
export const YES_NO = (cond: string) => `CASE WHEN ${cond} THEN 'Yes' ELSE 'No' END`;
export const col = (key: string, label: string, type: ReportColumn["type"] = "text"): ReportColumn => ({ key, label, type });
export const IDENT = [col("number", "Employee number"), col("name", "Name")];

/** Years from joining to leaving (or today). */
export const tenureYears = (q: Q, a = "e") => `CASE WHEN ${a}.date_of_joining IS NULL THEN NULL ELSE ROUND((COALESCE(${a}.termination_date, ${q.today}) - ${a}.date_of_joining) / 365.25, 1) END`;
/** Employee in force on `today` without relying on a missing termination date. */
export const NOT_DATED_LEAVER = "NOT (e.employment_status = 'terminated' AND e.termination_date IS NULL)";

/** The organisation context joins for an employee alias `e`: unit `ou`, position `p`, location `l`, manager `mg`. */
export const ORG_JOINS = `
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
      LEFT JOIN positions p ON p.id = e.position_id
      LEFT JOIN locations l ON l.id = e.location_id
      LEFT JOIN employees mg ON mg.id = e.manager_id AND mg.company_id = e.company_id`;

/** Months to cover: the report's own date range when it has one, else the 12 months ending today. One row each: `ms` (month start), `me` (month end, capped at today). */
export function monthSeries(q: Q): string {
  if (q.ctx.range) return q.months().replace("AS point", "AS me");
  return `SELECT gs::date AS ms, LEAST((gs + interval '1 month - 1 day')::date, ${q.today}) AS me
            FROM generate_series(date_trunc('month', ${q.today} - interval '11 months')::date, date_trunc('month', ${q.today})::date, interval '1 month') gs`;
}

/** Range for "records in the period": the report's own range, else the 12 months ending today. */
export function periodBounds(q: Q): { from: string; to: string; label: string } {
  if (q.ctx.range) return { from: q.from, to: q.to, label: "in the selected period" };
  return { from: `(${q.today} - interval '12 months')::date`, to: q.today, label: "in the last 12 months" };
}

type BreakdownOpts = {
  /** Which employees: current employees by default. */
  where?: (q: Q) => string;
  /** Add the average years of service column. */
  tenure?: boolean;
  from?: string;
};

/** Headcount-style breakdown: one row per value of `groupExpr`, with the count, share of total and (optionally) average years of service. */
export function headcountBy(key: string, title: string, description: string, dimLabel: string, groupExpr: string, o: BreakdownOpts = {}): ReportSectionSpec {
  const withTenure = o.tenure !== false;
  return {
    key,
    title,
    description,
    columns: [col("label", dimLabel), col("employees", "Employees", "number"), col("share", "Share (%)", "percent"), ...(withTenure ? [col("tenure", "Average years of service", "number")] : [])],
    sql: (q) => `
      SELECT g.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share${withTenure ? ", ROUND(AVG(g.tenure), 1) AS tenure" : ""}
        FROM (SELECT COALESCE(NULLIF((${groupExpr})::text, ''), 'Not set') AS label, ${tenureYears(q)} AS tenure
                FROM employees e ${o.from ?? ORG_JOINS}
               WHERE ${q.emp()} AND ${o.where ? o.where(q) : q.current()}) g
       GROUP BY g.label ORDER BY employees DESC, g.label`,
  };
}

export const byUnit = (extra?: BreakdownOpts) => headcountBy("by-unit", "By organisation unit", "Current employees in each unit.", "Organisation unit", "ou.name", extra);
export const byLocation = (extra?: BreakdownOpts) => headcountBy("by-location", "By location", "Current employees at each work location.", "Location", "l.name", extra);
export const byType = (extra?: BreakdownOpts) => headcountBy("by-type", "By employment type", "Current employees by employment type.", "Employment type", LABEL("e.employment_type"), extra);
export const byPosition = (extra?: BreakdownOpts) => headcountBy("by-position", "By position", "Current employees by position title.", "Position", "COALESCE(p.position_title, e.designation)", extra);
export const byManager = (extra?: BreakdownOpts) => headcountBy("by-manager", "By manager", "Current employees by the manager they report to.", "Reports to", NAME("mg"), extra);

export const TENURE_BANDS: ReportSectionSpec = {
  key: "tenure-bands",
  title: "Years of service",
  description: "Current employees grouped by how long they have worked here.",
  columns: [col("label", "Band"), col("employees", "Employees", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN y IS NULL THEN 'Not set' WHEN y < 1 THEN 'Under 1 year' WHEN y < 3 THEN '1 to 3 years' WHEN y < 5 THEN '3 to 5 years' WHEN y < 10 THEN '5 to 10 years' ELSE '10 years or more' END AS label,
                   CASE WHEN y IS NULL THEN 6 WHEN y < 1 THEN 1 WHEN y < 3 THEN 2 WHEN y < 5 THEN 3 WHEN y < 10 THEN 4 ELSE 5 END AS ord
              FROM (SELECT ${tenureYears(q)} AS y FROM employees e WHERE ${q.emp()} AND ${q.current()}) t) b
     GROUP BY b.label, b.ord ORDER BY b.ord`,
};

/** Joiners, leavers and net change for each month of the report's range (or the last 12 months). */
export const MOVEMENT: ReportSectionSpec = {
  key: "movement",
  title: "Joiners and leavers by month",
  description: "Month by month: people who joined, people who left, the net change and the headcount at month end.",
  columns: [col("month", "Month"), col("joined", "Joined", "number"), col("left", "Left", "number"), col("net", "Net change", "number"), col("headcount", "Headcount at month end", "number")],
  sql: (q) => `
    WITH mo AS (${monthSeries(q)})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month,
           COUNT(e.id) FILTER (WHERE e.date_of_joining BETWEEN mo.ms AND mo.me)::int AS joined,
           COUNT(e.id) FILTER (WHERE e.termination_date BETWEEN mo.ms AND mo.me)::int AS "left",
           (COUNT(e.id) FILTER (WHERE e.date_of_joining BETWEEN mo.ms AND mo.me) - COUNT(e.id) FILTER (WHERE e.termination_date BETWEEN mo.ms AND mo.me))::int AS net,
           COUNT(e.id) FILTER (WHERE e.date_of_joining <= mo.me AND ${NOT_DATED_LEAVER} AND (e.termination_date IS NULL OR e.termination_date > mo.me))::int AS headcount
      FROM mo LEFT JOIN employees e ON ${q.emp()}
     GROUP BY mo.ms ORDER BY mo.ms`,
};

/** Month-end headcount for each organisation unit, month by month. */
export const HEADCOUNT_BY_UNIT_MONTHLY: ReportSectionSpec = {
  key: "monthly-by-unit",
  title: "Month-end headcount by organisation unit",
  description: "How many people each unit had at the end of every month.",
  columns: [col("month", "Month"), col("label", "Organisation unit"), col("headcount", "Headcount at month end", "number")],
  sql: (q) => `
    WITH mo AS (${monthSeries(q)})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COALESCE(ou.name, 'Not set') AS label, COUNT(e.id)::int AS headcount
      FROM mo JOIN employees e ON ${q.emp()} AND e.date_of_joining <= mo.me AND ${NOT_DATED_LEAVER} AND (e.termination_date IS NULL OR e.termination_date > mo.me)
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     GROUP BY mo.ms, ou.name ORDER BY mo.ms, headcount DESC, label`,
};

const RECORD_COLUMNS: ReportColumn[] = [
  ...IDENT,
  col("unit", "Organisation unit"),
  col("position", "Position"),
  col("location", "Location"),
  col("type", "Employment type"),
  col("status", "Status"),
  col("joined", "Joined", "date"),
  col("left", "Left on", "date"),
  col("tenure", "Years of service", "number"),
  col("manager", "Reports to"),
];

/** The employee records behind a figure. `where` narrows them; `currentOnly` (default) keeps to people still employed. */
export function employeeRecords(key: string, title: string, description: string, o: { where?: (q: Q) => string; currentOnly?: boolean; order?: string } = {}): ReportSectionSpec {
  return {
    key,
    title,
    description,
    columns: RECORD_COLUMNS,
    sql: (q) => `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position,
             COALESCE(l.name, 'Not set') AS location, ${LABEL("e.employment_type")} AS type, ${LABEL("e.employment_status")} AS status,
             e.date_of_joining::text AS joined, e.termination_date::text AS "left", ${tenureYears(q)} AS tenure, NULLIF(${NAME("mg")}, '') AS manager
        FROM employees e ${ORG_JOINS}
       WHERE ${q.emp()} AND ${o.currentOnly === false ? "TRUE" : q.current()}${o.where ? ` AND ${o.where(q)}` : ""}
       ORDER BY ${o.order ?? "name, number"}`,
  };
}

/** People who joined (or left) in the report's period, with the reason for leaving. */
export const JOINERS_IN_PERIOD: ReportSectionSpec = {
  key: "joiners",
  title: "Joiners in the period",
  description: "Everyone who joined in the period, newest first.",
  columns: [...IDENT, col("joined", "Joined", "date"), col("unit", "Organisation unit"), col("position", "Position"), col("location", "Location"), col("type", "Employment type"), col("manager", "Reports to")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, e.date_of_joining::text AS joined, COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position,
             COALESCE(l.name, 'Not set') AS location, ${LABEL("e.employment_type")} AS type, NULLIF(${NAME("mg")}, '') AS manager
        FROM employees e ${ORG_JOINS}
       WHERE ${q.emp()} AND e.date_of_joining BETWEEN ${b.from} AND ${b.to}
       ORDER BY e.date_of_joining DESC, name`;
  },
};

export const LEAVERS_IN_PERIOD: ReportSectionSpec = {
  key: "leavers",
  title: "Leavers in the period",
  description: "Everyone who left in the period, with the date, reason and years of service.",
  columns: [...IDENT, col("left", "Left on", "date"), col("reason", "Reason for leaving"), col("tenure", "Years of service", "number"), col("unit", "Organisation unit"), col("position", "Position"), col("type", "Employment type")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, e.termination_date::text AS "left", COALESCE(NULLIF(e.termination_reason, ''), 'Not recorded') AS reason, ${tenureYears(q)} AS tenure,
             COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position, ${LABEL("e.employment_type")} AS type
        FROM employees e ${ORG_JOINS}
       WHERE ${q.emp()} AND e.termination_date BETWEEN ${b.from} AND ${b.to}
       ORDER BY e.termination_date DESC, name`;
  },
};

export const LEAVING_REASONS: ReportSectionSpec = {
  key: "leaving-reasons",
  title: "Reasons for leaving",
  description: "Why people left in the period.",
  columns: [col("label", "Reason"), col("leavers", "Leavers", "number"), col("share", "Share (%)", "percent"), col("tenure", "Average years of service", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT g.label, COUNT(*)::int AS leavers, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, ROUND(AVG(g.tenure), 1) AS tenure
        FROM (SELECT COALESCE(NULLIF(e.termination_reason, ''), 'Not recorded') AS label, ${tenureYears(q)} AS tenure FROM employees e WHERE ${q.emp()} AND e.termination_date BETWEEN ${b.from} AND ${b.to}) g
       GROUP BY g.label ORDER BY leavers DESC, g.label`;
  },
};

/** Joiners, leavers and attrition for each organisation unit over the period. */
export const MOVEMENT_BY_UNIT: ReportSectionSpec = {
  key: "movement-by-unit",
  title: "Joiners and leavers by organisation unit",
  description: "For each unit: headcount now, people who joined, people who left and the share of the average headcount that left.",
  columns: [col("label", "Organisation unit"), col("headcount", "Headcount now", "number"), col("joined", "Joined", "number"), col("left", "Left", "number"), col("attrition", "Leavers as % of headcount", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*) FILTER (WHERE ${q.current()})::int AS headcount,
             COUNT(*) FILTER (WHERE e.date_of_joining BETWEEN ${b.from} AND ${b.to})::int AS joined,
             COUNT(*) FILTER (WHERE e.termination_date BETWEEN ${b.from} AND ${b.to})::int AS "left",
             ROUND(COUNT(*) FILTER (WHERE e.termination_date BETWEEN ${b.from} AND ${b.to}) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE ${q.current()}) + COUNT(*) FILTER (WHERE e.termination_date BETWEEN ${b.from} AND ${b.to}), 0), 1) AS attrition
        FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
       WHERE ${q.emp()}
       GROUP BY ou.name HAVING COUNT(*) FILTER (WHERE ${q.current()}) > 0 OR COUNT(*) FILTER (WHERE e.termination_date BETWEEN ${b.from} AND ${b.to}) > 0
       ORDER BY headcount DESC, label`;
  },
};
