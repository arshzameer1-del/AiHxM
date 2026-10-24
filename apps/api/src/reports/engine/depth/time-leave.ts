import type { Q, ReportSectionSpec } from "../report-spec";
import { IDENT, LABEL, NAME, col } from "./common";

/**
 * Extra tables for attendance, overtime, timesheets (D) and leave (E). Scope is the employee scope of the report (whole
 * company or direct reports) applied through `q.emp()`. Leave reasons and attachments are never shown.
 */

const ATTENDED = "r.status IN ('present', 'late', 'early_departure', 'late_and_early', 'half_day', 'on_duty')";
const EXPECTED = "r.status NOT IN ('holiday', 'rest_day', 'no_schedule')";
const DAILY = "attendance_daily_results r JOIN employees e ON e.id = r.employee_id AND e.company_id = r.company_id";
const IN_RANGE = (q: Q) => `r.work_date BETWEEN ${q.from} AND ${q.to}`;
const RATE = `ROUND(COUNT(*) FILTER (WHERE ${ATTENDED}) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE ${ATTENDED}) + COUNT(*) FILTER (WHERE r.status = 'absent'), 0), 1)`;
const hours = (c: string) => `ROUND(COALESCE(SUM(${c}), 0) / 60.0, 1)`;

const SUMMARY_COLS = [
  col("expected", "Expected to work", "number"),
  col("attended", "Attended", "number"),
  col("late", "Late", "number"),
  col("early", "Left early", "number"),
  col("absent", "Absent", "number"),
  col("onLeave", "On leave", "number"),
  col("rate", "Attendance rate (%)", "percent"),
];
const summarySelect = `COUNT(*) FILTER (WHERE ${EXPECTED})::int AS expected, COUNT(*) FILTER (WHERE ${ATTENDED})::int AS attended, COUNT(*) FILTER (WHERE r.status IN ('late', 'late_and_early'))::int AS late,
       COUNT(*) FILTER (WHERE r.status IN ('early_departure', 'late_and_early'))::int AS early, COUNT(*) FILTER (WHERE r.status = 'absent')::int AS absent, COUNT(*) FILTER (WHERE r.status = 'on_leave')::int AS "onLeave", ${RATE} AS rate`;

// ---------------------------------------------------------------- attendance

const attendanceBy = (key: string, title: string, description: string, label: string, expr: string, join: string, order = "label"): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("label", label), col("people", "People", "number"), ...SUMMARY_COLS],
  sql: (q) => `SELECT ${expr} AS label, COUNT(DISTINCT e.id)::int AS people, ${summarySelect} FROM ${DAILY} ${join} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY 1 ORDER BY ${order}`,
});
const A_BY_UNIT = attendanceBy("attendance-by-unit", "Attendance by organisation unit", "Attendance counts and rate for each unit.", "Organisation unit", "COALESCE(ou.name, 'Not set')", "LEFT JOIN org_units ou ON ou.id = e.org_unit_id", "rate ASC NULLS LAST, label");
const A_BY_LOCATION = attendanceBy("attendance-by-location", "Attendance by location", "Attendance counts and rate for each location.", "Location", "COALESCE(l.name, 'Not set')", "LEFT JOIN locations l ON l.id = e.location_id", "rate ASC NULLS LAST, label");
const A_BY_TYPE = attendanceBy("attendance-by-type", "Attendance by employment type", "Attendance counts and rate for each employment type.", "Employment type", LABEL("e.employment_type"), "", "rate ASC NULLS LAST, label");
const A_BY_WEEKDAY: ReportSectionSpec = {
  key: "attendance-by-weekday",
  title: "Attendance by day of the week",
  description: "Which weekdays have the most lateness and absence.",
  columns: [col("label", "Weekday"), ...SUMMARY_COLS],
  sql: (q) => `SELECT to_char(r.work_date, 'Dy') AS label, ${summarySelect} FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY to_char(r.work_date, 'Dy'), EXTRACT(ISODOW FROM r.work_date) ORDER BY EXTRACT(ISODOW FROM r.work_date)`,
};
const A_BY_DAY: ReportSectionSpec = {
  key: "attendance-by-day",
  title: "Attendance by day",
  description: "Counts for every day in the range.",
  columns: [col("date", "Date", "date"), col("weekday", "Day"), ...SUMMARY_COLS],
  sql: (q) => `SELECT r.work_date::text AS date, to_char(r.work_date, 'Dy') AS weekday, ${summarySelect} FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY r.work_date ORDER BY r.work_date`,
};
const A_BY_WEEK: ReportSectionSpec = {
  key: "attendance-by-week",
  title: "Attendance by week",
  description: "Weekly trend of attendance (weeks start on Monday).",
  columns: [col("week", "Week starting", "date"), ...SUMMARY_COLS],
  sql: (q) => `SELECT date_trunc('week', r.work_date)::date::text AS week, ${summarySelect} FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY 1 ORDER BY 1`,
};
const A_BY_MONTH: ReportSectionSpec = {
  key: "attendance-by-month",
  title: "Attendance by month",
  description: "Monthly counts and hours worked against scheduled.",
  columns: [col("month", "Month"), ...SUMMARY_COLS, col("scheduledHours", "Scheduled hours", "number"), col("workedHours", "Worked hours", "number")],
  sql: (q) => `SELECT to_char(r.work_date, 'YYYY-MM') AS month, ${summarySelect}, ${hours(`r.scheduled_minutes) FILTER (WHERE ${ATTENDED}`)} AS "scheduledHours", ${hours(`r.worked_minutes) FILTER (WHERE ${ATTENDED}`)} AS "workedHours" FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY 1 ORDER BY 1`,
};
const A_PER_PERSON: ReportSectionSpec = {
  key: "attendance-per-person",
  title: "Attendance per person",
  description: "For each person: days attended, late, left early, absent, on leave, and their rate.",
  columns: [...IDENT, col("unit", "Organisation unit"), ...SUMMARY_COLS, col("workedHours", "Worked hours", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${summarySelect}, ${hours(`r.worked_minutes) FILTER (WHERE ${ATTENDED}`)} AS "workedHours"
      FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY e.id, ou.name ORDER BY rate ASC NULLS LAST, name`,
};
const A_DAY_RECORDS: ReportSectionSpec = {
  key: "day-records",
  title: "Daily results",
  description: "Every evaluated day in the range: status, first in, last out, scheduled and worked hours, late and early minutes, and flagged exceptions.",
  columns: [col("date", "Date", "date"), ...IDENT, col("unit", "Organisation unit"), col("schedule", "Schedule"), col("status", "Status"), col("firstIn", "First in"), col("lastOut", "Last out"), col("scheduled", "Scheduled hours", "number"), col("worked", "Worked hours", "number"), col("late", "Late (min)", "number"), col("early", "Left early (min)", "number"), col("exceptions", "Exceptions")],
  sql: (q) => `
    SELECT r.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COALESCE(r.schedule_name, 'None') AS schedule, ${LABEL("r.status")} AS status,
           to_char(r.first_in_at AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "firstIn", to_char(r.last_out_at AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "lastOut",
           ROUND(COALESCE(r.scheduled_minutes, 0) / 60.0, 2) AS scheduled, ROUND(COALESCE(r.worked_minutes, 0) / 60.0, 2) AS worked, COALESCE(r.late_minutes, 0) AS late, COALESCE(r.early_leave_minutes, 0) AS early,
           NULLIF(ARRAY_TO_STRING(r.exceptions, ', '), '') AS exceptions
      FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} ORDER BY r.work_date DESC, name`,
};
const dayList = (key: string, title: string, description: string, cond: string, withMinutes: "late" | "early" | null): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("date", "Date", "date"), ...IDENT, col("unit", "Organisation unit"), col("status", "Status"), col("scheduled", "Scheduled hours", "number"), col("worked", "Worked hours", "number"), ...(withMinutes ? [col("minutes", withMinutes === "late" ? "Late (min)" : "Left early (min)", "number")] : [])],
  sql: (q) => `
    SELECT r.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("r.status")} AS status,
           ROUND(COALESCE(r.scheduled_minutes, 0) / 60.0, 2) AS scheduled, ROUND(COALESCE(r.worked_minutes, 0) / 60.0, 2) AS worked${withMinutes ? `, COALESCE(${withMinutes === "late" ? "r.late_minutes" : "r.early_leave_minutes"}, 0) AS minutes` : ""}
      FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} AND ${cond} ORDER BY r.work_date DESC, name`,
});
const LATE_DAYS = dayList("late-days", "Late arrivals", "Every day someone arrived late, with the minutes.", "r.late_minutes > 0", "late");
const EARLY_DAYS = dayList("early-days", "Early departures", "Every day someone left early, with the minutes.", "r.early_leave_minutes > 0", "early");
const ABSENT_DAYS = dayList("absent-days", "Absent days", "Every day someone was absent without leave or duty cover.", "r.status = 'absent'", null);
const BAND = (expr: string, order: string, label: string, nounKey: string, noun: string): ReportSectionSpec => ({
  key: `${nounKey}-bands`,
  title: `${noun} by size`,
  description: `How serious each ${noun.toLowerCase()} case is.`,
  columns: [col("label", label), col("days", "Days", "number"), col("people", "People", "number")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS days, COUNT(DISTINCT b.emp)::int AS people
      FROM (SELECT e.id AS emp, CASE WHEN m <= 15 THEN '1 Up to 15 min' WHEN m <= 30 THEN '2 16 to 30 min' WHEN m <= 60 THEN '3 31 to 60 min' ELSE '4 Over 60 min' END AS label
              FROM (SELECT e.id, ${expr} AS m FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} AND ${order}) e) b GROUP BY b.label ORDER BY b.label`,
});
const LATE_BANDS = BAND("r.late_minutes", "r.late_minutes > 0", "Minutes late", "late", "Late arrivals");
const EARLY_BANDS = BAND("r.early_leave_minutes", "r.early_leave_minutes > 0", "Minutes early", "early", "Early departures");
const ABSENT_PER_PERSON: ReportSectionSpec = {
  key: "absent-per-person",
  title: "Absence per person",
  description: "Days absent for each person in the range.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("days", "Days absent", "number"), col("first", "First", "date"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS days, MIN(r.work_date)::text AS first, MAX(r.work_date)::text AS last
      FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} AND r.status = 'absent' GROUP BY e.id, ou.name ORDER BY days DESC, name`,
};
const A_STATUS_MIX: ReportSectionSpec = {
  key: "status-mix",
  title: "Results by status",
  description: "How many person-days ended in each result.",
  columns: [col("label", "Result"), col("days", "Person-days", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => `SELECT ${LABEL("r.status")} AS label, COUNT(*)::int AS days, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY r.status ORDER BY days DESC, label`,
};
const PUNCH_EXCEPTIONS_BY_KIND: ReportSectionSpec = {
  key: "exception-kinds",
  title: "Exceptions by kind",
  description: "Flagged attendance exceptions in the range.",
  columns: [col("label", "Exception"), col("days", "Days", "number"), col("people", "People", "number")],
  sql: (q) => `
    SELECT LABEL_X AS label, COUNT(*)::int AS days, COUNT(DISTINCT x.emp)::int AS people
      FROM (SELECT e.id AS emp, UNNEST(r.exceptions) AS ex FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)}) x GROUP BY x.ex ORDER BY days DESC, label`.replace("LABEL_X", LABEL("x.ex")),
};
const PUNCH_EXCEPTIONS_BY_UNIT: ReportSectionSpec = {
  key: "exceptions-by-unit",
  title: "Exceptions by organisation unit",
  description: "Days with a flagged exception in each unit.",
  columns: [col("label", "Organisation unit"), col("days", "Days with an exception", "number"), col("people", "People", "number")],
  sql: (q) => `SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS days, COUNT(DISTINCT e.id)::int AS people FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} AND COALESCE(CARDINALITY(r.exceptions), 0) > 0 GROUP BY ou.name ORDER BY days DESC, label`,
};
const OPEN_PUNCHES: ReportSectionSpec = {
  key: "open-punches",
  title: "Clock-ins with no clock-out",
  description: "Past days with a clock-in and no clock-out recorded.",
  columns: [col("date", "Date", "date"), ...IDENT, col("clockIn", "Clock-in"), col("source", "Source")],
  sql: (q) => `
    SELECT ar.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, to_char(ar.clock_in_at AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "clockIn", ${LABEL("ar.source")} AS source
      FROM attendance_records ar JOIN employees e ON e.id = ar.employee_id AND e.company_id = ar.company_id
     WHERE ${q.emp()} AND ar.work_date BETWEEN ${q.from} AND ${q.to} AND ar.work_date < ${q.today} AND ar.clock_in_at IS NOT NULL AND ar.clock_out_at IS NULL ORDER BY ar.work_date DESC, name`,
};
const SCHEDULE_COMPLIANCE_RECORDS: ReportSectionSpec = {
  key: "short-days",
  title: "Days short of schedule",
  description: "Attended days where fewer hours were worked than scheduled.",
  columns: [col("date", "Date", "date"), ...IDENT, col("unit", "Organisation unit"), col("scheduled", "Scheduled hours", "number"), col("worked", "Worked hours", "number"), col("short", "Short by (hours)", "number")],
  sql: (q) => `
    SELECT r.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ROUND(r.scheduled_minutes / 60.0, 2) AS scheduled, ROUND(r.worked_minutes / 60.0, 2) AS worked,
           ROUND((r.scheduled_minutes - r.worked_minutes) / 60.0, 2) AS short
      FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} AND ${ATTENDED} AND r.worked_minutes < r.scheduled_minutes ORDER BY short DESC, name`,
};
const NO_SCHEDULE_PEOPLE: ReportSectionSpec = {
  key: "no-schedule",
  title: "People with days that had no schedule",
  description: "Employees with days in the range that had no work schedule assigned.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("days", "Days with no schedule", "number")],
  sql: (q) => `SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS days FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} AND r.status = 'no_schedule' GROUP BY e.id, ou.name ORDER BY days DESC, name`,
};
const ADHERENCE_BY_PERSON: ReportSectionSpec = {
  key: "adherence-per-person",
  title: "Schedule adherence per person",
  description: "For each person: attended days and how many were fully on schedule (no late arrival, no early leave).",
  columns: [...IDENT, col("unit", "Organisation unit"), col("days", "Days attended", "number"), col("onSchedule", "On schedule", "number"), col("adherence", "Adherence (%)", "percent")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*) FILTER (WHERE ${ATTENDED})::int AS days, COUNT(*) FILTER (WHERE r.status IN ('present', 'on_duty'))::int AS "onSchedule",
           ROUND(COUNT(*) FILTER (WHERE r.status IN ('present', 'on_duty')) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE ${ATTENDED}), 0), 1) AS adherence
      FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} GROUP BY e.id, ou.name HAVING COUNT(*) FILTER (WHERE ${ATTENDED}) > 0 ORDER BY adherence ASC NULLS LAST, name`,
};

// ---------------------------------------------------------------- corrections

const CORR_FROM = "attendance_correction_requests c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id";
const CORRECTIONS: ReportSectionSpec = {
  key: "corrections",
  title: "Correction requests",
  description: "Every correction request in the range: the day, the times asked for, status and how long the decision took. The reason text is not shown.",
  columns: [col("created", "Requested on", "date"), ...IDENT, col("day", "Day corrected", "date"), col("clockIn", "Clock-in asked"), col("clockOut", "Clock-out asked"), col("status", "Status"), col("decided", "Decided on", "date"), col("days", "Days to decide", "number")],
  sql: (q) => `
    SELECT c.created_at::date::text AS created, e.employee_number AS number, ${NAME("e")} AS name, c.requested_date::text AS day,
           to_char(c.requested_clock_in AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "clockIn", to_char(c.requested_clock_out AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "clockOut",
           ${LABEL("c.status")} AS status, c.decided_at::date::text AS decided, ROUND((EXTRACT(EPOCH FROM (COALESCE(c.decided_at, now()) - c.created_at)) / 86400.0)::numeric, 1) AS days
      FROM ${CORR_FROM} WHERE ${q.emp()} AND c.created_at::date BETWEEN ${q.from} AND ${q.to} ORDER BY c.created_at DESC`,
};
const CORR_BY_UNIT: ReportSectionSpec = {
  key: "corrections-by-unit",
  title: "Corrections by organisation unit",
  description: "Correction requests for each unit by outcome.",
  columns: [col("label", "Organisation unit"), col("requests", "Requests", "number"), col("approved", "Approved", "number"), col("rejected", "Rejected", "number"), col("pending", "Waiting", "number"), col("avgDays", "Average days to decide", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE c.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE c.status = 'rejected')::int AS rejected, COUNT(*) FILTER (WHERE c.status = 'pending')::int AS pending,
           ROUND(AVG(EXTRACT(EPOCH FROM (c.decided_at - c.created_at)) / 86400.0) FILTER (WHERE c.decided_at IS NOT NULL)::numeric, 1) AS "avgDays"
      FROM ${CORR_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND c.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.name ORDER BY requests DESC, label`,
};
const CORR_BY_MONTH: ReportSectionSpec = {
  key: "corrections-by-month",
  title: "Corrections by month",
  description: "Correction requests per month by outcome.",
  columns: [col("month", "Month"), col("requests", "Requests", "number"), col("approved", "Approved", "number"), col("rejected", "Rejected", "number"), col("pending", "Waiting", "number")],
  sql: (q) => `
    SELECT to_char(c.created_at, 'YYYY-MM') AS month, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE c.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE c.status = 'rejected')::int AS rejected, COUNT(*) FILTER (WHERE c.status = 'pending')::int AS pending
      FROM ${CORR_FROM} WHERE ${q.emp()} AND c.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const CORR_PER_PERSON: ReportSectionSpec = {
  key: "corrections-per-person",
  title: "Corrections per person",
  description: "Who asks for corrections most often.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("requests", "Requests", "number"), col("approved", "Approved", "number"), col("rejected", "Rejected", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE c.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE c.status = 'rejected')::int AS rejected
      FROM ${CORR_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND c.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY e.id, ou.name ORDER BY requests DESC, name`,
};

// ---------------------------------------------------------------- overtime

const OT_FROM = "overtime_records o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id";
const OT_RANGE = (q: Q) => `o.work_date BETWEEN ${q.from} AND ${q.to}`;
const OVERTIME: ReportSectionSpec = {
  key: "overtime-records",
  title: "Overtime records",
  description: "Every overtime record in the range: the day, scheduled and actual time, overtime minutes, day type and status. Amounts are not shown here.",
  columns: [col("date", "Date", "date"), ...IDENT, col("unit", "Organisation unit"), col("dayType", "Day type"), col("scheduled", "Scheduled hours", "number"), col("actual", "Actual hours", "number"), col("overtime", "Overtime hours", "number"), col("status", "Status"), col("payout", "Paid as")],
  sql: (q) => `
    SELECT o.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("o.day_type")} AS "dayType", ROUND(COALESCE(o.scheduled_minutes, 0) / 60.0, 2) AS scheduled,
           ROUND(COALESCE(o.actual_minutes, 0) / 60.0, 2) AS actual, ROUND(o.overtime_minutes / 60.0, 2) AS overtime, ${LABEL("o.status")} AS status, ${LABEL("COALESCE(o.payout_mode, 'not_set')")} AS payout
      FROM ${OT_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${OT_RANGE(q)} ORDER BY o.work_date DESC, name`,
};
const OT_BY_UNIT: ReportSectionSpec = {
  key: "overtime-by-unit",
  title: "Overtime by organisation unit",
  description: "Overtime hours in each unit by status.",
  columns: [col("label", "Organisation unit"), col("people", "People", "number"), col("approved", "Approved hours", "number"), col("pending", "Waiting hours", "number"), col("rejected", "Rejected hours", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(DISTINCT e.id)::int AS people, ${hours("o.overtime_minutes) FILTER (WHERE o.status IN ('approved', 'paid')")} AS approved,
           ${hours("o.overtime_minutes) FILTER (WHERE o.status IN ('pending', 'returned')")} AS pending, ${hours("o.overtime_minutes) FILTER (WHERE o.status = 'rejected'")} AS rejected
      FROM ${OT_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${OT_RANGE(q)} GROUP BY ou.name ORDER BY approved DESC, label`,
};
const OT_BY_MONTH: ReportSectionSpec = {
  key: "overtime-by-month",
  title: "Overtime by month",
  description: "Overtime hours per month by status.",
  columns: [col("month", "Month"), col("records", "Records", "number"), col("approved", "Approved hours", "number"), col("pending", "Waiting hours", "number"), col("rejected", "Rejected hours", "number")],
  sql: (q) => `
    SELECT to_char(o.work_date, 'YYYY-MM') AS month, COUNT(*)::int AS records, ${hours("o.overtime_minutes) FILTER (WHERE o.status IN ('approved', 'paid')")} AS approved,
           ${hours("o.overtime_minutes) FILTER (WHERE o.status IN ('pending', 'returned')")} AS pending, ${hours("o.overtime_minutes) FILTER (WHERE o.status = 'rejected'")} AS rejected
      FROM ${OT_FROM} WHERE ${q.emp()} AND ${OT_RANGE(q)} GROUP BY 1 ORDER BY 1`,
};
const OT_PER_PERSON: ReportSectionSpec = {
  key: "overtime-per-person",
  title: "Overtime per person",
  description: "Approved and waiting overtime hours for each person.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("records", "Records", "number"), col("approved", "Approved hours", "number"), col("pending", "Waiting hours", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS records, ${hours("o.overtime_minutes) FILTER (WHERE o.status IN ('approved', 'paid')")} AS approved,
           ${hours("o.overtime_minutes) FILTER (WHERE o.status IN ('pending', 'returned')")} AS pending
      FROM ${OT_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${OT_RANGE(q)} GROUP BY e.id, ou.name ORDER BY approved DESC, name`,
};
const OT_BY_STATUS: ReportSectionSpec = {
  key: "overtime-by-status",
  title: "Overtime by status",
  description: "Overtime records and hours by status.",
  columns: [col("label", "Status"), col("records", "Records", "number"), col("hours", "Hours", "number")],
  sql: (q) => `SELECT ${LABEL("o.status")} AS label, COUNT(*)::int AS records, ${hours("o.overtime_minutes")} AS hours FROM ${OT_FROM} WHERE ${q.emp()} AND ${OT_RANGE(q)} GROUP BY o.status ORDER BY records DESC, label`,
};
const OT_PAY_BY_UNIT: ReportSectionSpec = {
  key: "overtime-pay-by-unit",
  title: "Overtime pay by organisation unit",
  description: "Calculated overtime amounts on approved and paid overtime, for each unit. Totals only, not per person.",
  columns: [col("label", "Organisation unit"), col("hours", "Approved hours", "number"), col("amount", "Amount", "number"), col("missing", "Records with no amount", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, ${hours("o.overtime_minutes")} AS hours, ROUND(COALESCE(SUM(o.amount), 0), 0) AS amount, COUNT(*) FILTER (WHERE o.amount IS NULL)::int AS missing
      FROM ${OT_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND o.status IN ('approved', 'paid') AND ${OT_RANGE(q)} GROUP BY ou.name ORDER BY amount DESC, label`,
};
const OT_PAY_BY_DAYTYPE: ReportSectionSpec = {
  key: "overtime-pay-by-day-type",
  title: "Overtime pay by day type",
  description: "Calculated overtime amounts by type of day.",
  columns: [col("label", "Day type"), col("hours", "Approved hours", "number"), col("amount", "Amount", "number"), col("rate", "Average rate multiplier", "number")],
  sql: (q) => `
    SELECT ${LABEL("o.day_type")} AS label, ${hours("o.overtime_minutes")} AS hours, ROUND(COALESCE(SUM(o.amount), 0), 0) AS amount, ROUND(AVG(o.rate_multiplier), 2) AS rate
      FROM ${OT_FROM} WHERE ${q.emp()} AND o.status IN ('approved', 'paid') AND ${OT_RANGE(q)} GROUP BY o.day_type ORDER BY amount DESC, label`,
};
const OT_PAY_RECORDS: ReportSectionSpec = {
  key: "overtime-missing-amount",
  title: "Approved overtime with no amount",
  description: "Approved or paid overtime records where no amount was calculated.",
  columns: [col("date", "Date", "date"), ...IDENT, col("overtime", "Overtime hours", "number"), col("status", "Status")],
  sql: (q) => `
    SELECT o.work_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, ROUND(o.overtime_minutes / 60.0, 2) AS overtime, ${LABEL("o.status")} AS status
      FROM ${OT_FROM} WHERE ${q.emp()} AND o.status IN ('approved', 'paid') AND o.amount IS NULL AND ${OT_RANGE(q)} ORDER BY o.work_date DESC, name`,
};

// ---------------------------------------------------------------- timesheets

const TS_FROM = "timesheets t JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id";
const TS_RANGE = (q: Q) => `t.period_end >= ${q.from} AND t.period_start <= ${q.to}`;
const TIMESHEETS: ReportSectionSpec = {
  key: "timesheets",
  title: "Timesheets",
  description: "Every timesheet overlapping the range: period, hours, status, submission and decision.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("start", "Period start", "date"), col("end", "Period end", "date"), col("hours", "Hours", "number"), col("status", "Status"), col("submitted", "Submitted", "date"), col("decided", "Decided on", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, t.period_start::text AS start, t.period_end::text AS "end", ROUND(COALESCE(t.total_minutes, 0) / 60.0, 1) AS hours, ${LABEL("t.status")} AS status,
           t.submitted_at::date::text AS submitted, t.decided_at::date::text AS decided
      FROM ${TS_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${TS_RANGE(q)} ORDER BY t.period_start DESC, name`,
};
const TS_BY_UNIT: ReportSectionSpec = {
  key: "timesheets-by-unit",
  title: "Timesheets by organisation unit",
  description: "Timesheets by status for each unit.",
  columns: [col("label", "Organisation unit"), col("timesheets", "Timesheets", "number"), col("draft", "Draft", "number"), col("pending", "Waiting", "number"), col("approved", "Approved", "number"), col("rejected", "Rejected", "number"), col("hours", "Hours", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS timesheets, COUNT(*) FILTER (WHERE t.status = 'draft')::int AS draft, COUNT(*) FILTER (WHERE t.status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE t.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE t.status = 'rejected')::int AS rejected, ${hours("t.total_minutes")} AS hours
      FROM ${TS_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${TS_RANGE(q)} GROUP BY ou.name ORDER BY timesheets DESC, label`,
};
const TS_BY_PERIOD: ReportSectionSpec = {
  key: "timesheets-by-period",
  title: "Timesheets by period",
  description: "Submission and approval for each timesheet period.",
  columns: [col("start", "Period start", "date"), col("timesheets", "Timesheets", "number"), col("submitted", "Submitted", "number"), col("approved", "Approved", "number"), col("hours", "Hours", "number")],
  sql: (q) => `
    SELECT t.period_start::text AS start, COUNT(*)::int AS timesheets, COUNT(*) FILTER (WHERE t.status <> 'draft')::int AS submitted, COUNT(*) FILTER (WHERE t.status = 'approved')::int AS approved, ${hours("t.total_minutes")} AS hours
      FROM ${TS_FROM} WHERE ${q.emp()} AND ${TS_RANGE(q)} GROUP BY t.period_start ORDER BY t.period_start DESC`,
};
const TS_PENDING_BY_UNIT: ReportSectionSpec = {
  key: "waiting-by-unit",
  title: "Waiting timesheets by organisation unit",
  description: "Timesheets still waiting for approval and how long they have waited.",
  columns: [col("label", "Organisation unit"), col("waiting", "Waiting", "number"), col("avgDays", "Average days waiting", "number"), col("oldest", "Oldest (days)", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS waiting, ROUND(AVG(${q.today} - COALESCE(t.submitted_at::date, t.updated_at::date)), 1) AS "avgDays", MAX(${q.today} - COALESCE(t.submitted_at::date, t.updated_at::date))::int AS oldest
      FROM ${TS_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND t.status = 'pending' GROUP BY ou.name ORDER BY waiting DESC, label`,
};
const TS_WAIT_BANDS: ReportSectionSpec = {
  key: "waiting-bands",
  title: "How long timesheets have waited",
  description: "Waiting timesheets grouped by days since submission.",
  columns: [col("label", "Waiting"), col("waiting", "Timesheets", "number")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS waiting FROM (SELECT CASE WHEN w <= 2 THEN '1 0 to 2 days' WHEN w <= 7 THEN '2 3 to 7 days' WHEN w <= 14 THEN '3 8 to 14 days' ELSE '4 Over 14 days' END AS label
      FROM (SELECT (${q.today} - COALESCE(t.submitted_at::date, t.updated_at::date)) AS w FROM ${TS_FROM} WHERE ${q.emp()} AND t.status = 'pending') x) b GROUP BY b.label ORDER BY b.label`,
};
const TS_PENDING_RECORDS: ReportSectionSpec = {
  key: "waiting-records",
  title: "Waiting timesheets with hours",
  description: "Each timesheet waiting for approval, with its period, hours and the date it was submitted.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("start", "Period start", "date"), col("end", "Period end", "date"), col("hours", "Hours", "number"), col("submitted", "Submitted", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, t.period_start::text AS start, t.period_end::text AS "end", ROUND(COALESCE(t.total_minutes, 0) / 60.0, 1) AS hours, t.submitted_at::date::text AS submitted
      FROM ${TS_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND t.status = 'pending' ORDER BY t.submitted_at NULLS LAST, name`,
};
const TS_NOT_SUBMITTED: ReportSectionSpec = {
  key: "drafts",
  title: "Timesheets still in draft",
  description: "Timesheets whose period has ended but were never submitted.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("start", "Period start", "date"), col("end", "Period end", "date"), col("hours", "Hours", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, t.period_start::text AS start, t.period_end::text AS "end", ROUND(COALESCE(t.total_minutes, 0) / 60.0, 1) AS hours
      FROM ${TS_FROM} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${TS_RANGE(q)} AND t.status = 'draft' AND t.period_end < ${q.today} ORDER BY t.period_end, name`,
};

// ---------------------------------------------------------------- leave

const LV_FROM = "leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type";
const TYPE_NAME = "COALESCE(lt.name, INITCAP(REPLACE(lr.leave_type, '_', ' ')))";
const typeCond = (q: Q) => {
  const v = q.filter("leaveType");
  return v ? `lr.leave_type = ${q.bind(v)}` : "TRUE";
};
const DAYS_IN_RANGE = (q: Q) => `CASE WHEN lr.start_date >= ${q.from} AND lr.end_date <= ${q.to} THEN lr.days_requested ELSE lr.days_requested * ((LEAST(lr.end_date, ${q.to}) - GREATEST(lr.start_date, ${q.from}) + 1)::numeric / (lr.end_date - lr.start_date + 1)) END`;

const lvRequests = (key: string, title: string, description: string, where: (q: Q) => string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [...IDENT, col("unit", "Organisation unit"), col("type", "Leave type"), col("start", "From", "date"), col("end", "To", "date"), col("days", "Days", "number"), col("part", "Day part"), col("status", "Status"), col("filed", "Filed on", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${TYPE_NAME} AS type, lr.start_date::text AS start, lr.end_date::text AS "end", lr.days_requested AS days,
           ${LABEL("COALESCE(lr.day_part, 'full')")} AS part, ${LABEL("lr.status")} AS status, lr.created_at::date::text AS filed
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND ${where(q)} ORDER BY lr.start_date DESC, name`,
});
const LV_STARTING = lvRequests("leave-requests", "Leave requests", "Every request whose first day falls in the range, with status. Reasons and attachments are not shown.", (q) => `lr.start_date BETWEEN ${q.from} AND ${q.to}`);
const LV_APPROVED_IN_RANGE = lvRequests("leave-approved", "Approved leave in the range", "Approved requests that overlap the range.", (q) => `lr.status = 'approved' AND lr.start_date <= ${q.to} AND lr.end_date >= ${q.from}`);
const LV_UPCOMING = lvRequests("leave-upcoming", "Approved leave coming up", "Approved leave that starts or runs during the range.", (q) => `lr.status = 'approved' AND lr.start_date <= ${q.to} AND lr.end_date >= ${q.from}`);
const LV_PENDING = lvRequests("leave-pending", "Requests waiting for a decision", "Pending requests, oldest first.", () => "lr.status = 'pending'");
const lvBy = (key: string, title: string, description: string, label: string, expr: string, rangeDef: "approved-overlap" | "start" = "approved-overlap"): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("label", label), col("people", "People", "number"), col("requests", "Requests", "number"), col("days", "Days", "number"), col("avgDays", "Average days per request", "number")],
  sql: (q) => `
    SELECT ${expr} AS label, COUNT(DISTINCT lr.employee_id)::int AS people, COUNT(*)::int AS requests, ROUND(SUM(${rangeDef === "start" ? "lr.days_requested" : DAYS_IN_RANGE(q)}), 1) AS days, ROUND(AVG(lr.days_requested), 1) AS "avgDays"
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND ${rangeDef === "start" ? `lr.start_date BETWEEN ${q.from} AND ${q.to}` : `lr.status = 'approved' AND lr.start_date <= ${q.to} AND lr.end_date >= ${q.from}`} GROUP BY 1 ORDER BY days DESC NULLS LAST, label`,
});
const LV_BY_TYPE = lvBy("leave-by-type", "Approved leave by type", "Approved leave days for each leave type in the range.", "Leave type", TYPE_NAME);
const LV_BY_UNIT = lvBy("leave-by-unit", "Approved leave by organisation unit", "Approved leave days for each unit in the range.", "Organisation unit", "COALESCE(ou.name, 'Not set')");
const LV_BY_LOCATION = lvBy("leave-by-location", "Approved leave by location", "Approved leave days for each location in the range.", "Location", "COALESCE((SELECT l.name FROM locations l WHERE l.id = e.location_id), 'Not set')");
const LV_BY_MONTH = lvBy("leave-by-month", "Approved leave by month of first day", "Approved leave by the month it starts.", "Month", "to_char(lr.start_date, 'YYYY-MM')");
const LV_BY_WEEKDAY = lvBy("leave-by-weekday", "Leave by starting weekday", "Which weekday leave starts on.", "Weekday", "to_char(lr.start_date, 'Dy')");
const LV_PER_PERSON: ReportSectionSpec = {
  key: "leave-per-person",
  title: "Approved leave per person",
  description: "Days of approved leave each person has in the range.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("requests", "Requests", "number"), col("days", "Days", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS requests, ROUND(SUM(${DAYS_IN_RANGE(q)}), 1) AS days
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.status = 'approved' AND lr.start_date <= ${q.to} AND lr.end_date >= ${q.from} GROUP BY e.id, ou.name ORDER BY days DESC, name`,
};
const LV_STATUS_BY_TYPE: ReportSectionSpec = {
  key: "status-by-type",
  title: "Status by leave type",
  description: "Requests starting in the range by leave type and status.",
  columns: [col("label", "Leave type"), col("status", "Status"), col("requests", "Requests", "number"), col("days", "Days", "number")],
  sql: (q) => `
    SELECT ${TYPE_NAME} AS label, ${LABEL("lr.status")} AS status, COUNT(*)::int AS requests, ROUND(SUM(lr.days_requested), 1) AS days
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.start_date BETWEEN ${q.from} AND ${q.to} GROUP BY 1, lr.status ORDER BY label, requests DESC`,
};
const LV_STATUS_BY_UNIT: ReportSectionSpec = {
  key: "status-by-unit",
  title: "Status by organisation unit",
  description: "Requests starting in the range by unit and status.",
  columns: [col("label", "Organisation unit"), col("requests", "Requests", "number"), col("approved", "Approved", "number"), col("rejected", "Rejected", "number"), col("pending", "Pending", "number"), col("cancelled", "Cancelled", "number"), col("rate", "Approval rate (%)", "percent")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE lr.status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE lr.status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE lr.status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE lr.status = 'cancelled')::int AS cancelled,
           ROUND(COUNT(*) FILTER (WHERE lr.status = 'approved') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE lr.status IN ('approved', 'rejected')), 0), 1) AS rate
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.start_date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.name ORDER BY requests DESC, label`,
};
const LV_REJECTIONS: ReportSectionSpec = {
  key: "rejections",
  title: "Rejected requests",
  description: "Requests that were rejected, with the rejection reason given by the approver.",
  columns: [...IDENT, col("type", "Leave type"), col("start", "From", "date"), col("days", "Days", "number"), col("reason", "Rejection reason")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${TYPE_NAME} AS type, lr.start_date::text AS start, lr.days_requested AS days, COALESCE(NULLIF(lr.rejection_reason, ''), 'Not recorded') AS reason
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.status = 'rejected' AND lr.start_date BETWEEN ${q.from} AND ${q.to} ORDER BY lr.start_date DESC, name`,
};
const LV_DECISIONS: ReportSectionSpec = {
  key: "decision-times",
  title: "Decisions and how long they took",
  description: "Each decided request with the hours between filing and the decision.",
  columns: [...IDENT, col("type", "Leave type"), col("status", "Outcome"), col("filed", "Filed", "date"), col("hours", "Hours to decide", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${TYPE_NAME} AS type, ${LABEL("lr.status")} AS status, lr.created_at::date::text AS filed, ROUND((EXTRACT(EPOCH FROM (lr.updated_at - lr.created_at)) / 3600.0)::numeric, 1) AS hours
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.status IN ('approved', 'rejected') AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} ORDER BY hours DESC, name`,
};
const LV_DECISION_BANDS: ReportSectionSpec = {
  key: "decision-bands",
  title: "Decision speed",
  description: "How many decided requests were settled within each time.",
  columns: [col("label", "Decided within"), col("requests", "Requests", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS requests, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN h <= 24 THEN '1 One day' WHEN h <= 72 THEN '2 Three days' WHEN h <= 168 THEN '3 One week' ELSE '4 More than a week' END AS label
              FROM (SELECT EXTRACT(EPOCH FROM (lr.updated_at - lr.created_at)) / 3600.0 AS h FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.status IN ('approved', 'rejected') AND lr.created_at::date BETWEEN ${q.from} AND ${q.to}) x) b GROUP BY b.label ORDER BY b.label`,
};
const LV_DECISION_BY_UNIT: ReportSectionSpec = {
  key: "decision-by-unit",
  title: "Decision speed by organisation unit",
  description: "Average hours to decide, per unit.",
  columns: [col("label", "Organisation unit"), col("decided", "Decided", "number"), col("avgHours", "Average hours", "number"), col("slowest", "Slowest (hours)", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS decided, ROUND(AVG(EXTRACT(EPOCH FROM (lr.updated_at - lr.created_at)) / 3600.0)::numeric, 1) AS "avgHours", ROUND(MAX(EXTRACT(EPOCH FROM (lr.updated_at - lr.created_at)) / 3600.0)::numeric, 1) AS slowest
      FROM ${LV_FROM} WHERE ${q.emp()} AND ${typeCond(q)} AND lr.status IN ('approved', 'rejected') AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.name ORDER BY "avgHours" DESC NULLS LAST, label`,
};

// balances

const LB_FROM = "leave_balances lb JOIN employees e ON e.id = lb.employee_id AND e.company_id = lb.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN leave_types lt ON lt.company_id = lb.company_id AND lt.code = lb.leave_type";
const LB_TYPE = "COALESCE(lt.name, INITCAP(REPLACE(lb.leave_type, '_', ' ')))";
const lbType = (q: Q) => {
  const v = q.filter("leaveType");
  return v ? `lb.leave_type = ${q.bind(v)}` : "TRUE";
};
const LB_YEAR = (q: Q) => `lb.year = EXTRACT(YEAR FROM ${q.today})::int`;
const LB_PER_PERSON: ReportSectionSpec = {
  key: "balances",
  title: "Balances per person",
  description: "Entitlement, days used and days left for every person and leave type this year.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("type", "Leave type"), col("entitled", "Entitled", "number"), col("used", "Used", "number"), col("remaining", "Left", "number"), col("carried", "Carried forward", "number"), col("used_pct", "Used (%)", "percent")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LB_TYPE} AS type, lb.entitled_days AS entitled, lb.used_days AS used, (lb.entitled_days - lb.used_days) AS remaining,
           lb.carried_forward_days AS carried, ROUND(lb.used_days * 100.0 / NULLIF(lb.entitled_days, 0), 1) AS used_pct
      FROM ${LB_FROM} WHERE ${q.emp()} AND ${lbType(q)} AND ${LB_YEAR(q)} ORDER BY name, type`,
};
const LB_OVER: ReportSectionSpec = {
  key: "balances-over",
  title: "People over their balance",
  description: "People who have used more than their entitlement.",
  columns: [...IDENT, col("type", "Leave type"), col("entitled", "Entitled", "number"), col("used", "Used", "number"), col("over", "Over by", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LB_TYPE} AS type, lb.entitled_days AS entitled, lb.used_days AS used, (lb.used_days - lb.entitled_days) AS over
      FROM ${LB_FROM} WHERE ${q.emp()} AND ${lbType(q)} AND ${LB_YEAR(q)} AND lb.used_days > lb.entitled_days ORDER BY over DESC, name`,
};
const LB_BY_UNIT_TYPE: ReportSectionSpec = {
  key: "balances-by-unit-type",
  title: "Balances by organisation unit and leave type",
  description: "Entitled, used and left for each unit and leave type this year.",
  columns: [col("label", "Organisation unit"), col("type", "Leave type"), col("people", "People", "number"), col("entitled", "Entitled", "number"), col("used", "Used", "number"), col("remaining", "Left", "number"), col("utilisation", "Used (%)", "percent")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, ${LB_TYPE} AS type, COUNT(DISTINCT lb.employee_id)::int AS people, ROUND(SUM(lb.entitled_days), 1) AS entitled, ROUND(SUM(lb.used_days), 1) AS used,
           ROUND(SUM(lb.entitled_days - lb.used_days), 1) AS remaining, ROUND(SUM(lb.used_days) * 100.0 / NULLIF(SUM(lb.entitled_days), 0), 1) AS utilisation
      FROM ${LB_FROM} WHERE ${q.emp()} AND ${lbType(q)} AND ${LB_YEAR(q)} GROUP BY ou.name, 2 ORDER BY label, type`,
};
const LB_BY_TYPE: ReportSectionSpec = {
  key: "balances-by-type",
  title: "Balance components by leave type",
  description: "How each leave type's entitlement is made up: opening, accrued, carried forward, adjusted, used, encashed and expired.",
  columns: [col("label", "Leave type"), col("opening", "Opening", "number"), col("accrued", "Accrued", "number"), col("carried", "Carried forward", "number"), col("adjusted", "Adjusted", "number"), col("used", "Used", "number"), col("encashed", "Encashed", "number"), col("expired", "Expired", "number")],
  sql: (q) => `
    SELECT ${LB_TYPE} AS label, ROUND(SUM(COALESCE(lb.opening_days, 0)), 1) AS opening, ROUND(SUM(COALESCE(lb.accrued_days, 0)), 1) AS accrued, ROUND(SUM(COALESCE(lb.carried_forward_days, 0)), 1) AS carried,
           ROUND(SUM(COALESCE(lb.adjusted_days, 0)), 1) AS adjusted, ROUND(SUM(lb.used_days), 1) AS used, ROUND(SUM(COALESCE(lb.encashed_days, 0)), 1) AS encashed, ROUND(SUM(COALESCE(lb.expired_days, 0)), 1) AS expired
      FROM ${LB_FROM} WHERE ${q.emp()} AND ${lbType(q)} AND ${LB_YEAR(q)} GROUP BY 1 ORDER BY label`,
};
const LB_HIGH: ReportSectionSpec = {
  key: "balances-high",
  title: "Largest unused balances",
  description: "People holding the most unused days.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("type", "Leave type"), col("remaining", "Days left", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LB_TYPE} AS type, (lb.entitled_days - lb.used_days) AS remaining
      FROM ${LB_FROM} WHERE ${q.emp()} AND ${lbType(q)} AND ${LB_YEAR(q)} AND lb.entitled_days - lb.used_days > 0 ORDER BY remaining DESC, name`,
};
const LV_CARRY: ReportSectionSpec = {
  key: "carry-forward",
  title: "Carry-forward by leave type",
  description: "Carry-forward days against each leave type's cap, this year and last.",
  columns: [col("label", "Leave type"), col("rule", "Carry-forward rule"), col("people", "People with a carry-forward", "number"), col("carried", "Days carried", "number"), col("cap", "Cap per person", "number")],
  sql: (q) => `
    SELECT ${LB_TYPE} AS label, CASE WHEN lt.carry_forward_allowed THEN 'Allowed' ELSE 'Not allowed' END AS rule, COUNT(*) FILTER (WHERE lb.carried_forward_days > 0)::int AS people,
           ROUND(SUM(COALESCE(lb.carried_forward_days, 0)), 1) AS carried, lt.carry_forward_cap_days AS cap
      FROM ${LB_FROM} WHERE ${q.emp()} AND ${lbType(q)} GROUP BY 1, lt.carry_forward_allowed, lt.carry_forward_cap_days ORDER BY label`,
};
const LEDGER_RECORDS: ReportSectionSpec = {
  key: "ledger",
  title: "Ledger entries",
  description: "Every leave ledger entry (accruals, usage, adjustments, expiry) for the people in scope this year, newest first.",
  columns: [col("date", "Effective", "date"), ...IDENT, col("type", "Leave type"), col("entry", "Entry"), col("days", "Days", "number"), col("source", "Source")],
  sql: (q) => `
    SELECT g.effective_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(lt.name, ${LABEL("g.leave_type")}) AS type, ${LABEL("g.entry_type")} AS entry, g.days, ${LABEL("COALESCE(g.source_type, 'manual')")} AS source
      FROM leave_ledger g JOIN employees e ON e.id = g.employee_id AND e.company_id = g.company_id LEFT JOIN leave_types lt ON lt.company_id = g.company_id AND lt.code = g.leave_type
     WHERE ${q.emp()} AND ${q.filter("leaveType") ? `g.leave_type = ${q.bind(q.filter("leaveType") as string)}` : "TRUE"} AND g.year = EXTRACT(YEAR FROM ${q.today})::int ORDER BY g.effective_date DESC, name`,
};
const LEDGER_BY_ENTRY: ReportSectionSpec = {
  key: "ledger-by-entry",
  title: "Ledger by entry kind",
  description: "Total days by kind of ledger entry this year.",
  columns: [col("label", "Entry"), col("entries", "Entries", "number"), col("days", "Days", "number")],
  sql: (q) => `
    SELECT ${LABEL("g.entry_type")} AS label, COUNT(*)::int AS entries, ROUND(SUM(g.days), 1) AS days FROM leave_ledger g JOIN employees e ON e.id = g.employee_id AND e.company_id = g.company_id
     WHERE ${q.emp()} AND ${q.filter("leaveType") ? `g.leave_type = ${q.bind(q.filter("leaveType") as string)}` : "TRUE"} AND g.year = EXTRACT(YEAR FROM ${q.today})::int GROUP BY g.entry_type ORDER BY entries DESC, label`,
};
const OVERLAPS_BY_UNIT: ReportSectionSpec = {
  key: "overlaps-by-unit",
  title: "Overlapping requests by organisation unit",
  description: "People with two pending or approved requests covering the same days.",
  columns: [col("label", "Organisation unit"), col("people", "People", "number"), col("pairs", "Overlapping pairs", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(DISTINCT a.employee_id)::int AS people, COUNT(*)::int AS pairs
      FROM leave_requests a JOIN leave_requests b ON b.employee_id = a.employee_id AND b.company_id = a.company_id AND b.id > a.id AND b.status IN ('pending', 'approved') AND a.start_date <= b.end_date AND b.start_date <= a.end_date
      JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND a.status IN ('pending', 'approved') AND a.start_date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.name ORDER BY pairs DESC, label`,
};
const OVERLAP_RECORDS: ReportSectionSpec = {
  key: "overlap-records",
  title: "Overlapping requests in detail",
  description: "Each pair of overlapping requests with dates and status.",
  columns: [...IDENT, col("firstStart", "First request from", "date"), col("firstEnd", "To", "date"), col("firstStatus", "Status"), col("secondStart", "Second request from", "date"), col("secondEnd", "To", "date"), col("secondStatus", "Status")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, a.start_date::text AS "firstStart", a.end_date::text AS "firstEnd", ${LABEL("a.status")} AS "firstStatus", b.start_date::text AS "secondStart", b.end_date::text AS "secondEnd", ${LABEL("b.status")} AS "secondStatus"
      FROM leave_requests a JOIN leave_requests b ON b.employee_id = a.employee_id AND b.company_id = a.company_id AND b.id > a.id AND b.status IN ('pending', 'approved') AND a.start_date <= b.end_date AND b.start_date <= a.end_date
      JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id
     WHERE ${q.emp()} AND a.status IN ('pending', 'approved') AND a.start_date BETWEEN ${q.from} AND ${q.to} ORDER BY a.start_date, name`,
};
const POLICY_BY_KIND: ReportSectionSpec = {
  key: "policy-by-kind",
  title: "Policy breaches by kind",
  description: "Requests that break their leave type's own rules, counted by rule.",
  columns: [col("label", "Rule broken"), col("requests", "Requests", "number")],
  sql: (q) => `
    SELECT x.label, COUNT(*)::int AS requests FROM (
      SELECT 'Longer than allowed' AS label FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
       WHERE ${q.emp()} AND lr.status IN ('pending', 'approved') AND lr.start_date BETWEEN ${q.from} AND ${q.to} AND lt.max_consecutive_days IS NOT NULL AND lr.days_requested > lt.max_consecutive_days
      UNION ALL SELECT 'Document missing' FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
       WHERE ${q.emp()} AND lr.status IN ('pending', 'approved') AND lr.start_date BETWEEN ${q.from} AND ${q.to} AND lt.document_required AND lr.days_requested > COALESCE(lt.document_required_after_days, 0) AND lr.attachment_document_id IS NULL
      UNION ALL SELECT 'Half day not allowed' FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
       WHERE ${q.emp()} AND lr.status IN ('pending', 'approved') AND lr.start_date BETWEEN ${q.from} AND ${q.to} AND NOT lt.half_day_allowed AND lr.day_part <> 'full'
      UNION ALL SELECT 'Not enough service' FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id JOIN leave_types lt ON lt.company_id = lr.company_id AND lt.code = lr.leave_type
       WHERE ${q.emp()} AND lr.status IN ('pending', 'approved') AND lr.start_date BETWEEN ${q.from} AND ${q.to} AND lt.min_service_months > 0 AND e.date_of_joining > (lr.start_date - make_interval(months => lt.min_service_months))::date) x GROUP BY x.label ORDER BY requests DESC, x.label`,
};
const UNPLANNED_RECORDS: ReportSectionSpec = {
  key: "unplanned",
  title: "Unplanned absence in detail",
  description: "Leave filed on or after its first day, and absent days with no leave.",
  columns: [col("date", "Date", "date"), ...IDENT, col("kind", "Kind"), col("detail", "Detail")],
  sql: (q) => `
    SELECT * FROM (
      SELECT lr.start_date::text AS date, e.employee_number AS number, ${NAME("e")} AS name, 'Filed late' AS kind, ${TYPE_NAME} || ', filed ' || lr.created_at::date::text AS detail
        FROM ${LV_FROM} WHERE ${q.emp()} AND lr.status = 'approved' AND lr.start_date BETWEEN ${q.from} AND ${q.to} AND lr.created_at::date >= lr.start_date
      UNION ALL
      SELECT r.work_date::text, e.employee_number, ${NAME("e")}, 'Absent without leave', 'No leave or duty cover' FROM ${DAILY} WHERE ${q.emp()} AND ${IN_RANGE(q)} AND r.status = 'absent') t ORDER BY date DESC, name`,
};
const UNPLANNED_BY_UNIT: ReportSectionSpec = {
  key: "unplanned-by-unit",
  title: "Unplanned absence by organisation unit",
  description: "Late-filed leave and absent days for each unit.",
  columns: [col("label", "Organisation unit"), col("filedLate", "Leave filed late", "number"), col("absent", "Absent days", "number"), col("total", "Total", "number")],
  sql: (q) => `
    SELECT u.label, SUM(u.filed)::int AS "filedLate", SUM(u.abs)::int AS absent, SUM(u.filed + u.abs)::int AS total
      FROM (SELECT COALESCE(ou.name, 'Not set') AS label, 1 AS filed, 0 AS abs FROM ${LV_FROM} WHERE ${q.emp()} AND lr.status = 'approved' AND lr.start_date BETWEEN ${q.from} AND ${q.to} AND lr.created_at::date >= lr.start_date
            UNION ALL SELECT COALESCE(ou.name, 'Not set'), 0, 1 FROM ${DAILY} LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${IN_RANGE(q)} AND r.status = 'absent') u GROUP BY u.label ORDER BY total DESC, u.label`,
};
const CALENDAR_PEOPLE: ReportSectionSpec = {
  key: "who-is-away",
  title: "Who is away each day",
  description: "For every day in the range, each person on approved leave.",
  columns: [col("date", "Date", "date"), col("weekday", "Day"), ...IDENT, col("unit", "Organisation unit"), col("type", "Leave type")],
  sql: (q) => `
    WITH d AS (SELECT gs::date AS day FROM generate_series(${q.from}, ${q.to}, interval '1 day') gs)
    SELECT d.day::text AS date, to_char(d.day, 'Dy') AS weekday, e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${TYPE_NAME} AS type
      FROM d JOIN ${LV_FROM} ON lr.status = 'approved' AND d.day BETWEEN lr.start_date AND lr.end_date WHERE ${q.emp()} ORDER BY d.day, name`,
};
const CALENDAR_BY_UNIT: ReportSectionSpec = {
  key: "away-by-unit",
  title: "People away by organisation unit",
  description: "For each unit: the most people away on any day in the range and the total person-days away.",
  columns: [col("label", "Organisation unit"), col("peak", "Most away in a day", "number"), col("personDays", "Person-days away", "number")],
  sql: (q) => `
    SELECT p.label, MAX(p.n)::int AS peak, SUM(p.n)::int AS "personDays"
      FROM (SELECT COALESCE(ou.name, 'Not set') AS label, d.day, COUNT(DISTINCT lr.employee_id) AS n
              FROM (SELECT gs::date AS day FROM generate_series(${q.from}, ${q.to}, interval '1 day') gs) d JOIN ${LV_FROM} ON lr.status = 'approved' AND d.day BETWEEN lr.start_date AND lr.end_date WHERE ${q.emp()} GROUP BY ou.name, d.day) p
     GROUP BY p.label ORDER BY "personDays" DESC, p.label`,
};
const HOLIDAYS: ReportSectionSpec = {
  key: "holidays",
  title: "Holidays in the range",
  description: "Company holidays and the number of people away on leave on the same day.",
  columns: [col("date", "Date", "date"), col("weekday", "Day"), col("name", "Holiday"), col("optional", "Optional"), col("away", "People on leave", "number")],
  sql: (q) => `
    SELECT h.holiday_date::text AS date, to_char(h.holiday_date, 'Dy') AS weekday, h.name, CASE WHEN h.is_optional THEN 'Yes' ELSE 'No' END AS optional,
           (SELECT COUNT(DISTINCT lr.employee_id) FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id WHERE ${q.emp()} AND lr.status = 'approved' AND h.holiday_date BETWEEN lr.start_date AND lr.end_date)::int AS away
      FROM holidays h WHERE ${q.co("h")} AND h.holiday_date BETWEEN ${q.from} AND ${q.to} ORDER BY h.holiday_date`,
};
const LEAVE_BY_WEEKDAY_AWAY: ReportSectionSpec = {
  key: "away-by-weekday",
  title: "People away by weekday",
  description: "Average people on leave for each weekday in the range.",
  columns: [col("label", "Weekday"), col("days", "Days in range", "number"), col("avgAway", "Average people away", "number")],
  sql: (q) => `
    SELECT p.label, COUNT(*)::int AS days, ROUND(AVG(p.n), 1) AS "avgAway"
      FROM (SELECT to_char(d.day, 'Dy') AS label, EXTRACT(ISODOW FROM d.day) AS dow, (SELECT COUNT(DISTINCT lr.employee_id) FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id WHERE ${q.emp()} AND lr.status = 'approved' AND d.day BETWEEN lr.start_date AND lr.end_date) AS n
              FROM (SELECT gs::date AS day FROM generate_series(${q.from}, ${q.to}, interval '1 day') gs) d) p GROUP BY p.label, p.dow ORDER BY p.dow`,
};

export const TIME_LEAVE_DEPTH: Record<string, ReportSectionSpec[]> = {
  D01: [A_BY_DAY, A_BY_WEEKDAY, A_BY_UNIT, A_BY_LOCATION, A_PER_PERSON, A_STATUS_MIX, A_DAY_RECORDS],
  D02: [A_BY_MONTH, A_BY_WEEK, A_BY_UNIT, A_BY_TYPE, A_PER_PERSON, A_STATUS_MIX],
  D03: [LATE_DAYS, LATE_BANDS, A_BY_UNIT, A_BY_WEEKDAY, A_BY_WEEK],
  D04: [EARLY_DAYS, EARLY_BANDS, A_BY_UNIT, A_BY_WEEKDAY, A_BY_WEEK],
  D05: [ABSENT_DAYS, ABSENT_PER_PERSON, A_BY_UNIT, A_BY_WEEKDAY, A_BY_WEEK],
  D06: [OPEN_PUNCHES, PUNCH_EXCEPTIONS_BY_KIND, PUNCH_EXCEPTIONS_BY_UNIT, A_DAY_RECORDS],
  D07: [CORRECTIONS, CORR_BY_UNIT, CORR_BY_MONTH, CORR_PER_PERSON],
  D08: [OVERTIME, OT_BY_UNIT, OT_BY_MONTH, OT_PER_PERSON, OT_BY_STATUS],
  D09: [OT_PAY_BY_UNIT, OT_PAY_BY_DAYTYPE, OT_PAY_RECORDS, OT_BY_MONTH],
  D10: [ADHERENCE_BY_PERSON, A_BY_WEEKDAY, A_BY_WEEK, LATE_DAYS, EARLY_DAYS],
  D11: [A_PER_PERSON, A_BY_DAY, A_BY_WEEK, A_BY_WEEKDAY, A_STATUS_MIX],
  D12: [A_PER_PERSON, A_BY_UNIT, A_BY_DAY, A_BY_WEEK, A_STATUS_MIX],
  D13: [SCHEDULE_COMPLIANCE_RECORDS, NO_SCHEDULE_PEOPLE, A_BY_LOCATION, A_BY_MONTH],
  D14: [TIMESHEETS, TS_BY_UNIT, TS_BY_PERIOD, TS_NOT_SUBMITTED],
  D15: [TS_PENDING_BY_UNIT, TS_WAIT_BANDS, TS_PENDING_RECORDS],
  E01: [LB_PER_PERSON, LB_BY_UNIT_TYPE, LB_BY_TYPE, LB_OVER, LB_HIGH],
  E02: [LV_APPROVED_IN_RANGE, LV_BY_UNIT, LV_BY_LOCATION, LV_BY_MONTH, LV_PER_PERSON, LV_BY_WEEKDAY],
  E03: [LV_STARTING, LV_STATUS_BY_TYPE, LV_STATUS_BY_UNIT, LV_REJECTIONS, LV_PENDING],
  E04: [LV_DECISIONS, LV_DECISION_BANDS, LV_DECISION_BY_UNIT, LV_PENDING],
  E05: [LV_UPCOMING, CALENDAR_BY_UNIT, CALENDAR_PEOPLE, LV_BY_TYPE],
  E06: [UNPLANNED_RECORDS, UNPLANNED_BY_UNIT, LV_BY_UNIT],
  E08: [LV_CARRY, LB_PER_PERSON, LEDGER_RECORDS, LEDGER_BY_ENTRY],
  E09: [LB_BY_UNIT_TYPE, LB_PER_PERSON, LB_BY_TYPE, LB_HIGH],
  E10: [LEDGER_RECORDS, LEDGER_BY_ENTRY, LB_PER_PERSON, LB_BY_TYPE],
  E11: [OVERLAP_RECORDS, OVERLAPS_BY_UNIT, LV_STARTING],
  E12: [LV_APPROVED_IN_RANGE, LV_BY_TYPE, LV_PER_PERSON, LV_BY_MONTH, LV_BY_UNIT],
  E13: [LV_APPROVED_IN_RANGE, LV_BY_TYPE, LV_PER_PERSON, LV_BY_MONTH, LV_BY_LOCATION],
  E14: [CALENDAR_PEOPLE, CALENDAR_BY_UNIT, HOLIDAYS, LEAVE_BY_WEEKDAY_AWAY],
  E15: [POLICY_BY_KIND, LV_STARTING, LV_BY_TYPE],
};
