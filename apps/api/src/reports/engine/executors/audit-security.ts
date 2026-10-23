import { barChart, count, donutChart, listReport, num, pct, percent, sqlReport, sum } from "../report-spec";

/**
 * Audit, compliance and security reports (catalog J01 to J13, except the blocked ones). They read the company's own audit
 * trail, role assignments and security settings, so they need administration rights and the sensitive-report permission.
 * They show who did what and when, never the values that changed (before/after data), passwords, secrets or IP addresses.
 *
 * Account and sign-in facts come from app.report_company_accounts() and app.report_company_sessions() (migration 0165).
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const LABEL = (col: string) => `INITCAP(REPLACE(REPLACE(${col}, '_', ' '), '.', ' - '))`;
const ACCOUNTS = "app.report_company_accounts()";
const SESSIONS = "app.report_company_sessions()";
const CONFIG = "app.report_company_configuration()";
const INTEGRATIONS = "app.report_company_integrations()";
/** Who did it: the employee's name, or the kind of actor when it was not an employee. */
const ACTOR = (emp: string, log = "a") => `CASE WHEN ${log}.actor_type = 'user' THEN COALESCE(NULLIF(${NAME(emp)}, ''), 'A user without an employee record') WHEN ${log}.actor_type = 'platform_admin' THEN 'Platform support' ELSE INITCAP(COALESCE(${log}.actor_type, 'system')) END`;
const ACTOR_JOIN = (log = "a", emp = "ae") => `LEFT JOIN employees ${emp} ON ${emp}.user_account_id = ${log}.actor_id AND ${emp}.company_id = ${log}.company_id`;
const IN_RANGE = (log: string, from: string, to: string) => `${log}.created_at::date BETWEEN ${from} AND ${to}`;
const STALE_DAYS = 90;

export const J01 = listReport({
  description: "Everyone who can sign in to this company: their roles, MFA, last sign-in and anything that needs a second look.",
  tables: ["user_accounts", "user_role_assignments", "roles", "employees"],
  tags: ["access review", "users", "roles"],
  countLabel: "Accounts",
  columns: [
    { key: "number", label: "Employee number", type: "text" },
    { key: "person", label: "Person", type: "text" },
    { key: "status", label: "Account", type: "text" },
    { key: "roles", label: "Roles", type: "text" },
    { key: "mfa", label: "MFA", type: "text" },
    { key: "lastSignIn", label: "Last sign-in", type: "date" },
    { key: "flags", label: "To review", type: "text" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT COALESCE(e.employee_number, '-') AS number, COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, ${LABEL("acc.status")} AS status,
             COALESCE(string_agg(DISTINCT r.name, ', ' ORDER BY r.name), 'No role') AS roles, CASE WHEN acc.mfa_enabled THEN 'On' WHEN acc.mfa_required THEN 'Required, not set up' ELSE 'Off' END AS mfa,
             acc.last_login_at::date::text AS "lastSignIn",
             NULLIF(CONCAT_WS('; ',
               CASE WHEN e.employment_status = 'terminated' AND acc.status = 'active' THEN 'Employee has left but the account is active' END,
               CASE WHEN acc.last_login_at IS NULL THEN 'Never signed in' WHEN acc.last_login_at::date < ${q.today} - ${STALE_DAYS} THEN 'No sign-in for ${STALE_DAYS}+ days' END,
               CASE WHEN NOT acc.mfa_enabled AND COUNT(r.id) > 0 THEN 'Has roles without MFA' END,
               CASE WHEN COUNT(r.id) = 0 THEN 'Account without a role' END), '') AS flags
        FROM ${ACCOUNTS} acc
        LEFT JOIN employees e ON e.user_account_id = acc.user_account_id AND ${q.co("e")}
        LEFT JOIN user_role_assignments ura ON ura.user_account_id = acc.user_account_id AND ${q.co("ura")}
             AND (ura.effective_from IS NULL OR ura.effective_from <= ${q.today}) AND (ura.effective_to IS NULL OR ura.effective_to >= ${q.today})
        LEFT JOIN roles r ON r.id = ura.role_id
       GROUP BY acc.user_account_id, acc.status, acc.mfa_enabled, acc.mfa_required, acc.last_login_at, e.id, e.employee_number, e.first_name, e.last_name, e.employment_status
    ) t ORDER BY (t.flags IS NULL), t.person`,
  kpis: ({ rows }) => [count("flagged", "With something to review", rows.filter((r) => r.flags).length), count("noMfa", "Without MFA", rows.filter((r) => r.mfa !== "On").length)],
  calculation: ["One line per account linked to this company through a role assignment or an employee record. Roles are the ones in force today.", `Flags: an active account for an employee who has left; no sign-in for ${STALE_DAYS} days or ever; roles held without MFA; an account with no role.`],
});

export const J02 = sqlReport({
  description: "Each role: how many people hold it today, how many permissions it carries and how many of those reach the whole company.",
  tables: ["roles", "role_permissions", "permissions", "user_role_assignments"],
  viz: ["bar", "kpi", "table"],
  tags: ["roles", "permissions"],
  columns: [
    { key: "role", label: "Role", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "active", label: "Active", type: "text" },
    { key: "people", label: "People holding it", type: "number" },
    { key: "permissions", label: "Permissions", type: "number" },
    { key: "wide", label: "Company-wide permissions", type: "number" },
  ],
  sql: (q) => `
    SELECT r.name AS role, CASE WHEN r.company_id IS NULL THEN 'Built in' ELSE 'Custom' END AS kind, CASE WHEN r.is_active THEN 'Yes' ELSE 'No' END AS active,
           (SELECT COUNT(DISTINCT ura.user_account_id)::int FROM user_role_assignments ura WHERE ura.role_id = r.id AND ${q.co("ura")}
               AND (ura.effective_from IS NULL OR ura.effective_from <= ${q.today}) AND (ura.effective_to IS NULL OR ura.effective_to >= ${q.today})) AS people,
           (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions,
           (SELECT COUNT(*)::int FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id AND p.scope = 'all') AS wide
      FROM roles r WHERE (r.company_id IS NULL OR ${q.co("r")})
     ORDER BY people DESC, wide DESC, role`,
  chart: ({ rows }) => (rows.some((r) => num(r, "people") > 0) ? barChart({ title: "People holding each role", unit: "people", rows: rows.filter((r) => num(r, "people") > 0), labelKey: "role", valueKey: "people", max: 12 }) : null),
  kpis: ({ rows }) => [count("roles", "Roles", rows.length), count("custom", "Custom roles", rows.filter((r) => r.kind === "Custom").length), count("unused", "Active roles nobody holds", rows.filter((r) => r.active === "Yes" && num(r, "people") === 0).length)],
  calculation: ["Lists built-in roles and this company's custom roles. People holding a role counts distinct accounts with an assignment in force today.", "Company-wide permissions are those whose scope is 'all' (they reach every employee rather than a team or oneself)."],
});

export const J03 = listReport({
  description: "Every time a sensitive or restricted report was opened: who, which report, when and how many rows it showed.",
  defaultRange: "last90Days",
  tables: ["audit_log"],
  tags: ["sensitive", "access", "audit"],
  countLabel: "Sensitive opens",
  columns: [
    { key: "when", label: "When", type: "date" },
    { key: "report", label: "Report", type: "text" },
    { key: "sensitivity", label: "Class", type: "text" },
    { key: "by", label: "Opened by", type: "text" },
    { key: "rows", label: "Rows shown", type: "number" },
    { key: "scope", label: "Scope", type: "text" },
  ],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", a.target AS report, ${LABEL("a.metadata->>'sensitivity'")} AS sensitivity, ${ACTOR("ae")} AS by, COALESCE((a.metadata->>'rowCount')::int, 0) AS rows, ${LABEL("a.metadata->>'scope'")} AS scope
      FROM audit_log a ${ACTOR_JOIN()}
     WHERE ${q.co("a")} AND a.action = 'report.run' AND ${IN_RANGE("a", q.from, q.to)}
     ORDER BY a.created_at DESC`,
  kpis: ({ rows }) => [count("people", "Different people", new Set(rows.map((r) => r.by)).size), count("reports", "Different reports", new Set(rows.map((r) => r.report)).size)],
  calculation: ["Reads the audit trail for report opens. Only sensitive and restricted reports are written there, so ordinary reports do not appear.", "Filter values and the data shown are not repeated here."],
});

export const J04 = listReport({
  description: "Every report export: who downloaded which report, when, and how many rows left the system.",
  defaultRange: "last90Days",
  tables: ["audit_log"],
  tags: ["export", "audit"],
  countLabel: "Exports",
  columns: [
    { key: "when", label: "When", type: "date" },
    { key: "report", label: "Report", type: "text" },
    { key: "sensitivity", label: "Class", type: "text" },
    { key: "by", label: "Exported by", type: "text" },
    { key: "rows", label: "Rows exported", type: "number" },
    { key: "scope", label: "Scope", type: "text" },
  ],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", a.target AS report, ${LABEL("a.metadata->>'sensitivity'")} AS sensitivity, ${ACTOR("ae")} AS by, COALESCE((a.metadata->>'rowCount')::int, 0) AS rows, ${LABEL("a.metadata->>'scope'")} AS scope
      FROM audit_log a ${ACTOR_JOIN()}
     WHERE ${q.co("a")} AND a.action = 'report.export' AND ${IN_RANGE("a", q.from, q.to)}
     ORDER BY a.created_at DESC`,
  kpis: ({ rows }) => [count("rowsOut", "Rows exported", sum(rows, "rows")), count("sensitive", "Sensitive or restricted exports", rows.filter((r) => r.sensitivity === "Sensitive" || r.sensitivity === "Restricted").length)],
  calculation: ["Every CSV export is written to the audit trail with the report, the person, the row count and the scope. This lists those entries newest first."],
});

export const J05 = sqlReport({
  description: "Sign-in and session events: sessions started, new devices, rapid network changes, suspicious sign-ins and forced sign-outs.",
  defaultRange: "last30Days",
  tables: ["audit_log", "user_sessions"],
  viz: ["bar", "kpi", "table"],
  tags: ["login", "sessions", "authentication"],
  columns: [
    { key: "event", label: "Event", type: "text" },
    { key: "events", label: "Count", type: "number" },
    { key: "people", label: "Different people", type: "number" },
  ],
  sql: (q) => `
    SELECT t.event, t.events, t.people FROM (
      SELECT 'Sessions started' AS event, COUNT(*)::int AS events, COUNT(DISTINCT s.user_account_id)::int AS people, 1 AS ord FROM ${SESSIONS} s WHERE s.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL SELECT 'Sessions from a new device', COUNT(*)::int, COUNT(DISTINCT s.user_account_id)::int, 2 FROM ${SESSIONS} s WHERE s.is_new_device AND s.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL SELECT 'Sessions with a rapid network change', COUNT(*)::int, COUNT(DISTINCT s.user_account_id)::int, 3 FROM ${SESSIONS} s WHERE s.is_rapid_network_change AND s.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL SELECT 'Sessions revoked', COUNT(*)::int, COUNT(DISTINCT s.user_account_id)::int, 4 FROM ${SESSIONS} s WHERE s.revoked_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL SELECT CASE a.action WHEN 'auth.suspicious_login' THEN 'Suspicious sign-ins flagged' WHEN 'sso.login' THEN 'Single sign-on sign-ins' WHEN 'session.force_logout' THEN 'Forced sign-outs' WHEN 'session.revoked' THEN 'Sessions revoked by an administrator' END,
                    COUNT(*)::int, COUNT(DISTINCT a.actor_id)::int, 5
        FROM audit_log a WHERE ${q.co("a")} AND a.action IN ('auth.suspicious_login', 'sso.login', 'session.force_logout', 'session.revoked') AND ${IN_RANGE("a", q.from, q.to)} GROUP BY a.action
    ) t ORDER BY t.ord, t.event`,
  chart: ({ rows }) => (sum(rows, "events") > 0 ? barChart({ title: "Sign-in and session events", unit: "events", rows, labelKey: "event", valueKey: "events" }) : null),
  kpis: ({ rows }) => [count("sessions", "Sessions started", num(rows.find((r) => r.event === "Sessions started") ?? {}, "events")), count("suspicious", "Suspicious sign-ins flagged", num(rows.find((r) => r.event === "Suspicious sign-ins flagged") ?? {}, "events"))],
  calculation: ["Session counts come from sessions still held by the platform and started (or revoked) in the range. Audit-trail events are counted by the day they were recorded.", "The product does not write an audit entry for every ordinary password sign-in, so ordinary sign-ins appear only as sessions."],
});

export const J06 = sqlReport({
  description: "Who has multi-factor authentication switched on, by role. Shows only whether it is on, never any secret.",
  tables: ["user_accounts", "user_role_assignments", "roles"],
  viz: ["bar", "kpi", "table"],
  tags: ["mfa", "security"],
  columns: [
    { key: "role", label: "Role", type: "text" },
    { key: "people", label: "People", type: "number" },
    { key: "mfaOn", label: "MFA on", type: "number" },
    { key: "required", label: "MFA required by admin", type: "number" },
    { key: "rate", label: "MFA on (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT r.name AS role, COUNT(DISTINCT acc.user_account_id)::int AS people, COUNT(DISTINCT acc.user_account_id) FILTER (WHERE acc.mfa_enabled)::int AS "mfaOn",
           COUNT(DISTINCT acc.user_account_id) FILTER (WHERE acc.mfa_required)::int AS required,
           ROUND(COUNT(DISTINCT acc.user_account_id) FILTER (WHERE acc.mfa_enabled) * 100.0 / NULLIF(COUNT(DISTINCT acc.user_account_id), 0), 1) AS rate
      FROM ${ACCOUNTS} acc JOIN user_role_assignments ura ON ura.user_account_id = acc.user_account_id AND ${q.co("ura")}
           AND (ura.effective_from IS NULL OR ura.effective_from <= ${q.today}) AND (ura.effective_to IS NULL OR ura.effective_to >= ${q.today})
      JOIN roles r ON r.id = ura.role_id
     GROUP BY r.id, r.name ORDER BY rate ASC NULLS LAST, people DESC, role`,
  summary: (q) => `
    SELECT COUNT(*)::int AS accounts, COUNT(*) FILTER (WHERE acc.mfa_enabled)::int AS on_count
      FROM ${ACCOUNTS} acc WHERE EXISTS (SELECT 1 FROM employees e WHERE e.user_account_id = acc.user_account_id AND ${q.co("e")}) OR EXISTS (SELECT 1 FROM user_role_assignments u WHERE u.user_account_id = acc.user_account_id AND ${q.co("u")})`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "MFA on, by role", unit: "percent", rows, labelKey: "role", valueKey: "rate", valueLabel: "MFA on (%)", max: 12 }) : null),
  kpis: ({ summary }) => [count("accounts", "Accounts", summary.accounts ?? 0), percent("rate", "MFA on", pct(summary.on_count ?? 0, summary.accounts ?? 0))],
  calculation: ["Counts each account once per role it holds today. An account with several roles appears under each of them.", "The headline tiles count every account of the company once, whether or not it holds a role."],
});

export const J07 = listReport({
  description: "Accounts with failed sign-in attempts or a lockout in force, and suspicious sign-ins flagged for them in the range.",
  defaultRange: "last30Days",
  tables: ["user_accounts", "audit_log"],
  tags: ["failed login", "lockout"],
  countLabel: "Accounts needing attention",
  columns: [
    { key: "person", label: "Person", type: "text" },
    { key: "status", label: "Account", type: "text" },
    { key: "failed", label: "Failed attempts (current)", type: "number" },
    { key: "locked", label: "Locked until", type: "date" },
    { key: "suspicious", label: "Suspicious sign-ins in range", type: "number" },
    { key: "lastSignIn", label: "Last sign-in", type: "date" },
  ],
  sql: (q) => `
    SELECT * FROM (
      SELECT COALESCE(NULLIF(${NAME("e")}, ''), 'No employee record') AS person, ${LABEL("acc.status")} AS status, acc.failed_login_attempts AS failed,
             CASE WHEN acc.locked_until > now() THEN acc.locked_until::date::text END AS locked,
             (SELECT COUNT(*)::int FROM audit_log a WHERE ${q.co("a")} AND a.action = 'auth.suspicious_login' AND a.actor_id = acc.user_account_id AND ${IN_RANGE("a", q.from, q.to)}) AS suspicious,
             acc.last_login_at::date::text AS "lastSignIn"
        FROM ${ACCOUNTS} acc LEFT JOIN employees e ON e.user_account_id = acc.user_account_id AND ${q.co("e")}
    ) t WHERE t.failed > 0 OR t.locked IS NOT NULL OR t.suspicious > 0 ORDER BY t.locked IS NULL, t.failed DESC, t.suspicious DESC, t.person`,
  kpis: ({ rows }) => [count("locked", "Locked now", rows.filter((r) => r.locked).length), count("suspicious", "Suspicious sign-ins in range", sum(rows, "suspicious"))],
  calculation: ["Failed attempts and the lockout time are the account's current values: the counter resets after a successful sign-in, so it is not a history.", "Suspicious sign-ins are counted from the audit trail for the range."],
});

export const J08 = listReport({
  description: "Changes to who can do what: role assignments and removals, custom roles, data scopes, field rules, MFA resets and password resets.",
  defaultRange: "last90Days",
  tables: ["audit_log", "user_role_assignments"],
  tags: ["privileged", "roles", "audit"],
  countLabel: "Access changes",
  columns: [
    { key: "when", label: "When", type: "date" },
    { key: "change", label: "Change", type: "text" },
    { key: "by", label: "Done by", type: "text" },
    { key: "affected", label: "Affected person", type: "text" },
  ],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", ${LABEL("a.action")} AS change, ${ACTOR("ae")} AS by, COALESCE(NULLIF(${NAME("te")}, ''), 'Not a person (role or rule)') AS affected
      FROM audit_log a ${ACTOR_JOIN()}
      LEFT JOIN employees te ON te.user_account_id::text = a.target AND te.company_id = a.company_id
     WHERE ${q.co("a")} AND ${IN_RANGE("a", q.from, q.to)}
       AND (a.action LIKE 'rbac.%' OR a.action IN ('system_admin.role_assigned', 'system_admin.role_revoked', 'system_admin.mfa_reset', 'system_admin.password_reset', 'system_admin.mfa_requirement_changed',
                                                  'company.admin.created', 'company.admin.mfa_reset', 'company.admin.password_reset', 'company.admin.locked', 'company.admin.unlocked', 'employee.access_revoked'))
     ORDER BY a.created_at DESC`,
  kpis: ({ rows }) => [count("people", "People who made changes", new Set(rows.map((r) => r.by)).size)],
  calculation: ["Lists audit-trail entries for access administration in the range, newest first. The role, scope or rule that changed is named in the Change column; the values themselves are not shown."],
});

export const J09 = sqlReport({
  description: "Changes made to employee master records, grouped by kind of change: how often, by how many people, and how many employees were touched.",
  defaultRange: "last90Days",
  tables: ["audit_log", "employee_versions"],
  viz: ["bar", "table"],
  tags: ["employee master", "changes", "audit"],
  columns: [
    { key: "change", label: "Kind of change", type: "text" },
    { key: "changes", label: "Changes", type: "number" },
    { key: "people", label: "Made by (people)", type: "number" },
    { key: "records", label: "Records touched", type: "number" },
    { key: "last", label: "Latest", type: "date" },
  ],
  sql: (q) => `
    SELECT ${LABEL("a.action")} AS change, COUNT(*)::int AS changes, COUNT(DISTINCT a.actor_id)::int AS people, COUNT(DISTINCT a.target)::int AS records, MAX(a.created_at)::date::text AS last
      FROM audit_log a
     WHERE ${q.co("a")} AND ${IN_RANGE("a", q.from, q.to)}
       AND (a.action IN ('employee.create', 'person.update', 'work_profile.set', 'employee_important_date.create', 'employee_address.create', 'employee_contact.create', 'employee_family_member.create', 'employee_education.create',
                         'employee_qualification.create', 'employee_org_assignment.create', 'employee_org_assignment.update', 'employee_org_assignment.end', 'employee_org_assignment.transfer', 'employee_number.reserved', 'employee_number.voided')
            OR a.action LIKE 'employee.lifecycle.%')
     GROUP BY a.action ORDER BY changes DESC, change`,
  chart: ({ rows }) => (rows.length ? barChart({ title: "Employee record changes", unit: "changes", rows, labelKey: "change", valueKey: "changes", max: 12 }) : null),
  kpis: ({ rows }) => [count("changes", "Changes", sum(rows, "changes")), count("kinds", "Kinds of change", rows.length)],
  calculation: ["Counts audit-trail entries about employee records in the range. Pay-related and bank-account changes are in the payroll audit, not here.", "Records touched counts distinct audit targets, which is the employee or the record that changed."],
});

export const J10 = listReport({
  domain: "payroll",
  sensitivity: "restricted",
  description: "Payroll run status changes and manual overrides: what happened, when, by whom and why. Amounts are not shown.",
  defaultRange: "last90Days",
  tables: ["payroll_run_events", "payroll_overrides", "payroll_runs"],
  tags: ["payroll", "audit", "overrides"],
  countLabel: "Payroll changes",
  columns: [
    { key: "when", label: "When", type: "date" },
    { key: "period", label: "Payroll period", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "what", label: "What happened", type: "text" },
    { key: "by", label: "Done by", type: "text" },
    { key: "reason", label: "Reason", type: "text" },
  ],
  sql: (q) => `
    SELECT t.at::date::text AS "when", t.period, t.kind, t.what, t.by, t.reason FROM (
      SELECT ev.created_at AS at, pr.period_start::text || ' to ' || pr.period_end::text AS period, 'Run status' AS kind, ${LABEL("ev.action")} || ' (' || COALESCE(${LABEL("ev.from_status")}, 'new') || ' to ' || ${LABEL("ev.to_status")} || ')' AS what,
             COALESCE(NULLIF(${NAME("ue")}, ''), 'System') AS by, COALESCE(NULLIF(LEFT(ev.reason, 200), ''), 'No reason recorded') AS reason
        FROM payroll_run_events ev JOIN payroll_runs pr ON pr.id = ev.payroll_run_id AND pr.company_id = ev.company_id
        LEFT JOIN employees ue ON ue.user_account_id = ev.actor_user_account_id AND ue.company_id = ev.company_id
       WHERE ${q.co("pr")} AND ${q.area("pr")} AND ev.created_at::date BETWEEN ${q.from} AND ${q.to}
      UNION ALL
      SELECT po.created_at, pr.period_start::text || ' to ' || pr.period_end::text, 'Override', 'Override of ' || ${LABEL("po.field")} || ' (' || ${LABEL("po.status")} || ')',
             COALESCE(NULLIF(${NAME("oe")}, ''), 'System'), COALESCE(NULLIF(LEFT(po.reason, 200), ''), 'No reason recorded')
        FROM payroll_overrides po JOIN payroll_runs pr ON pr.id = po.payroll_run_id AND pr.company_id = po.company_id
        LEFT JOIN employees oe ON oe.user_account_id = po.overridden_by AND oe.company_id = po.company_id
       WHERE ${q.co("pr")} AND ${q.area("pr")} AND po.created_at::date BETWEEN ${q.from} AND ${q.to}
    ) t ORDER BY t.at DESC`,
  kpis: ({ rows }) => [count("overrides", "Manual overrides", rows.filter((r) => r.kind === "Override").length), count("noReason", "Without a reason", rows.filter((r) => r.reason === "No reason recorded").length)],
  calculation: ["Lists payroll run status changes and manual overrides on runs you are allowed to see. Old and new values of an override are not shown.", "Reasons are cut to 200 characters."],
});

export const J11 = listReport({
  description: "Changes to workflow templates and configuration: created, published, activated, deactivated, validated or rolled back.",
  defaultRange: "last90Days",
  tables: ["audit_log", "workflow_template_versions", "workflow_templates"],
  tags: ["workflow", "configuration", "audit"],
  countLabel: "Configuration changes",
  columns: [
    { key: "when", label: "When", type: "date" },
    { key: "change", label: "Change", type: "text" },
    { key: "template", label: "Template", type: "text" },
    { key: "by", label: "Done by", type: "text" },
  ],
  sql: (q) => `
    SELECT a.created_at::date::text AS "when", ${LABEL("a.action")} AS change, COALESCE(wt.name, '-') AS template, ${ACTOR("ae")} AS by
      FROM audit_log a ${ACTOR_JOIN()} LEFT JOIN workflow_templates wt ON wt.id::text = a.target AND wt.company_id = a.company_id
     WHERE ${q.co("a")} AND ${IN_RANGE("a", q.from, q.to)} AND (a.action LIKE 'workflow_template.%' OR a.action LIKE 'configuration_%' OR a.action LIKE 'tenant_configuration.%' OR a.action LIKE 'rule_%')
     ORDER BY a.created_at DESC`,
  kpis: ({ rows }) => [count("published", "Versions published", rows.filter((r) => String(r.change).includes("Publish")).length), count("people", "People who made changes", new Set(rows.map((r) => r.by)).size)],
  calculation: ["Lists audit-trail entries for workflow templates, configuration changes and rule definitions in the range. The template name is shown when the entry points at one."],
});

export const J12 = sqlReport({
  description: "Data subject requests (access, correction, deletion): how many came in, how many were fulfilled and how long they took.",
  defaultRange: "last12Months",
  tables: ["data_subject_requests", "audit_log"],
  viz: ["donut", "kpi", "table"],
  tags: ["privacy", "deletion", "retention"],
  columns: [
    { key: "type", label: "Request type", type: "text" },
    { key: "received", label: "Received", type: "number" },
    { key: "fulfilled", label: "Fulfilled", type: "number" },
    { key: "open", label: "Open", type: "number" },
    { key: "days", label: "Average days to fulfil", type: "number" },
  ],
  sql: (q) => `
    SELECT ${LABEL("d.request_type")} AS type, COUNT(*)::int AS received, COUNT(*) FILTER (WHERE d.fulfilled_at IS NOT NULL)::int AS fulfilled,
           COUNT(*) FILTER (WHERE d.fulfilled_at IS NULL AND d.status NOT IN ('rejected', 'cancelled', 'declined', 'withdrawn'))::int AS open,
           ROUND(AVG(EXTRACT(EPOCH FROM (d.fulfilled_at - d.created_at)) / 86400.0) FILTER (WHERE d.fulfilled_at IS NOT NULL)::numeric, 1) AS days
      FROM data_subject_requests d WHERE ${q.co("d")} AND d.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY d.request_type ORDER BY received DESC, type`,
  summary: (q) => `
    SELECT (SELECT COUNT(*) FROM audit_log a WHERE ${q.co("a")} AND a.action = 'candidate.anonymise' AND ${IN_RANGE("a", q.from, q.to)})::int AS anonymised,
           (SELECT COUNT(*) FROM audit_log a WHERE ${q.co("a")} AND a.action LIKE 'company.deletion_%' AND ${IN_RANGE("a", q.from, q.to)})::int AS deletion_events`,
  chart: ({ rows }) => (sum(rows, "received") > 0 ? donutChart({ title: "Requests by type", unit: "requests", rows, labelKey: "type", valueKey: "received" }) : null),
  kpis: ({ rows, summary }) => [count("received", "Requests received", sum(rows, "received")), count("open", "Still open", sum(rows, "open")), count("anonymised", "Candidate records anonymised", summary.anonymised ?? 0), count("deletion", "Company deletion events", summary.deletion_events ?? 0)],
  calculation: ["Counts data subject requests created in the range by type. Fulfilled means a fulfilment time is recorded; open means not fulfilled and not rejected or withdrawn.", "Anonymisation and company-deletion tiles count audit-trail entries in the same range."],
});

export const J13 = sqlReport({
  description: "Security settings in force for this company: sign-in limits, session rules and IP lists, and whether single sign-on and SCIM are switched on.",
  tables: ["tenant_configuration", "tenant_integrations", "company_config"],
  viz: ["kpi", "table"],
  tags: ["security", "configuration"],
  columns: [
    { key: "setting", label: "Setting", type: "text" },
    { key: "value", label: "Value", type: "text" },
    { key: "scope", label: "Applies to", type: "text" },
    { key: "since", label: "In force since", type: "date" },
    { key: "until", label: "Until", type: "date" },
    { key: "source", label: "Source", type: "text" },
  ],
  sql: (q) => `
    SELECT t.setting, t.value, t.scope, t.since, t."until", t.source FROM (
      SELECT ${LABEL("tc.setting_key")} AS setting, TRIM(BOTH '"' FROM tc.value) AS value, ${LABEL("COALESCE(tc.scope_type, 'company')")} AS scope, tc.effective_from::text AS since, tc.effective_to::text AS "until", 'Company setting' AS source, 1 AS ord
        FROM ${CONFIG} tc
       WHERE tc.category = 'security' AND tc.status = 'published' AND (tc.effective_from IS NULL OR tc.effective_from <= ${q.today}) AND (tc.effective_to IS NULL OR tc.effective_to >= ${q.today})
      UNION ALL
      SELECT 'Single sign-on', CASE WHEN ti.enabled THEN 'On' ELSE 'Off' END, 'Company', NULL, NULL, 'Integration', 2 FROM ${INTEGRATIONS} ti WHERE ti.provider_key = 'sso'
      UNION ALL
      SELECT 'SCIM provisioning', CASE WHEN ti.scim_enabled THEN 'On' ELSE 'Off' END, 'Company', NULL, NULL, 'Integration', 3 FROM ${INTEGRATIONS} ti WHERE ti.provider_key = 'sso'
    ) t ORDER BY t.ord, t.setting`,
  kpis: ({ rows }) => [count("settings", "Settings in force", rows.filter((r) => r.source === "Company setting").length), count("integrations", "Identity integrations on", rows.filter((r) => r.source === "Integration" && r.value === "On").length)],
  calculation: ["Lists published security settings whose effective dates include today, plus whether single sign-on and SCIM are on."],
  notes: () => ["Settings you have not overridden use the platform's built-in default and are not listed."],
});
