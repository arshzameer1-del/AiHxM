import { Pool } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { RbacService } from "../../rbac/rbac.service";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { AuditService } from "../../audit/audit.service";
import { LocalFileStorageService } from "../../file-storage/local-file-storage.service";
import { EffectiveDatingEngine } from "../../effective-dating/effective-dating.engine";
import { RulesEngine } from "../../rules-engine/rules-engine.engine";
import { ShiftsService } from "../../shifts/shifts.service";
import { EmployeeCompensationService } from "../employee-compensation.service";
import { EmployeesService } from "../employees.service";
import { HrBusinessPolicyService } from "../../hr-administration/hr-business-policy.service";
import { WorkflowService } from "../../workflow/workflow.service";
import { WorkflowAdapterRegistry } from "../../workflow/workflow-adapter.registry";
import { InboxService } from "../../workflow/inbox.service";
import { HiringProcessService } from "./hiring-process.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "hiring-step6-fixtures" };

/** WFL-01: a submitted hire is approved through the workflow engine / My Inbox when a template is active. */
describe("Hire approval through the workflow engine (Step 6)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let hiring: HiringProcessService;
  let workflow: WorkflowService;
  let inbox: InboxService;
  let companyId: string;
  let hr: RequestClaims;
  let approver: RequestClaims;
  let admin: RequestClaims;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.withClaims(FIXTURE, async (c) => (await c.query(text, params)).rows as T[]);

  const REQUIRED_PAYLOADS: Record<string, Record<string, unknown>> = {
    personal_identity: { firstName: "Hira", lastName: "Tester" },
    employment: { employmentType: "permanent", dateOfJoining: "2026-01-01" },
    organization_assignment: { note: "HQ" },
    review_completion: { reviewed: true },
  };

  async function driveToReady() {
    let p = await hiring.start(hr, {});
    for (const [cardKey, data] of Object.entries(REQUIRED_PAYLOADS)) await hiring.saveCard(hr, p.id, cardKey, { data });
    for (let i = 0; i < 30; i++) {
      p = await hiring.get(hr, p.id);
      if (p.status === "ready_for_completion") break;
      p = await hiring.next(hr, p.id, p.revision);
    }
    expect(p.status).toBe("ready_for_completion");
    return p;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    const registry = new WorkflowAdapterRegistry();
    workflow = new WorkflowService(db, rbac, audit, registry);
    inbox = new InboxService(db, rbac, audit, workflow, registry, new LocalFileStorageService());
    const shifts = new ShiftsService(db, rbac, ent, audit, new EffectiveDatingEngine(), new RulesEngine());
    const compensation = new EmployeeCompensationService(db, rbac, ent, audit, new EffectiveDatingEngine());
    hiring = new HiringProcessService(db, rbac, ent, audit, employees, undefined, undefined, undefined, shifts, undefined, undefined, compensation);
    const internals = hiring as unknown as { businessPolicy: HrBusinessPolicyService; workflow: WorkflowService; registerWorkflowAdapter(): void };
    internals.businessPolicy = new HrBusinessPolicyService(db, rbac, ent, audit);
    internals.workflow = workflow;
    internals.registerWorkflowAdapter();

    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`H6 ${stamp}`, `h6-${stamp}`])).rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true), ($1,'leave',true)", [companyId]);
      const mk = async (label: string, role: string): Promise<RequestClaims> => {
        const id = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`h6-${label}-${stamp}@example.com`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [id, companyId, role]);
        return { sub: id, company_id: companyId, is_platform_admin: false };
      };
      hr = await mk("hr", "hr_admin");
      approver = await mk("approver", "hr_admin");
      admin = await mk("admin", "rbac_demo_full_access");
    });
    await sql(
      `INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default) VALUES ($1,'hiring','default','Hiring','{"requireApproval": true}'::jsonb, true)`,
      [companyId]
    );
    await workflow.createTemplate(admin, {
      key: `hire-${stamp}`,
      name: "Hire approval",
      objectKey: "hire_process",
      steps: [{ stepOrder: 1, name: "HR head", approvers: [{ approverType: "specific_user", userAccountId: approver.sub }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  it("submit creates an engine instance; the configured approver (not the maker, not a bystander) decides from My Inbox", async () => {
    const p = await driveToReady();
    const submitted = await hiring.submit(hr, p.id);
    expect(submitted.status).toBe("submitted");
    const [row] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM hire_processes WHERE id = $1", [p.id]);
    expect(row.workflow_instance_id).not.toBeNull();

    const items = await inbox.list(approver, {});
    expect(items.some((i) => i.recordId === p.id && i.objectKey === "hire_process")).toBe(true);
    await expect(hiring.approve(hr, p.id)).rejects.toBeInstanceOf(ForbiddenException); // hr is not a configured approver
    await inbox.decide(approver, row.workflow_instance_id, { decision: "approved" });
    const after = await hiring.get(hr, p.id);
    expect(after.status).toBe("approved");
    expect((await hiring.complete(hr, p.id)).status).toBe("hired");
  });

  it("a rejection through the engine rejects the hire with the approver's reason, and reopening drops the instance link", async () => {
    const p = await driveToReady();
    await hiring.submit(hr, p.id);
    const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM hire_processes WHERE id = $1", [p.id]);
    await hiring.reject(approver, p.id, "salary band missing");
    expect(await hiring.get(hr, p.id)).toMatchObject({ status: "rejected", decisionReason: "salary band missing" });
    expect((await sql<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [iid]))[0].status).toBe("rejected");
    await hiring.saveCard(hr, p.id, "personal_identity", { data: { firstName: "Hira", lastName: "Fixed" } });
    expect((await sql<{ workflow_instance_id: string | null }>("SELECT workflow_instance_id FROM hire_processes WHERE id = $1", [p.id]))[0].workflow_instance_id).toBeNull();
  });

  it("cancelling a hire that is awaiting approval closes its workflow instance", async () => {
    const p = await driveToReady();
    await hiring.submit(hr, p.id);
    const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM hire_processes WHERE id = $1", [p.id]);
    const fresh = await hiring.get(hr, p.id);
    await hiring.cancel(hr, p.id, fresh.revision);
    expect((await sql<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [iid]))[0].status).toBe("cancelled");
    expect((await inbox.list(approver, {})).some((i) => i.recordId === p.id)).toBe(false);
  });
});
