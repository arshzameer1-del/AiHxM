import { DEPT, ETYPE, LOC, barChart, count, donutChart, lineChart, listReport, num, pct, percent, round1, round2, sqlReport, stackedChart, sum, type Q } from "../report-spec";

/**
 * Attendance and time reports (catalog D01 to D15). They read the evaluated daily results, so a day only appears once
 * attendance has been evaluated for it. They use the leave-request view permissions (the interim attendance mapping
 * documented in the security model): everything for people with leave_request.view.all, direct reports for managers.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const STATUS = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const ATTENDED = "r.status IN ('present', 'late', 'early_departure', 'late_and_early', 'half_day', 'on_duty')";
const EXPECTED = "r.status NOT IN ('holiday', 'rest_day', 'no_schedule')";
const FILTERS = [DEPT, LOC, ETYPE];
const DAILY = (_q: Q) => `attendance_daily_results r JOIN employees e ON e.id = r.employee_id AND e.company_id = r.company_id`;
const IN_RANGE = (q: Q) => `r.work_date BETWEEN ${q.from} AND ${q.to}`;
const RATE = `ROUND(COUNT(*) FILTER (WHERE ${ATTENDED}) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE ${ATTENDED}) + COUNT(*) FILTER (WHERE r.status = 'absent'), 0), 1)`;
const RATE_DEF = "Attendance rate is days attended divided by days attended plus days absent. People on approved leave, holidays, rest days and days with no schedule are not expected to attend and are left out.";
const ATTENDED_DEF = "Attended means the day's result is present, late, early departure, late and early, half day or on duty.";

// ---------------------------------------------------------------- D01 / D02 summaries

const summaryColumns = [
  { key: "expected", label: "Expected to work", type: "number" as const },
  { key: "attended", label: "Attended", type: "number" as const },
  { key: "late", label: "Late", type: "number" as const },
  { key: "absent", label: "Absent", type: "number" as const },
  { key: "onLeave", label: "On leave", type: "number" as const },
  { key: "rate", label: "Attendance rate (%)", type: "percent" as const },
];
const summarySelect = `COUNT(*) FILTER (WHERE ${EXPECTED})::int AS expected, COUNT(*) FILTER (WHERE ${ATTENDED})::int AS attended,
       COUNT(*) FILTER (WHERE r.status IN ('late', 'late_and_early'))::int AS late, COUNT(*) FILTER (WHERE r.status = 'absent')::int AS absent,
       COUNT(*) FILTER (WHERE r.status = 'on_leave')::int AS "onLeave", ${RATE} AS rate`;

export const D01 = sqlReport({
  description: "For each day: how many people were expected, attended, were late, absent or on leave, and the attendance rate.",
  filters: FILTERS,
  defaultRange: "last30Days",
  tables: ["attendance_daily_results", "employees"],
  viz: ["stackedBar", "kpi", "table"],
  tags: ["daily", "attendance"],
  columns: [{ key: "date", label: "Date", type: "date" }, ...summaryColumns],
  sql: (q) => `SELECT r.work_date::text AS date, ${summarySelect} FROM ${DAILY(q)} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY r.work_date ORDER BY r.work_date`,
  chart: ({ rows }) => stackedChart({ title: "Attended, late, absent and on leave", unit: "people", rows: rows.map((r) => ({ date: r.date, attended: num(r, "attended") - num(r, "late"), late: r.late, absent: r.absent, onLeave: r.onLeave })), xKey: "date", series: [{ key: "attended", label: "On time" }, { key: "late", label: "Late" }, { key: "absent", label: "Absent" }, { key: "onLeave", label: "On leave" }] }),
  kpis: ({ rows }) => {
    const att = sum(rows, "attended");
    const abs = sum(rows, "absent");
    return [percent("rate", "Attendance rate", pct(att, att + abs)), count("attended", "Person-days attended", att), count("absent", "Person-days absent", abs), count("late", "Late arrivals", sum(rows, "late"))];
  },
  notes: ({ rows }) => (rows.length === 0 ? ["No evaluated attendance exists in this range for the people you can see. Days appear once attendance has been evaluated."] : []),
  calculation: [RATE_DEF, ATTENDED_DEF, "Late counts days whose result is late or late and early."],
});

export const D02 = sqlReport({
  description: "The same attendance figures month by month, with hours worked against hours scheduled.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["attendance_daily_results", "employees"],
  viz: ["line", "kpi", "table"],
  tags: ["monthly", "attendance"],
  columns: [{ key: "month", label: "Month", type: "text" }, ...summaryColumns, { key: "scheduledHours", label: "Scheduled hours", type: "number" }, { key: "workedHours", label: "Worked hours", type: "number" }],
  sql: (q) => `SELECT to_char(date_trunc('month', r.work_date), 'YYYY-MM') AS month, ${summarySelect},
                      ROUND(COALESCE(SUM(r.scheduled_minutes), 0) / 60.0, 1) AS "scheduledHours", ROUND(COALESCE(SUM(r.worked_minutes), 0) / 60.0, 1) AS "workedHours"
                 FROM ${DAILY(q)} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY 1 ORDER BY 1`,
  chart: ({ rows }) => lineChart({ title: "Attendance rate by month", unit: "percent", rows: rows.filter((r) => r.rate !== null), xKey: "month", series: [{ key: "rate", label: "Attendance rate (%)" }] }),
  kpis: ({ rows }) => {
    const att = sum(rows, "attended");
    return [percent("rate", "Attendance rate", pct(att, att + sum(rows, "absent"))), count("absent", "Person-days absent", sum(rows, "absent")), { key: "hours", label: "Worked hours", value: round1(sum(rows, "workedHours")), unit: "count" as const }];
  },
  calculation: [RATE_DEF, ATTENDED_DEF, "Hours are the sum of scheduled and worked minutes on each day's result, divided by 60."],
});

// ---------------------------------------------------------------- D03 / D04 / D05 exceptions by person

function byPerson(o: { id: string; description: string; tags: string[]; metric: string; minutes: string | null; title: string; noun: string; condition: string; extraCalc: string }) {
  return sqlReport({
    description: o.description,
    filters: FILTERS,
    defaultRange: "last30Days",
    tables: ["attendance_daily_results", "employees", "org_units"],
    viz: ["bar", "kpi", "table"],
    tags: o.tags,
    columns: [
      { key: "number", label: "Employee number", type: "text" },
      { key: "name", label: "Name", type: "text" },
      { key: "unit", label: "Organisation unit", type: "text" },
      { key: "days", label: o.noun, type: "number" },
      ...(o.minutes ? [{ key: "minutes", label: "Total minutes", type: "number" as const }, { key: "avg", label: "Average minutes each time", type: "number" as const }] : []),
      { key: "workDays", label: "Days worked or expected", type: "number" },
    ],
    sql: (q) => `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*) FILTER (WHERE ${o.condition})::int AS days,
             ${o.minutes ? `COALESCE(SUM(${o.minutes}) FILTER (WHERE ${o.condition}), 0)::int AS minutes, ROUND(AVG(${o.minutes}) FILTER (WHERE ${o.condition}), 1) AS avg,` : ""}
             COUNT(*) FILTER (WHERE ${EXPECTED} AND r.status <> 'on_leave')::int AS "workDays"
        FROM ${DAILY(q)} LEFT JOIN org_units ou ON ou.id = e.org_unit_id
       WHERE ${q.emp()} AND ${IN_RANGE(q)}
       GROUP BY e.id, ou.name HAVING COUNT(*) FILTER (WHERE ${o.condition}) > 0
       ORDER BY days DESC, ${o.minutes ? "minutes DESC," : ""} name`,
    chart: ({ rows }) => barChart({ title: o.title, unit: "days", rows, labelKey: "name", valueKey: "days", valueLabel: o.noun, max: 12 }),
    kpis: ({ rows }) => [count("people", "People affected", rows.length), count("days", o.noun, sum(rows, "days")), ...(o.minutes ? [{ key: "avg", label: "Average minutes each time", value: sum(rows, "days") ? round1(sum(rows, "minutes") / sum(rows, "days")) : null, unit: "count" as const }] : [])],
    calculation: [o.extraCalc, "Only people with at least one such day in the range are listed. Days worked or expected excludes holidays, rest days, days with no schedule and approved leave."],
  });
}

export const D03 = byPerson({
  id: "D03",
  description: "Who arrived late, how often and by how many minutes in total.",
  tags: ["late", "punctuality"],
  metric: "late",
  minutes: "r.late_minutes",
  title: "Late days per person",
  noun: "Late days",
  condition: "r.late_minutes > 0",
  extraCalc: "A late day is a day whose evaluated result shows more than zero late minutes, after the shift's grace period.",
});

export const D04 = byPerson({
  id: "D04",
  description: "Who left early, how often and by how many minutes in total.",
  tags: ["early departure"],
  metric: "early",
  minutes: "r.early_leave_minutes",
  title: "Early-departure days per person",
  noun: "Early-departure days",
  condition: "r.early_leave_minutes > 0",
  extraCalc: "An early-departure day is a day whose evaluated result shows more than zero early-leave minutes.",
});

export const D05 = byPerson({
  id: "D05",
  description: "Who was absent without leave or duty cover, and for how many days.",
  tags: ["absence", "no-show"],
  metric: "absent",
  minutes: null,
  title: "Absent days per person",
  noun: "Absent days",
  condition: "r.status = 'absent'",
  extraCalc: "An absent day is a scheduled working day with no punches and no approved leave or on-duty request covering it.",
});

// ---------------------------------------------------------------- D06 missing punches

export const D06 = listReport({
  description: "Days where a clock-out is missing or no time was recorded, so the day cannot be trusted until fixed.",
  filters: FILTERS,
  defaultRange: "last30Days",
  tables: ["attendance_daily_results", "attendance_records", "employees"],
  tags: ["punches", "exceptions"],
  countLabel: "Exceptions",
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "issue", label: "Issue", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT r.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name,
             CASE WHEN 'missing_clock_out' = ANY(r.exceptions) THEN 'Clock-out missing' ELSE 'No time recorded' END AS issue
        FROM ${DAILY(q)} WHERE ${q.emp()} AND ${IN_RANGE(q)} AND (r.exceptions && ARRAY['missing_clock_out', 'time_not_recorded'])
      UNION
      SELECT ar.work_date::text, e.employee_number, ${NAME("e")}, 'Clock-out missing'
        FROM attendance_records ar JOIN employees e ON e.id = ar.employee_id
       WHERE ${q.emp()} AND ar.work_date BETWEEN ${q.from} AND ${q.to} AND ar.work_date < ${q.today} AND ar.clock_in_at IS NOT NULL AND ar.clock_out_at IS NULL
    ) t ORDER BY date DESC, number`,
  kpis: ({ rows }) => [count("clockOut", "Clock-out missing", rows.filter((r) => r.issue === "Clock-out missing").length), count("none", "No time recorded", rows.filter((r) => r.issue === "No time recorded").length)],
  calculation: ["Combines evaluated days flagged 'missing clock-out' or 'time not recorded' with any past day that has a clock-in and no clock-out. The same person and day is listed once.", "Today is excluded from the clock-out check because the day is not over."],
});

// ---------------------------------------------------------------- D07 regularization requests

export const D07 = sqlReport({
  description: "Attendance correction requests by status, with how long decisions take.",
  filters: FILTERS,
  defaultRange: "last90Days",
  tables: ["attendance_correction_requests", "employees"],
  viz: ["donut", "kpi", "table"],
  tags: ["regularization", "corrections"],
  columns: [
    { key: "status", label: "Status", type: "text" },
    { key: "requests", label: "Requests", type: "number" },
    { key: "share", label: "Share (%)", type: "percent" },
    { key: "avgDays", label: "Average days to decide", type: "number" },
    { key: "oldest", label: "Oldest waiting (days)", type: "number" },
  ],
  sql: (q) => `
    SELECT ${STATUS("c.status")} AS status, COUNT(*)::int AS requests, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share,
           ROUND(AVG(EXTRACT(EPOCH FROM (c.decided_at - c.created_at)) / 86400.0) FILTER (WHERE c.decided_at IS NOT NULL)::numeric, 1) AS "avgDays",
           MAX(${q.today} - c.created_at::date) FILTER (WHERE c.status = 'pending')::int AS oldest
      FROM attendance_correction_requests c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id
     WHERE ${q.emp()} AND c.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY c.status ORDER BY requests DESC, status`,
  chart: ({ rows }) => donutChart({ title: "Correction requests by status", unit: "requests", rows, labelKey: "status", valueKey: "requests" }),
  kpis: ({ rows }) => [count("total", "Requests", sum(rows, "requests")), count("pending", "Waiting", num(rows.find((r) => r.status === "Pending") ?? {}, "requests"))],
  calculation: ["Counts correction requests created in the range, by current status.", "Days to decide runs from the request to the decision. Requests not yet decided are left out of the average."],
});

// ---------------------------------------------------------------- D08 / D09 overtime

export const D08 = sqlReport({
  description: "Overtime hours by type of day, split into approved, paid and waiting for approval.",
  filters: FILTERS,
  defaultRange: "last90Days",
  tables: ["overtime_records", "employees"],
  viz: ["bar", "kpi", "table"],
  tags: ["overtime"],
  columns: [
    { key: "dayType", label: "Day type", type: "text" },
    { key: "records", label: "Records", type: "number" },
    { key: "people", label: "People", type: "number" },
    { key: "approved", label: "Approved hours", type: "number" },
    { key: "pending", label: "Waiting hours", type: "number" },
    { key: "rejected", label: "Rejected hours", type: "number" },
  ],
  sql: (q) => `
    SELECT ${STATUS("o.day_type")} AS "dayType", COUNT(*)::int AS records, COUNT(DISTINCT o.employee_id)::int AS people,
           ROUND(COALESCE(SUM(o.overtime_minutes) FILTER (WHERE o.status IN ('approved', 'paid')), 0) / 60.0, 1) AS approved,
           ROUND(COALESCE(SUM(o.overtime_minutes) FILTER (WHERE o.status IN ('pending', 'returned')), 0) / 60.0, 1) AS pending,
           ROUND(COALESCE(SUM(o.overtime_minutes) FILTER (WHERE o.status = 'rejected'), 0) / 60.0, 1) AS rejected
      FROM overtime_records o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id
     WHERE ${q.emp()} AND o.work_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY o.day_type ORDER BY approved DESC, "dayType"`,
  chart: ({ rows }) => barChart({ title: "Approved overtime hours by day type", unit: "hours", rows, labelKey: "dayType", valueKey: "approved", valueLabel: "Approved hours" }),
  kpis: ({ rows }) => [{ key: "approved", label: "Approved hours", value: round1(sum(rows, "approved")), unit: "count" as const }, { key: "pending", label: "Hours waiting for approval", value: round1(sum(rows, "pending")), unit: "count" as const }, count("records", "Records", sum(rows, "records"))],
  calculation: ["Sums overtime minutes on records whose work date falls in the range and divides by 60.", "Approved includes records already paid. Waiting means pending or returned. Cancelled records are not counted as hours but are included in the record count only when they match another status."],
});

export const D09 = sqlReport({
  description: "Overtime pay by month from the amounts calculated on approved and paid overtime. Needs permission to see sensitive employee data.",
  filters: FILTERS,
  defaultRange: "last12Months",
  sensitivity: "sensitive",
  needs: ["employee.view_sensitive.all"],
  tables: ["overtime_records", "employees"],
  viz: ["line", "kpi", "table"],
  tags: ["overtime", "cost"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "hours", label: "Approved hours", type: "number" },
    { key: "amount", label: "Amount", type: "number" },
    { key: "missing", label: "Records with no amount", type: "number" },
  ],
  sql: (q) => `
    SELECT to_char(date_trunc('month', o.work_date), 'YYYY-MM') AS month, ROUND(COALESCE(SUM(o.overtime_minutes), 0) / 60.0, 1) AS hours, ROUND(COALESCE(SUM(o.amount), 0), 0) AS amount,
           COUNT(*) FILTER (WHERE o.amount IS NULL)::int AS missing
      FROM overtime_records o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id
     WHERE ${q.emp()} AND o.status IN ('approved', 'paid') AND o.work_date BETWEEN ${q.from} AND ${q.to}
     GROUP BY 1 ORDER BY 1`,
  chart: ({ rows }) => lineChart({ title: "Overtime pay by month", unit: "PKR", rows, xKey: "month", series: [{ key: "amount", label: "Amount" }] }),
  kpis: ({ rows }) => [count("amount", "Total overtime pay", round2(sum(rows, "amount"))), { key: "hours", label: "Approved hours", value: round1(sum(rows, "hours")), unit: "count" as const }],
  notes: ({ rows }) => (sum(rows, "missing") > 0 ? [`${sum(rows, "missing")} approved record${sum(rows, "missing") === 1 ? " has" : "s have"} no amount calculated yet. They add hours but no money.`] : []),
  calculation: ["Sums the amount stored on each approved or paid overtime record. The amount is the calculation made when the overtime was approved; it is not recomputed here.", "Per-person amounts are not shown. Records with no amount are counted separately and contribute nothing."],
});

// ---------------------------------------------------------------- D10 / D13 schedule adherence

export const D10 = sqlReport({
  description: "How many attended days were fully on schedule (no late arrival and no early leave), by organisation unit.",
  filters: FILTERS,
  defaultRange: "last30Days",
  tables: ["attendance_daily_results", "shift_assignments", "employees", "org_units"],
  viz: ["bar", "table"],
  tags: ["shift", "adherence"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "days", label: "Days attended on a shift", type: "number" },
    { key: "onSchedule", label: "On schedule", type: "number" },
    { key: "adherence", label: "Adherence (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(*)::int AS days,
           COUNT(*) FILTER (WHERE r.late_minutes = 0 AND r.early_leave_minutes = 0)::int AS "onSchedule",
           ROUND(COUNT(*) FILTER (WHERE r.late_minutes = 0 AND r.early_leave_minutes = 0) * 100.0 / NULLIF(COUNT(*), 0), 1) AS adherence
      FROM ${DAILY(q)} LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${IN_RANGE(q)} AND ${ATTENDED} AND r.shift_id IS NOT NULL
     GROUP BY ou.id, ou.name ORDER BY adherence ASC NULLS LAST, unit`,
  chart: ({ rows }) => barChart({ title: "Schedule adherence by unit", unit: "percent", rows, labelKey: "unit", valueKey: "adherence", valueLabel: "Adherence (%)", max: 12 }),
  kpis: ({ rows }) => [percent("adherence", "Overall adherence", pct(sum(rows, "onSchedule"), sum(rows, "days"))), count("days", "Days attended on a shift", sum(rows, "days"))],
  calculation: ["Looks at attended days that were assigned a shift. A day is on schedule when it has no late minutes and no early-leave minutes.", "Days with no shift (including days with no schedule) are not part of adherence."],
});

export const D13 = sqlReport({
  description: "Worked hours against scheduled hours on days people attended, and days with no schedule at all, by organisation unit.",
  filters: FILTERS,
  defaultRange: "last30Days",
  tables: ["attendance_daily_results", "work_schedule_assignment_rules", "employees"],
  viz: ["bar", "table"],
  tags: ["schedule", "compliance"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "scheduled", label: "Scheduled hours", type: "number" },
    { key: "worked", label: "Worked hours", type: "number" },
    { key: "compliance", label: "Hours worked vs scheduled (%)", type: "percent" },
    { key: "short", label: "Days short of schedule", type: "number" },
    { key: "noSchedule", label: "Days with no schedule", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, ROUND(COALESCE(SUM(r.scheduled_minutes) FILTER (WHERE ${ATTENDED}), 0) / 60.0, 1) AS scheduled,
           ROUND(COALESCE(SUM(r.worked_minutes) FILTER (WHERE ${ATTENDED}), 0) / 60.0, 1) AS worked,
           ROUND(SUM(r.worked_minutes) FILTER (WHERE ${ATTENDED}) * 100.0 / NULLIF(SUM(r.scheduled_minutes) FILTER (WHERE ${ATTENDED}), 0), 1) AS compliance,
           COUNT(*) FILTER (WHERE ${ATTENDED} AND r.worked_minutes < r.scheduled_minutes)::int AS short, COUNT(*) FILTER (WHERE r.status = 'no_schedule')::int AS "noSchedule"
      FROM ${DAILY(q)} LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${IN_RANGE(q)}
     GROUP BY ou.id, ou.name ORDER BY compliance ASC NULLS LAST, unit`,
  chart: ({ rows }) => barChart({ title: "Hours worked vs scheduled", unit: "percent", rows, labelKey: "unit", valueKey: "compliance", valueLabel: "Worked vs scheduled (%)", max: 12 }),
  kpis: ({ rows }) => [percent("compliance", "Hours worked vs scheduled", pct(sum(rows, "worked"), sum(rows, "scheduled"))), count("noSchedule", "Days with no schedule", sum(rows, "noSchedule"), "People working with no shift assigned")],
  calculation: ["Compares worked minutes with scheduled minutes on days the person attended. Absent days and leave are attendance questions, not hours questions, and are excluded here.", "A day is short when worked minutes are below scheduled minutes. Days with no schedule are counted separately because there is nothing to compare."],
});

// ---------------------------------------------------------------- D11 / D12 by unit and location

function attendanceBy(o: { dimension: string; label: string; join: string; group: string; description: string; title: string; tags: string[] }) {
  return sqlReport({
    description: o.description,
    filters: FILTERS,
    defaultRange: "last30Days",
    tables: ["attendance_daily_results", "employees", "org_units", "locations"],
    viz: ["bar", "table"],
    tags: o.tags,
    columns: [{ key: "label", label: o.dimension, type: "text" }, { key: "people", label: "People", type: "number" }, ...summaryColumns],
    sql: (q) => `SELECT ${o.label} AS label, COUNT(DISTINCT e.id)::int AS people, ${summarySelect} FROM ${DAILY(q)} ${o.join} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY ${o.group} ORDER BY rate ASC NULLS LAST, label`,
    chart: ({ rows }) => barChart({ title: o.title, unit: "percent", rows, labelKey: "label", valueKey: "rate", valueLabel: "Attendance rate (%)", max: 12 }),
    kpis: ({ rows }) => {
      const att = sum(rows, "attended");
      return [percent("rate", "Attendance rate", pct(att, att + sum(rows, "absent"))), count("groups", `${o.dimension}s with data`, rows.length)];
    },
    calculation: [RATE_DEF, ATTENDED_DEF],
  });
}

export const D11 = attendanceBy({ dimension: "Organisation unit", label: "COALESCE(ou.name, 'No organisation unit set')", join: "LEFT JOIN org_units ou ON ou.id = e.org_unit_id", group: "ou.id, ou.name", description: "Attendance rate and counts for each organisation unit.", title: "Attendance rate by unit", tags: ["attendance", "unit"] });
export const D12 = attendanceBy({ dimension: "Location", label: "COALESCE(l.name, 'No location set')", join: "LEFT JOIN locations l ON l.id = e.location_id", group: "l.id, l.name", description: "Attendance rate and counts for each work location.", title: "Attendance rate by location", tags: ["attendance", "location"] });

// ---------------------------------------------------------------- D14 / D15 timesheets

export const D14 = sqlReport({
  description: "Timesheets by status for periods that overlap the range, with hours and people.",
  filters: FILTERS,
  defaultRange: "last90Days",
  tables: ["timesheets", "employees"],
  viz: ["donut", "kpi", "table"],
  tags: ["timesheets", "submission"],
  columns: [
    { key: "status", label: "Status", type: "text" },
    { key: "timesheets", label: "Timesheets", type: "number" },
    { key: "people", label: "People", type: "number" },
    { key: "hours", label: "Hours", type: "number" },
    { key: "share", label: "Share (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT ${STATUS("t.status")} AS status, COUNT(*)::int AS timesheets, COUNT(DISTINCT t.employee_id)::int AS people, ROUND(COALESCE(SUM(t.total_minutes), 0) / 60.0, 1) AS hours,
           ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM timesheets t JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id
     WHERE ${q.emp()} AND t.period_end >= ${q.from} AND t.period_start <= ${q.to}
     GROUP BY t.status ORDER BY timesheets DESC, status`,
  chart: ({ rows }) => donutChart({ title: "Timesheets by status", unit: "timesheets", rows, labelKey: "status", valueKey: "timesheets" }),
  kpis: ({ rows }) => {
    const n = (s: string) => num(rows.find((r) => r.status === s) ?? {}, "timesheets");
    return [count("total", "Timesheets", sum(rows, "timesheets")), count("draft", "Still in draft", n("Draft")), count("pending", "Waiting for approval", n("Pending"))];
  },
  calculation: ["Counts timesheets whose period overlaps the range, by current status. A draft has not been submitted.", "Hours are the total minutes recorded on each timesheet divided by 60."],
});

export const D15 = listReport({
  description: "Submitted timesheets still waiting for approval, longest wait first.",
  filters: FILTERS,
  tables: ["timesheets", "employees", "workflow_instances"],
  tags: ["timesheets", "ageing", "approval"],
  countLabel: "Waiting for approval",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "start", label: "Period start", type: "date" },
    { key: "end", label: "Period end", type: "date" },
    { key: "submitted", label: "Submitted", type: "date" },
    { key: "waiting", label: "Days waiting", type: "number" },
    { key: "band", label: "Wait band", type: "text" },
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, t.period_start::text AS start, t.period_end::text AS "end", t.submitted_at::date::text AS submitted,
           (${q.today} - COALESCE(t.submitted_at::date, t.updated_at::date))::int AS waiting,
           CASE WHEN ${q.today} - COALESCE(t.submitted_at::date, t.updated_at::date) <= 2 THEN '0-2 days' WHEN ${q.today} - COALESCE(t.submitted_at::date, t.updated_at::date) <= 7 THEN '3-7 days' ELSE 'Over 7 days' END AS band
      FROM timesheets t JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id
     WHERE ${q.emp()} AND t.status = 'pending'
     ORDER BY waiting DESC, number`,
  kpis: ({ rows }) => [{ key: "avg", label: "Average days waiting", value: rows.length ? round1(sum(rows, "waiting") / rows.length) : null, unit: "days" as const }, count("over7", "Waiting over 7 days", rows.filter((r) => r.band === "Over 7 days").length)],
  calculation: ["Lists timesheets whose status is pending. Days waiting runs from the day it was submitted to today."],
});
