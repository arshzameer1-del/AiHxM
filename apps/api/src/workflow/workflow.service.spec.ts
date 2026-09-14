import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { WorkflowService } from "./workflow.service";

/**
 * Phase 6's own exit criterion, proven the same way Phases 4/5 proved
 * theirs: real Postgres, real RLS, real HTTP-shaped claims objects — no
 * mocking of `pg`. Routes Phase 4/5's own `dummy_records` scaffolding
 * through a tenant-defined 2-step approval chain, including a
 * forced-timeout escalation, plus the rejection and conditional-skip
 * paths and the template-management permission gate.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "workflow-spec-fixtures" };

describe("WorkflowService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let audit: AuditService;
  let workflow: WorkflowService;

  let companyId: string;
  let adminUserId: string; // holds rbac_demo_full_access -> workflow_template.manage.all
  let step1ApproverUserId: string; // holds rbac_demo_view_only
  let step2ApproverUserId: string; // holds rbac_demo_self_service
  let escalationTargetUserId: string;
  let outsiderUserId: string; // no role assignment at all

  let adminClaims: RequestClaims;
  let step1ApproverClaims: RequestClaims;
  let step2ApproverClaims: RequestClaims;
  let escalationTargetClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  let viewOnlyRoleId: string;
  let selfServiceRoleId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    audit = new AuditService();
    workflow = new WorkflowService(db, rbac, audit);

    const stamp = Date.now();

    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query(
        "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
        [`Workflow Spec Co ${stamp}`, `workflow-spec-${stamp}`]
      );
      companyId = company.rows[0].id;

      async function makeUser(email: string): Promise<string> {
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
          [email]
        );
        return account.rows[0].id;
      }
      adminUserId = await makeUser(`wf-admin-${stamp}@example.com`);
      step1ApproverUserId = await makeUser(`wf-step1-${stamp}@example.com`);
      step2ApproverUserId = await makeUser(`wf-step2-${stamp}@example.com`);
      escalationTargetUserId = await makeUser(`wf-escalation-${stamp}@example.com`);
      outsiderUserId = await makeUser(`wf-outsider-${stamp}@example.com`);

      async function assign(userAccountId: string, roleKey: string): Promise<string> {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
        return role.rows[0].id;
      }
      await assign(adminUserId, "rbac_demo_full_access");
      viewOnlyRoleId = await assign(step1ApproverUserId, "rbac_demo_view_only");
      selfServiceRoleId = await assign(step2ApproverUserId, "rbac_demo_self_service");
      // escalationTargetUserId and outsiderUserId deliberately get no role assignment.
    });

    adminClaims = { is_platform_admin: false, company_id: companyId, sub: adminUserId };
    step1ApproverClaims = { is_platform_admin: false, company_id: companyId, sub: step1ApproverUserId };
    step2ApproverClaims = { is_platform_admin: false, company_id: companyId, sub: step2ApproverUserId };
    escalationTargetClaims = { is_platform_admin: false, company_id: companyId, sub: escalationTargetUserId };
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyId]); // cascades everything workflow-related
      await client.query("DELETE FROM user_accounts WHERE id = ANY($1::uuid[])", [
        [adminUserId, step1ApproverUserId, step2ApproverUserId, escalationTargetUserId, outsiderUserId],
      ]);
    });
    await pool.end();
  });

  async function makeDummyRecord(status: "locked" | "unlocked"): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO dummy_records (company_id, title, status) VALUES ($1, $2, $3) RETURNING id`,
        [companyId, "Workflow test record", status]
      );
      return result.rows[0].id;
    });
  }

  describe("template management permission gate", () => {
    it("denies creating a template for a caller without workflow_template.manage.all", async () => {
      await expect(
        workflow.createTemplate(step1ApproverClaims, {
          key: "unauthorized-attempt",
          name: "Should not be created",
          objectKey: "dummy_record",
          steps: [{ stepOrder: 1, name: "Step 1", approvers: [{ approverType: "role", roleId: viewOnlyRoleId }] }],
        })
      ).rejects.toThrow();
    });

    it("allows creating a template for a caller with workflow_template.manage.all", async () => {
      const template = await workflow.createTemplate(adminClaims, {
        key: `smoke-${Date.now()}`,
        name: "Smoke test template",
        objectKey: "dummy_record",
        steps: [{ stepOrder: 1, name: "Step 1", approvers: [{ approverType: "role", roleId: viewOnlyRoleId }] }],
      });
      expect(template.steps).toHaveLength(1);
    });
  });

  describe("the full 2-step approval chain with forced-timeout escalation", () => {
    let templateKey: string;

    beforeAll(async () => {
      templateKey = `two-step-${Date.now()}`;
      await workflow.createTemplate(adminClaims, {
        key: templateKey,
        name: "Two-step approval",
        objectKey: "dummy_record",
        steps: [
          {
            stepOrder: 1,
            name: "First approval",
            slaHours: 1,
            approvers: [
              {
                approverType: "role",
                roleId: viewOnlyRoleId,
                escalationApproverType: "specific_user",
                escalationUserAccountId: escalationTargetUserId,
              },
            ],
          },
          {
            stepOrder: 2,
            name: "Second approval",
            slaHours: 1,
            approvers: [
              {
                approverType: "role",
                roleId: selfServiceRoleId,
                escalationApproverType: "specific_user",
                escalationUserAccountId: escalationTargetUserId,
              },
            ],
          },
        ],
      });
    });

    it("starts in_progress with step 1 pending and step 2 not yet created", async () => {
      const recordId = await makeDummyRecord("locked");
      const instance = await workflow.submitForApproval(step1ApproverClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });
      expect(instance.status).toBe("in_progress");
      expect(instance.steps).toHaveLength(1);
      expect(instance.steps[0].status).toBe("pending");
      expect(instance.steps[0].approvals[0].status).toBe("pending");
    });

    it("rejects a decision from someone who isn't a resolved approver on the step", async () => {
      const recordId = await makeDummyRecord("locked");
      const instance = await workflow.submitForApproval(step1ApproverClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });
      const stepInstanceId = instance.steps[0].id;
      await expect(workflow.decide(outsiderClaims, stepInstanceId, { decision: "approved" })).rejects.toThrow();
    });

    it("advances to step 2 once step 1 is approved, then completes once step 2 is approved", async () => {
      const recordId = await makeDummyRecord("locked");
      const submitted = await workflow.submitForApproval(step1ApproverClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });

      const afterStep1 = await workflow.decide(step1ApproverClaims, submitted.steps[0].id, {
        decision: "approved",
        comment: "looks fine",
      });
      expect(afterStep1.status).toBe("in_progress");
      expect(afterStep1.steps).toHaveLength(2);
      expect(afterStep1.steps[0].status).toBe("approved");
      expect(afterStep1.steps[1].status).toBe("pending");

      const afterStep2 = await workflow.decide(step2ApproverClaims, afterStep1.steps[1].id, {
        decision: "approved",
      });
      expect(afterStep2.status).toBe("approved");
      expect(afterStep2.steps[1].status).toBe("approved");
    });

    it("fails the whole instance immediately on a rejection, without creating step 2", async () => {
      const recordId = await makeDummyRecord("locked");
      const submitted = await workflow.submitForApproval(step1ApproverClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });
      const afterRejection = await workflow.decide(step1ApproverClaims, submitted.steps[0].id, {
        decision: "rejected",
        comment: "not today",
      });
      expect(afterRejection.status).toBe("rejected");
      expect(afterRejection.steps).toHaveLength(1);
    });

    it("forces a timeout escalation: an overdue approval reassigns to the configured escalation target, who can then decide", async () => {
      const recordId = await makeDummyRecord("locked");
      const submitted = await workflow.submitForApproval(step1ApproverClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });
      const approvalId = submitted.steps[0].approvals[0].id;

      // Force the SLA into the past rather than waiting a real hour —
      // escalateOverdue() only looks at due_at, so backdating it
      // faithfully simulates "an hour has passed with no decision."
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query(`UPDATE workflow_step_approvals SET due_at = now() - interval '1 minute' WHERE id = $1`, [
          approvalId,
        ]);
      });

      const escalatedCount = await workflow.escalateOverdue();
      expect(escalatedCount).toBeGreaterThanOrEqual(1);

      const afterEscalation = await workflow.getInstance(step1ApproverClaims, submitted.id);
      expect(afterEscalation.steps[0].approvals[0].status).toBe("escalated");
      expect(afterEscalation.steps[0].approvals[0].escalatedToUserAccountId).toBe(escalationTargetUserId);

      // The original approver can no longer act once escalated in this
      // test's flow — but the escalation target can.
      const decided = await workflow.decide(escalationTargetClaims, submitted.steps[0].id, { decision: "approved" });
      expect(decided.steps[0].status).toBe("approved");
      expect(decided.steps[1].status).toBe("pending");
    });
  });

  describe("conditional steps", () => {
    it("skips a step whose condition doesn't match the submitted record snapshot", async () => {
      const templateKey = `conditional-${Date.now()}`;
      await workflow.createTemplate(adminClaims, {
        key: templateKey,
        name: "Conditional skip",
        objectKey: "dummy_record",
        steps: [
          {
            stepOrder: 1,
            name: "Only when unlocked",
            condition: { field: "status", equals: "unlocked" },
            approvers: [{ approverType: "role", roleId: viewOnlyRoleId }],
          },
        ],
      });

      const recordId = await makeDummyRecord("locked");
      const instance = await workflow.submitForApproval(step1ApproverClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });

      // No matching steps at all -> the whole instance completes immediately.
      expect(instance.status).toBe("approved");
      expect(instance.steps).toHaveLength(1);
      expect(instance.steps[0].status).toBe("skipped");
      expect(instance.steps[0].approvals).toHaveLength(0);
    });
  });

  /**
   * Phase 9's own addition to this engine (Decision #6's deferred
   * capability, now that Phase 7's employee/manager hierarchy exists to
   * route against) — see 0014_workflow_manager_of_submitter.sql. A fresh,
   * self-contained fixture company with real Employee Core rows, since
   * this needs a manager_id hierarchy the rest of this file's
   * `dummy_records`/rbac_demo fixtures have no reason to carry.
   */
  describe("manager_of_submitter routing (Phase 9)", () => {
    let momCompanyId: string;
    let managerEmployeeUserId: string;
    let staffEmployeeUserId: string;
    let noManagerEmployeeUserId: string;
    let staffClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let noManagerClaims: RequestClaims;
    let templateKey: string;

    beforeAll(async () => {
      const stamp = `${Date.now()}-mom`;
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
          `MoM Co ${stamp}`,
          `mom-co-${stamp}`,
        ]);
        momCompanyId = company.rows[0].id;
        await client.query(
          `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
           VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
          [momCompanyId]
        );
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)",
          [momCompanyId]
        );

        async function makeUser(email: string): Promise<string> {
          const account = await client.query(
            "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
            [email]
          );
          return account.rows[0].id;
        }
        managerEmployeeUserId = await makeUser(`mom-manager-${stamp}@example.com`);
        staffEmployeeUserId = await makeUser(`mom-staff-${stamp}@example.com`);
        noManagerEmployeeUserId = await makeUser(`mom-nomanager-${stamp}@example.com`);

        const manager = await client.query(
          `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name)
           VALUES ($1, $2, 'EMP-M1', 'Maya', 'Manager') RETURNING id`,
          [momCompanyId, managerEmployeeUserId]
        );
        await client.query(
          `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, manager_id)
           VALUES ($1, $2, 'EMP-S1', 'Sam', 'Staff', $3)`,
          [momCompanyId, staffEmployeeUserId, manager.rows[0].id]
        );
        // Deliberately no employees row at all for noManagerEmployeeUserId —
        // proves the "subject has no Employee record" unresolvable case.

        const role = await client.query("SELECT id FROM roles WHERE key = 'rbac_demo_full_access'");
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3), ($4, $2, $3)",
          [staffEmployeeUserId, momCompanyId, role.rows[0].id, noManagerEmployeeUserId]
        );
      });

      staffClaims = { is_platform_admin: false, company_id: momCompanyId, sub: staffEmployeeUserId };
      managerClaims = { is_platform_admin: false, company_id: momCompanyId, sub: managerEmployeeUserId };
      noManagerClaims = { is_platform_admin: false, company_id: momCompanyId, sub: noManagerEmployeeUserId };

      templateKey = `mom-${Date.now()}`;
      await workflow.createTemplate(staffClaims, {
        key: templateKey,
        name: "Manager approval",
        objectKey: "dummy_record",
        steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }],
      });
    });

    afterAll(async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [momCompanyId]));
    });

    async function makeMomRecord(): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          `INSERT INTO dummy_records (company_id, title, status) VALUES ($1, 'MoM test', 'locked') RETURNING id`,
          [momCompanyId]
        );
        return result.rows[0].id;
      });
    }

    it("resolves the approval to the submitter's actual manager, and only that manager can decide it", async () => {
      const recordId = await makeMomRecord();
      const instance = await workflow.submitForApproval(staffClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
      });
      const approval = instance.steps[0].approvals[0];
      expect(approval.approverType).toBe("manager_of_submitter");
      expect(approval.userAccountId).toBe(managerEmployeeUserId);

      // The submitter themselves is NOT the resolved approver — they
      // cannot decide their own manager-approval step.
      await expect(workflow.decide(staffClaims, instance.steps[0].id, { decision: "approved" })).rejects.toThrow();

      const decided = await workflow.decide(managerClaims, instance.steps[0].id, { decision: "approved" });
      expect(decided.status).toBe("approved");
    });

    it("resolves against the On-Behalf subject, not the caller who actually submitted", async () => {
      // noManagerClaims (an HR-equivalent caller with no Employee record
      // of their own — proven unable to resolve manager_of_submitter for
      // THEMSELVES in the test above) submits FOR Sam via
      // subjectUserAccountId — proving manager_of_submitter routes to
      // SAM's manager, the subject, not the caller's own (nonexistent) one.
      const recordId = await makeMomRecord();
      const instance = await workflow.submitForApproval(noManagerClaims, {
        templateKey,
        objectKey: "dummy_record",
        recordId,
        record: { status: "locked" },
        subjectUserAccountId: staffEmployeeUserId,
      });
      expect(instance.subjectUserAccountId).toBe(staffEmployeeUserId);
      expect(instance.steps[0].approvals[0].userAccountId).toBe(managerEmployeeUserId);
    });

    it("safe-denies (throws) rather than silently creating an unreachable approval when the subject has no manager", async () => {
      await expect(
        workflow.submitForApproval(noManagerClaims, {
          templateKey,
          objectKey: "dummy_record",
          recordId: await makeMomRecord(),
          record: { status: "locked" },
        })
      ).rejects.toThrow();
    });
  });
});
