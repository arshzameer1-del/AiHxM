import type { Q, ReportSectionSpec } from "../report-spec";
import { LABEL, NAME, col } from "./common";

/**
 * Extra tables for the self-service reports (I01 to I14) and the audit and security reports (J01 to J13).
 *
 * Both families are for administrators only. Like the reports themselves, nothing here shows passwords, secrets, IP
 * addresses, notification bodies, or the before and after values of a change: the audit tables say who did what and when.
 * Sign-in and account facts come only through the narrow app.report_company_*() functions.
 */

const ACCOUNTS = "app.report_company_accounts()";
const SESSIONS = "app.report_company_sessions()";
const CONFIG = "app.report_company_configuration()";
const INTEGRATIONS = "app.report_company_integrations()";
const RECENT_DAYS = 30;
const LBL = (c: string) => `INITCAP(REPLACE(REPLACE(${c}, '_', ' '), '.', ' - '))`;
const UNIT = "COALESCE(ou.name, 'No organisation unit set')";
const UNIT_JOIN = "LEFT JOIN org_units ou ON ou.id = e.org_unit_id";
const n = (key: string, label: string) => col(key, label, "number");
const pc = (key: string, label: string) => col(key, label, "percent");
const MONTH_OF = (c: string) => `to_char(date_trunc('month', ${c}), 'YYYY-MM')`;
const TZ = (c: string) => `(${c} AT TIME ZONE 'Asia/Karachi')`;
const ACTOR = (emp: string, log = "a") => `CASE WHEN ${log}.actor_type = 'user' THEN COALESCE(NULLIF(${NAME(emp)}, ''), 'A user without an employee record') WHEN ${log}.actor_type = 'platform_admin' THEN 'Platform support' ELSE INITCAP(COALESCE(${log}.actor_type, 'system')) END`;
const ACTOR_JOIN = (log = "a", emp = "ae") => `LEFT JOIN employees ${emp} ON ${emp}.user_account_id = ${log}.actor_id AND ${emp}.company_id = ${log}.company_id`;
const IN_RANGE = (log: string, q: Q) => `${log}.created_at::date BETWEEN ${q.from} AND ${q.to}`;
const ROLE_NOW = (q: Q, a = "ura") => `(${a}.effective_from IS NULL OR ${a}.effective_from <= ${q.today}) AND (${a}.effective_to IS NULL OR ${a}.effective_to >= ${q.today})`;

// ================================================================ I: self-service

const CUR = (q: Q) => `${q.emp()} AND ${q.current()}`;
const ACC_JOIN = `LEFT JOIN ${ACCOUNTS} acc ON acc.user_account_id = e.user_account_id`;

const I01_LOCATION: ReportSectionSpec = {
  key: "adoption-by-location",
  title: "Portal use by location",
  description: "For each work location: employees, those with a login and those active in the last 30 days.",
  columns: [col("label", "Location"), n("employees", "Employees"), n("withLogin", "With a login"), n("recent", "Active in last 30 days"), pc("rate", "Active (%)")],
  sql: (q) => `
    SELECT COALESCE(l.name, 'No location set') AS label, COUNT(*)::int AS employees, COUNT(acc.user_account_id)::int AS "withLogin", COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS})::int AS recent,
           ROUND(COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS}) * 100.0 / COUNT(*), 1) AS rate
      FROM employees e LEFT JOIN locations l ON l.id = e.location_id ${ACC_JOIN} WHERE ${CUR(q)} GROUP BY l.id, l.name ORDER BY rate ASC, label`,
};
const I01_TYPE: ReportSectionSpec = {
  key: "adoption-by-type",
  title: "Portal use by employment type",
  description: "Login and recent activity by employment type.",
  columns: [col("label", "Employment type"), n("employees", "Employees"), n("withLogin", "With a login"), n("recent", "Active in last 30 days"), pc("rate", "Active (%)")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(INITCAP(REPLACE(e.employment_type, '_', ' ')), ''), 'Not set') AS label, COUNT(*)::int AS employees, COUNT(acc.user_account_id)::int AS "withLogin",
           COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS})::int AS recent, ROUND(COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS}) * 100.0 / COUNT(*), 1) AS rate
      FROM employees e ${ACC_JOIN} WHERE ${CUR(q)} GROUP BY 1 ORDER BY rate ASC, label`,
};
const I01_RECENCY: ReportSectionSpec = {
  key: "last-sign-in",
  title: "How recently people signed in",
  description: "Current employees grouped by their last sign-in.",
  columns: [col("label", "Last signed in"), n("employees", "Employees"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN acc.user_account_id IS NULL THEN '5 No login' WHEN acc.last_login_at IS NULL THEN '4 Never signed in' WHEN acc.last_login_at::date >= ${q.today} - 7 THEN '0 In the last 7 days'
                         WHEN acc.last_login_at::date >= ${q.today} - 30 THEN '1 In the last 30 days' WHEN acc.last_login_at::date >= ${q.today} - 90 THEN '2 In the last 90 days' ELSE '3 More than 90 days ago' END AS band
              FROM employees e ${ACC_JOIN} WHERE ${CUR(q)}) b GROUP BY b.band ORDER BY b.band`,
};
const I01_NEVER: ReportSectionSpec = {
  key: "never-signed-in",
  title: "Employees with no login or who never signed in",
  description: "Current employees who cannot or did not use the portal, to follow up.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("joined", "Joined", "date"), col("state", "Portal state")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, e.date_of_joining::text AS joined, CASE WHEN acc.user_account_id IS NULL THEN 'No login' ELSE 'Never signed in' END AS state
      FROM employees e ${UNIT_JOIN} ${ACC_JOIN} WHERE ${CUR(q)} AND (acc.user_account_id IS NULL OR acc.last_login_at IS NULL) ORDER BY e.date_of_joining DESC NULLS LAST, name`,
};
const I01_MFA: ReportSectionSpec = {
  key: "mfa-by-unit",
  title: "Sign-in security by organisation unit",
  description: "For each unit: people with a login, how many have MFA on, and how many accounts are locked.",
  columns: [col("label", "Organisation unit"), n("withLogin", "With a login"), n("mfa", "MFA on"), pc("mfaRate", "MFA on (%)"), n("locked", "Locked now")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(acc.user_account_id)::int AS "withLogin", COUNT(*) FILTER (WHERE acc.mfa_enabled)::int AS mfa, ROUND(COUNT(*) FILTER (WHERE acc.mfa_enabled) * 100.0 / NULLIF(COUNT(acc.user_account_id), 0), 1) AS "mfaRate",
           COUNT(*) FILTER (WHERE acc.locked_until > now())::int AS locked
      FROM employees e ${UNIT_JOIN} ${ACC_JOIN} WHERE ${CUR(q)} GROUP BY ou.id, ou.name ORDER BY "mfaRate" ASC NULLS LAST, label`,
};
const I01_TENURE: ReportSectionSpec = {
  key: "adoption-by-service",
  title: "Portal use by years of service",
  description: "Whether newer or longer-serving staff use the portal more.",
  columns: [col("label", "Years of service"), n("employees", "Employees"), n("recent", "Active in last 30 days"), pc("rate", "Active (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS employees, COUNT(*) FILTER (WHERE b.recent)::int AS recent, ROUND(COUNT(*) FILTER (WHERE b.recent) * 100.0 / COUNT(*), 1) AS rate
      FROM (SELECT COALESCE(acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS}, false) AS recent,
                   CASE WHEN e.date_of_joining IS NULL THEN '5 Joining date not set' WHEN ${q.today} - e.date_of_joining < 365 THEN '0 Under 1 year' WHEN ${q.today} - e.date_of_joining < 1095 THEN '1 1 to 3 years'
                        WHEN ${q.today} - e.date_of_joining < 1825 THEN '2 3 to 5 years' WHEN ${q.today} - e.date_of_joining < 3650 THEN '3 5 to 10 years' ELSE '4 Over 10 years' END AS band
              FROM employees e ${ACC_JOIN} WHERE ${CUR(q)}) b GROUP BY b.band ORDER BY b.band`,
};

const I02_WEEKDAY: ReportSectionSpec = {
  key: "sign-ins-by-weekday",
  title: "Sign-ins by day of the week",
  description: "Sessions started on each day of the week, in company time.",
  columns: [col("label", "Day"), n("sessions", "Sessions"), n("people", "Different people")],
  sql: (q) => `
    SELECT trim(to_char(${TZ("s.created_at")}, 'Day')) AS label, COUNT(*)::int AS sessions, COUNT(DISTINCT s.user_account_id)::int AS people
      FROM ${SESSIONS} s JOIN employees e ON e.user_account_id = s.user_account_id WHERE ${q.emp()} AND s.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY 1, EXTRACT(isodow FROM ${TZ("s.created_at")}) ORDER BY EXTRACT(isodow FROM ${TZ("s.created_at")})`,
};
const I02_HOUR: ReportSectionSpec = {
  key: "sign-ins-by-hour",
  title: "Sign-ins by hour of the day",
  description: "Sessions started in each hour of the day, in company time.",
  columns: [n("hour", "Hour"), n("sessions", "Sessions")],
  sql: (q) => `
    SELECT EXTRACT(hour FROM ${TZ("s.created_at")})::int AS hour, COUNT(*)::int AS sessions
      FROM ${SESSIONS} s JOIN employees e ON e.user_account_id = s.user_account_id WHERE ${q.emp()} AND s.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const I02_UNIT: ReportSectionSpec = {
  key: "sign-ins-by-unit",
  title: "Sign-ins by organisation unit",
  description: "Sessions and different people for each unit in the period.",
  columns: [col("label", "Organisation unit"), n("sessions", "Sessions"), n("people", "Different people"), n("perPerson", "Sessions per person")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS sessions, COUNT(DISTINCT s.user_account_id)::int AS people, ROUND(COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT s.user_account_id), 0), 1) AS "perPerson"
      FROM ${SESSIONS} s JOIN employees e ON e.user_account_id = s.user_account_id ${UNIT_JOIN} WHERE ${q.emp()} AND s.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.id, ou.name ORDER BY sessions DESC, label`,
};
const I02_DEVICE: ReportSectionSpec = {
  key: "sign-in-devices",
  title: "New devices and network changes by month",
  description: "How many sessions came from a device not seen before or showed a rapid network change.",
  columns: [col("month", "Month"), n("sessions", "Sessions"), n("newDevice", "From a new device"), n("rapid", "Rapid network change"), n("revoked", "Revoked")],
  sql: (q) => `
    SELECT ${MONTH_OF("s.created_at")} AS month, COUNT(*)::int AS sessions, COUNT(*) FILTER (WHERE s.is_new_device)::int AS "newDevice", COUNT(*) FILTER (WHERE s.is_rapid_network_change)::int AS rapid, COUNT(*) FILTER (WHERE s.revoked_at IS NOT NULL)::int AS revoked
      FROM ${SESSIONS} s JOIN employees e ON e.user_account_id = s.user_account_id WHERE ${q.emp()} AND s.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const I02_RETURN: ReportSectionSpec = {
  key: "returning-people",
  title: "New and returning users by month",
  description: "People who signed in for the first time in the period and people who came back after signing in earlier.",
  columns: [col("month", "Month"), n("people", "Different people"), n("firstTime", "First sign-in in this period"), n("returning", "Signed in before that month")],
  sql: (q) => `
    SELECT x.month, COUNT(DISTINCT x.user_account_id)::int AS people, COUNT(DISTINCT x.user_account_id) FILTER (WHERE x.first_month = x.month)::int AS "firstTime", COUNT(DISTINCT x.user_account_id) FILTER (WHERE x.first_month < x.month)::int AS returning
      FROM (SELECT ${MONTH_OF("s.created_at")} AS month, s.user_account_id, MIN(${MONTH_OF("s.created_at")}) OVER (PARTITION BY s.user_account_id) AS first_month
              FROM ${SESSIONS} s JOIN employees e ON e.user_account_id = s.user_account_id WHERE ${q.emp()} AND s.created_at::date BETWEEN ${q.from} AND ${q.to}) x
     GROUP BY x.month ORDER BY x.month`,
};

const SELF_BRANCHES = (q: Q) => {
  const branch = (label: string, table: string, alias: string) => `
      SELECT '${label}' AS type, ${alias}.created_at AS at, (${alias}.submitted_by_user_account_id = e.user_account_id) AS self, e.id AS eid, e.org_unit_id AS unit_id, ${alias}.submitted_by_user_account_id AS by_account, e.company_id AS cid
        FROM ${table} ${alias} JOIN employees e ON e.id = ${alias}.employee_id AND e.company_id = ${alias}.company_id
       WHERE ${q.emp()} AND ${alias}.created_at::date BETWEEN ${q.from} AND ${q.to}`;
  return `
      ${branch("Leave requests", "leave_requests", "x1")}
      UNION ALL ${branch("Attendance corrections", "attendance_correction_requests", "x2")}
      UNION ALL ${branch("Expense claims", "expense_claims", "x3")}
      UNION ALL ${branch("On-duty requests", "on_duty_requests", "x4")}
      UNION ALL ${branch("Overtime claims", "overtime_records", "x5")}
      UNION ALL ${branch("Timesheets", "timesheets", "x6")}`;
};
const I03_MONTH: ReportSectionSpec = {
  key: "self-service-by-month",
  title: "Self-service by month and transaction",
  description: "Requests raised each month for each transaction type, and how many the employee submitted themselves.",
  columns: [col("month", "Month"), col("type", "Transaction"), n("total", "Submitted"), n("self", "By the employee"), pc("rate", "Self-service (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("t.at")} AS month, t.type, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.self)::int AS self, ROUND(COUNT(*) FILTER (WHERE t.self) * 100.0 / COUNT(*), 1) AS rate
      FROM (${SELF_BRANCHES(q)}) t GROUP BY 1, t.type ORDER BY 1, total DESC, t.type`,
};
const I03_UNIT: ReportSectionSpec = {
  key: "self-service-by-unit",
  title: "Self-service by organisation unit",
  description: "For each unit: requests raised and the share the employee submitted themselves.",
  columns: [col("label", "Organisation unit"), n("total", "Submitted"), n("self", "By the employee"), n("onBehalf", "Entered for the employee"), pc("rate", "Self-service (%)")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'No organisation unit set') AS label, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.self)::int AS self, COUNT(*) FILTER (WHERE NOT t.self)::int AS "onBehalf", ROUND(COUNT(*) FILTER (WHERE t.self) * 100.0 / COUNT(*), 1) AS rate
      FROM (${SELF_BRANCHES(q)}) t LEFT JOIN org_units ou ON ou.id = t.unit_id GROUP BY ou.id, ou.name ORDER BY rate ASC, label`,
};
const I03_ENTERED_BY: ReportSectionSpec = {
  key: "entered-by",
  title: "Who enters requests for employees",
  description: "People who submitted requests on someone else's behalf and how many.",
  columns: [col("person", "Entered by"), n("requests", "Requests entered for others"), n("people", "Different employees")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("se")}, ''), 'A user without an employee record') AS person, COUNT(*)::int AS requests, COUNT(DISTINCT t.eid)::int AS people
      FROM (${SELF_BRANCHES(q)}) t LEFT JOIN employees se ON se.user_account_id = t.by_account AND se.company_id = t.cid WHERE NOT t.self GROUP BY se.id, se.first_name, se.last_name ORDER BY requests DESC, person`,
};
const I03_ADOPTION: ReportSectionSpec = {
  key: "people-using-self-service",
  title: "How many employees raised something themselves",
  description: "Current employees in your filters and how many raised at least one request on their own in the period.",
  columns: [col("label", "Organisation unit"), n("employees", "Current employees"), n("raised", "Raised a request themselves"), pc("rate", "Raised a request (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS employees, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM (${SELF_BRANCHES(q)}) t WHERE t.eid = e.id AND t.self))::int AS raised,
           ROUND(COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM (${SELF_BRANCHES(q)}) t WHERE t.eid = e.id AND t.self)) * 100.0 / COUNT(*), 1) AS rate
      FROM employees e ${UNIT_JOIN} WHERE ${CUR(q)} GROUP BY ou.id, ou.name ORDER BY rate ASC, label`,
};

const I04_MANAGERS: ReportSectionSpec = {
  key: "managers",
  title: "People managers and their portal use",
  description: "Each people manager with their last sign-in, approvals decided in the period and approvals waiting on them.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), n("reports", "Direct reports"), col("lastSignIn", "Last sign-in", "date"), n("decided", "Approvals decided"), n("waiting", "Waiting on them now")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,
           (SELECT COUNT(*) FROM org_relationships r WHERE r.manager_employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active')::int AS reports,
           acc.last_login_at::date::text AS "lastSignIn",
           (SELECT COUNT(*) FROM workflow_step_approvals a JOIN workflow_step_instances si ON si.id = a.step_instance_id JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
             WHERE wi.company_id = e.company_id AND a.decided_by_user_account_id = e.user_account_id AND a.decided_at::date BETWEEN ${q.from} AND ${q.to})::int AS decided,
           (SELECT COUNT(*) FROM workflow_step_approvals a JOIN workflow_step_instances si ON si.id = a.step_instance_id JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
             WHERE wi.company_id = e.company_id AND a.user_account_id = e.user_account_id AND a.status IN ('pending', 'escalated') AND si.status = 'pending' AND wi.status = 'in_progress')::int AS waiting
      FROM employees e ${UNIT_JOIN} ${ACC_JOIN}
     WHERE ${CUR(q)} AND EXISTS (SELECT 1 FROM org_relationships r WHERE r.manager_employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active')
     ORDER BY waiting DESC, name`,
};
const I04_INACTIVE: ReportSectionSpec = {
  key: "inactive-managers",
  title: "Managers with work waiting who have not signed in lately",
  description: "People managers with approvals waiting and no sign-in in the last 30 days.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), col("lastSignIn", "Last sign-in", "date"), n("waiting", "Waiting on them now")],
  sql: (q) => `
    SELECT * FROM (
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, acc.last_login_at::date::text AS "lastSignIn",
             (SELECT COUNT(*) FROM workflow_step_approvals a JOIN workflow_step_instances si ON si.id = a.step_instance_id JOIN workflow_instances wi ON wi.id = si.workflow_instance_id
               WHERE wi.company_id = e.company_id AND a.user_account_id = e.user_account_id AND a.status IN ('pending', 'escalated') AND si.status = 'pending' AND wi.status = 'in_progress')::int AS waiting, acc.last_login_at AS ll
        FROM employees e ${UNIT_JOIN} ${ACC_JOIN} WHERE ${CUR(q)}) t
     WHERE t.waiting > 0 AND (t.ll IS NULL OR t.ll::date < ${q.today} - ${RECENT_DAYS}) ORDER BY t.waiting DESC, t.name`,
};
const I04_LOCATION: ReportSectionSpec = {
  key: "managers-by-location",
  title: "People managers by location",
  description: "Managers with a login and those active in the last 30 days, for each location.",
  columns: [col("label", "Location"), n("managers", "Managers"), n("withLogin", "With a login"), n("recent", "Active in last 30 days"), pc("rate", "Active (%)")],
  sql: (q) => `
    SELECT COALESCE(l.name, 'No location set') AS label, COUNT(*)::int AS managers, COUNT(acc.user_account_id)::int AS "withLogin", COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS})::int AS recent,
           ROUND(COUNT(*) FILTER (WHERE acc.last_login_at::date >= ${q.today} - ${RECENT_DAYS}) * 100.0 / COUNT(*), 1) AS rate
      FROM employees e LEFT JOIN locations l ON l.id = e.location_id ${ACC_JOIN}
     WHERE ${CUR(q)} AND EXISTS (SELECT 1 FROM org_relationships r WHERE r.manager_employee_id = e.id AND r.company_id = e.company_id AND r.relationship_type = 'direct' AND r.status = 'active') GROUP BY l.id, l.name ORDER BY rate ASC, label`,
};

const LEAVE_SELF = "leave_requests lr JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id";
const I06_TYPE: ReportSectionSpec = {
  key: "leave-self-service-by-type",
  title: "Self-service by leave type",
  description: "For each leave type: requests and the share the employee submitted themselves.",
  columns: [col("label", "Leave type"), n("total", "Requests"), n("self", "By the employee"), n("onBehalf", "Entered for the employee"), pc("rate", "Self-service (%)")],
  sql: (q) => `
    SELECT ${LBL("lr.leave_type")} AS label, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE lr.submitted_by_user_account_id = e.user_account_id)::int AS self, COUNT(*) FILTER (WHERE lr.submitted_by_user_account_id IS DISTINCT FROM e.user_account_id)::int AS "onBehalf",
           ROUND(COUNT(*) FILTER (WHERE lr.submitted_by_user_account_id = e.user_account_id) * 100.0 / COUNT(*), 1) AS rate
      FROM ${LEAVE_SELF} WHERE ${q.emp()} AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY lr.leave_type ORDER BY total DESC, label`,
};
const I06_UNIT: ReportSectionSpec = {
  key: "leave-self-service-by-unit",
  title: "Self-service by organisation unit",
  description: "Leave requests per unit and the share submitted by the employee.",
  columns: [col("label", "Organisation unit"), n("total", "Requests"), n("self", "By the employee"), pc("rate", "Self-service (%)")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE lr.submitted_by_user_account_id = e.user_account_id)::int AS self,
           ROUND(COUNT(*) FILTER (WHERE lr.submitted_by_user_account_id = e.user_account_id) * 100.0 / COUNT(*), 1) AS rate
      FROM ${LEAVE_SELF} ${UNIT_JOIN} WHERE ${q.emp()} AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.id, ou.name ORDER BY rate ASC, label`,
};
const I06_ENTERED: ReportSectionSpec = {
  key: "leave-entered-by",
  title: "Who enters leave for employees",
  description: "People who submitted leave on someone else's behalf and how many requests.",
  columns: [col("person", "Entered by"), n("requests", "Requests"), n("people", "Different employees")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("se")}, ''), 'A user without an employee record') AS person, COUNT(*)::int AS requests, COUNT(DISTINCT e.id)::int AS people
      FROM ${LEAVE_SELF} LEFT JOIN employees se ON se.user_account_id = lr.submitted_by_user_account_id AND se.company_id = lr.company_id
     WHERE ${q.emp()} AND lr.created_at::date BETWEEN ${q.from} AND ${q.to} AND lr.submitted_by_user_account_id IS DISTINCT FROM e.user_account_id GROUP BY se.id, se.first_name, se.last_name ORDER BY requests DESC, person`,
};

const I10_UNIT: ReportSectionSpec = {
  key: "record-completeness-by-unit",
  title: "Record completeness by organisation unit",
  description: "For each unit: employees and how many have each part of their record filled in.",
  columns: [col("label", "Organisation unit"), n("employees", "Employees"), n("contact", "Contact details"), n("address", "Home address"), n("family", "Family or emergency contact"), n("education", "Education"), n("payment", "Payment account")],
  sql: (q) => `
    SELECT ${UNIT} AS label, COUNT(*)::int AS employees,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee_contacts c WHERE c.employee_id = e.id AND c.company_id = e.company_id AND c.status = 'active'))::int AS contact,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active'))::int AS address,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee_family_members f WHERE f.employee_id = e.id AND f.company_id = e.company_id AND f.status = 'active'))::int AS family,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee_education d WHERE d.employee_id = e.id AND d.company_id = e.company_id AND d.status = 'active'))::int AS education,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee_payment_accounts p WHERE p.employee_id = e.id AND p.company_id = e.company_id AND p.status = 'active'))::int AS payment
      FROM employees e ${UNIT_JOIN} WHERE ${CUR(q)} GROUP BY ou.id, ou.name ORDER BY employees DESC, label`,
};
const I10_MISSING: ReportSectionSpec = {
  key: "employees-with-gaps",
  title: "Employees with gaps in their record",
  description: "Current employees and which of the five sections are missing. Nothing from inside the sections is shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("unit", "Organisation unit"), n("missing", "Sections missing"), col("which", "Missing")],
  sql: (q) => `
    SELECT * FROM (
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,
             (SELECT COUNT(*) FROM (VALUES (c.ok), (a.ok), (f.ok), (d.ok), (p.ok)) v(ok) WHERE NOT v.ok)::int AS missing,
             NULLIF(CONCAT_WS(', ', CASE WHEN NOT c.ok THEN 'Contact details' END, CASE WHEN NOT a.ok THEN 'Home address' END, CASE WHEN NOT f.ok THEN 'Family or emergency contact' END,
                                    CASE WHEN NOT d.ok THEN 'Education' END, CASE WHEN NOT p.ok THEN 'Payment account' END), '') AS which
        FROM employees e ${UNIT_JOIN}
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM employee_contacts c WHERE c.employee_id = e.id AND c.company_id = e.company_id AND c.status = 'active') AS ok) c
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active') AS ok) a
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM employee_family_members f WHERE f.employee_id = e.id AND f.company_id = e.company_id AND f.status = 'active') AS ok) f
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM employee_education d WHERE d.employee_id = e.id AND d.company_id = e.company_id AND d.status = 'active') AS ok) d
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM employee_payment_accounts p WHERE p.employee_id = e.id AND p.company_id = e.company_id AND p.status = 'active') AS ok) p
       WHERE ${CUR(q)}) t WHERE t.missing > 0 ORDER BY t.missing DESC, t.name`,
};
const I10_COUNT: ReportSectionSpec = {
  key: "sections-complete",
  title: "How many sections people have completed",
  description: "Current employees grouped by how many of the five sections are filled in.",
  columns: [col("label", "Sections filled in"), n("employees", "Employees"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT b.filled::text || ' of 5' AS label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT (EXISTS (SELECT 1 FROM employee_contacts c WHERE c.employee_id = e.id AND c.company_id = e.company_id AND c.status = 'active')::int
                  + EXISTS (SELECT 1 FROM employee_addresses a WHERE a.employee_id = e.id AND a.company_id = e.company_id AND a.status = 'active')::int
                  + EXISTS (SELECT 1 FROM employee_family_members f WHERE f.employee_id = e.id AND f.company_id = e.company_id AND f.status = 'active')::int
                  + EXISTS (SELECT 1 FROM employee_education d WHERE d.employee_id = e.id AND d.company_id = e.company_id AND d.status = 'active')::int
                  + EXISTS (SELECT 1 FROM employee_payment_accounts p WHERE p.employee_id = e.id AND p.company_id = e.company_id AND p.status = 'active')::int) AS filled
              FROM employees e WHERE ${CUR(q)}) b GROUP BY b.filled ORDER BY b.filled`,
};

const NL = "notification_log n";
const NW = (q: Q) => `${q.co("n")} AND n.created_at::date BETWEEN ${q.from} AND ${q.to}`;
const I12_DAY: ReportSectionSpec = {
  key: "notifications-by-day",
  title: "Notifications by day",
  description: "Sent, failed and logged-only notifications for each day.",
  columns: [col("day", "Day", "date"), n("total", "Notifications"), n("sent", "Sent"), n("failed", "Failed"), n("logged", "Logged only")],
  sql: (q) => `
    SELECT n.created_at::date::text AS day, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE n.status = 'logged')::int AS logged
      FROM ${NL} WHERE ${NW(q)} GROUP BY 1 ORDER BY 1 DESC`,
};
const I12_CHANNEL: ReportSectionSpec = {
  key: "notifications-by-channel",
  title: "Notifications by channel and month",
  description: "How each channel performed month by month.",
  columns: [col("month", "Month"), col("channel", "Channel"), n("total", "Notifications"), n("sent", "Sent"), n("failed", "Failed"), pc("failRate", "Failed (%)")],
  sql: (q) => `
    SELECT ${MONTH_OF("n.created_at")} AS month, ${LABEL("n.channel")} AS channel, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed,
           ROUND(COUNT(*) FILTER (WHERE n.status = 'failed') * 100.0 / COUNT(*), 1) AS "failRate"
      FROM ${NL} WHERE ${NW(q)} GROUP BY 1, n.channel ORDER BY 1, channel`,
};
const I12_TEMPLATE: ReportSectionSpec = {
  key: "worst-message-types",
  title: "Message types that fail most",
  description: "Message types ranked by failures. Only types with at least one failure are listed.",
  columns: [col("template", "Message type"), n("total", "Notifications"), n("failed", "Failed"), pc("failRate", "Failed (%)"), col("last", "Last failure", "date")],
  sql: (q) => `
    SELECT ${LABEL("n.template_key")} AS template, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed, ROUND(COUNT(*) FILTER (WHERE n.status = 'failed') * 100.0 / COUNT(*), 1) AS "failRate",
           MAX(n.created_at) FILTER (WHERE n.status = 'failed')::date::text AS last
      FROM ${NL} WHERE ${NW(q)} GROUP BY n.template_key HAVING COUNT(*) FILTER (WHERE n.status = 'failed') > 0 ORDER BY failed DESC, template`,
};
const I12_STATUS: ReportSectionSpec = {
  key: "notifications-by-status",
  title: "Notifications by status",
  description: "Every status a notification reached in the period.",
  columns: [col("label", "Status"), n("total", "Notifications"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT ${LABEL("n.status")} AS label, COUNT(*)::int AS total, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM ${NL} WHERE ${NW(q)} GROUP BY n.status ORDER BY total DESC, label`,
};
const I13_CHANNEL: ReportSectionSpec = {
  key: "failures-by-channel",
  title: "Failures by channel and message type",
  description: "Failed notifications by channel and message type.",
  columns: [col("channel", "Channel"), col("template", "Message type"), n("failed", "Failed"), col("first", "First failure", "date"), col("last", "Last failure", "date")],
  sql: (q) => `
    SELECT ${LABEL("n.channel")} AS channel, ${LABEL("n.template_key")} AS template, COUNT(*)::int AS failed, MIN(n.created_at)::date::text AS first, MAX(n.created_at)::date::text AS last
      FROM ${NL} WHERE ${NW(q)} AND n.status = 'failed' GROUP BY n.channel, n.template_key ORDER BY failed DESC, channel, template`,
};
const I13_DAY: ReportSectionSpec = {
  key: "failures-by-day",
  title: "Failures by day",
  description: "Failed notifications each day, to show whether they cluster around one incident.",
  columns: [col("day", "Day", "date"), n("failed", "Failed"), n("channels", "Channels affected")],
  sql: (q) => `
    SELECT n.created_at::date::text AS day, COUNT(*)::int AS failed, COUNT(DISTINCT n.channel)::int AS channels FROM ${NL} WHERE ${NW(q)} AND n.status = 'failed' GROUP BY 1 ORDER BY 1 DESC`,
};
const I13_REPEAT: ReportSectionSpec = {
  key: "recipients-failing-repeatedly",
  title: "Recipients that failed more than once",
  description: "Masked recipients who did not receive two or more notifications, which usually means a wrong address.",
  columns: [col("recipient", "Recipient (masked)"), col("channel", "Channel"), n("failed", "Failures"), col("last", "Last failure", "date")],
  sql: (q) => `
    SELECT CASE WHEN POSITION('@' IN n.recipient) > 1 THEN LEFT(n.recipient, 1) || '***' || SUBSTRING(n.recipient FROM POSITION('@' IN n.recipient)) ELSE LEFT(n.recipient, 2) || '***' END AS recipient,
           ${LABEL("n.channel")} AS channel, COUNT(*)::int AS failed, MAX(n.created_at)::date::text AS last
      FROM ${NL} WHERE ${NW(q)} AND n.status = 'failed' GROUP BY n.recipient, n.channel HAVING COUNT(*) > 1 ORDER BY failed DESC, last DESC`,
};

const ONB_FROM = "employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id";
const OFF_FROM = "employee_offboarding_items i JOIN employee_offboarding o ON o.id = i.offboarding_id JOIN employees e ON e.id = o.employee_id";
const ONB_W = (q: Q) => `${q.emp()} AND o.started_at::date BETWEEN ${q.from} AND ${q.to}`;
const I14_PEOPLE: ReportSectionSpec = {
  key: "task-progress-by-person",
  title: "Checklist progress by person",
  description: "Each onboarding and offboarding checklist with its status and how many tasks are done, open or overdue.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("process", "Process"), col("status", "Checklist status"), col("started", "Started", "date"), n("tasks", "Tasks"), n("done", "Done"), n("open", "Open"), n("overdue", "Open and overdue")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, 'Onboarding' AS process, ${LABEL("o.status")} AS status, o.started_at::date::text AS started, COUNT(i.id)::int AS tasks, COUNT(*) FILTER (WHERE i.status = 'completed')::int AS done,
           COUNT(*) FILTER (WHERE i.status = 'pending')::int AS open, COUNT(*) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue
      FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id LEFT JOIN employee_onboarding_items i ON i.onboarding_id = o.id WHERE ${ONB_W(q)} GROUP BY o.id, e.id
    UNION ALL
    SELECT e.employee_number, ${NAME("e")}, 'Offboarding', ${LABEL("o.status")}, o.started_at::date::text, COUNT(i.id)::int, COUNT(*) FILTER (WHERE i.status = 'completed')::int, COUNT(*) FILTER (WHERE i.status = 'pending')::int, 0
      FROM employee_offboarding o JOIN employees e ON e.id = o.employee_id LEFT JOIN employee_offboarding_items i ON i.offboarding_id = o.id WHERE ${ONB_W(q)} GROUP BY o.id, e.id
    ORDER BY overdue DESC, open DESC, name`,
};
const I14_CATEGORY: ReportSectionSpec = {
  key: "tasks-by-category",
  title: "Tasks by category",
  description: "Which kinds of task (equipment, accounts, documents and so on) get completed and which stall.",
  columns: [col("process", "Process"), col("category", "Category"), n("tasks", "Tasks"), n("done", "Done"), n("open", "Open"), n("skipped", "Skipped"), pc("rate", "Completion (%)")],
  sql: (q) => `
    SELECT t.process, t.category, COUNT(*)::int AS tasks, COUNT(*) FILTER (WHERE t.status = 'completed')::int AS done, COUNT(*) FILTER (WHERE t.status = 'pending')::int AS open, COUNT(*) FILTER (WHERE t.status = 'skipped')::int AS skipped,
           ROUND(COUNT(*) FILTER (WHERE t.status = 'completed') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE t.status <> 'skipped'), 0), 1) AS rate
      FROM (SELECT 'Onboarding' AS process, ${LABEL("COALESCE(i.category, 'other')")} AS category, i.status FROM ${ONB_FROM} WHERE ${ONB_W(q)}
            UNION ALL SELECT 'Offboarding', ${LABEL("COALESCE(i.category, 'other')")}, i.status FROM ${OFF_FROM} WHERE ${ONB_W(q)}) t
     GROUP BY t.process, t.category ORDER BY open DESC, t.process, t.category`,
};
const I14_OVERDUE: ReportSectionSpec = {
  key: "overdue-tasks",
  title: "Overdue onboarding tasks",
  description: "Each open onboarding task past its due date, who has to act and how late it is.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("task", "Task"), col("category", "Category"), col("role", "Who acts"), col("due", "Was due", "date"), n("late", "Days late")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, i.title AS task, ${LABEL("COALESCE(i.category, 'other')")} AS category,
           CASE i.responsible_role WHEN 'self' THEN 'The employee' WHEN 'team' THEN 'The line manager' WHEN 'all' THEN 'HR and administrators' ELSE 'Not assigned' END AS role, i.due_date::text AS due, (${q.today} - i.due_date)::int AS late
      FROM ${ONB_FROM} WHERE ${ONB_W(q)} AND i.status = 'pending' AND i.due_date < ${q.today} ORDER BY late DESC, name`,
};
const I14_MONTH: ReportSectionSpec = {
  key: "checklists-by-month",
  title: "Checklists started by month",
  description: "Onboarding and offboarding checklists started each month and how many are complete.",
  columns: [col("month", "Month"), col("process", "Process"), n("started", "Started"), n("completed", "Completed")],
  sql: (q) => `
    SELECT t.month, t.process, COUNT(*)::int AS started, COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed
      FROM (SELECT ${MONTH_OF("o.started_at")} AS month, 'Onboarding' AS process, o.status FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id WHERE ${ONB_W(q)}
            UNION ALL SELECT ${MONTH_OF("o.started_at")}, 'Offboarding', o.status FROM employee_offboarding o JOIN employees e ON e.id = o.employee_id WHERE ${ONB_W(q)}) t GROUP BY 1, 2 ORDER BY 1, 2`,
};
const I14_TIME: ReportSectionSpec = {
  key: "time-to-complete",
  title: "How long checklists take to finish",
  description: "Days from a checklist starting to its completion.",
  columns: [col("process", "Process"), n("completed", "Completed checklists"), n("avgDays", "Average days"), n("slowest", "Slowest (days)")],
  sql: (q) => `
    SELECT t.process, COUNT(*)::int AS completed, ROUND(AVG(t.days), 1) AS "avgDays", MAX(t.days)::int AS slowest
      FROM (SELECT 'Onboarding' AS process, (o.completed_at::date - o.started_at::date) AS days FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id WHERE ${ONB_W(q)} AND o.completed_at IS NOT NULL
            UNION ALL SELECT 'Offboarding', (o.completed_at::date - o.started_at::date) FROM employee_offboarding o JOIN employees e ON e.id = o.employee_id WHERE ${ONB_W(q)} AND o.completed_at IS NOT NULL) t GROUP BY t.process ORDER BY t.process`,
};

// ================================================================ J: audit and security

const J01_STATUS: ReportSectionSpec = {
  key: "accounts-by-status",
  title: "Accounts by status, sign-in method and MFA",
  description: "Accounts linked to this company grouped by status, how they sign in, and whether MFA is on.",
  columns: [col("status", "Account"), col("provider", "Sign-in method"), n("accounts", "Accounts"), n("mfa", "MFA on"), n("neverSignedIn", "Never signed in")],
  sql: (q) => `
    SELECT ${LBL("acc.status")} AS status, ${LBL("COALESCE(acc.auth_provider, 'password')")} AS provider, COUNT(*)::int AS accounts, COUNT(*) FILTER (WHERE acc.mfa_enabled)::int AS mfa, COUNT(*) FILTER (WHERE acc.last_login_at IS NULL)::int AS "neverSignedIn"
      FROM ${ACCOUNTS} acc WHERE EXISTS (SELECT 1 FROM employees e WHERE e.user_account_id = acc.user_account_id AND ${q.co("e")}) OR EXISTS (SELECT 1 FROM user_role_assignments u WHERE u.user_account_id = acc.user_account_id AND ${q.co("u")})
     GROUP BY acc.status, acc.auth_provider ORDER BY accounts DESC, status`,
};
const J01_LEFT: ReportSectionSpec = {
  key: "leavers-with-access",
  title: "Employees who left but can still sign in",
  description: "Accounts that are still active for employees whose employment has ended.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("left", "Left on", "date"), col("lastSignIn", "Last sign-in", "date"), n("roles", "Roles still held")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, e.termination_date::text AS left, acc.last_login_at::date::text AS "lastSignIn",
           (SELECT COUNT(*) FROM user_role_assignments ura WHERE ura.user_account_id = acc.user_account_id AND ${q.co("ura")} AND ${ROLE_NOW(q)})::int AS roles
      FROM ${ACCOUNTS} acc JOIN employees e ON e.user_account_id = acc.user_account_id AND ${q.co("e")} WHERE e.employment_status = 'terminated' AND acc.status = 'active' ORDER BY e.termination_date DESC NULLS LAST, name`,
};
const J01_HOLDERS: ReportSectionSpec = {
  key: "role-holders",
  title: "Who holds each role",
  description: "Every role assignment in force today: the role, the person, when it started and ends, how it was granted and by whom.",
  columns: [col("role", "Role"), col("person", "Person"), col("from", "From", "date"), col("to", "Until", "date"), col("source", "Granted through"), col("by", "Granted by")],
  sql: (q) => `
    SELECT r.name AS role, COALESCE(NULLIF(${NAME("pe")}, ''), 'No employee record') AS person, ura.effective_from::text AS from, ura.effective_to::text AS to, ${LBL("COALESCE(ura.source, 'manual')")} AS source,
           COALESCE(NULLIF(${NAME("ge")}, ''), 'System') AS by
      FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id LEFT JOIN employees pe ON pe.user_account_id = ura.user_account_id AND pe.company_id = ura.company_id
      LEFT JOIN employees ge ON ge.user_account_id = ura.granted_by AND ge.company_id = ura.company_id
     WHERE ${q.co("ura")} AND ${ROLE_NOW(q)} ORDER BY r.name, person`,
};
const J01_STALE: ReportSectionSpec = {
  key: "stale-accounts",
  title: "Accounts not used for 90 days",
  description: "Active accounts that have not signed in for 90 days or more, or never.",
  columns: [col("person", "Person"), col("status", "Account"), col("lastSignIn", "Last sign-in", "date"), n("days", "Days since sign-in"), n("roles", "Roles held")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, ${LBL("acc.status")} AS status, acc.last_login_at::date::text AS "lastSignIn", (${q.today} - acc.last_login_at::date)::int AS days,
           (SELECT COUNT(*) FROM user_role_assignments ura WHERE ura.user_account_id = acc.user_account_id AND ${q.co("ura")} AND ${ROLE_NOW(q)})::int AS roles
      FROM ${ACCOUNTS} acc LEFT JOIN employees e ON e.user_account_id = acc.user_account_id AND ${q.co("e")}
     WHERE acc.status = 'active' AND (acc.last_login_at IS NULL OR acc.last_login_at::date < ${q.today} - 90) AND (e.id IS NOT NULL OR EXISTS (SELECT 1 FROM user_role_assignments u WHERE u.user_account_id = acc.user_account_id AND ${q.co("u")}))
     ORDER BY days DESC NULLS FIRST, person`,
};

const J02_PERMS: ReportSectionSpec = {
  key: "role-permissions",
  title: "Permissions in each role",
  description: "Every permission a role carries, with the area it acts on and how far it reaches.",
  columns: [col("role", "Role"), col("kind", "Kind"), col("object", "Area"), col("action", "Action"), col("scope", "Reach")],
  sql: (q) => `
    SELECT r.name AS role, CASE WHEN r.company_id IS NULL THEN 'Built in' ELSE 'Custom' END AS kind, ${LBL("COALESCE(p.object_key, split_part(p.key, '.', 1))")} AS object, ${LBL("COALESCE(p.action, split_part(p.key, '.', 2))")} AS action, ${LBL("COALESCE(p.scope, 'none')")} AS scope
      FROM roles r JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id WHERE (r.company_id IS NULL OR ${q.co("r")}) ORDER BY r.name, object, action`,
};
const J02_WIDE: ReportSectionSpec = {
  key: "company-wide-holders",
  title: "People holding company-wide permissions",
  description: "People whose roles carry at least one permission that reaches the whole company, with the number of such permissions.",
  columns: [col("person", "Person"), col("roles", "Roles"), n("wide", "Company-wide permissions"), col("mfa", "MFA")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, string_agg(DISTINCT r.name, ', ' ORDER BY r.name) AS roles, COUNT(DISTINCT p.id)::int AS wide, CASE WHEN bool_or(acc.mfa_enabled) THEN 'On' ELSE 'Off' END AS mfa
      FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id AND p.scope = 'all'
      LEFT JOIN employees e ON e.user_account_id = ura.user_account_id AND e.company_id = ura.company_id LEFT JOIN ${ACCOUNTS} acc ON acc.user_account_id = ura.user_account_id
     WHERE ${q.co("ura")} AND ${ROLE_NOW(q)} GROUP BY ura.user_account_id, e.id, e.first_name, e.last_name ORDER BY wide DESC, person`,
};
const J02_EMPTY: ReportSectionSpec = {
  key: "roles-without-holders",
  title: "Roles nobody holds",
  description: "Roles with no one assigned today.",
  columns: [col("role", "Role"), col("kind", "Kind"), col("active", "Active"), n("permissions", "Permissions")],
  sql: (q) => `
    SELECT r.name AS role, CASE WHEN r.company_id IS NULL THEN 'Built in' ELSE 'Custom' END AS kind, CASE WHEN r.is_active THEN 'Yes' ELSE 'No' END AS active, (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id)::int AS permissions
      FROM roles r WHERE (r.company_id IS NULL OR ${q.co("r")}) AND NOT EXISTS (SELECT 1 FROM user_role_assignments ura WHERE ura.role_id = r.id AND ${q.co("ura")} AND ${ROLE_NOW(q)}) ORDER BY r.name`,
};
const J02_EXPIRING: ReportSectionSpec = {
  key: "assignments-ending-soon",
  title: "Role assignments ending in the next 30 days",
  description: "Temporary assignments that are about to end.",
  columns: [col("role", "Role"), col("person", "Person"), col("to", "Ends", "date"), n("days", "Days left")],
  sql: (q) => `
    SELECT r.name AS role, COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, ura.effective_to::text AS to, (ura.effective_to - ${q.today})::int AS days
      FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id LEFT JOIN employees e ON e.user_account_id = ura.user_account_id AND e.company_id = ura.company_id
     WHERE ${q.co("ura")} AND ura.effective_to BETWEEN ${q.today} AND ${q.today} + 30 ORDER BY ura.effective_to, role`,
};

const REPORT_AUDIT = (action: string) => (q: Q) => `${q.co("a")} AND a.action = '${action}' AND ${IN_RANGE("a", q)}`;
const auditByReport = (key: string, title: string, description: string, action: string, noun: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("report", "Report"), col("sensitivity", "Class"), n("times", noun), n("people", "Different people"), n("rows", "Rows shown"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT a.target AS report, ${LBL("a.metadata->>'sensitivity'")} AS sensitivity, COUNT(*)::int AS times, COUNT(DISTINCT a.actor_id)::int AS people, COALESCE(SUM((a.metadata->>'rowCount')::int), 0)::int AS rows, MAX(a.created_at)::date::text AS last
      FROM audit_log a WHERE ${REPORT_AUDIT(action)(q)} GROUP BY a.target, a.metadata->>'sensitivity' ORDER BY times DESC, report`,
});
const auditByPerson = (key: string, title: string, description: string, action: string, noun: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("person", "Person"), n("times", noun), n("reports", "Different reports"), n("rows", "Rows"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT ${ACTOR("ae")} AS person, COUNT(*)::int AS times, COUNT(DISTINCT a.target)::int AS reports, COALESCE(SUM((a.metadata->>'rowCount')::int), 0)::int AS rows, MAX(a.created_at)::date::text AS last
      FROM audit_log a ${ACTOR_JOIN()} WHERE ${REPORT_AUDIT(action)(q)} GROUP BY a.actor_type, a.actor_id, ae.id, ae.first_name, ae.last_name ORDER BY times DESC, person`,
});
const auditByMonth = (key: string, title: string, description: string, action: string, noun: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("month", "Month"), n("times", noun), n("people", "Different people"), n("rows", "Rows")],
  sql: (q) => `
    SELECT ${MONTH_OF("a.created_at")} AS month, COUNT(*)::int AS times, COUNT(DISTINCT a.actor_id)::int AS people, COALESCE(SUM((a.metadata->>'rowCount')::int), 0)::int AS rows FROM audit_log a WHERE ${REPORT_AUDIT(action)(q)} GROUP BY 1 ORDER BY 1`,
});
const auditBySensitivity = (key: string, title: string, description: string, action: string, noun: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("label", "Class"), col("scope", "Scope"), n("times", noun), n("people", "Different people"), n("rows", "Rows")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(a.metadata->>'sensitivity', 'unknown')")} AS label, ${LBL("COALESCE(a.metadata->>'scope', 'unknown')")} AS scope, COUNT(*)::int AS times, COUNT(DISTINCT a.actor_id)::int AS people, COALESCE(SUM((a.metadata->>'rowCount')::int), 0)::int AS rows
      FROM audit_log a WHERE ${REPORT_AUDIT(action)(q)} GROUP BY a.metadata->>'sensitivity', a.metadata->>'scope' ORDER BY times DESC, label`,
});
const J03_LARGEST: ReportSectionSpec = {
  key: "largest-exports",
  title: "Largest exports",
  description: "The exports that moved the most rows out of the system.",
  columns: [col("when", "When", "date"), col("report", "Report"), col("by", "Exported by"), n("rows", "Rows exported"), col("sensitivity", "Class")],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", a.target AS report, ${ACTOR("ae")} AS by, COALESCE((a.metadata->>'rowCount')::int, 0) AS rows, ${LBL("a.metadata->>'sensitivity'")} AS sensitivity
      FROM audit_log a ${ACTOR_JOIN()} WHERE ${REPORT_AUDIT("report.export")(q)} ORDER BY rows DESC, a.created_at DESC LIMIT 100`,
};
const J03_OUT_OF_HOURS: ReportSectionSpec = {
  key: "out-of-hours",
  title: "Sensitive reports opened out of hours",
  description: "Sensitive and restricted reports opened before 7am, after 10pm or at the weekend, in company time.",
  columns: [col("when", "When"), col("report", "Report"), col("by", "Opened by"), n("rows", "Rows shown")],
  sql: (q) => `
    SELECT to_char(${TZ("a.created_at")}, 'YYYY-MM-DD HH24:MI') AS "when", a.target AS report, ${ACTOR("ae")} AS by, COALESCE((a.metadata->>'rowCount')::int, 0) AS rows
      FROM audit_log a ${ACTOR_JOIN()}
     WHERE ${REPORT_AUDIT("report.run")(q)} AND (EXTRACT(hour FROM ${TZ("a.created_at")}) < 7 OR EXTRACT(hour FROM ${TZ("a.created_at")}) >= 22 OR EXTRACT(isodow FROM ${TZ("a.created_at")}) IN (6, 7))
       AND COALESCE(a.metadata->>'sensitivity', '') IN ('sensitive', 'restricted') ORDER BY a.created_at DESC`,
};

const J05_DAY: ReportSectionSpec = {
  key: "sessions-by-day",
  title: "Sign-in events by day",
  description: "Sessions started, from new devices, with rapid network change and revoked, for each day.",
  columns: [col("day", "Day", "date"), n("sessions", "Sessions"), n("newDevice", "From a new device"), n("rapid", "Rapid network change"), n("revoked", "Revoked")],
  sql: (q) => `
    SELECT s.created_at::date::text AS day, COUNT(*)::int AS sessions, COUNT(*) FILTER (WHERE s.is_new_device)::int AS "newDevice", COUNT(*) FILTER (WHERE s.is_rapid_network_change)::int AS rapid, COUNT(*) FILTER (WHERE s.revoked_at IS NOT NULL)::int AS revoked
      FROM ${SESSIONS} s WHERE s.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1 DESC`,
};
const J05_PEOPLE: ReportSectionSpec = {
  key: "sessions-flagged-by-person",
  title: "People with flagged sessions",
  description: "People who had sessions from a new device, with a rapid network change or that were revoked.",
  columns: [col("person", "Person"), n("sessions", "Sessions"), n("newDevice", "From a new device"), n("rapid", "Rapid network change"), n("revoked", "Revoked"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, COUNT(*)::int AS sessions, COUNT(*) FILTER (WHERE s.is_new_device)::int AS "newDevice", COUNT(*) FILTER (WHERE s.is_rapid_network_change)::int AS rapid,
           COUNT(*) FILTER (WHERE s.revoked_at IS NOT NULL)::int AS revoked, MAX(s.created_at)::date::text AS last
      FROM ${SESSIONS} s LEFT JOIN employees e ON e.user_account_id = s.user_account_id AND ${q.co("e")}
     WHERE s.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY s.user_account_id, e.id, e.first_name, e.last_name HAVING COUNT(*) FILTER (WHERE s.is_new_device OR s.is_rapid_network_change OR s.revoked_at IS NOT NULL) > 0 ORDER BY revoked DESC, rapid DESC, "newDevice" DESC, person`,
};
const J05_LENGTH: ReportSectionSpec = {
  key: "session-length",
  title: "How long sessions last",
  description: "Sessions grouped by the time between sign-in and last activity.",
  columns: [col("label", "Session length"), n("sessions", "Sessions"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS sessions, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN m < 5 THEN '0 Under 5 minutes' WHEN m < 30 THEN '1 5 to 30 minutes' WHEN m < 120 THEN '2 30 minutes to 2 hours' WHEN m < 480 THEN '3 2 to 8 hours' ELSE '4 Over 8 hours' END AS band
              FROM (SELECT EXTRACT(EPOCH FROM (s.last_seen_at - s.created_at)) / 60.0 AS m FROM ${SESSIONS} s WHERE s.created_at::date BETWEEN ${q.from} AND ${q.to} AND s.last_seen_at IS NOT NULL) x) b GROUP BY b.band ORDER BY b.band`,
};
const J05_ACTIONS: ReportSectionSpec = {
  key: "security-events-by-day",
  title: "Security events by day",
  description: "Suspicious sign-ins, single sign-on sign-ins and forced sign-outs recorded in the audit trail each day.",
  columns: [col("day", "Day", "date"), col("event", "Event"), n("events", "Count"), n("people", "Different people")],
  sql: (q) => `
    SELECT a.created_at::date::text AS day, CASE a.action WHEN 'auth.suspicious_login' THEN 'Suspicious sign-in flagged' WHEN 'sso.login' THEN 'Single sign-on sign-in' WHEN 'session.force_logout' THEN 'Forced sign-out' ELSE 'Session revoked by an administrator' END AS event,
           COUNT(*)::int AS events, COUNT(DISTINCT a.actor_id)::int AS people
      FROM audit_log a WHERE ${q.co("a")} AND a.action IN ('auth.suspicious_login', 'sso.login', 'session.force_logout', 'session.revoked') AND ${IN_RANGE("a", q)} GROUP BY 1, a.action ORDER BY 1 DESC, event`,
};
const J05_CHANNEL: ReportSectionSpec = {
  key: "sign-ins-by-channel",
  title: "Where sign-in events came from",
  description: "Audit events about sign-in by the channel they came through, without addresses.",
  columns: [col("label", "Channel"), col("event", "Event"), n("events", "Count")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(a.source_channel, 'unknown')")} AS label, ${LBL("a.action")} AS event, COUNT(*)::int AS events
      FROM audit_log a WHERE ${q.co("a")} AND (a.action LIKE 'auth.%' OR a.action LIKE 'session.%' OR a.action = 'sso.login') AND ${IN_RANGE("a", q)} GROUP BY a.source_channel, a.action ORDER BY events DESC, label, event`,
};

const J06_STATUS: ReportSectionSpec = {
  key: "mfa-status",
  title: "MFA status of everyone with access",
  description: "Accounts with a role in force today grouped by MFA state.",
  columns: [col("label", "MFA"), n("accounts", "Accounts"), pc("share", "Share (%)")],
  sql: (q) => `
    SELECT x.label, COUNT(*)::int AS accounts, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM (SELECT CASE WHEN acc.mfa_enabled THEN 'On' WHEN acc.mfa_required THEN 'Required, not set up' ELSE 'Off' END AS label
              FROM ${ACCOUNTS} acc WHERE EXISTS (SELECT 1 FROM user_role_assignments ura WHERE ura.user_account_id = acc.user_account_id AND ${q.co("ura")} AND ${ROLE_NOW(q)})) x GROUP BY x.label ORDER BY accounts DESC, label`,
};
const J06_NO_MFA: ReportSectionSpec = {
  key: "roles-without-mfa",
  title: "People with roles but no MFA",
  description: "Everyone who holds a role in force today and has MFA switched off.",
  columns: [col("person", "Person"), col("roles", "Roles"), col("mfa", "MFA"), col("lastSignIn", "Last sign-in", "date")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, string_agg(DISTINCT r.name, ', ' ORDER BY r.name) AS roles, CASE WHEN acc.mfa_required THEN 'Required, not set up' ELSE 'Off' END AS mfa, acc.last_login_at::date::text AS "lastSignIn"
      FROM ${ACCOUNTS} acc JOIN user_role_assignments ura ON ura.user_account_id = acc.user_account_id AND ${q.co("ura")} AND ${ROLE_NOW(q)} JOIN roles r ON r.id = ura.role_id
      LEFT JOIN employees e ON e.user_account_id = acc.user_account_id AND ${q.co("e")} WHERE NOT acc.mfa_enabled GROUP BY acc.user_account_id, acc.mfa_required, acc.last_login_at, e.id, e.first_name, e.last_name ORDER BY person`,
};
const J06_PROVIDER: ReportSectionSpec = {
  key: "mfa-by-sign-in-method",
  title: "MFA by sign-in method",
  description: "How MFA is spread across password and single sign-on accounts.",
  columns: [col("label", "Sign-in method"), n("accounts", "Accounts"), n("mfa", "MFA on"), pc("rate", "MFA on (%)")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(acc.auth_provider, 'password')")} AS label, COUNT(*)::int AS accounts, COUNT(*) FILTER (WHERE acc.mfa_enabled)::int AS mfa, ROUND(COUNT(*) FILTER (WHERE acc.mfa_enabled) * 100.0 / COUNT(*), 1) AS rate
      FROM ${ACCOUNTS} acc WHERE EXISTS (SELECT 1 FROM user_role_assignments ura WHERE ura.user_account_id = acc.user_account_id AND ${q.co("ura")} AND ${ROLE_NOW(q)}) GROUP BY acc.auth_provider ORDER BY accounts DESC, label`,
};
const J06_MFA_EVENTS: ReportSectionSpec = {
  key: "mfa-resets",
  title: "MFA resets and requirement changes",
  description: "Audit events that changed MFA for an account, with who made them. Available for the last 90 days.",
  columns: [col("when", "When", "date"), col("event", "Event"), col("by", "Done by"), col("affected", "Affected person")],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", ${LBL("a.action")} AS event, ${ACTOR("ae")} AS by, COALESCE(NULLIF(${NAME("te")}, ''), 'Not a person') AS affected
      FROM audit_log a ${ACTOR_JOIN()} LEFT JOIN employees te ON te.user_account_id::text = a.target AND te.company_id = a.company_id
     WHERE ${q.co("a")} AND a.action IN ('system_admin.mfa_reset', 'system_admin.mfa_requirement_changed', 'company.admin.mfa_reset') AND a.created_at::date >= ${q.today} - 90 ORDER BY a.created_at DESC`,
};

const J07_LOCKED: ReportSectionSpec = {
  key: "lockouts-by-status",
  title: "Failed attempts and lockouts",
  description: "Accounts grouped by how many failed attempts they currently carry and whether they are locked.",
  columns: [col("label", "State"), n("accounts", "Accounts")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS accounts
      FROM (SELECT CASE WHEN acc.locked_until > now() THEN '0 Locked now' WHEN acc.failed_login_attempts >= 3 THEN '1 Three or more failed attempts' WHEN acc.failed_login_attempts > 0 THEN '2 One or two failed attempts' ELSE '3 No failed attempts' END AS band
              FROM ${ACCOUNTS} acc WHERE EXISTS (SELECT 1 FROM employees e WHERE e.user_account_id = acc.user_account_id AND ${q.co("e")}) OR EXISTS (SELECT 1 FROM user_role_assignments u WHERE u.user_account_id = acc.user_account_id AND ${q.co("u")})) b GROUP BY b.band ORDER BY b.band`,
};
const J07_SUSPICIOUS: ReportSectionSpec = {
  key: "suspicious-by-day",
  title: "Suspicious sign-ins by day",
  description: "Suspicious sign-ins flagged each day and the number of accounts involved.",
  columns: [col("day", "Day", "date"), n("flagged", "Flagged"), n("accounts", "Accounts")],
  sql: (q) => `
    SELECT a.created_at::date::text AS day, COUNT(*)::int AS flagged, COUNT(DISTINCT a.actor_id)::int AS accounts FROM audit_log a WHERE ${q.co("a")} AND a.action = 'auth.suspicious_login' AND ${IN_RANGE("a", q)} GROUP BY 1 ORDER BY 1 DESC`,
};
const J07_UNLOCKS: ReportSectionSpec = {
  key: "lock-and-unlock",
  title: "Locks and unlocks by an administrator",
  description: "Accounts locked or unlocked by an administrator and who did it.",
  columns: [col("when", "When", "date"), col("event", "Event"), col("by", "Done by"), col("affected", "Affected person")],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", ${LBL("a.action")} AS event, ${ACTOR("ae")} AS by, COALESCE(NULLIF(${NAME("te")}, ''), 'Not a person') AS affected
      FROM audit_log a ${ACTOR_JOIN()} LEFT JOIN employees te ON te.user_account_id::text = a.target AND te.company_id = a.company_id
     WHERE ${q.co("a")} AND a.action IN ('company.admin.locked', 'company.admin.unlocked', 'auth.account_locked', 'auth.account_unlocked') AND ${IN_RANGE("a", q)} ORDER BY a.created_at DESC`,
};
const J07_PASSWORD: ReportSectionSpec = {
  key: "credential-age",
  title: "How old credentials are",
  description: "Active accounts grouped by when their credentials were last issued or reset.",
  columns: [col("label", "Credentials issued"), n("accounts", "Accounts")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS accounts
      FROM (SELECT CASE WHEN acc.credential_issued_at IS NULL THEN '4 Not recorded' WHEN acc.credential_issued_at::date >= ${q.today} - 90 THEN '0 In the last 90 days' WHEN acc.credential_issued_at::date >= ${q.today} - 180 THEN '1 90 to 180 days ago'
                         WHEN acc.credential_issued_at::date >= ${q.today} - 365 THEN '2 180 days to a year ago' ELSE '3 More than a year ago' END AS band
              FROM ${ACCOUNTS} acc WHERE acc.status = 'active' AND (EXISTS (SELECT 1 FROM employees e WHERE e.user_account_id = acc.user_account_id AND ${q.co("e")}) OR EXISTS (SELECT 1 FROM user_role_assignments u WHERE u.user_account_id = acc.user_account_id AND ${q.co("u")}))) b
     GROUP BY b.band ORDER BY b.band`,
};

const ACCESS_CHANGE = `(a.action LIKE 'rbac.%' OR a.action IN ('system_admin.role_assigned', 'system_admin.role_revoked', 'system_admin.mfa_reset', 'system_admin.password_reset', 'system_admin.mfa_requirement_changed',
                                                  'company.admin.created', 'company.admin.mfa_reset', 'company.admin.password_reset', 'company.admin.locked', 'company.admin.unlocked', 'employee.access_revoked'))`;
const auditActionMix = (key: string, title: string, description: string, filter: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("change", "Kind of change"), n("changes", "Changes"), n("people", "Made by (people)"), col("first", "First", "date"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT ${LBL("a.action")} AS change, COUNT(*)::int AS changes, COUNT(DISTINCT a.actor_id)::int AS people, MIN(a.created_at)::date::text AS first, MAX(a.created_at)::date::text AS last
      FROM audit_log a WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${filter} GROUP BY a.action ORDER BY changes DESC, change`,
});
const auditByActor = (key: string, title: string, description: string, filter: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("person", "Done by"), n("changes", "Changes"), n("kinds", "Kinds of change"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT ${ACTOR("ae")} AS person, COUNT(*)::int AS changes, COUNT(DISTINCT a.action)::int AS kinds, MAX(a.created_at)::date::text AS last
      FROM audit_log a ${ACTOR_JOIN()} WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${filter} GROUP BY a.actor_type, a.actor_id, ae.id, ae.first_name, ae.last_name ORDER BY changes DESC, person`,
});
const auditMonthly = (key: string, title: string, description: string, filter: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("month", "Month"), n("changes", "Changes"), n("people", "Made by (people)"), n("kinds", "Kinds of change")],
  sql: (q) => `
    SELECT ${MONTH_OF("a.created_at")} AS month, COUNT(*)::int AS changes, COUNT(DISTINCT a.actor_id)::int AS people, COUNT(DISTINCT a.action)::int AS kinds FROM audit_log a WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${filter} GROUP BY 1 ORDER BY 1`,
});
const auditWeekday = (key: string, title: string, description: string, filter: string): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [col("label", "Day"), n("changes", "Changes"), n("outOfHours", "Outside 7am to 10pm")],
  sql: (q) => `
    SELECT trim(to_char(${TZ("a.created_at")}, 'Day')) AS label, COUNT(*)::int AS changes, COUNT(*) FILTER (WHERE EXTRACT(hour FROM ${TZ("a.created_at")}) < 7 OR EXTRACT(hour FROM ${TZ("a.created_at")}) >= 22)::int AS "outOfHours"
      FROM audit_log a WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${filter} GROUP BY 1, EXTRACT(isodow FROM ${TZ("a.created_at")}) ORDER BY EXTRACT(isodow FROM ${TZ("a.created_at")})`,
});
const MASTER_CHANGE = `(a.action IN ('employee.create', 'person.update', 'work_profile.set', 'employee_important_date.create', 'employee_address.create', 'employee_contact.create', 'employee_family_member.create', 'employee_education.create',
                         'employee_qualification.create', 'employee_org_assignment.create', 'employee_org_assignment.update', 'employee_org_assignment.end', 'employee_org_assignment.transfer', 'employee_number.reserved', 'employee_number.voided')
            OR a.action LIKE 'employee.lifecycle.%')`;
const J09_RECORDS: ReportSectionSpec = {
  key: "most-changed-records",
  title: "Employees whose records changed most",
  description: "Employees with the most recorded changes in the period. The values that changed are not shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), n("changes", "Changes"), n("kinds", "Kinds of change"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT COALESCE(e.employee_number, '-') AS number, COALESCE(NULLIF(${NAME("e")}, ''), 'Record not found') AS name, COUNT(*)::int AS changes, COUNT(DISTINCT a.action)::int AS kinds, MAX(a.created_at)::date::text AS last
      FROM audit_log a LEFT JOIN employees e ON e.id::text = a.target AND e.company_id = a.company_id
     WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${MASTER_CHANGE} GROUP BY e.id, e.employee_number, e.first_name, e.last_name ORDER BY changes DESC, name LIMIT 200`,
};
const J09_CHANNEL: ReportSectionSpec = {
  key: "changes-by-channel",
  title: "Master data changes by channel",
  description: "Whether record changes were made in the portal, by import, by an integration or by the system.",
  columns: [col("label", "Channel"), n("changes", "Changes"), n("people", "Made by (people)")],
  sql: (q) => `
    SELECT ${LBL("COALESCE(a.source_channel, 'unknown')")} AS label, COUNT(*)::int AS changes, COUNT(DISTINCT a.actor_id)::int AS people FROM audit_log a WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${MASTER_CHANGE} GROUP BY a.source_channel ORDER BY changes DESC, label`,
};

const J10_EVENTS = (q: Q) => `${q.co("pr")} AND ${q.area("pr")}`;
const J10_BY_ACTION: ReportSectionSpec = {
  key: "run-events-by-action",
  title: "Run changes by action",
  description: "Each kind of status change on payroll runs: how often, by how many people. Amounts are not shown.",
  columns: [col("action", "Action"), col("from", "From status"), col("to", "To status"), n("times", "Times"), n("people", "Done by (people)"), n("noReason", "With no reason recorded")],
  sql: (q) => `
    SELECT ${LBL("ev.action")} AS action, ${LBL("COALESCE(ev.from_status, 'new')")} AS "from", ${LBL("ev.to_status")} AS "to", COUNT(*)::int AS times, COUNT(DISTINCT ev.actor_user_account_id)::int AS people,
           COUNT(*) FILTER (WHERE COALESCE(TRIM(ev.reason), '') = '')::int AS "noReason"
      FROM payroll_run_events ev JOIN payroll_runs pr ON pr.id = ev.payroll_run_id AND pr.company_id = ev.company_id WHERE ${J10_EVENTS(q)} AND ev.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY ev.action, ev.from_status, ev.to_status ORDER BY times DESC, action`,
};
const J10_OVERRIDES: ReportSectionSpec = {
  key: "overrides-by-field",
  title: "Overrides by field and status",
  description: "Manual overrides of calculated payroll fields: which field, how many, and whether they were approved or withdrawn. The values are not shown.",
  columns: [col("field", "Field overridden"), col("status", "Status"), n("overrides", "Overrides"), n("people", "Employees affected"), n("noReason", "With no reason recorded")],
  sql: (q) => `
    SELECT ${LBL("po.field")} AS field, ${LBL("po.status")} AS status, COUNT(*)::int AS overrides, COUNT(DISTINCT po.employee_id)::int AS people, COUNT(*) FILTER (WHERE COALESCE(TRIM(po.reason), '') = '')::int AS "noReason"
      FROM payroll_overrides po JOIN payroll_runs pr ON pr.id = po.payroll_run_id AND pr.company_id = po.company_id WHERE ${J10_EVENTS(q)} AND po.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY po.field, po.status ORDER BY overrides DESC, field`,
};
const J10_ACTORS: ReportSectionSpec = {
  key: "payroll-changes-by-person",
  title: "Payroll changes by person",
  description: "Who changed payroll run status and who made overrides.",
  columns: [col("person", "Person"), n("runChanges", "Run status changes"), n("overrides", "Overrides made")],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${NAME("ue")}, ''), 'System') AS person, SUM(t.runs)::int AS "runChanges", SUM(t.ovr)::int AS overrides FROM (
      SELECT ev.actor_user_account_id AS acct, ev.company_id AS cid, 1 AS runs, 0 AS ovr FROM payroll_run_events ev JOIN payroll_runs pr ON pr.id = ev.payroll_run_id AND pr.company_id = ev.company_id
       WHERE ${J10_EVENTS(q)} AND ev.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL SELECT po.overridden_by, po.company_id, 0, 1 FROM payroll_overrides po JOIN payroll_runs pr ON pr.id = po.payroll_run_id AND pr.company_id = po.company_id
       WHERE ${J10_EVENTS(q)} AND po.created_at::date BETWEEN ${q.from} AND ${q.to}) t
      LEFT JOIN employees ue ON ue.user_account_id = t.acct AND ue.company_id = t.cid GROUP BY ue.id, ue.first_name, ue.last_name ORDER BY "runChanges" DESC, overrides DESC, person`,
};
const J10_MONTH: ReportSectionSpec = {
  key: "payroll-changes-by-month",
  title: "Payroll changes by month",
  description: "Run status changes and overrides each month.",
  columns: [col("month", "Month"), n("runChanges", "Run status changes"), n("overrides", "Overrides")],
  sql: (q) => `
    SELECT t.month, SUM(t.runs)::int AS "runChanges", SUM(t.ovr)::int AS overrides FROM (
      SELECT ${MONTH_OF("ev.created_at")} AS month, 1 AS runs, 0 AS ovr FROM payroll_run_events ev JOIN payroll_runs pr ON pr.id = ev.payroll_run_id AND pr.company_id = ev.company_id WHERE ${J10_EVENTS(q)} AND ev.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL SELECT ${MONTH_OF("po.created_at")}, 0, 1 FROM payroll_overrides po JOIN payroll_runs pr ON pr.id = po.payroll_run_id AND pr.company_id = po.company_id WHERE ${J10_EVENTS(q)} AND po.created_at::date BETWEEN ${q.from} AND ${q.to}) t GROUP BY t.month ORDER BY t.month`,
};
const J10_REVERSALS: ReportSectionSpec = {
  key: "reversals-and-cancellations",
  title: "Reversed and cancelled runs",
  description: "Runs that were reversed or cancelled in the period, with who did it and the reason. Amounts are not shown.",
  columns: [col("period", "Payroll period"), col("status", "Status"), col("on", "On", "date"), col("by", "Done by"), col("reason", "Reason")],
  sql: (q) => `
    SELECT pr.period_start::text || ' to ' || pr.period_end::text AS period, ${LBL("pr.status")} AS status, COALESCE(pr.reversed_at, pr.cancelled_at)::date::text AS on,
           COALESCE(NULLIF(${NAME("ue")}, ''), 'System') AS by, COALESCE(NULLIF(LEFT(COALESCE(pr.reversal_reason, pr.cancel_reason), 200), ''), 'No reason recorded') AS reason
      FROM payroll_runs pr LEFT JOIN employees ue ON ue.user_account_id = COALESCE(pr.reversed_by_user_account_id, pr.cancelled_by_user_account_id) AND ue.company_id = pr.company_id
     WHERE ${J10_EVENTS(q)} AND pr.is_simulation = false AND pr.status IN ('reversed', 'cancelled') AND COALESCE(pr.reversed_at, pr.cancelled_at)::date BETWEEN ${q.from} AND ${q.to} ORDER BY COALESCE(pr.reversed_at, pr.cancelled_at) DESC`,
};

const J11_FILTER = "(a.action LIKE 'workflow_template.%' OR a.action LIKE 'configuration_%' OR a.action LIKE 'tenant_configuration.%' OR a.action LIKE 'rule_%')";
const J11_TEMPLATES: ReportSectionSpec = {
  key: "templates-changed",
  title: "Templates changed most",
  description: "Workflow templates with the most configuration changes in the period.",
  columns: [col("template", "Template"), n("changes", "Changes"), n("people", "Changed by (people)"), col("last", "Latest", "date")],
  sql: (q) => `
    SELECT COALESCE(wt.name, 'Not a template') AS template, COUNT(*)::int AS changes, COUNT(DISTINCT a.actor_id)::int AS people, MAX(a.created_at)::date::text AS last
      FROM audit_log a LEFT JOIN workflow_templates wt ON wt.id::text = a.target AND wt.company_id = a.company_id WHERE ${q.co("a")} AND ${IN_RANGE("a", q)} AND ${J11_FILTER} GROUP BY wt.id, wt.name ORDER BY changes DESC, template`,
};

const J12_STATUS: ReportSectionSpec = {
  key: "requests-by-status",
  title: "Requests by type and status",
  description: "Data subject requests grouped by type and where they stand.",
  columns: [col("type", "Request type"), col("status", "Status"), n("requests", "Requests"), n("avgDays", "Average days open")],
  sql: (q) => `
    SELECT ${LBL("d.request_type")} AS type, ${LBL("d.status")} AS status, COUNT(*)::int AS requests, ROUND(AVG(COALESCE(d.fulfilled_at::date, ${q.today}) - d.created_at::date), 1) AS "avgDays"
      FROM data_subject_requests d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY d.request_type, d.status ORDER BY requests DESC, type`,
};
const J12_MONTH: ReportSectionSpec = {
  key: "requests-by-month",
  title: "Requests by month",
  description: "Requests received and fulfilled each month.",
  columns: [col("month", "Month"), n("received", "Received"), n("fulfilled", "Fulfilled")],
  sql: (q) => `
    SELECT ${MONTH_OF("d.created_at")} AS month, COUNT(*)::int AS received, COUNT(*) FILTER (WHERE d.fulfilled_at IS NOT NULL)::int AS fulfilled FROM data_subject_requests d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const J12_OPEN: ReportSectionSpec = {
  key: "open-requests",
  title: "Open requests and their age",
  description: "Requests not yet fulfilled with how long they have been open. Descriptions and notes are not shown.",
  columns: [col("number", "Employee number"), col("name", "Name"), col("type", "Request type"), col("status", "Status"), col("received", "Received", "date"), n("days", "Days open")],
  sql: (q) => `
    SELECT COALESCE(e.employee_number, '-') AS number, COALESCE(NULLIF(${NAME("e")}, ''), 'Not linked to an employee') AS name, ${LBL("d.request_type")} AS type, ${LBL("d.status")} AS status, d.created_at::date::text AS received, (${q.today} - d.created_at::date)::int AS days
      FROM data_subject_requests d LEFT JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id
     WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} AND d.fulfilled_at IS NULL AND d.status NOT IN ('rejected', 'cancelled', 'declined', 'withdrawn') ORDER BY days DESC, name`,
};
const J12_SPEED: ReportSectionSpec = {
  key: "time-to-fulfil",
  title: "How long fulfilment took",
  description: "Fulfilled requests grouped by days from receipt to fulfilment.",
  columns: [col("label", "Fulfilled within"), n("requests", "Requests")],
  sql: (q) => `
    SELECT substr(b.band, 3) AS label, COUNT(*)::int AS requests
      FROM (SELECT CASE WHEN d <= 7 THEN '0 A week' WHEN d <= 14 THEN '1 Two weeks' WHEN d <= 30 THEN '2 A month' ELSE '3 More than a month' END AS band
              FROM (SELECT (d.fulfilled_at::date - d.created_at::date) AS d FROM data_subject_requests d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to} AND d.fulfilled_at IS NOT NULL) x) b GROUP BY b.band ORDER BY b.band`,
};

const J13_CATEGORIES: ReportSectionSpec = {
  key: "settings-by-category",
  title: "All company settings by category",
  description: "How many settings exist in each category, how many are published and when each category last changed.",
  columns: [col("label", "Category"), n("settings", "Settings"), n("published", "Published"), n("draft", "Not published"), col("last", "Last changed", "date")],
  sql: () => `
    SELECT ${LBL("tc.category")} AS label, COUNT(*)::int AS settings, COUNT(*) FILTER (WHERE tc.status = 'published')::int AS published, COUNT(*) FILTER (WHERE tc.status <> 'published')::int AS draft, MAX(tc.updated_at)::date::text AS last
      FROM ${CONFIG} tc GROUP BY tc.category ORDER BY settings DESC, label`,
};
const J13_PENDING: ReportSectionSpec = {
  key: "security-settings-pending",
  title: "Security settings not yet in force",
  description: "Security settings that are drafts, scheduled for the future or already ended.",
  columns: [col("setting", "Setting"), col("state", "State"), col("scope", "Applies to"), col("from", "From", "date"), col("to", "Until", "date")],
  sql: (q) => `
    SELECT ${LBL("tc.setting_key")} AS setting, CASE WHEN tc.status <> 'published' THEN 'Not published' WHEN tc.effective_from > ${q.today} THEN 'Starts later' ELSE 'Ended' END AS state, ${LBL("COALESCE(tc.scope_type, 'company')")} AS scope,
           tc.effective_from::text AS from, tc.effective_to::text AS to
      FROM ${CONFIG} tc WHERE tc.category = 'security' AND (tc.status <> 'published' OR tc.effective_from > ${q.today} OR tc.effective_to < ${q.today}) ORDER BY setting`,
};
const J13_INTEGRATIONS: ReportSectionSpec = {
  key: "integrations",
  title: "Integrations",
  description: "Connected providers, whether each is on and whether provisioning is on.",
  columns: [col("label", "Provider"), col("enabled", "Enabled"), col("scim", "Provisioning"), col("updated", "Last changed", "date")],
  sql: () => `
    SELECT ${LBL("i.provider_key")} AS label, CASE WHEN i.enabled THEN 'On' ELSE 'Off' END AS enabled, CASE WHEN i.scim_enabled THEN 'On' ELSE 'Off' END AS scim, i.updated_at::date::text AS updated
      FROM ${INTEGRATIONS} i ORDER BY label`,
};
const J13_CHANGES: ReportSectionSpec = {
  key: "settings-recently-changed",
  title: "Settings changed in the last 90 days",
  description: "Company settings updated recently, from any category.",
  columns: [col("category", "Category"), col("setting", "Setting"), col("status", "Status"), col("updated", "Changed", "date")],
  sql: (q) => `
    SELECT ${LBL("tc.category")} AS category, ${LBL("tc.setting_key")} AS setting, ${LBL("tc.status")} AS status, tc.updated_at::date::text AS updated FROM ${CONFIG} tc WHERE tc.updated_at::date >= ${q.today} - 90 ORDER BY tc.updated_at DESC`,
};

export const ESS_AUDIT_DEPTH: Record<string, ReportSectionSpec[]> = {
  I01: [I01_LOCATION, I01_TYPE, I01_TENURE, I01_RECENCY, I01_MFA, I01_NEVER],
  I02: [I02_UNIT, I02_WEEKDAY, I02_HOUR, I02_DEVICE, I02_RETURN],
  I03: [I03_MONTH, I03_UNIT, I03_ENTERED_BY, I03_ADOPTION],
  I04: [I04_MANAGERS, I04_INACTIVE, I04_LOCATION],
  I06: [I06_TYPE, I06_UNIT, I06_ENTERED],
  I10: [I10_UNIT, I10_COUNT, I10_MISSING],
  I12: [I12_DAY, I12_CHANNEL, I12_TEMPLATE, I12_STATUS],
  I13: [I13_CHANNEL, I13_DAY, I13_REPEAT],
  I14: [I14_PEOPLE, I14_CATEGORY, I14_OVERDUE, I14_MONTH, I14_TIME],
  J01: [J01_STATUS, J01_HOLDERS, J01_LEFT, J01_STALE],
  J02: [J02_PERMS, J02_WIDE, J02_EMPTY, J02_EXPIRING],
  J03: [auditByReport("opens-by-report", "Opens by report", "Which sensitive reports were opened, how often and by how many people.", "report.run", "Times opened"), auditByPerson("opens-by-person", "Opens by person", "Who opened sensitive reports and how many.", "report.run", "Times opened"),
        auditByMonth("opens-by-month", "Opens by month", "Sensitive report opens each month.", "report.run", "Times opened"), auditBySensitivity("opens-by-class", "Opens by class and scope", "Opens split by sensitivity and by the scope of access used.", "report.run", "Times opened"), J03_OUT_OF_HOURS],
  J04: [auditByReport("exports-by-report", "Exports by report", "Which reports were exported, how often, by how many people and how many rows.", "report.export", "Exports"), auditByPerson("exports-by-person", "Exports by person", "Who exported reports and how many rows left the system.", "report.export", "Exports"),
        auditByMonth("exports-by-month", "Exports by month", "Exports each month.", "report.export", "Exports"), auditBySensitivity("exports-by-class", "Exports by class and scope", "Exports split by sensitivity and scope of access.", "report.export", "Exports"), J03_LARGEST],
  J05: [J05_DAY, J05_PEOPLE, J05_LENGTH, J05_ACTIONS, J05_CHANNEL],
  J06: [J06_STATUS, J06_NO_MFA, J06_PROVIDER, J06_MFA_EVENTS],
  J07: [J07_LOCKED, J07_SUSPICIOUS, J07_UNLOCKS, J07_PASSWORD],
  J08: [auditActionMix("access-changes-by-kind", "Access changes by kind", "Each kind of access change: how often, by how many people.", ACCESS_CHANGE), auditByActor("access-changes-by-person", "Access changes by person", "Who made access changes.", ACCESS_CHANGE),
        auditMonthly("access-changes-by-month", "Access changes by month", "Access changes each month.", ACCESS_CHANGE), auditWeekday("access-changes-by-weekday", "Access changes by day of the week", "When access changes are made, including outside working hours.", ACCESS_CHANGE), J02_EXPIRING],
  J09: [auditByActor("master-changes-by-person", "Record changes by person", "Who changed employee records.", MASTER_CHANGE), auditMonthly("master-changes-by-month", "Record changes by month", "Employee record changes each month.", MASTER_CHANGE),
        auditWeekday("master-changes-by-weekday", "Record changes by day of the week", "When employee records are changed, including outside working hours.", MASTER_CHANGE), J09_CHANNEL, J09_RECORDS],
  J10: [J10_BY_ACTION, J10_OVERRIDES, J10_ACTORS, J10_MONTH, J10_REVERSALS],
  J11: [auditActionMix("configuration-changes-by-kind", "Configuration changes by kind", "Each kind of configuration change: how often, by how many people.", J11_FILTER), auditByActor("configuration-changes-by-person", "Configuration changes by person", "Who changed configuration.", J11_FILTER),
        auditMonthly("configuration-changes-by-month", "Configuration changes by month", "Configuration changes each month.", J11_FILTER), J11_TEMPLATES],
  J12: [J12_STATUS, J12_MONTH, J12_OPEN, J12_SPEED],
  J13: [J13_CATEGORIES, J13_PENDING, J13_INTEGRATIONS, J13_CHANGES],
};
