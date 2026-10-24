import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { WorkflowService } from "./workflow.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "workflow-fallback-spec" };

/**
 * BACKLOG57 (real Postgres): what happens when the manager is missing (fallback), the manager's manager as an approver,
 * escalation to the approver's manager, automatic approve / reject after escalation, and the notifications around all of it.
 */
describe("Workflow fallback, escalation and notifications", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let companyId: string;
  let admin: RequestClaims;
  let hrRoleId: string;
  const stamp = Date.now();
  const people: Record<string, { id: string; claims: RequestClaims; employeeId: string }> = {};

  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return db.withClaims(FIXTURE, async (client) => (await client.query(text, params)).rows as T[]);
  }

  async function person(name: string, managerKey: string | null, roleKey?: string) {
    const userId = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`wfb-${name}-${stamp}@example.com`]))[0].id;
    if (roleKey) await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3", [userId, companyId, roleKey]);
    const employeeId = (
      await sql<{ id: string }>(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, email, user_account_id, manager_id, employment_type, employment_status, date_of_joining)
         VALUES ($1, $2, $3, 'Fixture', $4, $5, $6, 'permanent', 'active', now()) RETURNING id`,
        [companyId, `WFB-${name}`, name, `wfb-${name}-${stamp}@example.com`, userId, managerKey ? people[managerKey].employeeId : null]
      )
    )[0].id;
    people[name] = { id: userId, employeeId, claims: { is_platform_admin: false, company_id: companyId, sub: userId } };
  }

  async function template(key: string, steps: Array<Record<string, unknown>>) {
    await workflow.createTemplate(admin, { key, name: `Template ${key}`, objectKey: "dummy_record", steps } as never);
  }

  async function submit(who: string, key: string) {
    const record = (await sql<{ id: string }>("INSERT INTO dummy_records (company_id, title, status) VALUES ($1, 'Fallback spec', 'locked') RETURNING id", [companyId]))[0].id;
    return workflow.submitForApproval(people[who].claims, { templateKey: key, objectKey: "dummy_record", recordId: record, record: { status: "locked" }, title: `Request ${key}` });
  }

  async function notificationsFor(userId: string, category: string) {
    // the notification is written after the transaction commits
    await new Promise((r) => setTimeout(r, 150));
    return sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1 AND category = $2 ORDER BY created_at", [userId, category]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    workflow = new WorkflowService(db, new RbacService(db), new AuditService(), undefined, new UserNotificationsService(db, { isConfigured: () => false } as never));
    companyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`WfFallback ${stamp}`, `wf-fallback-${stamp}`]))[0].id;
    hrRoleId = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = 'rbac_demo_view_only'"))[0].id;
    await person("boss", null);
    await person("mgr", "boss");
    await person("emp", "mgr");
    await person("orphan", null);
    await person("hr", null, "rbac_demo_view_only");
    await person("adm", null, "rbac_demo_full_access");
    admin = people.adm.claims;
  });

  afterAll(async () => {
    await sql("DELETE FROM workflow_instances WHERE company_id = $1", [companyId]);
    await sql("DELETE FROM workflow_templates WHERE company_id = $1", [companyId]);
    await sql("DELETE FROM companies WHERE id = $1", [companyId]);
    await pool.end();
  });

  it("without a fallback a person with no manager still cannot submit (unchanged)", async () => {
    await template(`nofb-${stamp}`, [{ stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter" }] }]);
    await expect(submit("orphan", `nofb-${stamp}`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fallback to a role: the request goes to that role, its holders are notified and a note explains why", async () => {
    await template(`fbrole-${stamp}`, [{ stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter", fallbackType: "role", fallbackRoleId: hrRoleId }] }]);
    const instance = await submit("orphan", `fbrole-${stamp}`);
    const line = instance.steps[0].approvals[0];
    expect(line.approverType).toBe("role");
    expect(line.roleId).toBe(hrRoleId);
    const notes = await sql<{ body: string }>("SELECT body FROM workflow_comments WHERE workflow_instance_id = $1 AND kind = 'system'", [instance.id]);
    expect(notes[0].body).toMatch(/fallback role/);
    const bell = await notificationsFor(people.hr.id, "approval_requests");
    expect(bell.some((n) => n.title.startsWith("Approval needed: Request fbrole"))).toBe(true);
    // never "approval needed" for the person who asked
    expect((await notificationsFor(people.orphan.id, "approval_requests")).length).toBe(0);
  });

  it("fallback to skip: a step with nobody to ask is skipped and the request completes", async () => {
    await template(`fbskip-${stamp}`, [{ stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter", fallbackType: "skip" }] }]);
    const instance = await submit("orphan", `fbskip-${stamp}`);
    expect(instance.status).toBe("approved");
    expect(instance.steps[0].status).toBe("skipped");
    const normal = await submit("emp", `fbskip-${stamp}`);
    expect(normal.status).toBe("in_progress");
    expect(normal.steps[0].approvals[0].userAccountId).toBe(people.mgr.id);
  });

  it("manager's manager is an approver type; its fallback can be the direct manager", async () => {
    await template(`mm-${stamp}`, [{ stepOrder: 1, name: "Skip level", approvers: [{ approverType: "manager_of_manager", fallbackType: "submitter_manager" }] }]);
    const high = await submit("emp", `mm-${stamp}`);
    expect(high.steps[0].approvals[0].userAccountId).toBe(people.boss.id);
    const near = await submit("mgr", `mm-${stamp}`); // mgr's manager (boss) has no manager: falls back to the direct manager
    expect(near.steps[0].approvals[0].userAccountId).toBe(people.boss.id);
    await template(`mmstrict-${stamp}`, [{ stepOrder: 1, name: "Skip level", approvers: [{ approverType: "manager_of_manager" }] }]);
    await expect(submit("mgr", `mmstrict-${stamp}`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a fallback is refused on types that never fail, and an automatic action needs hours and an SLA", async () => {
    await expect(template(`bad1-${stamp}`, [{ stepOrder: 1, name: "x", approvers: [{ approverType: "role", roleId: hrRoleId, fallbackType: "skip" }] }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      template(`bad2-${stamp}`, [{ stepOrder: 1, name: "x", slaHours: 4, approvers: [{ approverType: "role", roleId: hrRoleId, escalationAction: "auto_reject" }] }])
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      template(`bad3-${stamp}`, [{ stepOrder: 1, name: "x", approvers: [{ approverType: "role", roleId: hrRoleId, escalationAction: "auto_reject", escalationActionHours: 5 }] }])
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an overdue approval escalates to the manager of the approver, who is told; then it is rejected automatically", async () => {
    await template(`esc-${stamp}`, [
      { stepOrder: 1, name: "HR", slaHours: 4, approvers: [{ approverType: "role", roleId: hrRoleId, escalationApproverType: "manager_of_approver", escalationAction: "auto_reject", escalationActionHours: 6 }] },
    ]);
    const instance = await submit("emp", `esc-${stamp}`);
    await sql("UPDATE workflow_step_approvals SET due_at = now() - interval '1 hour' WHERE step_instance_id = $1", [instance.steps[0].id]);
    await workflow.escalateOverdue();
    const after = (await sql<{ status: string; escalated_to_user_account_id: string | null }>("SELECT status, escalated_to_user_account_id FROM workflow_step_approvals WHERE step_instance_id = $1", [instance.steps[0].id]))[0];
    expect(after.status).toBe("escalated");
    expect(after.escalated_to_user_account_id).toBe(people.mgr.id); // role line: the requester's manager
    expect((await notificationsFor(people.mgr.id, "approval_requests")).some((n) => n.title.startsWith("Escalated to you"))).toBe(true);

    // not yet: 6 hours have not passed
    expect(await workflow.applyAutomaticActions()).toBe(0);
    await sql("UPDATE workflow_step_approvals SET escalated_at = now() - interval '7 hours' WHERE step_instance_id = $1", [instance.steps[0].id]);
    await workflow.applyAutomaticActions();
    const done = (await sql<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [instance.id]))[0];
    expect(done.status).toBe("rejected");
    const line = (await sql<{ status: string; decided_by_user_account_id: string | null; comment: string }>("SELECT status, decided_by_user_account_id, comment FROM workflow_step_approvals WHERE step_instance_id = $1", [instance.steps[0].id]))[0];
    expect(line.status).toBe("rejected");
    expect(line.decided_by_user_account_id).toBeNull();
    expect(line.comment).toMatch(/automatically/);
    expect((await notificationsFor(people.emp.id, "request_progress")).some((n) => n.title.startsWith("Rejected: Request esc"))).toBe(true);
  });

  it("a normal decision tells the requester, and a reminder tells the approver", async () => {
    await template(`dec-${stamp}`, [{ stepOrder: 1, name: "Manager", reminderHours: 2, approvers: [{ approverType: "manager_of_submitter" }] }]);
    const instance = await submit("emp", `dec-${stamp}`);
    expect((await notificationsFor(people.mgr.id, "approval_requests")).some((n) => n.title.startsWith("Approval needed: Request dec"))).toBe(true);
    await sql("UPDATE workflow_step_approvals SET created_at = now() - interval '3 hours' WHERE step_instance_id = $1", [instance.steps[0].id]);
    await workflow.remindDue();
    expect((await notificationsFor(people.mgr.id, "approval_requests")).some((n) => n.title.startsWith("Reminder: Request dec"))).toBe(true);
    await workflow.decide(people.mgr.claims, instance.steps[0].id, { decision: "approved" });
    expect((await notificationsFor(people.emp.id, "request_progress")).some((n) => n.title.startsWith("Approved: Request dec"))).toBe(true);
  });

  it("\"who would approve this?\" shows each step's people, skipped steps and blocked approvers without submitting anything", async () => {
    await template(`sim-${stamp}`, [
      { stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter" }] },
      { stepOrder: 2, name: "Big ones only", condition: { field: "amount", op: "gte", value: 1000 }, approvers: [{ approverType: "role", roleId: hrRoleId }] },
      { stepOrder: 3, name: "Skip level", approvers: [{ approverType: "manager_of_manager", fallbackType: "skip" }] },
    ]);
    const before = (await sql<{ n: string }>("SELECT count(*)::text AS n FROM workflow_instances WHERE company_id = $1", [companyId]))[0].n;
    const small = await workflow.simulate(admin, `sim-${stamp}`, { subjectUserAccountId: people.emp.id, record: { amount: 10 } });
    expect(small.blocked).toBe(false);
    expect(small.steps[0].approvers[0]).toMatchObject({ outcome: "person", names: ["mgr Fixture"] });
    expect(small.steps[1].status).toBe("skipped_condition");
    expect(small.steps[2].approvers[0]).toMatchObject({ outcome: "person", names: ["boss Fixture"] });
    const big = await workflow.simulate(admin, `sim-${stamp}`, { subjectUserAccountId: people.mgr.id, record: { amount: 5000 } });
    expect(big.steps[1].status).toBe("will_run");
    expect(big.steps[1].approvers[0].outcome).toBe("role");
    expect(big.steps[1].approvers[0].names).toContain("hr Fixture");
    expect(big.steps[2].status).toBe("skipped_nobody"); // boss has no manager: the fallback skips the line
    const orphan = await workflow.simulate(admin, `sim-${stamp}`, { subjectUserAccountId: people.orphan.id, record: { amount: 10 } });
    expect(orphan.blocked).toBe(true);
    expect(orphan.steps[0].approvers[0].outcome).toBe("blocked");
    expect(orphan.steps[0].approvers[0].note).toMatch(/Without a fallback/);
    expect((await sql<{ n: string }>("SELECT count(*)::text AS n FROM workflow_instances WHERE company_id = $1", [companyId]))[0].n).toBe(before);
    await expect(workflow.simulate(people.emp.claims, `sim-${stamp}`, { subjectUserAccountId: people.emp.id, record: {} })).rejects.toThrow(/Not permitted/);
  });
});
