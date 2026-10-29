import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { DismissSmartCheckRequest, SmartCheckFinding, SmartCheckReport, SmartCheckSample, SmartCheckSeverity } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const PERMISSION = "smart_checks.manage";
const SAMPLE_LIMIT = 25;
const ROW_LIMIT = 2000;

const WHO = `trim(concat_ws(' ', e.first_name, e.last_name)) || ' (' || e.employee_number || ')'`;

type Rule = { key: string; title: string; severity: SmartCheckSeverity; why: string; link: string | null; sql: string };

/**
 * Each rule is one plain, read-only query over the company's own data. They are rules, not predictions: every finding says what was
 * matched and why it deserves a look, and a person decides. $1 is today's date. A query returns subject_key (stable, so a dismissal sticks),
 * employee_id (optional), label and detail.
 */
export const RULES: Rule[] = [
  {
    key: "shared_bank_account", title: "Two or more people paid into the same bank account", severity: "high", link: "/app/employees",
    why: "Active employees whose payment accounts have the same account number. Sometimes it is family; sometimes it is a duplicate or ghost employee.",
    sql: `SELECT a.account_number_bidx AS subject_key, NULL::uuid AS employee_id,
                 string_agg(DISTINCT ${WHO}, ', ') AS label, 'Same account number on ' || count(DISTINCT e.id) || ' active employees' AS detail
            FROM employee_payment_accounts a JOIN employees e ON e.id = a.employee_id
           WHERE a.account_number_bidx IS NOT NULL AND a.status = 'active' AND e.employment_status = 'active'
           GROUP BY a.account_number_bidx HAVING count(DISTINCT e.id) > 1`,
  },
  {
    key: "leaver_keeps_access", title: "Left the company but still has roles", severity: "high", link: "/app/employees",
    why: "Employees whose termination date has passed while their login still holds one or more roles in this company. Access should end with employment.",
    sql: `SELECT e.id::text AS subject_key, e.id AS employee_id, ${WHO} AS label,
                 'Left on ' || to_char(e.termination_date, 'DD Mon YYYY') || '; still holds ' || count(r.id) || ' role' || CASE WHEN count(r.id) = 1 THEN '' ELSE 's' END AS detail
            FROM employees e JOIN user_role_assignments r ON r.user_account_id = e.user_account_id AND r.company_id = e.company_id
           WHERE e.employment_status = 'terminated' AND e.termination_date IS NOT NULL AND e.termination_date < $1::date
           GROUP BY e.id, e.first_name, e.last_name, e.employee_number, e.termination_date`,
  },
  {
    key: "reporting_loop", title: "Reporting line goes in a circle", severity: "high", link: "/app/employees",
    why: "Following 'reports to' upwards from this person leads back to them. Approvals and org charts break on a loop.",
    sql: `WITH RECURSIVE chain(start_id, cur_id, depth) AS (
                 SELECT id, manager_id, 1 FROM employees WHERE manager_id IS NOT NULL AND employment_status = 'active'
                 UNION ALL
                 SELECT c.start_id, m.manager_id, c.depth + 1 FROM chain c JOIN employees m ON m.id = c.cur_id
                  WHERE m.manager_id IS NOT NULL AND c.depth < 30 AND c.cur_id <> c.start_id)
          SELECT e.id::text AS subject_key, e.id AS employee_id, ${WHO} AS label, 'Their manager chain returns to them' AS detail
            FROM employees e WHERE e.id IN (SELECT start_id FROM chain WHERE cur_id = start_id)`,
  },
  {
    key: "no_salary", title: "Active for over 30 days with no basic salary on record", severity: "medium", link: "/app/payroll",
    why: "Employees who joined more than 30 days ago and have no basic salary in force today. Payroll will skip or zero them.",
    sql: `SELECT e.id::text AS subject_key, e.id AS employee_id, ${WHO} AS label, 'Joined ' || to_char(e.date_of_joining, 'DD Mon YYYY') || '; no basic salary in force' AS detail
            FROM employees e
           WHERE e.employment_status = 'active' AND e.date_of_joining IS NOT NULL AND e.date_of_joining <= $1::date - 30
             AND NOT EXISTS (SELECT 1 FROM employee_compensation_components c JOIN compensation_components k ON k.id = c.component_id AND k.key = 'basic_salary'
                              WHERE c.employee_id = e.id AND c.effective_from <= $1::date AND (c.effective_to IS NULL OR c.effective_to >= $1::date))`,
  },
  {
    key: "no_payment_account", title: "No active bank account for salary", severity: "medium", link: "/app/employees",
    why: "Employees who joined more than 30 days ago and have no active, approved payment account, so a bank transfer has nowhere to go.",
    sql: `SELECT e.id::text AS subject_key, e.id AS employee_id, ${WHO} AS label, 'No active approved payment account' AS detail
            FROM employees e
           WHERE e.employment_status = 'active' AND e.date_of_joining IS NOT NULL AND e.date_of_joining <= $1::date - 30
             AND NOT EXISTS (SELECT 1 FROM employee_payment_accounts a WHERE a.employee_id = e.id AND a.status = 'active' AND a.approval_status = 'approved')`,
  },
  {
    key: "salary_outlier", title: "Salary far from others in the same designation", severity: "medium", link: "/app/payroll",
    why: "Compares each salary with the median of people holding the same designation (at least 4 of them). More than three times or under a third of the median is flagged.",
    sql: `WITH cur AS (
                 SELECT DISTINCT ON (e.id) e.id, e.designation, ${WHO} AS who, c.amount AS monthly_salary
                   FROM employees e
                   JOIN employee_compensation_components c ON c.employee_id = e.id AND c.effective_from <= $1::date AND (c.effective_to IS NULL OR c.effective_to >= $1::date)
                   JOIN compensation_components k ON k.id = c.component_id AND k.key = 'basic_salary'
                  WHERE e.employment_status = 'active' AND e.designation IS NOT NULL AND c.amount > 0
                  ORDER BY e.id, c.effective_from DESC),
               med AS (SELECT designation, percentile_cont(0.5) WITHIN GROUP (ORDER BY monthly_salary) AS m, count(*) AS n FROM cur GROUP BY designation HAVING count(*) >= 4)
          SELECT cur.id::text AS subject_key, cur.id AS employee_id, cur.who AS label,
                 round((cur.monthly_salary / med.m)::numeric, 1) || ' times the median for ' || cur.designation AS detail
            FROM cur JOIN med USING (designation) WHERE cur.monthly_salary > 3 * med.m OR cur.monthly_salary < med.m / 3`,
  },
  {
    key: "repeat_absence", title: "Four or more absent days in the last 30", severity: "medium", link: "/app/attendance",
    why: "Days marked absent (not leave, not holiday) in the last 30 days. A pattern may need a conversation, or a missing leave request.",
    sql: `SELECT e.id::text AS subject_key, e.id AS employee_id, ${WHO} AS label, count(*) || ' absent days since ' || to_char($1::date - 30, 'DD Mon') AS detail
            FROM attendance_daily_results d JOIN employees e ON e.id = d.employee_id
           WHERE d.status = 'absent' AND d.work_date > $1::date - 30 AND d.work_date <= $1::date AND e.employment_status = 'active'
           GROUP BY e.id, e.first_name, e.last_name, e.employee_number HAVING count(*) >= 4`,
  },
  {
    key: "payslip_swing", title: "Take-home changed by more than 40% since last month", severity: "medium", link: "/app/payroll",
    why: "Compares the latest regular payslip with the one before it. A big swing is often right (a bonus, unpaid leave) and sometimes a mistake worth catching before payment.",
    sql: `WITH s AS (
                 SELECT p.employee_id, p.net_pay, row_number() OVER (PARTITION BY p.employee_id ORDER BY r.period_end DESC, r.created_at DESC) AS rn
                   FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id
                  WHERE r.run_type = 'regular' AND r.is_simulation = false AND r.status NOT IN ('draft', 'reversed', 'cancelled') AND p.status <> 'voided')
          SELECT a.employee_id::text AS subject_key, a.employee_id, ${WHO} AS label,
                 round(((a.net_pay - b.net_pay) / b.net_pay) * 100) || '% change in net pay' AS detail
            FROM s a JOIN s b ON b.employee_id = a.employee_id AND b.rn = 2 JOIN employees e ON e.id = a.employee_id
           WHERE a.rn = 1 AND b.net_pay > 0 AND abs(a.net_pay - b.net_pay) / b.net_pay > 0.4 AND e.employment_status = 'active'`,
  },
  {
    key: "stale_approval", title: "Approvals waiting more than 7 days", severity: "medium", link: "/app/approvals",
    why: "Requests still waiting for a decision a week after they were submitted. Someone may be away or may not have noticed.",
    sql: `SELECT w.id::text AS subject_key, NULL::uuid AS employee_id, COALESCE(w.title, w.object_key) AS label,
                 'Waiting ' || (($1::date - w.created_at::date)) || ' days' AS detail
            FROM workflow_instances w WHERE w.status = 'in_progress' AND w.created_at < ($1::date - 7)`,
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

@Injectable()
export class SmartChecksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async run(claims: RequestClaims): Promise<SmartCheckReport> {
    await this.require(claims);
    const today = localToday();
    return this.db.withClaims(claims, async (client) => {
      const dismissed = await client.query("SELECT rule_key, subject_key FROM smart_check_dismissals");
      const gone = new Set(dismissed.rows.map((d: Row) => `${d.rule_key}|${d.subject_key}`));
      const findings: SmartCheckFinding[] = [];
      // One query at a time: a pooled client runs a single statement at once.
      for (const rule of RULES) {
        const r = await client.query(`${rule.sql} LIMIT ${ROW_LIMIT}`, rule.sql.includes("$1") ? [today] : []);
        const open = r.rows.filter((x: Row) => !gone.has(`${rule.key}|${x.subject_key}`));
        const samples: SmartCheckSample[] = open.slice(0, SAMPLE_LIMIT).map((x: Row) => ({
          subjectKey: String(x.subject_key), employeeId: x.employee_id ?? null, label: String(x.label ?? ""), detail: String(x.detail ?? ""),
        }));
        findings.push({
          ruleKey: rule.key, title: rule.title, severity: rule.severity, why: rule.why, count: open.length, dismissedCount: r.rows.length - open.length, samples, link: rule.link,
        });
      }
      const open = findings.filter((f) => f.count > 0);
      return {
        ranAt: new Date().toISOString(),
        totalOpen: open.reduce((s, f) => s + f.count, 0),
        high: open.filter((f) => f.severity === "high").reduce((s, f) => s + f.count, 0),
        medium: open.filter((f) => f.severity === "medium").reduce((s, f) => s + f.count, 0),
        findings: [...findings].sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1)),
      };
    });
  }

  /** "I looked, this one is fine." Recorded with the reason and who said so; undone from the same screen. */
  async dismiss(claims: RequestClaims, input: DismissSmartCheckRequest): Promise<{ ok: true }> {
    await this.require(claims);
    if (!RULES.some((r) => r.key === input.ruleKey)) throw new BadRequestException("Unknown check");
    const reason = (input.reason ?? "").trim();
    if (reason.length < 3 || reason.length > 500) throw new BadRequestException("Say briefly why this is fine (3 to 500 characters)");
    if (!input.subjectKey || input.subjectKey.length > 200) throw new BadRequestException("Missing the finding to mark");
    return this.db.withClaims(claims, async (client) => {
      await client.query(
        `INSERT INTO smart_check_dismissals (company_id, rule_key, subject_key, reason, dismissed_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, rule_key, subject_key) DO UPDATE SET reason = EXCLUDED.reason, dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now()`,
        [claims.company_id, input.ruleKey, input.subjectKey, reason, /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "smart_check.dismiss", target: input.ruleKey, metadata: { subjectKey: input.subjectKey }, reason });
      return { ok: true as const };
    });
  }

  async listDismissed(claims: RequestClaims): Promise<Array<{ id: string; ruleKey: string; ruleTitle: string; subjectKey: string; reason: string; dismissedAt: string }>> {
    await this.require(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT id, rule_key, subject_key, reason, dismissed_at FROM smart_check_dismissals ORDER BY dismissed_at DESC LIMIT 500");
      return r.rows.map((x: Row) => ({
        id: x.id, ruleKey: x.rule_key, ruleTitle: RULES.find((q) => q.key === x.rule_key)?.title ?? x.rule_key, subjectKey: x.subject_key, reason: x.reason,
        dismissedAt: new Date(x.dismissed_at).toISOString(),
      }));
    });
  }

  async restore(claims: RequestClaims, id: string): Promise<void> {
    await this.require(claims);
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query("DELETE FROM smart_check_dismissals WHERE id = $1 RETURNING rule_key, subject_key", [id]);
      if (!r.rowCount) throw new NotFoundException("Nothing to restore");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "smart_check.restore", target: r.rows[0].rule_key, metadata: { subjectKey: r.rows[0].subject_key } });
    });
  }

  private async require(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, PERMISSION))) throw new ForbiddenException("Not permitted to run the smart checks");
  }
}
