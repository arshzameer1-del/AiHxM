import { Pool, type PoolClient } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { MODULE_KEYS, type ReportResult } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ReportsService } from "./reports.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "reports-domains-fixtures" };

/**
 * Figures for the workflow, learning, self-service, audit, governance and platform-operations reports, each worked out by
 * hand from rows this spec inserts. Every report here also has to return rows that match its declared columns, which the
 * thinner smoke fixture cannot prove for reports that need data of their own.
 */
describe("workflow, learning, service, audit and governance reports (hand-computed)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let co: string;
  let other: string;
  let all: RequestClaims;
  let mgr: RequestClaims;
  let e2User: string;
  let ou: string;
  const fx = <T>(fn: (client: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  const run = async (claims: RequestClaims, id: string, filters: Record<string, unknown> = {}): Promise<ReportResult> => {
    const r = await reports.run(claims, id, filters);
    for (const row of r.rows) for (const c of r.columns) expect(c.key in row).toBe(true);
    return r;
  };
  const num = (r: ReportResult, key: string) => Number(r.rows[0]?.[key]);
  const kpi = (r: ReportResult, key: string) => r.kpis.find((k) => k.key === key)?.value;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    await fx(async (client) => {
      const mkCompany = async (tag: string) => {
        const c = await client.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`Dom ${tag} ${stamp}`, `dom-${tag}-${stamp}`.toLowerCase()]);
        await client.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [c.rows[0].id, JSON.stringify(MODULE_KEYS)]);
        for (const m of MODULE_KEYS) await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [c.rows[0].id, m]);
        return c.rows[0].id as string;
      };
      co = await mkCompany("a");
      other = await mkCompany("b");

      const role = await client.query("INSERT INTO roles (key, name) VALUES ($1, 'Domains all') RETURNING id", [`dom_all_${stamp}`]);
      await client.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions", [role.rows[0].id]);
      const mkUser = async (tag: string, company: string, roleId: string | null) => {
        const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`dom-${tag}-${stamp}@example.com`]);
        if (roleId) await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, company, roleId]);
        return u.rows[0].id as string;
      };
      const allUser = await mkUser("all", co, role.rows[0].id);
      all = { is_platform_admin: false, company_id: co, sub: allUser };
      const lm = await client.query("SELECT id FROM roles WHERE key = 'line_manager'");
      const mgrUser = await mkUser("mgr", co, lm.rows[0].id);
      mgr = { is_platform_admin: false, company_id: co, sub: mgrUser };
      e2User = await mkUser("e2", co, null);
      await client.query("UPDATE user_accounts SET last_login_at = now() - interval '5 days' WHERE id = $1", [e2User]);

      ou = (await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [co])).rows[0].id;
      const loc = (await client.query("INSERT INTO locations (company_id, location_type, name) VALUES ($1, 'city', 'Lahore') RETURNING id", [co])).rows[0].id;
      const emp = async (n: string, user: string | null) => {
        const p = await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [co, `Person ${n}`]);
        const r = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, org_unit_id, location_id, user_account_id)
           VALUES ($1, $2, 'Dom', $3, $4, 'active', (now() AT TIME ZONE 'Asia/Karachi')::date - 400, $5, $6, $7) RETURNING id`,
          [co, `D-${n}-${stamp}`.slice(0, 30), `Emp${n}`, p.rows[0].id, ou, loc, user]
        );
        return r.rows[0].id as string;
      };
      const boss = await emp("1", mgrUser);
      const e2 = await emp("2", e2User);
      const e3 = await emp("3", null);
      for (const e of [e2, e3]) await client.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1, $2, $3, 'direct')", [co, e, boss]);

      // ---------------- workflow: four requests on one template with a 24 hour limit on its only step
      const tpl = (await client.query("INSERT INTO workflow_templates (company_id, key, name, object_key) VALUES ($1, $2, 'Leave approval', 'step6_object') RETURNING id", [co, `leave_${stamp}`])).rows[0].id;
      await client.query("INSERT INTO workflow_template_steps (template_id, step_order, name, sla_hours) VALUES ($1, 1, 'Manager approval', 24)", [tpl]);
      const wf = async (opts: { status: string; createdAgo: string; completedAfter?: string; approval: { status: string; decided?: string; comment?: string; user: string; escalatedAgo?: string } }) => {
        const i = await client.query(
          `INSERT INTO workflow_instances (company_id, template_id, object_key, record_id, submitted_by_user_account_id, subject_user_account_id, status, title, created_at, updated_at, completed_at)
           VALUES ($1, $2, 'step6_object', gen_random_uuid(), $3, $3, $4, 'Annual leave', now() - $5::interval, now() - $5::interval,
                   CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $5::interval + $6::interval END) RETURNING id`,
          [co, tpl, e2User, opts.status, opts.createdAgo, opts.completedAfter ?? null]
        );
        const stepStatus = opts.status === "in_progress" ? "pending" : opts.status;
        const s = await client.query("INSERT INTO workflow_step_instances (workflow_instance_id, step_order, name, status, created_at) VALUES ($1, 1, 'Manager approval', $2, now() - $3::interval) RETURNING id", [i.rows[0].id, stepStatus, opts.createdAgo]);
        const a = opts.approval;
        await client.query(
          `INSERT INTO workflow_step_approvals (step_instance_id, approver_type, user_account_id, status, comment, created_at, decided_at, decided_by_user_account_id, escalated_at)
           VALUES ($1, 'manager_of_submitter', $2, $3, $4, now() - $5::interval,
                   CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $5::interval + $6::interval END,
                   CASE WHEN $6::text IS NULL THEN NULL ELSE $2::uuid END,
                   CASE WHEN $7::text IS NULL THEN NULL ELSE now() - $7::interval END)`,
          [s.rows[0].id, a.user, a.status, a.comment ?? null, opts.createdAgo, a.decided ?? null, a.escalatedAgo ?? null]
        );
      };
      await wf({ status: "approved", createdAgo: "10 hours", completedAfter: "4 hours", approval: { status: "approved", decided: "4 hours", user: mgrUser } });
      await wf({ status: "rejected", createdAgo: "2 days", completedAfter: "30 hours", approval: { status: "rejected", decided: "30 hours", comment: "Budget freeze", user: mgrUser } });
      await wf({ status: "in_progress", createdAgo: "10 days", approval: { status: "pending", user: mgrUser } });
      await client.query("UPDATE workflow_instances SET updated_at = now() - interval '10 days' WHERE company_id = $1 AND status = 'in_progress'", [co]);
      await wf({ status: "in_progress", createdAgo: "3 days", approval: { status: "escalated", user: allUser, escalatedAgo: "1 day" } });

      // ---------------- learning
      const c1 = (await client.query("INSERT INTO courses (company_id, title, category, duration_minutes) VALUES ($1, 'Fire safety', 'compliance', 60) RETURNING id", [co])).rows[0].id;
      const c2 = (await client.query("INSERT INTO courses (company_id, title, category, duration_minutes) VALUES ($1, 'SQL basics', 'technical', 120) RETURNING id", [co])).rows[0].id;
      await client.query("INSERT INTO course_enrollments (company_id, employee_id, course_id, status, progress_percent, due_date, created_at, started_at, completed_at) VALUES ($1,$2,$3,'completed',100,(now() AT TIME ZONE 'Asia/Karachi')::date - 6, now() - interval '20 days', now() - interval '19 days', now() - interval '5 days')", [co, e2, c1]);
      await client.query("INSERT INTO course_enrollments (company_id, employee_id, course_id, status, progress_percent, due_date, created_at) VALUES ($1,$2,$3,'assigned',0,(now() AT TIME ZONE 'Asia/Karachi')::date - 5, now() - interval '20 days')", [co, e3, c1]);
      await client.query("INSERT INTO course_enrollments (company_id, employee_id, course_id, status, progress_percent, due_date, created_at) VALUES ($1,$2,$3,'in_progress',40,(now() AT TIME ZONE 'Asia/Karachi')::date + 10, now() - interval '3 days')", [co, e3, c2]);
      await client.query("INSERT INTO employee_qualifications (company_id, employee_id, qualification_type, title, issuing_authority, issue_date, expiry_date, status) VALUES ($1,$2,'certificate','First aid','Red Crescent',(now() AT TIME ZONE 'Asia/Karachi')::date - 300,(now() AT TIME ZONE 'Asia/Karachi')::date + 30,'active'), ($1,$3,'certificate','Forklift','NAVTTC',(now() AT TIME ZONE 'Asia/Karachi')::date - 900,(now() AT TIME ZONE 'Asia/Karachi')::date - 10,'active')", [co, e2, e3]);
      await client.query("INSERT INTO development_plans (company_id, employee_id, title, status, target_date) VALUES ($1,$2,'Grow into lead','active',(now() AT TIME ZONE 'Asia/Karachi')::date - 3)", [co, e2]);

      // ---------------- service: messages, requests, onboarding
      for (const st of ["sent", "sent", "failed", "logged"]) await client.query("INSERT INTO notification_log (company_id, channel, recipient, template_key, status) VALUES ($1,'email','john.doe@example.com','leave_decision',$2)", [co, st]);
      await client.query("INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id) VALUES ($1,$2,'annual',(now() AT TIME ZONE 'Asia/Karachi')::date - 10,(now() AT TIME ZONE 'Asia/Karachi')::date - 9,2,'approved',$3), ($1,$2,'annual',(now() AT TIME ZONE 'Asia/Karachi')::date - 20,(now() AT TIME ZONE 'Asia/Karachi')::date - 20,1,'approved',$4)", [co, e2, e2User, allUser]);
      const ob = (await client.query("INSERT INTO employee_onboarding (company_id, employee_id, started_at) VALUES ($1,$2, now() - interval '10 days') RETURNING id", [co, e3])).rows[0].id;
      await client.query(
        "INSERT INTO employee_onboarding_items (onboarding_id, company_id, title, category, responsible_role, status, due_date) VALUES ($1,$2,'Laptop','it','all','completed',(now() AT TIME ZONE 'Asia/Karachi')::date - 5), ($1,$2,'Badge','general','all','pending',(now() AT TIME ZONE 'Asia/Karachi')::date - 2), ($1,$2,'Payroll set-up','hr','all','pending',(now() AT TIME ZONE 'Asia/Karachi')::date + 3)",
        [ob, co]
      );
      await client.query("INSERT INTO data_subject_requests (company_id, employee_id, request_type, description, submitted_by_user_account_id) VALUES ($1,$2,'access','Copy of my data',$3)", [co, e2, e2User]);

      // ---------------- audit and operations
      await client.query("INSERT INTO audit_log (company_id, actor, actor_id, actor_type, action, target) VALUES ($1,$2::text,$2::uuid,'user','rbac.role_assigned',$3)", [co, mgrUser, e2User]);
      await client.query("INSERT INTO tenant_configuration (company_id, category, setting_key, value, status, updated_by, scope_type) VALUES ($1,'security','max_login_attempts','5'::jsonb,'published','test','tenant')", [co]);
      await client.query("INSERT INTO tenant_integrations (company_id, provider_key, enabled, updated_by) VALUES ($1,'sso',true,'test')", [co]);
      await client.query("INSERT INTO tenant_daily_usage_counter (company_id, usage_date, api_request_count, email_sent_count) VALUES ($1, (now() AT TIME ZONE 'Asia/Karachi')::date, 10, 2)", [co]);
      await client.query("INSERT INTO tenant_data_exports (company_id, scope, format, status, size_bytes, requested_by) VALUES ($1,'employees','csv','completed',2097152,'test'), ($1,'payroll','json','failed',0,'test')", [co]);
      await client.query("INSERT INTO background_jobs (company_id, job_type, status) VALUES ($1,'import.run','completed'), ($1,'import.run','completed')", [co]);
      await client.query("INSERT INTO background_jobs (company_id, job_type, status, last_error, attempts, dead_lettered) VALUES ($1,'payroll.calculate','failed','Deadlock detected', 3, true)", [co]);
      await client.query("INSERT INTO employee_documents (company_id, employee_id, document_type, file_name, mime_type, size_bytes, storage_path) VALUES ($1,$2,'contract','a.pdf','application/pdf',1048576,'p/a'), ($1,$2,'cnic','b.pdf','application/pdf',1048576,'p/b')", [co, e2]);
      await client.query("INSERT INTO import_batches (company_id, import_type, status, source_hash, config_hash, failed_rows, last_error, file_name) VALUES ($1,'employees','failed','h1','h2',4,'Bad header','people.csv')", [co]);

      // a second company's rows must never show up in company A's reports
      const of = (await client.query("INSERT INTO persons (company_id, full_name) VALUES ($1,'Other') RETURNING id", [other])).rows[0].id;
      await client.query("INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining) VALUES ($1,$2,'Other','Person',$3,'active',(now() AT TIME ZONE 'Asia/Karachi')::date - 100)", [other, `O-${stamp}`.slice(0, 30), of]);
      await client.query("INSERT INTO notification_log (company_id, channel, recipient, template_key, status) VALUES ($1,'email','x@other.com','leave_decision','failed')", [other]);
      await client.query("INSERT INTO background_jobs (company_id, job_type, status, last_error) VALUES ($1,'other.job','failed','other company error')", [other]);
      await client.query("INSERT INTO tenant_daily_usage_counter (company_id, usage_date, api_request_count, email_sent_count) VALUES ($1, (now() AT TIME ZONE 'Asia/Karachi')::date, 999, 999)", [other]);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------- workflow
  describe("workflow and approvals", () => {
    it("H01 counts the two open approvals, one escalated, with the oldest at 10 days", async () => {
      const r = await run(all, "H01");
      expect(r.rows).toHaveLength(1);
      expect(num(r, "waiting")).toBe(2);
      expect(num(r, "escalated")).toBe(1);
      expect(num(r, "oldest")).toBe(10);
      expect(kpi(r, "waiting")).toBe(2);
    });

    it("H02 puts the 10 day approval in '8 to 14 days' and the 3 day one in '3 to 7 days'", async () => {
      const r = await run(all, "H02");
      const band = (b: string) => Number(r.rows.find((x) => x.band === b)?.approvals);
      expect(band("8 to 14 days")).toBe(1);
      expect(band("3 to 7 days")).toBe(1);
      expect(band("Under 1 day") + band("1 to 2 days") + band("15 to 30 days") + band("Over 30 days")).toBe(0);
    });

    it("H03 averages 4 and 30 hours to 17, with a median of 17 and a slowest of 30", async () => {
      const r = await run(all, "H03");
      expect(r.rows).toHaveLength(1);
      expect(num(r, "requests")).toBe(2);
      expect(num(r, "average")).toBeCloseTo(17, 0);
      expect(num(r, "slowest")).toBeCloseTo(30, 0);
    });

    it("H04 shows 4 submitted: 1 approved, 1 rejected, 2 open, so 50% decided", async () => {
      const r = await run(all, "H04");
      expect(num(r, "submitted")).toBe(4);
      expect(num(r, "approved")).toBe(1);
      expect(num(r, "rejected")).toBe(1);
      expect(num(r, "open")).toBe(2);
      expect(num(r, "rate")).toBe(50);
    });

    it("H05 lists the rejection with the reason the approver gave", async () => {
      const r = await run(all, "H05");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.reason).toBe("Budget freeze");
      expect(r.rows[0]?.by).toBe("Dom Emp1");
    });

    it("H07 measures all 4 steps against the 24 hour limit: 4h is fine, 30h, 10 days and 3 days are over", async () => {
      const r = await run(all, "H07");
      expect(num(r, "steps")).toBe(4);
      expect(num(r, "breached")).toBe(3);
      expect(num(r, "rate")).toBe(75);
    });

    it("H12 lists the one escalation", async () => {
      const r = await run(all, "H12");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.status).toBe("Escalated");
    });

    it("H14 shows the two approvers holding one approval each", async () => {
      const r = await run(all, "H14");
      expect(r.rows).toHaveLength(2);
      expect(kpi(r, "open")).toBe(2);
      expect(kpi(r, "top3")).toBe(100);
    });

    it("H15 lists only the request idle for 10 days, not the one idle for 3", async () => {
      const r = await run(all, "H15");
      expect(r.rows).toHaveLength(1);
      expect(Number(r.rows[0]?.idle)).toBe(10);
    });

    it("H13 and H10 run on the same data without error", async () => {
      expect((await run(all, "H13")).rows.length).toBe(1);
      expect(num(await run(all, "H10"), "assigned")).toBe(3);
    });
  });

  // ---------------------------------------------------------------- learning
  describe("learning", () => {
    it("L01 counts 3 enrolments: 2 on Fire safety (1 not started, 1 completed) and 1 on SQL basics", async () => {
      const r = await run(all, "L01");
      const fire = r.rows.find((x) => x.course === "Fire safety");
      expect(Number(fire?.enrolled)).toBe(2);
      expect(Number(fire?.assigned)).toBe(1);
      expect(Number(fire?.completed)).toBe(1);
      expect(kpi(r, "enrolled")).toBe(3);
    });

    it("L02 completes 1 of 2 compliance enrolments (50%) in 15 days, and 0 of 1 technical", async () => {
      const r = await run(all, "L02");
      const comp = r.rows.find((x) => x.category === "Compliance");
      expect(Number(comp?.rate)).toBe(50);
      expect(Number(comp?.daysToFinish)).toBeCloseTo(15, 0);
      expect(Number(r.rows.find((x) => x.category === "Technical")?.rate)).toBe(0);
    });

    it("L04 lists the one enrolment 5 days past due", async () => {
      const r = await run(all, "L04");
      expect(r.rows).toHaveLength(1);
      expect(Number(r.rows[0]?.late)).toBe(5);
    });

    it("L05 counts 1 completed hour for Engineering", async () => {
      const r = await run(all, "L05");
      expect(r.rows).toHaveLength(1);
      expect(num(r, "hours")).toBe(1);
      expect(r.rows[0]?.unit).toBe("Engineering");
    });

    it("L09 shows one qualification expiring in 30 days and one expired 10 days ago", async () => {
      const r = await run(all, "L09");
      expect(r.rows).toHaveLength(2);
      expect(r.rows.find((x) => x.title === "First aid")?.state).toBe("Expires soon");
      expect(Number(r.rows.find((x) => x.title === "First aid")?.left)).toBe(30);
      expect(r.rows.find((x) => x.title === "Forklift")?.state).toBe("Expired");
    });

    it("L10 and L15 flag the plan with no actions and a passed target date", async () => {
      expect((await run(all, "L10")).rows).toHaveLength(1);
      const r = await run(all, "L15");
      expect(r.rows.map((x) => x.exception).sort()).toEqual(["No actions", "Target date passed"]);
    });
  });

  // ---------------------------------------------------------------- self-service
  describe("employee service", () => {
    it("I01: 3 current employees, 2 with a login, 1 who ever signed in and was active in the last 30 days (33.3%)", async () => {
      const r = await run(all, "I01");
      expect(r.rows).toHaveLength(1);
      expect(num(r, "employees")).toBe(3);
      expect(num(r, "withLogin")).toBe(2);
      expect(num(r, "signedIn")).toBe(1);
      expect(num(r, "recent")).toBe(1);
      expect(num(r, "rate")).toBe(33.3);
    });

    it("I03 and I06: one leave request was submitted by the employee and one for them (50%)", async () => {
      const leave = (await run(all, "I03")).rows.find((x) => x.type === "Leave requests");
      expect(Number(leave?.total)).toBe(2);
      expect(Number(leave?.self)).toBe(1);
      expect(Number(leave?.onBehalf)).toBe(1);
      expect(Number(leave?.rate)).toBe(50);
      expect(kpi(await run(all, "I06"), "total")).toBe(2);
    });

    it("I04 finds the one people manager with a login who has not signed in", async () => {
      const r = await run(all, "I04");
      expect(num(r, "managers")).toBe(1);
      expect(num(r, "withLogin")).toBe(1);
      expect(num(r, "recent")).toBe(0);
    });

    it("I10 reports no sections filled in, because the fixture employees have no personal records", async () => {
      const r = await run(all, "I10");
      expect(r.rows).toHaveLength(5);
      expect(r.rows.every((x) => Number(x.complete) === 0 && Number(x.employees) === 3)).toBe(true);
    });

    it("I12 and I13: 4 notifications, 2 sent, 1 failed (25%), recipient masked", async () => {
      const r = await run(all, "I12");
      expect(r.rows).toHaveLength(1);
      expect(num(r, "total")).toBe(4);
      expect(num(r, "sent")).toBe(2);
      expect(num(r, "failRate")).toBe(25);
      const f = await run(all, "I13");
      expect(f.rows).toHaveLength(1);
      expect(f.rows[0]?.recipient).toBe("j***@example.com");
    });

    it("I14 groups the 3 onboarding tasks by who acts: 1 done and 1 overdue", async () => {
      const r = await run(all, "I14");
      const hr = r.rows.find((x) => x.role === "HR and administrators" && x.process === "Onboarding");
      expect(Number(hr?.tasks)).toBe(3);
      expect(Number(hr?.done)).toBe(1);
      expect(Number(hr?.overdue)).toBe(1);
      expect(kpi(r, "overdue")).toBe(1);
    });
  });

  // ---------------------------------------------------------------- audit and security
  describe("audit and security", () => {
    it("J01 lists the 3 accounts and flags the one with no role", async () => {
      const r = await run(all, "J01");
      expect(r.rows).toHaveLength(3);
      expect(r.rows.some((x) => String(x.flags).includes("Account without a role"))).toBe(true);
      expect(r.rows.every((x) => x.mfa !== "On")).toBe(true);
    });

    it("J02 shows the custom test role held by one person", async () => {
      const r = await run(all, "J02");
      const mine = r.rows.find((x) => x.role === "Domains all");
      expect(Number(mine?.people)).toBe(1);
      expect(Number(mine?.permissions)).toBeGreaterThan(10);
    });

    it("J03 and J04 record the sensitive open and the export of J01 itself", async () => {
      await run(all, "J01");
      await reports.exportCsv(all, "J01", {});
      const opens = await run(all, "J03");
      expect(opens.rows.some((x) => x.report === "J01")).toBe(true);
      const exports = await run(all, "J04");
      expect(exports.rows.some((x) => x.report === "J01")).toBe(true);
    });

    it("J08 names the person a role change affected", async () => {
      const r = await run(all, "J08");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.affected).toBe("Dom Emp2");
      expect(r.rows[0]?.by).toBe("Dom Emp1");
    });

    it("J12 shows the one open access request", async () => {
      const r = await run(all, "J12");
      expect(num(r, "received")).toBe(1);
      expect(num(r, "open")).toBe(1);
    });

    it("J13 shows the security setting and the single sign-on switch", async () => {
      const r = await run(all, "J13");
      expect(r.rows.find((x) => x.setting === "Max Login Attempts")?.value).toBe("5");
      expect(r.rows.find((x) => x.setting === "Single sign-on")?.value).toBe("On");
    });

    it("J07 and J06 run and count the 3 accounts", async () => {
      await run(all, "J07");
      expect(kpi(await run(all, "J06"), "accounts")).toBe(3);
    });
  });

  // ---------------------------------------------------------------- operations and governance
  describe("operations and governance", () => {
    it("N01 shows this company's counters only (10 requests, 2 emails), never the other company's 999", async () => {
      const r = await run(all, "N01");
      expect(kpi(r, "api")).toBe(10);
      expect(kpi(r, "emails")).toBe(2);
    });

    it("N05 and H11: 3 jobs, 1 failed; the other company's failed job is invisible", async () => {
      const r = await run(all, "N05");
      expect(kpi(r, "jobs")).toBe(3);
      expect(kpi(r, "failed")).toBe(1);
      const h = await run(all, "H11");
      expect(h.rows).toHaveLength(1);
      expect(h.rows[0]?.job).toBe("payroll.calculate");
      expect(h.rows[0]?.deadLettered).toBe("Yes");
    });

    it("N07: 2 exports, 1 failed, 2 MB", async () => {
      const r = await run(all, "N07");
      expect(kpi(r, "exports")).toBe(2);
      expect(kpi(r, "failed")).toBe(1);
      expect(kpi(r, "mb")).toBe(2);
    });

    it("N08 adds 2 MB of employee documents toward the quota", async () => {
      const r = await run(all, "N08");
      expect(kpi(r, "used")).toBe(2);
      expect(r.rows.find((x) => x.source === "Employee documents")?.files).toBe(2);
    });

    it("N09 marks email 'Some failures' (1 of 3 attempts failed)", async () => {
      const r = await run(all, "N09");
      expect(r.rows[0]?.health).toBe("Some failures");
    });

    it("N10, N11 and N12 describe the integration, the failed import and failed export, and the checklist", async () => {
      expect((await run(all, "N10")).rows.some((x) => x.name === "Sso" && x.state === "Enabled")).toBe(true);
      const n11 = await run(all, "N11");
      expect(kpi(n11, "imports")).toBe(1);
      expect(kpi(n11, "exports")).toBe(1);
      expect(kpi(n11, "failedRows")).toBe(4);
      const n12 = await run(all, "N12");
      expect(n12.rows.find((x) => x.item === "Organisation units")?.state).toBe("Done");
      expect(n12.rows.find((x) => x.item === "Shifts")?.state).toBe("Missing");
    });

    it("O11 and O15: a line manager refused a report is listed by name; O02 shows what was run", async () => {
      await expect(reports.run(mgr, "J01", {})).rejects.toThrow(ForbiddenException);
      const denied = await run(all, "O11");
      expect(denied.rows.some((x) => x.person === "Dom Emp1" && x.report === "J01")).toBe(true);
      const top = await run(all, "O02");
      expect(top.rows.length).toBeGreaterThan(0);
      await run(all, "O15");
    });

    it("O12 counts the whole catalog and agrees with the catalog's own statuses", async () => {
      const r = await run(all, "O12");
      expect(kpi(r, "total")).toBe(220);
      const cat = await reports.catalog(all);
      expect(Number(r.rows.reduce((s, x) => s + Number(x.available), 0))).toBe(cat.counts.available);
    });

    it("O01, O03, O04, O05 and O10 run on the usage this spec generated", async () => {
      expect(kpi(await run(all, "O01"), "runs")).toBeGreaterThan(0);
      expect((await run(all, "O03")).rows.length).toBeGreaterThan(100);
      expect(kpi(await run(all, "O04"), "runs")).toBeGreaterThan(0);
      await run(all, "O05");
      expect(kpi(await run(all, "O10"), "exports")).toBeGreaterThanOrEqual(1);
    });

    it("a user from company B sees none of company A's operations or workflow figures", async () => {
      const bUser = await fx(async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [`dom_all_${stamp}`]);
        const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`dom-b-${stamp}@example.com`]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, other, role.rows[0].id]);
        return u.rows[0].id as string;
      });
      const b: RequestClaims = { is_platform_admin: false, company_id: other, sub: bUser };
      expect(kpi(await run(b, "N01"), "api")).toBe(999);
      expect(kpi(await run(b, "H01"), "waiting")).toBe(0);
      expect((await run(b, "H05")).rows).toHaveLength(0);
      expect((await run(b, "L04")).rows).toHaveLength(0);
      expect(kpi(await run(b, "I12"), "total")).toBe(1); // its own single failed notification, never company A's four
      expect(kpi(await run(b, "J06"), "accounts")).toBe(1);
      expect((await run(b, "J08")).rows).toHaveLength(0);
    });
  });
});
