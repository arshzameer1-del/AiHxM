import { DEPT, ETYPE, LOC, barChart, count, donutChart, lineChart, listReport, num, pct, percent, round1, sqlReport, stackedChart, sum } from "../report-spec";

/**
 * Self-service and employee-service reports (catalog I01 to I14, except the blocked ones). They answer "are people using
 * the portal and are the notifications and tasks reaching them". They need administration rights (employee.manage.all)
 * because they describe sign-in activity, and they never show passwords, secrets, IP addresses or notification bodies.
 *
 * Sign-in facts come from app.report_company_accounts() and app.report_company_sessions() (migration 0165): narrow functions
 * that return only non-secret columns, only for people who belong to the caller's company.
 */

const LABEL = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const FILTERS = [DEPT, LOC, ETYPE];
const ACCOUNTS = "app.report_company_accounts()";
const SESSIONS = "app.report_company_sessions()";
const RECENT_DAYS = 30;
/** Onboarding and offboarding tasks record who may act on them: the employee, their manager, or HR and administrators. */
const ACTOR_ROLE = (col: string) => `CASE ${col} WHEN 'self' THEN 'The employee' WHEN 'team' THEN 'The line manager' WHEN 'all' THEN 'HR and administrators' ELSE 'Not assigned' END`;

export const I01 = sqlReport({
  description: "How many current employees have a portal login, have actually signed in, and signed in during the last 30 days.",
  filters: FILTERS,
  tables: ["employees", "user_accounts"],
  viz: ["bar", "kpi", "table"],
  tags: ["adoption", "portal", "login"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "employees", label: "Employees", type: "number" },
    { key: "withLogin", label: "With a login", type: "number" },
    { key: "signedIn", label: "Ever signed in", type: "number" },
    { key: "recent", label: `Signed in, last ${RECENT_DAYS} days`, type: "number" },
    { key: "rate", label: "Active in last 30 days (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS unit, COUNT(*)::int AS employees, COUNT(acc.user_account_id)::int AS "withLogin",
           COUNT(*) FILTER (WHERE acc.last_login_at IS NOT NULL)::int AS "signedIn",
           COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS})::int AS recent,
           ROUND(COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS}) * 100.0 / COUNT(*), 1) AS rate
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN ${ACCOUNTS} acc ON acc.user_account_id = e.user_account_id
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY ou.id, ou.name ORDER BY rate ASC, unit`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Employees active in the last 30 days", unit: "percent", rows, labelKey: "unit", valueKey: "rate", valueLabel: "Active (%)", max: 12 }) : null),
  kpis: ({ rows }) => {
    const n = sum(rows, "employees");
    return [count("employees", "Current employees", n), percent("login", "With a login", pct(sum(rows, "withLogin"), n)), percent("recent", "Active in last 30 days", pct(sum(rows, "recent"), n))];
  },
  calculation: ["Counts current employees in your filters. 'With a login' means the employee record is linked to a user account.", "'Ever signed in' and 'last 30 days' use the account's last sign-in time. People who signed in before but not recently count as ever signed in only."],
});

export const I02 = sqlReport({
  description: "Portal sign-ins by month: sessions started and how many different people signed in.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["user_sessions", "employees"],
  viz: ["line", "kpi", "table"],
  tags: ["login", "usage", "trend"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "sessions", label: "Sessions started", type: "number" },
    { key: "people", label: "Different people", type: "number" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(s.user_account_id)::int AS sessions, COUNT(DISTINCT s.user_account_id)::int AS people
      FROM mo LEFT JOIN (
        SELECT s.user_account_id, s.created_at::date AS day FROM ${SESSIONS} s JOIN employees e ON e.user_account_id = s.user_account_id
         WHERE ${q.emp()}) s ON s.day >= mo.ms AND s.day < mo.ms + interval '1 month'
     GROUP BY mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => (rows.length ? lineChart({ title: "Sessions and people signing in", unit: "count", rows, xKey: "month", series: [{ key: "sessions", label: "Sessions started" }, { key: "people", label: "Different people" }] }) : null),
  kpis: ({ rows }) => [count("sessions", "Sessions started", sum(rows, "sessions")), count("peak", "Busiest month (people)", rows.length ? Math.max(...rows.map((r) => num(r, "people"))) : null)],
  calculation: ["Counts sessions started for employees in your filters, by the month the session began.", "Different people counts each employee once per month."],
  notes: () => ["Only sessions still held by the platform are counted, so months before its retention window show no activity even if people signed in. Administrator-only accounts without an employee record are not included."],
});

export const I03 = sqlReport({
  description: "Requests raised in the portal, by type: how many employees submitted themselves and how many were entered for them.",
  filters: FILTERS,
  defaultRange: "last90Days",
  tables: ["leave_requests", "attendance_correction_requests", "expense_claims", "on_duty_requests", "overtime_records", "timesheets"],
  viz: ["stackedBar", "kpi", "table"],
  tags: ["self service", "transactions"],
  columns: [
    { key: "type", label: "Transaction", type: "text" },
    { key: "total", label: "Submitted", type: "number" },
    { key: "self", label: "By the employee", type: "number" },
    { key: "onBehalf", label: "Entered for the employee", type: "number" },
    { key: "rate", label: "Self-service (%)", type: "percent" },
  ],
  sql: (q) => {
    const branch = (label: string, table: string, alias: string, dateCol: string, byCol: string) => `
      SELECT '${label}' AS type, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${alias}.${byCol} = e.user_account_id)::int AS self
        FROM ${table} ${alias} JOIN employees e ON e.id = ${alias}.employee_id AND e.company_id = ${alias}.company_id
       WHERE ${q.emp()} AND ${alias}.${dateCol}::date BETWEEN ${q.from} AND ${q.to}`;
    return `
    SELECT t.type, t.total, t.self, t.total - t.self AS "onBehalf", ROUND(t.self * 100.0 / NULLIF(t.total, 0), 1) AS rate FROM (
      ${branch("Leave requests", "leave_requests", "x1", "created_at", "submitted_by_user_account_id")}
      UNION ALL ${branch("Attendance corrections", "attendance_correction_requests", "x2", "created_at", "submitted_by_user_account_id")}
      UNION ALL ${branch("Expense claims", "expense_claims", "x3", "created_at", "submitted_by_user_account_id")}
      UNION ALL ${branch("On-duty requests", "on_duty_requests", "x4", "created_at", "submitted_by_user_account_id")}
      UNION ALL ${branch("Overtime claims", "overtime_records", "x5", "created_at", "submitted_by_user_account_id")}
      UNION ALL ${branch("Timesheets", "timesheets", "x6", "created_at", "submitted_by_user_account_id")}
    ) t ORDER BY t.total DESC, t.type`;
  },
  chart: ({ rows }) => (sum(rows, "total") > 0 ? stackedChart({ title: "Submitted by the employee or entered for them", unit: "requests", rows, xKey: "type", series: [{ key: "self", label: "By the employee" }, { key: "onBehalf", label: "Entered for the employee" }] }) : null),
  kpis: ({ rows }) => [count("total", "Transactions", sum(rows, "total")), percent("rate", "Submitted by employees", pct(sum(rows, "self"), sum(rows, "total")))],
  calculation: ["Counts requests created in the range for employees in your filters. A request is self-service when the user who submitted it is the employee's own account.", "Entered for the employee means someone else (a manager or HR) submitted it."],
});

export const I04 = sqlReport({
  description: "Whether people who manage a team use the portal: sign-ins, approvals decided and approvals waiting on them.",
  filters: FILTERS,
  defaultRange: "last90Days",
  tables: ["employees", "org_relationships", "user_accounts", "workflow_step_approvals"],
  viz: ["bar", "table"],
  tags: ["managers", "adoption"],
  columns: [
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "managers", label: "Managers", type: "number" },
    { key: "withLogin", label: "With a login", type: "number" },
    { key: "recent", label: "Signed in, last 30 days", type: "number" },
    { key: "decided", label: "Approvals decided", type: "number" },
    { key: "waiting", label: "Waiting on them now", type: "number" },
    { key: "rate", label: "Active in last 30 days (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(x.unit, 'No organisation unit set') AS unit, COUNT(*)::int AS managers, COUNT(*) FILTER (WHERE x.has_login)::int AS "withLogin", COUNT(*) FILTER (WHERE x.recent)::int AS recent,
           COALESCE(SUM(x.decided), 0)::int AS decided, COALESCE(SUM(x.waiting), 0)::int AS waiting, ROUND(COUNT(*) FILTER (WHERE x.recent) * 100.0 / COUNT(*), 1) AS rate
      FROM (
        SELECT ou.name AS unit, (acc.user_account_id IS NOT NULL) AS has_login, COALESCE(acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS}, false) AS recent,
               (SELECT COUNT(*) FROM workflow_step_approvals a JOIN workflow_step_instances si ON si.id = a.step_instance_id JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
                 WHERE wi.company_id = e.company_id AND a.decided_by_user_account_id = e.user_account_id AND a.decided_at::date BETWEEN ${q.from} AND ${q.to}) AS decided,
               (SELECT COUNT(*) FROM workflow_step_approvals a JOIN workflow_step_instances si ON si.id = a.step_instance_id JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
                 WHERE wi.company_id = e.company_id AND a.user_account_id = e.user_account_id AND a.status IN ('pending', 'escalated') AND si.status = 'pending' AND wi.status = 'in_progress') AS waiting
          FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN ${ACCOUNTS} acc ON acc.user_account_id = e.user_account_id
         WHERE ${q.emp()} AND ${q.current()}
           AND EXISTS (SELECT 1 FROM org_relationships r WHERE r.manager_employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active')
      ) x GROUP BY x.unit ORDER BY rate ASC, unit`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Managers active in the last 30 days", unit: "percent", rows, labelKey: "unit", valueKey: "rate", valueLabel: "Active (%)", max: 12 }) : null),
  kpis: ({ rows }) => {
    const n = sum(rows, "managers");
    return [count("managers", "People managers", n), percent("recent", "Active in last 30 days", pct(sum(rows, "recent"), n)), count("waiting", "Approvals waiting on managers", sum(rows, "waiting"))];
  },
  calculation: ["A manager is a current employee with at least one active direct report. Sign-in activity uses the account's last sign-in time.", "Approvals decided are those the manager's own account decided in the range; waiting counts approvals addressed to them that are open today."],
});

export const I06 = sqlReport({
  description: "Leave requests by month, split into those employees submitted themselves and those entered for them.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["leave_requests", "employees"],
  viz: ["stackedBar", "kpi", "table"],
  tags: ["leave", "self service"],
  columns: [
    { key: "month", label: "Month", type: "text" },
    { key: "total", label: "Requests", type: "number" },
    { key: "self", label: "By the employee", type: "number" },
    { key: "onBehalf", label: "Entered for the employee", type: "number" },
    { key: "rate", label: "Self-service (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH mo AS (${q.months()})
    SELECT to_char(mo.ms, 'YYYY-MM') AS month, COUNT(lr.id)::int AS total, COUNT(lr.id) FILTER (WHERE lr.submitted_by_user_account_id = lr.own_account)::int AS self,
           COUNT(lr.id) FILTER (WHERE lr.submitted_by_user_account_id IS DISTINCT FROM lr.own_account)::int AS "onBehalf",
           ROUND(COUNT(lr.id) FILTER (WHERE lr.submitted_by_user_account_id = lr.own_account) * 100.0 / NULLIF(COUNT(lr.id), 0), 1) AS rate
      FROM mo LEFT JOIN (
        SELECT l.id, l.created_at::date AS day, l.submitted_by_user_account_id, e.user_account_id AS own_account
          FROM leave_requests l JOIN employees e ON e.id = l.employee_id AND e.company_id = l.company_id WHERE ${q.emp()}) lr
        ON lr.day >= mo.ms AND lr.day < mo.ms + interval '1 month'
     GROUP BY mo.ms ORDER BY mo.ms`,
  chart: ({ rows }) => (sum(rows, "total") > 0 ? stackedChart({ title: "Leave requests by month", unit: "requests", rows, xKey: "month", series: [{ key: "self", label: "By the employee" }, { key: "onBehalf", label: "Entered for the employee" }] }) : null),
  kpis: ({ rows }) => [count("total", "Leave requests", sum(rows, "total")), percent("rate", "Submitted by employees", pct(sum(rows, "self"), sum(rows, "total")))],
  calculation: ["Counts leave requests by the month they were created, for employees in your filters.", "A request is self-service when the user who submitted it is the employee's own account."],
});

export const I10 = sqlReport({
  description: "How many current employees have each part of their personal record filled in, so you can see which sections the portal still needs people to complete.",
  filters: FILTERS,
  tables: ["employees", "persons", "employee_contacts", "employee_addresses", "employee_family_members", "employee_education", "employee_payment_accounts"],
  viz: ["bar", "kpi", "table"],
  tags: ["completeness", "portal", "data quality"],
  columns: [
    { key: "section", label: "Section", type: "text" },
    { key: "employees", label: "Employees", type: "number" },
    { key: "complete", label: "With the section filled in", type: "number" },
    { key: "missing", label: "Missing", type: "number" },
    { key: "rate", label: "Complete (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT t.section, COUNT(*)::int AS employees, COUNT(*) FILTER (WHERE t.ok)::int AS complete, COUNT(*) FILTER (WHERE NOT t.ok)::int AS missing, ROUND(COUNT(*) FILTER (WHERE t.ok) * 100.0 / COUNT(*), 1) AS rate
      FROM employees e CROSS JOIN LATERAL (VALUES
        (1, 'Contact details', EXISTS (SELECT 1 FROM employee_contacts c WHERE c.employee_id = e.id AND c.company_id = e.company_id AND c.status = 'active')),
        (2, 'Home address', EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active')),
        (3, 'Family or emergency contact', EXISTS (SELECT 1 FROM employee_family_members f WHERE f.employee_id = e.id AND f.company_id = e.company_id AND f.status = 'active')),
        (4, 'Education', EXISTS (SELECT 1 FROM employee_education d WHERE d.employee_id = e.id AND d.company_id = e.company_id AND d.status = 'active')),
        (5, 'Payment account', EXISTS (SELECT 1 FROM employee_payment_accounts p WHERE p.employee_id = e.id AND p.company_id = e.company_id AND p.status = 'active'))
      ) AS t(ord, section, ok)
     WHERE ${q.emp()} AND ${q.current()}
     GROUP BY t.ord, t.section ORDER BY rate ASC, t.ord`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Completeness by section", unit: "percent", rows, labelKey: "section", valueKey: "rate", valueLabel: "Complete (%)" }) : null),
  kpis: ({ rows }) => [count("employees", "Current employees", rows.length ? num(rows[0] ?? {}, "employees") : 0), { key: "avg", label: "Average completeness", value: rows.length ? round1(sum(rows, "rate") / rows.length) : null, unit: "percent" as const }],
  calculation: ["A section counts as filled in when the employee has at least one active record of that kind (contact, address, family member, education, payment account).", "Only whether a record exists is checked; the contents are never shown."],
});

export const I12 = sqlReport({
  description: "How notifications fared: queued, sent or failed, for each channel and message type.",
  defaultRange: "last30Days",
  tables: ["notification_log"],
  viz: ["donut", "kpi", "table"],
  tags: ["notifications", "delivery"],
  columns: [
    { key: "channel", label: "Channel", type: "text" },
    { key: "template", label: "Message type", type: "text" },
    { key: "total", label: "Notifications", type: "number" },
    { key: "sent", label: "Sent", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "logged", label: "Logged only", type: "number" },
    { key: "failRate", label: "Failed (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT ${LABEL("n.channel")} AS channel, ${LABEL("n.template_key")} AS template, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE n.status = 'logged')::int AS logged, ROUND(COUNT(*) FILTER (WHERE n.status = 'failed') * 100.0 / COUNT(*), 1) AS "failRate"
      FROM notification_log n WHERE ${q.co("n")} AND n.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY n.channel, n.template_key ORDER BY failed DESC, total DESC, channel, template`,
  chart: ({ rows }) => {
    const total = sum(rows, "total");
    if (total === 0) return null;
    const parts = [{ label: "Sent", n: sum(rows, "sent") }, { label: "Failed", n: sum(rows, "failed") }, { label: "Logged only", n: sum(rows, "logged") }].filter((p) => p.n > 0);
    return donutChart({ title: "Notification outcomes", unit: "notifications", rows: parts, labelKey: "label", valueKey: "n" });
  },
  kpis: ({ rows }) => [count("total", "Notifications", sum(rows, "total")), count("failed", "Failed", sum(rows, "failed")), percent("failRate", "Share failed", pct(sum(rows, "failed"), sum(rows, "total")))],
  calculation: ["Counts entries in the notification log created in the range. 'Sent' was accepted by the mail service, 'Failed' was rejected or errored, and 'Logged only' was recorded without a send attempt (for example when email delivery is not configured).", "No recipient or message content is shown."],
});

export const I13 = listReport({
  description: "Notifications that failed to send, with a masked recipient so the right person can be followed up.",
  defaultRange: "last30Days",
  tables: ["notification_log"],
  tags: ["notifications", "failures"],
  countLabel: "Failed notifications",
  columns: [
    { key: "when", label: "Created", type: "date" },
    { key: "channel", label: "Channel", type: "text" },
    { key: "template", label: "Message type", type: "text" },
    { key: "recipient", label: "Recipient (masked)", type: "text" },
  ],
  sql: (q) => `
    SELECT n.created_at::date::text AS "when", ${LABEL("n.channel")} AS channel, ${LABEL("n.template_key")} AS template,
           CASE WHEN POSITION('@' IN n.recipient) > 1 THEN LEFT(n.recipient, 1) || '***' || SUBSTRING(n.recipient FROM POSITION('@' IN n.recipient)) ELSE LEFT(n.recipient, 2) || '***' END AS recipient
      FROM notification_log n WHERE ${q.co("n")} AND n.status = 'failed' AND n.created_at::date BETWEEN ${q.from} AND ${q.to}
     ORDER BY n.created_at DESC`,
  kpis: ({ rows }) => [count("types", "Message types affected", new Set(rows.map((r) => r.template)).size)],
  calculation: ["Lists notification log entries whose status is failed and that were created in the range. Recipients are masked to the first character and the domain."],
});

export const I14 = sqlReport({
  description: "Onboarding and offboarding tasks by who has to act on them (the employee, the line manager or HR): how many are done, open or overdue.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["employee_onboarding_items", "employee_offboarding_items", "employee_onboarding", "employee_offboarding", "employees"],
  viz: ["bar", "table"],
  tags: ["tasks", "onboarding", "offboarding"],
  columns: [
    { key: "process", label: "Process", type: "text" },
    { key: "role", label: "Who acts", type: "text" },
    { key: "tasks", label: "Tasks", type: "number" },
    { key: "done", label: "Completed", type: "number" },
    { key: "open", label: "Open", type: "number" },
    { key: "overdue", label: "Open and overdue", type: "number" },
    { key: "rate", label: "Completion (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT t.process, t.role, COUNT(*)::int AS tasks, COUNT(*) FILTER (WHERE t.status = 'completed')::int AS done, COUNT(*) FILTER (WHERE t.status = 'pending')::int AS open,
           COUNT(*) FILTER (WHERE t.status = 'pending' AND t.due_date < ${q.today})::int AS overdue, ROUND(COUNT(*) FILTER (WHERE t.status = 'completed') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE t.status <> 'skipped'), 0), 1) AS rate
      FROM (
        SELECT 'Onboarding' AS process, ${ACTOR_ROLE("i.responsible_role")} AS role, i.status, i.due_date
          FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id
         WHERE ${q.emp()} AND o.started_at::date BETWEEN ${q.from} AND ${q.to}
        UNION ALL
        SELECT 'Offboarding', ${ACTOR_ROLE("i.responsible_role")}, i.status, NULL::date
          FROM employee_offboarding_items i JOIN employee_offboarding o ON o.id = i.offboarding_id JOIN employees e ON e.id = o.employee_id
         WHERE ${q.emp()} AND o.started_at::date BETWEEN ${q.from} AND ${q.to}
      ) t GROUP BY t.process, t.role ORDER BY overdue DESC, open DESC, t.process, t.role`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Open tasks by who acts", unit: "tasks", rows: rows.map((r) => ({ ...r, label: `${r.process} - ${r.role}` })), labelKey: "label", valueKey: "open", max: 12 }) : null),
  kpis: ({ rows }) => [count("tasks", "Tasks", sum(rows, "tasks")), percent("rate", "Completion", pct(sum(rows, "done"), sum(rows, "done") + sum(rows, "open"))), count("overdue", "Open and overdue", sum(rows, "overdue"))],
  calculation: ["Includes tasks of onboarding and offboarding checklists that started in the range, for employees in your filters.", "Completion is completed tasks divided by completed plus open tasks; skipped tasks are left out. Offboarding tasks have no due date, so they are never counted as overdue."],
});
