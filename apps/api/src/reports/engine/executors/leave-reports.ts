import { DEPT, ETYPE, LOC, barChart, count, lineChart, listReport, num, pct, percent, round1, round2, sqlReport, sum, type Q } from "../report-spec";

/**
 * Leave and absence reports (catalog E01, E04 to E15; E02 and E03 are the original hand-written pair). Scope comes from
 * leave_request.view.all (whole company) or leave_request.view.team (direct reports), applied through the employee.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const BASE = [DEPT, LOC, ETYPE] as const;
const WITH_TYPE = [DEPT, LOC, ETYPE, "leaveType"] as const;
const TYPE_NAME = "COALESCE(lt.name, INITCAP(REPLACE(lr.leave_type, '_', ' ')))";
const LT_JOIN = "LEFT JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type";
const typeCond = (q: Q, col: string) => {
  const v = q.filter("leaveType");
  return v ? `${col} = ${q.bind(v)}` : "TRUE";
};
/** Approved days of a request that fall inside [from, to], spreading a straddling request evenly over its calendar days. */
const DAYS_IN_RANGE = (q: Q) => `CASE WHEN lr.start_date >= ${q.from} AND lr.end_date <= ${q.to} THEN lr.days_requested
        ELSE lr.days_requested * ((LEAST(lr.end_date, ${q.to}) - GREATEST(lr.start_date, ${q.from}) + 1)::numeric / (lr.end_date - lr.start_date + 1)) END`;

export const E01 = sqlReport({
  description: "Leave entitlement, days used and days left for each leave type, for the current year.",
  filters: [...WITH_TYPE],
  tables: ["leave_balances", "leave_types", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["balances", "entitlement"],
  columns: [
    { key: "type", label: "Leave type", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "entitled", label: "Entitled days", type: "number" },
    { key: "used", label: "Used days", type: "number" },
    { key: "remaining", label: "Days left", type: "number" },
    { key: "utilisation", label: "Used (%)", type: "percent" },
    { key: "negative", label: "People over their balance", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(lt.name, INITCAP(REPLACE(lb.leave_type, '_', ' '))) AS type, COUNT(DISTINCT lb.employee_id)::int AS people, ROUND(SUM(lb.entitled_days), 1) AS entitled,
           ROUND(SUM(lb.used_days), 1) AS used, ROUND(SUM(lb.entitled_days - lb.used_days), 1) AS remaining,
           ROUND(SUM(lb.used_days) * 100.0 / NULLIF(SUM(lb.entitled_days), 0), 1) AS utilisation, COUNT(*) FILTER (WHERE lb.entitled_days - lb.used_days < 0)::int AS negative
      FROM leave_balances lb JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id
      LEFT JOIN leave_types lt ON lt.company_id = lb.company_id AND lt.code = lb.leave_type
     WHERE ${q.emp()} AND ${q.current()} AND lb.year = EXTRACT(year FROM ${q.today})::int AND ${typeCond(q, "lb.leave_type")}
     GROUP BY lb.leave_type, lt.name ORDER BY entitled DESC, type`,
  chart: ({ rows }) => barChart({ title: "Days left by leave type", unit: "days", rows, labelKey: "type", valueKey: "remaining", valueLabel: "Days left", max: 12 }),
  kpis: ({ rows }) => [{ key: "remaining", label: "Days left", value: round1(sum(rows, "remaining")), unit: "days" as const }, percent("used", "Used so far", pct(sum(rows, "used"), sum(rows, "entitled"))), count("negative", "Balances below zero", sum(rows, "negative"))],
  calculation: ["Uses the balance rows for the current year (company time) of current employees. Entitled is opening plus accrual plus carry-forward plus adjustments, minus encashment and expiry, as posted in the leave ledger.", "Days left is entitled minus used. A balance below zero is counted as 'over their balance'."],
});

export const E04 = sqlReport({
  description: "How quickly leave requests are decided, by leave type: average, median and share decided within a day.",
  filters: [...WITH_TYPE],
  defaultRange: "last90Days",
  tables: ["leave_requests", "workflow_instances", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["turnaround", "approval"],
  columns: [
    { key: "type", label: "Leave type", type: "text" },
    { key: "decided", label: "Requests decided", type: "number" },
    { key: "avgHours", label: "Average hours to decide", type: "number" },
    { key: "medianHours", label: "Median hours", type: "number" },
    { key: "within24", label: "Decided within 24 hours (%)", type: "percent" },
    { key: "slowest", label: "Slowest (hours)", type: "number" },
  ],
  sql: (q) => `
    WITH d AS (
      SELECT ${TYPE_NAME} AS type, EXTRACT(EPOCH FROM (wi.completed_at - lr.created_at)) / 3600.0 AS h
        FROM leave_requests lr JOIN workflow_instances wi ON wi.id = lr.workflow_instance_id AND wi.completed_at IS NOT NULL
        JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id ${LT_JOIN}
       WHERE ${q.emp()} AND lr.status IN ('approved', 'rejected') AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} AND ${typeCond(q, "lr.leave_type")})
    SELECT type, COUNT(*)::int AS decided, ROUND(AVG(h)::numeric, 1) AS "avgHours", ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h))::numeric, 1) AS "medianHours",
           ROUND(COUNT(*) FILTER (WHERE h <= 24) * 100.0 / COUNT(*), 1) AS within24, ROUND(MAX(h)::numeric, 1) AS slowest
      FROM d GROUP BY type ORDER BY "avgHours" DESC, type`,
  summary: (q) => `
    SELECT COUNT(*) FILTER (WHERE lr.workflow_instance_id IS NULL)::int AS "noWorkflow"
      FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id
     WHERE ${q.emp()} AND lr.status IN ('approved', 'rejected') AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} AND ${typeCond(q, "lr.leave_type")}`,
  chart: ({ rows }) => barChart({ title: "Average hours to decide", unit: "hours", rows, labelKey: "type", valueKey: "avgHours", valueLabel: "Average hours", max: 12 }),
  kpis: ({ rows }) => {
    const n = sum(rows, "decided");
    const w = rows.reduce((s, r) => s + num(r, "avgHours") * num(r, "decided"), 0);
    return [count("decided", "Requests decided", n), { key: "avg", label: "Average hours to decide", value: n ? round1(w / n) : null, unit: "count" as const }];
  },
  notes: ({ summary }) => (summary.noWorkflow > 0 ? [`${summary.noWorkflow} decided request${summary.noWorkflow === 1 ? " was" : "s were"} not routed through an approval workflow, so no decision time exists. ${summary.noWorkflow === 1 ? "It is" : "They are"} left out.`] : []),
  calculation: ["Time to decide runs from the moment the request was created to the moment its approval workflow completed. Only approved and rejected requests that went through a workflow are measured.", "The overall average weights each leave type by the number of requests decided."],
});

export const E05 = listReport({
  description: "Approved leave that starts or runs during the coming period, so cover can be planned.",
  filters: [...WITH_TYPE],
  defaultRange: "next30Days",
  tables: ["leave_requests", "employees", "org_units"],
  tags: ["upcoming", "cover"],
  countLabel: "Approved absences",
  columns: [
    { key: "start", label: "From", type: "date" },
    { key: "end", label: "To", type: "date" },
    { key: "days", label: "Days", type: "number" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "type", label: "Leave type", type: "text" },
  ],
  sql: (q) => `
    SELECT lr.start_date::text AS start, lr.end_date::text AS "end", lr.days_requested AS days, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${TYPE_NAME} AS type
      FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id ${LT_JOIN}
     WHERE ${q.emp()} AND lr.status = 'approved' AND lr.end_date >= ${q.from} AND lr.start_date <= ${q.to} AND ${typeCond(q, "lr.leave_type")}
     ORDER BY lr.start_date, name`,
  kpis: ({ rows }) => [count("people", "People away", new Set(rows.map((r) => r.number)).size), { key: "days", label: "Leave days requested", value: round1(sum(rows, "days")), unit: "days" as const }],
  calculation: ["Lists approved requests that overlap the range, soonest first. Days is the full length of the request, even if only part of it falls in the range.", "Pending requests are not shown because they may not be approved."],
});

export const E06 = sqlReport({
  description: "Absence nobody planned for, month by month: approved leave filed on or after its first day, and absent days with no leave.",
  filters: [...BASE],
  defaultRange: "last12Months",
  tables: ["leave_requests", "attendance_daily_results", "employees"],
  viz: ["stackedBar", "table"],
  tags: ["unplanned", "absence", "trend"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "filedLate", label: "Leave days filed on or after day one", type: "number" },
    { key: "absent", label: "Absent days with no leave", type: "number" },
    { key: "total", label: "Unplanned days", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()}),
         f AS (SELECT date_trunc('month', lr.start_date)::date AS ms, SUM(lr.days_requested) AS days
                 FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id
                WHERE ${q.emp()} AND lr.status = 'approved' AND lr.created_at::date >= lr.start_date AND lr.start_date BETWEEN ${q.from} AND ${q.to} GROUP BY 1),
         a AS (SELECT date_trunc('month', r.work_date)::date AS ms, COUNT(*) AS n
                 FROM attendance_daily_results r JOIN employees e ON e.id = r.employee_id AND e.company_id = r.company_id
                WHERE ${q.emp()} AND r.status = 'absent' AND r.work_date BETWEEN ${q.from} AND ${q.to} GROUP BY 1)
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COALESCE(f.days, 0) AS "filedLate", COALESCE(a.n, 0)::int AS absent, COALESCE(f.days, 0) + COALESCE(a.n, 0) AS total
      FROM mo LEFT JOIN f ON f.ms = mo.ms LEFT JOIN a ON a.ms = mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => ({ kind: "stackedBar", title: "Unplanned days by month", unit: "days", xKey: "month", series: [{ key: "filedLate", label: "Leave filed on or after day one" }, { key: "absent", label: "Absent, no leave" }], data: rows }),
  kpis: ({ rows }) => [{ key: "total", label: "Unplanned days", value: round1(sum(rows, "total")), unit: "days" as const }, { key: "absent", label: "Absent with no leave", value: sum(rows, "absent"), unit: "days" as const }],
  calculation: [
    "Unplanned is a judgement from the data, not a recorded flag: approved leave whose request was created on or after its first day (so it could not have been planned), plus evaluated absent days.",
    "Absent days come from evaluated attendance, so months that have not been evaluated show zero absent days.",
  ],
});

export const E08 = sqlReport({
  description: "Carry-forward entries that break the leave type's rule: carried when not allowed, or above the cap.",
  filters: [...BASE],
  defaultRange: "last12Months",
  tables: ["leave_ledger", "leave_types", "employees"],
  viz: ["kpi", "table"],
  tags: ["carry forward", "exceptions"],
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Leave type", type: "text" },
    { key: "year", label: "Year", type: "number" },
    { key: "carried", label: "Days carried", type: "number" },
    { key: "cap", label: "Cap", type: "number" },
    { key: "issue", label: "Issue", type: "text" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, lt.name AS type, ll.year, ll.days AS carried, lt.carry_forward_cap_days AS cap,
           CASE WHEN NOT lt.carry_forward_allowed THEN 'Carry-forward is not allowed for this type' ELSE 'More than the cap' END AS issue
      FROM leave_ledger ll JOIN employees e ON e.id = ll.employee_id AND e.company_id = ll.company_id JOIN leave_types lt ON lt.company_id = ll.company_id AND lt.code = ll.leave_type
     WHERE ${q.emp()} AND ll.entry_type = 'carry_forward' AND ll.days > 0 AND ll.effective_date BETWEEN ${q.from} AND ${q.to}
       AND (NOT lt.carry_forward_allowed OR (lt.carry_forward_cap_days IS NOT NULL AND ll.days > lt.carry_forward_cap_days))
     ORDER BY ll.year DESC, name`,
  summary: (q) => `
    SELECT COUNT(*)::int AS checked FROM leave_ledger ll JOIN employees e ON e.id = ll.employee_id AND e.company_id = ll.company_id
     WHERE ${q.emp()} AND ll.entry_type = 'carry_forward' AND ll.days > 0 AND ll.effective_date BETWEEN ${q.from} AND ${q.to}`,
  kpis: ({ rows, summary }) => [count("checked", "Carry-forward entries checked", summary.checked ?? 0), count("exceptions", "Exceptions", rows.length)],
  calculation: ["Looks at carry-forward entries posted to the leave ledger in the range and compares each with its leave type's rules.", "An entry is an exception if the type does not allow carry-forward, or the days carried exceed the type's cap. Types with no cap are only checked for 'allowed'."],
});

export const E09 = sqlReport({
  description: "How much of the leave entitlement has been used, for each organisation unit, for the current year.",
  filters: [...WITH_TYPE],
  tables: ["leave_balances", "employees", "org_units"],
  viz: ["bar", "table"],
  tags: ["utilisation", "quota"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "entitled", label: "Entitled days", type: "number" },
    { key: "used", label: "Used days", type: "number" },
    { key: "utilisation", label: "Used (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(DISTINCT lb.employee_id)::int AS people, ROUND(SUM(lb.entitled_days), 1) AS entitled, ROUND(SUM(lb.used_days), 1) AS used,
           ROUND(SUM(lb.used_days) * 100.0 / NULLIF(SUM(lb.entitled_days), 0), 1) AS utilisation
      FROM leave_balances lb JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()} AND lb.year = EXTRACT(year FROM ${q.today})::int AND ${typeCond(q, "lb.leave_type")}
     GROUP BY ou.id, ou.name ORDER BY utilisation DESC NULLS LAST, unit`,
  chart: ({ rows }) => barChart({ title: "Share of entitlement used", unit: "percent", rows, labelKey: "unit", valueKey: "utilisation", valueLabel: "Used (%)", max: 12 }),
  kpis: ({ rows }) => [percent("used", "Used so far", pct(sum(rows, "used"), sum(rows, "entitled"))), count("units", "Units", rows.length)],
  calculation: ["Used divided by entitled days across the balance rows of current employees for the current year. Types that do not track a balance have no rows and are not included."],
});

export const E10 = listReport({
  description: "Balances that do not agree with the leave ledger they are summarised from. An empty list means every balance reconciles.",
  filters: [...BASE],
  tables: ["leave_balances", "leave_ledger", "employees"],
  tags: ["reconciliation", "integrity"],
  countLabel: "Balances that do not reconcile",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Leave type", type: "text" },
    { key: "year", label: "Year", type: "number" },
    { key: "balEntitled", label: "Balance: entitled", type: "number" },
    { key: "ledEntitled", label: "Ledger: entitled", type: "number" },
    { key: "balUsed", label: "Balance: used", type: "number" },
    { key: "ledUsed", label: "Ledger: used", type: "number" },
  ],
  sql: (q) => `
    WITH l AS (
      SELECT ll.employee_id, ll.leave_type, ll.year,
             COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('opening', 'accrual', 'carry_forward', 'adjustment', 'encashment', 'expiry')), 0) AS ent,
             -COALESCE(SUM(ll.days) FILTER (WHERE ll.entry_type IN ('deduction', 'reversal')), 0) AS used
        FROM leave_ledger ll WHERE ${q.co("ll")} GROUP BY 1, 2, 3)
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(lt.name, lb.leave_type) AS type, lb.year, lb.entitled_days AS "balEntitled", COALESCE(l.ent, 0) AS "ledEntitled",
           lb.used_days AS "balUsed", COALESCE(l.used, 0) AS "ledUsed"
      FROM leave_balances lb JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id
      LEFT JOIN l ON l.employee_id = lb.employee_id AND l.leave_type = lb.leave_type AND l.year = lb.year
      LEFT JOIN leave_types lt ON lt.company_id = lb.company_id AND lt.code = lb.leave_type
     WHERE ${q.emp()} AND (ABS(lb.entitled_days - COALESCE(l.ent, 0)) > 0.005 OR ABS(lb.used_days - COALESCE(l.used, 0)) > 0.005)
     ORDER BY lb.year DESC, name`,
  summary: (q) => `SELECT COUNT(*)::int AS checked FROM leave_balances lb JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id WHERE ${q.emp()}`,
  kpis: ({ summary }) => [count("checked", "Balances checked", summary.checked ?? 0)],
  calculation: ["Re-adds each employee's leave-ledger entries for the type and year and compares them with the stored balance, for both entitled and used days. Differences above 0.005 of a day are listed.", "This checks the balance against the ledger. It does not check the ledger against approved requests."],
});

export const E11 = listReport({
  description: "People with two pending or approved leave requests that cover the same days.",
  filters: [...BASE],
  defaultRange: "next90Days",
  tables: ["leave_requests", "employees"],
  tags: ["overlap", "exceptions"],
  countLabel: "Overlapping pairs",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "first", label: "First request", type: "text" },
    { key: "second", label: "Second request", type: "text" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name,
           INITCAP(a.status) || ': ' || a.start_date::text || ' to ' || a.end_date::text AS first, INITCAP(b.status) || ': ' || b.start_date::text || ' to ' || b.end_date::text AS second
      FROM leave_requests a JOIN leave_requests b ON b.employee_id = a.employee_id AND b.company_id = a.company_id AND a.id < b.id
      JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id
     WHERE ${q.emp()} AND a.status IN ('pending', 'approved') AND b.status IN ('pending', 'approved') AND a.start_date <= b.end_date AND b.start_date <= a.end_date
       AND NOT (a.start_date = a.end_date AND b.start_date = a.start_date AND b.end_date = a.start_date AND a.day_part <> 'full' AND b.day_part <> 'full' AND a.day_part <> b.day_part)
       AND a.end_date >= ${q.from} AND a.start_date <= ${q.to}
     ORDER BY a.start_date, name`,
  calculation: ["Compares every pair of pending or approved requests for the same person. Two requests overlap when each starts on or before the other ends.", "A first-half and a second-half request on the same single day do not overlap."],
});

function leaveBy(o: { dimension: string; label: string; join: string; group: string; description: string; title: string; tags: string[] }) {
  return sqlReport({
    description: o.description,
    filters: [...WITH_TYPE],
    defaultRange: "yearToDate",
    tables: ["leave_requests", "employees", "org_units", "locations"],
    viz: ["bar", "table"],
    tags: o.tags,
    columns: [
      { key: "label", label: o.dimension, type: "text" },
      { key: "headcount", label: "Current headcount", type: "number" },
      { key: "requests", label: "Approved requests", type: "number" },
      { key: "days", label: "Approved days", type: "number" },
      { key: "perPerson", label: "Days per person", type: "number" },
    ],
    sql: (q) => `
      SELECT ${o.label} AS label, COUNT(DISTINCT e.id)::int AS headcount, COALESCE(SUM(lv.requests), 0)::int AS requests, ROUND(COALESCE(SUM(lv.days), 0), 1) AS days,
             ROUND(COALESCE(SUM(lv.days), 0) / NULLIF(COUNT(DISTINCT e.id), 0), 2) AS "perPerson"
        FROM employees e ${o.join}
        LEFT JOIN LATERAL (SELECT SUM(${DAYS_IN_RANGE(q)}) AS days, COUNT(*) AS requests FROM leave_requests lr
                            WHERE lr.employee_id = e.id AND lr.company_id = e.company_id AND lr.status = 'approved' AND lr.start_date <= ${q.to} AND lr.end_date >= ${q.from} AND ${typeCond(q, "lr.leave_type")}) lv ON TRUE
       WHERE ${q.emp()} AND ${q.current()}
       GROUP BY ${o.group} ORDER BY days DESC, label`,
    chart: ({ rows }) => barChart({ title: o.title, unit: "days per person", rows, labelKey: "label", valueKey: "perPerson", valueLabel: "Days per person", max: 12 }),
    kpis: ({ rows }) => [{ key: "days", label: "Approved leave days", value: round1(sum(rows, "days")), unit: "days" as const }, { key: "perPerson", label: "Days per person", value: sum(rows, "headcount") ? round2(sum(rows, "days") / sum(rows, "headcount")) : null, unit: "days" as const }],
    calculation: ["Approved leave days that fall inside the range, summed for current employees in each group. A request that straddles the range contributes in proportion to the calendar days inside it.", "Days per person divides by the group's current headcount, including people who took no leave. People who have left are not included."],
  });
}

export const E12 = leaveBy({ dimension: "Organisation unit", label: "COALESCE(ou.name, 'No organisation unit set')", join: "LEFT JOIN org_units ou ON ou.id = e.org_unit_id", group: "ou.id, ou.name", description: "Approved leave days for each organisation unit, with days per person.", title: "Leave days per person by unit", tags: ["leave", "unit"] });
export const E13 = leaveBy({ dimension: "Location", label: "COALESCE(l.name, 'No location set')", join: "LEFT JOIN locations l ON l.id = e.location_id", group: "l.id, l.name", description: "Approved leave days for each work location, with days per person.", title: "Leave days per person by location", tags: ["leave", "location"] });

export const E14 = sqlReport({
  description: "For every day in the range: how many people are on approved leave and whether it is a holiday. Shows the busiest and quietest days.",
  filters: [...BASE],
  defaultRange: "next30Days",
  tables: ["leave_requests", "holidays", "employees"],
  viz: ["line", "kpi", "table"],
  tags: ["calendar", "capacity"],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "weekday", label: "Day", type: "text" },
    { key: "holiday", label: "Holiday", type: "text" },
    { key: "onLeave", label: "People on leave", type: "number" },
  ],
  sql: (q) => `
    WITH d AS (SELECT gs::date AS day FROM generate_series(${q.from}, ${q.to}, interval '1 day') gs)
    SELECT d.day::text AS date, to_char(d.day, 'Dy') AS weekday, COALESCE(STRING_AGG(DISTINCT h.name, ', '), '') AS holiday, COUNT(DISTINCT lr.employee_id)::int AS "onLeave"
      FROM d LEFT JOIN holidays h ON ${q.co("h")} AND h.holiday_date = d.day
      LEFT JOIN (leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id AND ${q.emp()}) ON lr.status = 'approved' AND d.day BETWEEN lr.start_date AND lr.end_date
     GROUP BY d.day ORDER BY d.day`,
  chart: ({ rows }) => lineChart({ title: "People on leave each day", unit: "people", rows, xKey: "date", series: [{ key: "onLeave", label: "People on leave" }] }),
  kpis: ({ rows }) => {
    const peak = rows.reduce<typeof rows[number] | null>((b, r) => (b === null || num(r, "onLeave") > num(b, "onLeave") ? r : b), null);
    return [count("peak", "Most people away in a day", peak ? num(peak, "onLeave") : null, peak ? `On ${peak.date}` : undefined), count("holidays", "Holidays in range", rows.filter((r) => r.holiday).length)];
  },
  calculation: ["Counts people with an approved request that covers each day, each person once per day. Half-day requests count as a person on leave.", "Holidays come from the company holiday calendar. Weekends are shown but not treated as non-working."],
});

export const E15 = listReport({
  description: "Pending or approved leave requests that break a rule of their own leave type: too long, missing a required document, half-days not allowed or too little service.",
  filters: [...BASE],
  defaultRange: "last90Days",
  tables: ["leave_requests", "leave_types", "employees"],
  tags: ["policy", "compliance", "exceptions"],
  countLabel: "Exceptions",
  columns: [
    { key: "start", label: "Starts", type: "date" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Leave type", type: "text" },
    { key: "issue", label: "Issue", type: "text" },
    { key: "detail", label: "Detail", type: "text" },
  ],
  sql: (q) => `
    WITH b AS (
      SELECT lr.start_date, lr.end_date, lr.days_requested, lr.day_part, lr.attachment_document_id, e.employee_number, ${NAME("e")} AS name, e.date_of_joining,
             lt.name AS type, lt.max_consecutive_days, lt.document_required, lt.document_required_after_days, lt.half_day_allowed, lt.min_service_months
        FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
       WHERE ${q.emp()} AND lr.status IN ('pending', 'approved') AND lr.start_date BETWEEN ${q.from} AND ${q.to})
    SELECT * FROM (
      SELECT start_date::text AS start, employee_number AS number, name, type, 'Longer than allowed' AS issue, days_requested::text || ' days requested; the limit is ' || max_consecutive_days::text AS detail FROM b WHERE max_consecutive_days IS NOT NULL AND days_requested > max_consecutive_days
      UNION ALL
      SELECT start_date::text, employee_number, name, type, 'Document missing', days_requested::text || ' days requested; a document is required over ' || COALESCE(document_required_after_days, 0)::text || ' days' FROM b WHERE document_required AND days_requested > COALESCE(document_required_after_days, 0) AND attachment_document_id IS NULL
      UNION ALL
      SELECT start_date::text, employee_number, name, type, 'Half day not allowed', 'This leave type does not allow half days' FROM b WHERE NOT half_day_allowed AND day_part <> 'full'
      UNION ALL
      SELECT start_date::text, employee_number, name, type, 'Not enough service', 'Needs ' || min_service_months::text || ' months of service' FROM b WHERE min_service_months > 0 AND date_of_joining > (start_date - make_interval(months => min_service_months))::date
      UNION ALL
      SELECT start_date::text, employee_number, name, type, 'Days exceed the dates', days_requested::text || ' days requested over ' || (end_date - start_date + 1)::text || ' calendar days' FROM b WHERE days_requested > (end_date - start_date + 1)
    ) t ORDER BY start DESC, number`,
  summary: (q) => `SELECT COUNT(*)::int AS checked FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id WHERE ${q.emp()} AND lr.status IN ('pending', 'approved') AND lr.start_date BETWEEN ${q.from} AND ${q.to}`,
  kpis: ({ rows, summary }) => [count("checked", "Requests checked", summary.checked ?? 0), count("people", "People affected", new Set(rows.map((r) => r.number)).size)],
  calculation: ["Checks each pending or approved request starting in the range against five rules held on its leave type: consecutive-day limit, supporting document, half-day permission, minimum service, and days against calendar span.", "One request can appear more than once if it breaks more than one rule."],
});
