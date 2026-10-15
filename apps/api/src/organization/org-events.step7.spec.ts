import { Pool } from "pg";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowAdapterRegistry } from "../workflow/workflow-adapter.registry";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { DomainEventsService } from "../domain-events/domain-events.service";
import { OrgUnitsService } from "./org-units.service";
import { LocationsService } from "./locations.service";
import { OrgEventConsumerService } from "./org-event-consumers.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-events-step7" };

/** Gap Register ORG-06: org events reach the outbox and internal consumers apply them idempotently. */
describe("Organization event consumers (Step 7C)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let consumers: OrgEventConsumerService;
  let employees: EmployeesService;
  let orgUnits: OrgUnitsService;
  let locations: LocationsService;
  let companyId: string;
  let hr: RequestClaims;
  let admin: RequestClaims;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);

  async function waitForEvent(type: string, aggregateId: string, minCount = 1) {
    for (let i = 0; i < 40; i++) {
      const rows = await sql("SELECT id FROM domain_events WHERE company_id = $1 AND event_type = $2 AND aggregate_id = $3", [companyId, type, aggregateId]);
      if (rows.length >= minCount) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no ${type} event for ${aggregateId}`);
  }

  async function userWithEmployee(label: string, managerId?: string) {
    const uid = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`ev7-${label}-${stamp}@example.com`]))[0].id;
    const emp = await employees.create(hr, { firstName: label, lastName: "Ev", managerId });
    await sql("UPDATE employees SET user_account_id = $2 WHERE id = $1", [emp.id, uid]);
    return { uid, employeeId: emp.id, claims: { is_platform_admin: false, company_id: companyId, sub: uid } as RequestClaims };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const eff = new EffectiveDatingEngine();
    const webhooks = new WebhookDispatchService(db, audit, new DomainEventsService());
    workflow = new WorkflowService(db, rbac, audit, new WorkflowAdapterRegistry());
    consumers = new OrgEventConsumerService(db, workflow);
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    orgUnits = new OrgUnitsService(db, rbac, ent, audit, eff, webhooks);
    locations = new LocationsService(db, rbac, ent, audit, eff, webhooks);

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Ev7 ${stamp}`, `ev7-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    const mk = async (label: string, role: string) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`ev7-${label}-${stamp}@example.com`]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [u.rows[0].id, companyId, role]);
        return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id } as RequestClaims;
      });
    hr = await mk("hr", "hr_admin");
    admin = await mk("admin", "rbac_demo_full_access");
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("renaming an org unit appends org.unit.changed to the outbox and the consumer refreshes the legacy department text, once", async () => {
    const unit = await orgUnits.create(hr, { name: "Platform", unitType: "department" });
    const emp = await employees.create(hr, { firstName: "Dept", lastName: "Sync", orgUnitId: unit.id });
    expect((await employees.get(hr, emp.id)).department).toBe("Platform");

    await orgUnits.update(hr, unit.id, { name: "Platform Engineering" });
    await waitForEvent("org.unit.changed", unit.id, 2); // create + rename
    const first = await consumers.processPending(500, companyId);
    expect(first.failed).toBe(0);
    expect((await employees.get(hr, emp.id)).department).toBe("Platform Engineering");

    const receipts = await sql("SELECT 1 FROM event_consumer_receipts WHERE company_id = $1 AND consumer = 'denormalized_text_sync' AND status = 'done'", [companyId]);
    expect(receipts.length).toBeGreaterThan(0);
    const again = await consumers.processPending(500, companyId);
    expect(again).toEqual({ processed: 0, failed: 0 });
  });

  it("renaming a location refreshes employees.location", async () => {
    const loc = await locations.create(hr, { name: "Karachi HQ", locationType: "site" });
    const emp = await employees.create(hr, { firstName: "Loc", lastName: "Sync", locationId: loc.id });
    await locations.update(hr, loc.id, { name: "Karachi Head Office" });
    await waitForEvent("org.location.changed", loc.id, 2);
    await consumers.processPending(500, companyId);
    const [row] = await sql<{ location: string }>("SELECT location FROM employees WHERE id = $1", [emp.id]);
    expect(row.location).toBe("Karachi Head Office");
  });

  it("a pending manager_of_submitter approval line follows the employee's new manager after an org event, and is left alone when no manager can be resolved", async () => {
    const oldMgr = await userWithEmployee("oldmgr");
    const newMgr = await userWithEmployee("newmgr");
    const staff = await userWithEmployee("staff", oldMgr.employeeId);
    await workflow.createTemplate(admin, {
      key: `mgr-${stamp}`,
      name: "Manager approval",
      objectKey: "org_event_probe",
      steps: [{ stepOrder: 1, name: "Manager", approvers: [{ approverType: "manager_of_submitter" }] }],
    });
    const instance = await workflow.submitForApproval(staff.claims, {
      templateKey: `mgr-${stamp}`,
      objectKey: "org_event_probe",
      recordId: randomUUID(),
      record: {},
    });
    const line = async () =>
      (await sql<{ user_account_id: string | null }>(
        "SELECT a.user_account_id FROM workflow_step_approvals a JOIN workflow_step_instances s ON s.id = a.step_instance_id WHERE s.workflow_instance_id = $1",
        [instance.id]
      ))[0].user_account_id;
    expect(await line()).toBe(oldMgr.uid);

    await sql("UPDATE employees SET manager_id = $2 WHERE id = $1", [staff.employeeId, newMgr.employeeId]);
    await db.withClaims(FIXTURE, (c) =>
      new DomainEventsService().publish(c, FIXTURE, {
        companyId,
        eventType: "org.relationship.changed",
        aggregateType: "org_relationship",
        aggregateId: randomUUID(),
        payload: { changeType: "create" },
      })
    );
    await consumers.processPending(500, companyId);
    expect(await line()).toBe(newMgr.uid);
    const audited = await sql("SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'workflow.approver_refreshed' AND target = $2", [companyId, instance.id]);
    expect(audited.length).toBe(1);

    // Manager removed: unresolvable now -> the existing approver stays.
    await sql("UPDATE employees SET manager_id = NULL WHERE id = $1", [staff.employeeId]);
    await db.withClaims(FIXTURE, (c) =>
      new DomainEventsService().publish(c, FIXTURE, {
        companyId,
        eventType: "org.relationship.changed",
        aggregateType: "org_relationship",
        aggregateId: randomUUID(),
        payload: { changeType: "end" },
      })
    );
    await consumers.processPending(500, companyId);
    expect(await line()).toBe(newMgr.uid);
  });

  it("a consumer that throws is recorded as failed with an attempt count, does not block the others, and is retried on the next sweep", async () => {
    let calls = 0;
    const flaky = new OrgEventConsumerService(db, workflow);
    flaky.consumers.push({
      name: "flaky_probe",
      handles: (t) => t === "org.probe.changed",
      handle: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
    });
    const eventId = (
      await db.withClaims(FIXTURE, (c) =>
        new DomainEventsService().publish(c, FIXTURE, { companyId, eventType: "org.probe.changed", aggregateType: "probe", aggregateId: randomUUID() })
      )
    ).id;
    expect(await flaky.processPending(500, companyId)).toMatchObject({ failed: 1 });
    const [failed] = await sql<{ status: string; attempts: number; error: string }>("SELECT status, attempts, error FROM event_consumer_receipts WHERE consumer = 'flaky_probe' AND event_id = $1", [eventId]);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, error: "boom" });
    expect(await flaky.processPending(500, companyId)).toMatchObject({ failed: 0 });
    const [done] = await sql<{ status: string; attempts: number }>("SELECT status, attempts FROM event_consumer_receipts WHERE consumer = 'flaky_probe' AND event_id = $1", [eventId]);
    expect(done).toMatchObject({ status: "done", attempts: 2 });
  });
});
