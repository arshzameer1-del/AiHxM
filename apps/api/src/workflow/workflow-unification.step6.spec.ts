import { Pool } from "pg";
import { randomUUID } from "crypto";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "../employees/employees.service";
import { WorkflowService, type CreateTemplateInput } from "./workflow.service";
import { WorkflowAdapterRegistry, type WorkflowOutcomeEvent } from "./workflow-adapter.registry";
import { InboxService, slaState } from "./inbox.service";
import { DelegationsService } from "./delegations.service";
import { conditionMatches, validateCondition } from "./workflow-conditions";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "workflow-step6" };
const OBJ = "step6_object";

/** Gap Register WFL-02..07, ACC-06: versioned templates, richer decisions, approval modes, inbox, delegation. */
describe("Workflow unification (Step 6)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let registry: WorkflowAdapterRegistry;
  let workflow: WorkflowService;
  let inbox: InboxService;
  let delegations: DelegationsService;
  let employees: EmployeesService;
  let companyId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const users: Record<string, { id: string; claims: RequestClaims }> = {};
  const events: Array<{ event: WorkflowOutcomeEvent; recordId: string }> = [];

  const claimsOf = (id: string): RequestClaims => ({ is_platform_admin: false, company_id: companyId, sub: id });

  async function mkUser(name: string, roleKey?: string) {
    const id = await db.withClaims(FIXTURE, async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`wf6-${name}-${stamp}@example.com`]);
      if (roleKey) {
        const r = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, r.rows[0].id]);
      }
      return u.rows[0].id as string;
    });
    users[name] = { id, claims: claimsOf(id) };
    return id;
  }

  async function roleId(key: string) {
    return db.withClaims(FIXTURE, async (c) => (await c.query("SELECT id FROM roles WHERE key = $1", [key])).rows[0].id as string);
  }

  async function tpl(key: string, steps: CreateTemplateInput["steps"], extra: Partial<CreateTemplateInput> = {}) {
    return workflow.createTemplate(users.admin.claims, { key: `${key}-${stamp}`, name: key, objectKey: OBJ, steps, ...extra });
  }
  const tkey = (k: string) => `${k}-${stamp}`;
  const submit = (templateKey: string, as = "submitter", record: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    workflow.submitForApproval(users[as].claims, { templateKey: tkey(templateKey), objectKey: OBJ, recordId: randomUUID(), record, ...extra });
  const user = (name: string) => ({ approverType: "specific_user" as const, userAccountId: users[name].id });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const audit = new AuditService();
    registry = new WorkflowAdapterRegistry();
    workflow = new WorkflowService(db, rbac, audit, registry);
    inbox = new InboxService(db, rbac, audit, workflow, registry, new LocalFileStorageService());
    delegations = new DelegationsService(db, rbac, audit);
    employees = new EmployeesService(db, rbac, new EntitlementsService(db), audit, new LocalFileStorageService());

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`WF6 Co ${stamp}`, `wf6-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    });
    await mkUser("admin", "rbac_demo_full_access"); // workflow_template.manage.all
    await mkUser("hr", "hr_admin");
    for (const n of ["submitter", "a1", "a2", "a3", "outsider", "delegate"]) await mkUser(n, "employee_self_service");

    registry.register({
      objectKey: OBJ,
      label: "Step 6 object",
      canSendBack: true,
      onOutcome: async (ctx) => {
        events.push({ event: ctx.event, recordId: ctx.recordId });
      },
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ------------------------------------------------------------------ conditions (WFL-04)
  describe("conditions", () => {
    it("keeps {field, equals} and adds comparison operators and groups", () => {
      expect(conditionMatches({ field: "a", equals: 1 }, { a: 1 })).toBe(true);
      expect(conditionMatches({ field: "amount", op: "gte", value: 100000 }, { amount: 150000 })).toBe(true);
      expect(conditionMatches({ field: "amount", op: "gte", value: 100000 }, { amount: "99999" })).toBe(false);
      expect(conditionMatches({ field: "amount", op: "between", value: [10, 20] }, { amount: 20 })).toBe(true);
      expect(conditionMatches({ field: "t", op: "in", value: ["a", "b"] }, { t: "b" })).toBe(true);
      expect(conditionMatches({ field: "t", op: "not_in", value: ["a"] }, {})).toBe(true);
      expect(conditionMatches({ field: "x", op: "gt", value: 1 }, {})).toBe(false);
      expect(conditionMatches({ all: [{ field: "a", equals: 1 }, { any: [{ field: "b", op: "lt", value: 5 }, { field: "c", equals: true }] }] }, { a: 1, b: 9, c: true })).toBe(true);
    });

    it("rejects malformed conditions when a template is saved", async () => {
      expect(() => validateCondition({ field: "a", op: "nope", value: 1 })).toThrow(BadRequestException);
      expect(() => validateCondition({ field: "a", op: "between", value: [1] })).toThrow(BadRequestException);
      expect(() => validateCondition({ all: [] })).toThrow(BadRequestException);
      await expect(tpl("bad-cond", [{ stepOrder: 1, name: "s", condition: { field: "a", op: "zzz", value: 1 } as never, approvers: [user("a1")] }])).rejects.toThrow(BadRequestException);
    });

    it("amount-threshold routing adds an approval step only for large amounts", async () => {
      await tpl("amount", [
        { stepOrder: 1, name: "Manager", approvers: [user("a1")] },
        { stepOrder: 2, name: "Finance", condition: { field: "amount", op: "gte", value: 100000 }, approvers: [user("a2")] },
      ]);
      const small = await submit("amount", "submitter", { amount: 5000 });
      await workflow.decide(users.a1.claims, small.steps[0].id, { decision: "approved" });
      expect((await workflow.getInstance(users.submitter.claims, small.id)).status).toBe("approved");
      const large = await submit("amount", "submitter", { amount: 250000 });
      const afterFirst = await workflow.decide(users.a1.claims, large.steps[0].id, { decision: "approved" });
      expect(afterFirst.status).toBe("in_progress");
      expect(afterFirst.steps.find((s) => s.stepOrder === 2)!.status).toBe("pending");
    });
  });

  // ------------------------------------------------------------------ versioning (WFL-02)
  describe("template versions", () => {
    it("pins an instance to the version it was submitted under; editing the template does not change it", async () => {
      await tpl("versioned", [
        { stepOrder: 1, name: "One", approvers: [user("a1")] },
        { stepOrder: 2, name: "Two", approvers: [user("a2")] },
      ]);
      const inFlight = await submit("versioned");
      expect(inFlight.templateVersionNo).toBe(1);

      const updated = await workflow.updateTemplate(users.admin.claims, tkey("versioned"), {
        name: "versioned",
        steps: [{ stepOrder: 1, name: "Only", approvers: [user("a3")] }],
      });
      expect(updated.currentVersionNo).toBe(2);

      // the in-flight request still needs a1 then a2
      const afterA1 = await workflow.decide(users.a1.claims, inFlight.steps[0].id, { decision: "approved" });
      expect(afterA1.status).toBe("in_progress");
      const step2 = afterA1.steps.find((s) => s.stepOrder === 2)!;
      expect(step2.name).toBe("Two");
      await expect(workflow.decide(users.a3.claims, step2.id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      expect((await workflow.decide(users.a2.claims, step2.id, { decision: "approved" })).status).toBe("approved");

      // a new submission runs on v2
      const fresh = await submit("versioned");
      expect(fresh.templateVersionNo).toBe(2);
      expect(fresh.steps).toHaveLength(1);
      expect(fresh.steps[0].name).toBe("Only");

      const versions = await workflow.listTemplateVersions(users.admin.claims, tkey("versioned"));
      expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
      expect(versions[1].definition.steps).toHaveLength(2);
    });

    it("version rows are immutable and cannot be deleted by the app role", async () => {
      await expect(db.withClaims(FIXTURE, (c) => c.query("UPDATE workflow_template_versions SET content_hash = 'x' WHERE company_id = $1", [companyId]))).rejects.toThrow(/immutable|permission denied/);
      await expect(db.withClaims(claimsOf(users.admin.id), (c) => c.query("DELETE FROM workflow_template_versions WHERE company_id = $1", [companyId]))).rejects.toThrow(/permission denied/);
    });

    it("only a template manager can edit, and start conditions gate submission", async () => {
      await expect(workflow.updateTemplate(users.a1.claims, tkey("versioned"), { name: "x", steps: [{ stepOrder: 1, name: "s", approvers: [user("a1")] }] })).rejects.toThrow(ForbiddenException);
      await tpl("start-cond", [{ stepOrder: 1, name: "s", approvers: [user("a1")] }], { startCondition: { field: "kind", equals: "special" }, triggerEvent: "special_request" });
      await expect(submit("start-cond", "submitter", { kind: "ordinary" })).rejects.toThrow(/start condition/);
      await expect(submit("start-cond", "submitter", { kind: "special" })).resolves.toBeDefined();
      const key = await db.withClaims(users.submitter.claims, (c) => workflow.resolveTemplateKey(c, companyId, OBJ, { kind: "special" }, "special_request"));
      expect(key).toBe(tkey("start-cond"));
      const none = await db.withClaims(users.submitter.claims, (c) => workflow.resolveTemplateKey(c, companyId, "no_such_object", {}));
      expect(none).toBeNull();
    });

    it("validates parallel groups, quorum and referenced ids at save time", async () => {
      await expect(tpl("bad-quorum", [{ stepOrder: 1, name: "s", approvalMode: "quorum", quorumCount: 3, approvers: [user("a1"), user("a2")] }])).rejects.toThrow(/quorumCount/);
      await expect(tpl("bad-group", [
        { stepOrder: 1, name: "a", parallelGroup: "g", approvers: [user("a1")] },
        { stepOrder: 2, name: "b", approvers: [user("a1")] },
        { stepOrder: 3, name: "c", parallelGroup: "g", approvers: [user("a1")] },
      ])).rejects.toThrow(/adjacent/);
      await expect(tpl("bad-pos", [{ stepOrder: 1, name: "s", approvers: [{ approverType: "position", positionId: randomUUID() }] }])).rejects.toThrow(/position not found/);
    });
  });

  // ------------------------------------------------------------------ decisions (WFL-03)
  describe("send back, request information, delegate", () => {
    it("send back needs a comment, returns the request, and resubmit reopens the same step", async () => {
      events.length = 0;
      await tpl("sendback", [
        { stepOrder: 1, name: "One", approvers: [user("a1")] },
        { stepOrder: 2, name: "Two", approvers: [user("a2")] },
      ]);
      const inst = await submit("sendback");
      await expect(workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "send_back" })).rejects.toThrow(/comment/);
      const returned = await workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "send_back", comment: "Attach the invoice" });
      expect(returned.status).toBe("returned");
      expect(returned.steps[0].status).toBe("returned");
      expect(events.at(-1)).toMatchObject({ event: "returned", recordId: inst.recordId });

      await expect(workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(/not pending|already/);
      await expect(workflow.resubmit(users.a1.claims, inst.id)).rejects.toThrow(ForbiddenException);
      const again = await workflow.resubmit(users.submitter.claims, inst.id, { record: { fixed: true }, comment: "Invoice attached" });
      expect(again.status).toBe("in_progress");
      expect(events.at(-1)!.event).toBe("resubmitted");
      expect(again.steps[0].status).toBe("pending");
      expect(again.steps[0].approvals.filter((a) => a.status === "pending")).toHaveLength(1);
      await workflow.decide(users.a1.claims, again.steps[0].id, { decision: "approved" });
      const final = await workflow.getInstance(users.submitter.claims, inst.id);
      const s2 = final.steps.find((s) => s.stepOrder === 2)!;
      const done = await workflow.decide(users.a2.claims, s2.id, { decision: "approved" });
      expect(done.status).toBe("approved");
      expect(events.at(-1)!.event).toBe("approved");

      const comments = await workflow.listComments(users.submitter.claims, inst.id);
      expect(comments.map((c) => c.kind)).toEqual(expect.arrayContaining(["send_back", "resubmit"]));
    });

    it("request information puts the request on hold, pauses the SLA, and the submitter's answer resumes it", async () => {
      await tpl("reqinfo", [{ stepOrder: 1, name: "One", slaHours: 24, approvers: [user("a1")] }]);
      const inst = await submit("reqinfo");
      await expect(workflow.requestInfo(users.outsider.claims, inst.id, "why?")).rejects.toThrow(ForbiddenException);
      await expect(workflow.requestInfo(users.a1.claims, inst.id, " ")).rejects.toThrow(BadRequestException);
      const held = await workflow.requestInfo(users.a1.claims, inst.id, "What is the project code?");
      expect(held.status).toBe("on_hold");
      expect(held.holdReason).toMatch(/project code/);
      await expect(workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(/on hold/);

      // an overdue line on a held request is not escalated
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE workflow_step_approvals SET due_at = now() - interval '1 hour' WHERE step_instance_id = $1", [inst.steps[0].id]));
      await workflow.escalateOverdue();
      const stillPending = await db.withClaims(FIXTURE, (c) => c.query("SELECT status FROM workflow_step_approvals WHERE step_instance_id = $1", [inst.steps[0].id]));
      expect(stillPending.rows[0].status).toBe("pending");

      await expect(workflow.respondToInfo(users.a1.claims, inst.id, "it is X")).rejects.toThrow(ForbiddenException);
      const lineBefore = (await db.withClaims(FIXTURE, (c) => c.query("SELECT due_at FROM workflow_step_approvals WHERE step_instance_id = $1", [inst.steps[0].id]))).rows[0].due_at as Date;
      const resumed = await workflow.respondToInfo(users.submitter.claims, inst.id, "Project code is PRJ-7");
      expect(resumed.status).toBe("in_progress");
      expect(resumed.holdReason).toBeNull();
      const lineAfter = (await db.withClaims(FIXTURE, (c) => c.query("SELECT due_at FROM workflow_step_approvals WHERE step_instance_id = $1", [inst.steps[0].id]))).rows[0].due_at as Date;
      expect(new Date(lineAfter).getTime()).toBeGreaterThanOrEqual(new Date(lineBefore).getTime()); // the hold time was added back, never taken away
      expect(resumed.dueAt).not.toBeNull();
      expect((await workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).status).toBe("approved");
    });

    it("an approver can hand a line to someone else, who then alone may decide", async () => {
      await tpl("handover", [{ stepOrder: 1, name: "One", approvers: [user("a1")] }]);
      const inst = await submit("handover");
      await expect(workflow.delegateLine(users.a1.claims, inst.id, users.a1.id)).rejects.toThrow(BadRequestException);
      await expect(workflow.delegateLine(users.a1.claims, inst.id, users.submitter.id)).rejects.toThrow(/about/);
      await expect(workflow.delegateLine(users.outsider.claims, inst.id, users.delegate.id)).rejects.toThrow(ForbiddenException);
      await workflow.delegateLine(users.a1.claims, inst.id, users.delegate.id, "On leave");
      await expect(workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      const done = await workflow.decide(users.delegate.claims, inst.steps[0].id, { decision: "approved" });
      expect(done.status).toBe("approved");
      expect(done.steps[0].approvals[0].delegatedFromUserAccountId).toBe(users.a1.id);
    });

    it("rejection can require a comment; cancel is for the submitter and withdraws open lines", async () => {
      await tpl("rejcomment", [{ stepOrder: 1, name: "One", requireCommentOnReject: true, approvers: [user("a1")] }]);
      const inst = await submit("rejcomment");
      await expect(workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "rejected" })).rejects.toThrow(/comment is required/);
      await expect(workflow.cancel(users.outsider.claims, inst.id)).rejects.toThrow(ForbiddenException);
      events.length = 0;
      const cancelled = await workflow.cancel(users.submitter.claims, inst.id, "No longer needed");
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.steps[0].approvals[0].status).toBe("withdrawn");
      expect(events.at(-1)!.event).toBe("cancelled");
      await expect(workflow.cancel(users.submitter.claims, inst.id)).rejects.toThrow(ConflictException);
    });
  });

  // ------------------------------------------------------------------ approval modes + parallel (WFL-05)
  describe("approval modes and parallel groups", () => {
    it("'any' completes on the first approval and withdraws the other lines", async () => {
      await tpl("mode-any", [{ stepOrder: 1, name: "Any", approvalMode: "any", approvers: [user("a1"), user("a2")] }]);
      const inst = await submit("mode-any");
      const done = await workflow.decide(users.a2.claims, inst.steps[0].id, { decision: "approved" });
      expect(done.status).toBe("approved");
      expect(done.steps[0].approvals.map((a) => a.status).sort()).toEqual(["approved", "withdrawn"]);
    });

    it("'quorum' needs N approvals and rejects only when the quorum is out of reach", async () => {
      await tpl("mode-quorum", [{ stepOrder: 1, name: "Two of three", approvalMode: "quorum", quorumCount: 2, approvers: [user("a1"), user("a2"), user("a3")] }]);
      const ok = await submit("mode-quorum");
      const first = await workflow.decide(users.a1.claims, ok.steps[0].id, { decision: "approved" });
      expect(first.status).toBe("in_progress");
      expect((await workflow.decide(users.a3.claims, ok.steps[0].id, { decision: "approved" })).status).toBe("approved");

      const no = await submit("mode-quorum");
      const one = await workflow.decide(users.a1.claims, no.steps[0].id, { decision: "rejected" });
      expect(one.status).toBe("in_progress"); // 2 lines left can still make 2
      const two = await workflow.decide(users.a2.claims, no.steps[0].id, { decision: "rejected" });
      expect(two.status).toBe("rejected");
    });

    it("default 'all' needs every line, and one rejection rejects", async () => {
      await tpl("mode-all", [{ stepOrder: 1, name: "All", approvers: [user("a1"), user("a2")] }]);
      const inst = await submit("mode-all");
      expect((await workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).status).toBe("in_progress");
      const rej = await workflow.decide(users.a2.claims, inst.steps[0].id, { decision: "rejected" });
      expect(rej.status).toBe("rejected");
    });

    it("steps in a parallel group open together and the next stage waits for all of them", async () => {
      await tpl("parallel", [
        { stepOrder: 1, name: "Finance", parallelGroup: "review", approvers: [user("a1")] },
        { stepOrder: 2, name: "Legal", parallelGroup: "review", approvers: [user("a2")] },
        { stepOrder: 3, name: "Director", approvers: [user("a3")] },
      ]);
      const inst = await submit("parallel");
      expect(inst.steps.map((s) => s.status)).toEqual(["pending", "pending"]);
      const afterLegal = await workflow.decide(users.a2.claims, inst.steps[1].id, { decision: "approved" });
      expect(afterLegal.steps.find((s) => s.stepOrder === 3)).toBeUndefined();
      const afterFinance = await workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" });
      const director = afterFinance.steps.find((s) => s.stepOrder === 3)!;
      expect(director.status).toBe("pending");
      expect((await workflow.decide(users.a3.claims, director.id, { decision: "approved" })).status).toBe("approved");
    });

    it("a rejection in a parallel stage closes the sibling steps", async () => {
      await tpl("parallel-rej", [
        { stepOrder: 1, name: "A", parallelGroup: "g", approvers: [user("a1")] },
        { stepOrder: 2, name: "B", parallelGroup: "g", approvers: [user("a2")] },
      ]);
      const inst = await submit("parallel-rej");
      const rej = await workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "rejected" });
      expect(rej.status).toBe("rejected");
      expect(rej.steps.map((s) => s.status)).toEqual(["rejected", "skipped"]);
    });
  });

  // ------------------------------------------------------------------ approver types (WFL-04)
  describe("org-driven approver types", () => {
    let subjectUser: string;
    let headUser: string;
    let dottedUser: string;
    let positionId: string;
    let groupId: string;
    let groupMember: string;

    beforeAll(async () => {
      subjectUser = await mkUser("emp-subject", "employee_self_service");
      headUser = await mkUser("emp-head", "employee_self_service");
      dottedUser = await mkUser("emp-dotted", "employee_self_service");
      groupMember = await mkUser("emp-group", "employee_self_service");
      const hr = users.hr.claims;
      const subject = await employees.create(hr, { firstName: "Sub", lastName: "Ject" });
      const head = await employees.create(hr, { firstName: "Hea", lastName: "D" });
      const dotted = await employees.create(hr, { firstName: "Dot", lastName: "Ted" });
      const member = await employees.create(hr, { firstName: "Gro", lastName: "Up" });
      await db.withClaims(FIXTURE, async (c) => {
        await c.query("UPDATE employees SET user_account_id = $2 WHERE id = $1", [subject.id, subjectUser]);
        await c.query("UPDATE employees SET user_account_id = $2 WHERE id = $1", [head.id, headUser]);
        await c.query("UPDATE employees SET user_account_id = $2 WHERE id = $1", [dotted.id, dottedUser]);
        await c.query("UPDATE employees SET user_account_id = $2 WHERE id = $1", [member.id, groupMember]);

        const parent = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'division', 'Parent') RETURNING id", [companyId])).rows[0].id;
        const unit = (await c.query("INSERT INTO org_units (company_id, parent_id, unit_type, name) VALUES ($1, $2, 'department', 'Dept') RETURNING id", [companyId, parent])).rows[0].id;
        const headPos = (await c.query("INSERT INTO positions (company_id, org_unit_id, position_title, status) VALUES ($1, $2, 'Head of Dept', 'filled') RETURNING id", [companyId, unit])).rows[0].id;
        positionId = headPos;
        await c.query("UPDATE org_units SET head_position_id = $2 WHERE id = $1", [unit, headPos]);
        await c.query("INSERT INTO employee_org_assignments (company_id, employee_id, assignment_type, org_unit_id, position_id) VALUES ($1, $2, 'primary', $3, $4)", [companyId, head.id, unit, headPos]);
        await c.query("INSERT INTO employee_org_assignments (company_id, employee_id, assignment_type, org_unit_id) VALUES ($1, $2, 'primary', $3)", [companyId, subject.id, unit]);
        await c.query("INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type) VALUES ($1, $2, $3, 'dotted_line')", [companyId, subject.id, dotted.id]);

        groupId = (await c.query("INSERT INTO employee_groups (company_id, name) VALUES ($1, 'Approvers') RETURNING id", [companyId])).rows[0].id;
        await c.query("INSERT INTO employee_group_memberships (company_id, group_id, employee_id) VALUES ($1, $2, $3)", [companyId, groupId, member.id]);
      });
    });

    it("org_unit_head resolves to the occupant of the unit's head position", async () => {
      await tpl("t-head", [{ stepOrder: 1, name: "Head", approvers: [{ approverType: "org_unit_head" }] }]);
      const inst = await submit("t-head", "emp-subject");
      expect(inst.steps[0].approvals[0].userAccountId).toBe(headUser);
      await expect(workflow.decide(users["emp-subject"].claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      expect((await workflow.decide(users["emp-head"].claims, inst.steps[0].id, { decision: "approved" })).status).toBe("approved");
    });

    it("a unit head submitting their own request is routed to the parent unit instead (no head there -> safe-deny)", async () => {
      await tpl("t-head-self", [{ stepOrder: 1, name: "Head", approvers: [{ approverType: "org_unit_head" }] }]);
      await expect(submit("t-head-self", "emp-head")).rejects.toThrow(/no head/);
    });

    it("dotted_line_manager resolves through org_relationships", async () => {
      await tpl("t-dotted", [{ stepOrder: 1, name: "Dotted", approvers: [{ approverType: "dotted_line_manager" }] }]);
      const inst = await submit("t-dotted", "emp-subject");
      expect(inst.steps[0].approvals[0].userAccountId).toBe(dottedUser);
      await expect(submit("t-dotted", "submitter")).rejects.toThrow(/dotted-line/);
    });

    it("position resolves to whoever occupies it", async () => {
      await tpl("t-pos", [{ stepOrder: 1, name: "Pos", approvers: [{ approverType: "position", positionId }] }]);
      const inst = await submit("t-pos");
      expect(inst.steps[0].approvals[0].userAccountId).toBe(headUser);
    });

    it("group lets any current member act", async () => {
      await tpl("t-group", [{ stepOrder: 1, name: "Group", approvers: [{ approverType: "group", employeeGroupId: groupId }] }]);
      const inst = await submit("t-group");
      await expect(workflow.decide(users.outsider.claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      expect((await workflow.decide(users["emp-group"].claims, inst.steps[0].id, { decision: "approved" })).status).toBe("approved");
    });
  });

  // ------------------------------------------------------------------ delegation (ACC-06) + inbox (WFL-07)
  describe("My Inbox and standing delegation", () => {
    it("lists what waits on the caller with priority, due date and SLA state; counts agree", async () => {
      await tpl("inbox-a", [{ stepOrder: 1, name: "Review", slaHours: 48, approvers: [user("a1")] }]);
      const urgent = await submit("inbox-a", "submitter", {}, { priority: "urgent", title: "Urgent thing" });
      const normal = await submit("inbox-a", "submitter", {}, { title: "Normal thing" });
      const items = await inbox.list(users.a1.claims, { objectKey: OBJ });
      const ids = items.map((i) => i.instanceId);
      expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(normal.id)); // urgent first
      const u = items.find((i) => i.instanceId === urgent.id)!;
      expect(u).toMatchObject({ title: "Urgent thing", priority: "urgent", reason: "approver", objectLabel: "Step 6 object", stepName: "Review" });
      expect(u.dueAt).not.toBeNull();
      expect(u.slaState).toBe("on_track");
      expect(slaState(new Date(Date.now() - 1000))).toBe("overdue");
      expect(slaState(new Date(Date.now() + 3_600_000))).toBe("due_soon");
      expect(slaState(null)).toBe("none");

      expect((await inbox.list(users.outsider.claims, { objectKey: OBJ })).map((i) => i.instanceId)).not.toContain(urgent.id);
      const counts = await inbox.counts(users.a1.claims);
      expect(counts.toApprove).toBeGreaterThanOrEqual(2);
      const overdueOnly = await inbox.list(users.a1.claims, { overdueOnly: true });
      expect(overdueOnly.every((i) => i.slaState === "overdue")).toBe(true);
      expect((await inbox.list(users.a1.claims, { q: "urgent thing" })).map((i) => i.instanceId)).toEqual([urgent.id]);
    });

    it("decisions go through the inbox; send back returns the item to the submitter's inbox", async () => {
      await tpl("inbox-b", [{ stepOrder: 1, name: "Review", approvers: [user("a1")] }]);
      const inst = await submit("inbox-b");
      await expect(inbox.decide(users.outsider.claims, inst.id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      await inbox.decide(users.a1.claims, inst.id, { decision: "send_back", comment: "Fix the dates" });
      const mine = await inbox.list(users.submitter.claims, { tab: "returned" });
      expect(mine.find((i) => i.instanceId === inst.id)).toMatchObject({ reason: "submitter_returned", status: "returned" });
      const detail = await inbox.get(users.submitter.claims, inst.id);
      expect(detail.actions).toMatchObject({ canResubmit: true, canDecide: false, canCancel: true });
      await inbox.get(users.outsider.claims, inst.id).then(
        () => { throw new Error("should not be readable"); },
        (e) => expect(e).toBeInstanceOf(ForbiddenException)
      );
    });

    it("request-info and delegate also work through the inbox", async () => {
      await tpl("inbox-c", [{ stepOrder: 1, name: "Review", approvers: [user("a1")] }]);
      const inst = await submit("inbox-c");
      const held = await inbox.decide(users.a1.claims, inst.id, { decision: "request_info", comment: "Which cost center?" });
      expect(held.status).toBe("on_hold");
      expect((await inbox.list(users.submitter.claims, { tab: "waiting" })).some((i) => i.instanceId === inst.id)).toBe(true);
      await workflow.respondToInfo(users.submitter.claims, inst.id, "CC-100");
      await expect(inbox.decide(users.a1.claims, inst.id, { decision: "delegate" })).rejects.toThrow(BadRequestException);
      await inbox.decide(users.a1.claims, inst.id, { decision: "delegate", delegateToUserAccountId: users.delegate.id });
      expect((await inbox.list(users.delegate.claims, { objectKey: OBJ })).map((i) => i.instanceId)).toContain(inst.id);
      expect((await inbox.list(users.a1.claims, { objectKey: OBJ })).map((i) => i.instanceId)).not.toContain(inst.id);
    });

    it("a standing delegation lets the delegate act for the delegator, recorded as such, until revoked", async () => {
      await tpl("deleg", [{ stepOrder: 1, name: "Review", approvers: [user("a2")] }]);
      const before = await submit("deleg");
      await expect(workflow.decide(users.delegate.claims, before.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);

      await expect(delegations.create(users.a2.claims, { delegateUserAccountId: users.a2.id, validTo: "2099-01-01", reason: "x" })).rejects.toThrow(BadRequestException);
      await expect(delegations.create(users.a2.claims, { delegateUserAccountId: users.delegate.id, validTo: "2099-01-01", reason: " " })).rejects.toThrow(/reason/);
      await expect(delegations.create(users.a2.claims, { delegateUserAccountId: users.delegate.id, validTo: "2000-01-01", reason: "past" })).rejects.toThrow(BadRequestException);
      await expect(delegations.create(users.outsider.claims, { delegatorUserAccountId: users.a2.id, delegateUserAccountId: users.delegate.id, validTo: "2099-01-01", reason: "sneaky" })).rejects.toThrow(ForbiddenException);
      const d = await delegations.create(users.a2.claims, { delegateUserAccountId: users.delegate.id, validTo: "2099-01-01", reason: "Annual leave", scopeObjectKeys: ["something_else"] });
      // scoped to another object: no effect here
      await expect(workflow.decide(users.delegate.claims, before.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      await delegations.revoke(users.a2.claims, d.id);
      const d2 = await delegations.create(users.a2.claims, { delegateUserAccountId: users.delegate.id, validTo: "2099-01-01", reason: "Annual leave" });

      const listed = await inbox.list(users.delegate.claims, { objectKey: OBJ });
      expect(listed.find((i) => i.instanceId === before.id)).toMatchObject({ reason: "delegate", actingFor: users.a2.id });
      const done = await inbox.decide(users.delegate.claims, before.id, { decision: "approved", comment: "covering" });
      expect(done.status).toBe("approved");
      const line = done.steps[0].approvals[0];
      expect(line.decidedByUserAccountId).toBe(users.delegate.id);
      expect(line.delegatedFromUserAccountId).toBe(users.a2.id);

      // a delegate never approves a request about themselves
      const own = await submit("deleg", "delegate");
      await expect(workflow.decide(users.delegate.claims, own.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);

      await delegations.revoke(users.a2.claims, d2.id);
      await expect(delegations.revoke(users.a2.claims, d2.id)).rejects.toThrow(ConflictException);
      const after = await submit("deleg");
      await expect(workflow.decide(users.delegate.claims, after.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      expect((await delegations.list(users.a2.claims)).length).toBeGreaterThanOrEqual(2);
      await expect(delegations.list(users.a2.claims, { all: true })).rejects.toThrow(ForbiddenException);
      expect((await delegations.list(users.admin.claims, { all: true })).length).toBeGreaterThanOrEqual(2);
    });

    it("role approvers still work, honouring the role assignment's effective dates", async () => {
      const roleSelf = await roleId("employee_self_service");
      await tpl("by-role", [{ stepOrder: 1, name: "Role", approvers: [{ approverType: "role", roleId: roleSelf }] }]);
      const inst = await submit("by-role", "hr");
      expect(inst.steps[0].approvals[0].roleId).toBe(roleSelf);
      await db.withClaims(FIXTURE, (c) =>
        c.query("UPDATE user_role_assignments SET effective_to = CURRENT_DATE - 1 WHERE user_account_id = $1 AND company_id = $2", [users.a3.id, companyId])
      );
      await expect(workflow.decide(users.a3.claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      expect((await workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).status).toBe("approved");
    });
  });

  // ------------------------------------------------------------------ legacy adapters
  describe("adapters", () => {
    it("an adapter with legacyDecide receives inbox approvals; send back is refused for it", async () => {
      const calls: Array<{ recordId: string; decision: string }> = [];
      registry.register({
        objectKey: "legacy_object",
        label: "Legacy thing",
        legacyDecide: async (claims, recordId, dto) => {
          calls.push({ recordId, decision: dto.decision });
          const inst = await db.withClaims(claims, (c) => c.query("SELECT id FROM workflow_instances WHERE record_id = $1", [recordId]));
          const step = await db.withClaims(claims, (c) => c.query("SELECT id FROM workflow_step_instances WHERE workflow_instance_id = $1 AND status = 'pending'", [inst.rows[0].id]));
          return workflow.decide(claims, step.rows[0].id, dto);
        },
      });
      await workflow.createTemplate(users.admin.claims, { key: tkey("legacy"), name: "legacy", objectKey: "legacy_object", steps: [{ stepOrder: 1, name: "s", approvers: [user("a1")] }] });
      const inst = await workflow.submitForApproval(users.submitter.claims, { templateKey: tkey("legacy"), objectKey: "legacy_object", recordId: randomUUID(), record: {} });
      await expect(inbox.decide(users.a1.claims, inst.id, { decision: "send_back", comment: "no" })).rejects.toThrow(/cannot be sent back/);
      const done = await inbox.decide(users.a1.claims, inst.id, { decision: "approved" });
      expect(done.status).toBe("approved");
      expect(calls).toEqual([{ recordId: inst.recordId, decision: "approved" }]);
    });

    it("onOutcome runs inside the decision transaction: a failing domain effect rolls the decision back", async () => {
      registry.register({
        objectKey: "atomic_object",
        label: "Atomic",
        onOutcome: async () => {
          throw new Error("domain write failed");
        },
      });
      await workflow.createTemplate(users.admin.claims, { key: tkey("atomic"), name: "atomic", objectKey: "atomic_object", steps: [{ stepOrder: 1, name: "s", approvers: [user("a1")] }] });
      const inst = await workflow.submitForApproval(users.submitter.claims, { templateKey: tkey("atomic"), objectKey: "atomic_object", recordId: randomUUID(), record: {} });
      await expect(workflow.decide(users.a1.claims, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(/domain write failed/);
      const still = await workflow.getInstance(users.submitter.claims, inst.id);
      expect(still.status).toBe("in_progress");
      expect(still.steps[0].approvals[0].status).toBe("pending");
    });

    it("listTasks contributes non-approval work to the inbox", async () => {
      registry.register({
        objectKey: "task_object",
        label: "Task",
        listTasks: async (_c, claims) => [
          {
            instanceId: randomUUID(), stepInstanceId: null, objectKey: "task_object", objectLabel: "Task", recordId: randomUUID(),
            title: `Task for ${claims.sub}`, status: "in_progress", priority: "normal", stepName: null, submittedByUserAccountId: claims.sub,
            submittedAt: new Date().toISOString(), dueAt: null, slaState: "none", actingFor: null, reason: "task", canSendBack: false,
          },
        ],
      });
      const tasks = await inbox.list(users.a1.claims, { tab: "tasks" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toContain(users.a1.id);
    });
  });

  // ------------------------------------------------------------------ comments and attachments (WFL-06)
  describe("comments and attachments", () => {
    it("only participants read or write; approver-only notes are hidden from the submitter", async () => {
      await tpl("collab", [{ stepOrder: 1, name: "s", approvers: [user("a1")] }]);
      const inst = await submit("collab");
      await workflow.addComment(users.submitter.claims, inst.id, "Please hurry");
      await workflow.addComment(users.a1.claims, inst.id, "Internal: check the budget", "approvers");
      await expect(workflow.addComment(users.submitter.claims, inst.id, "sneaky", "approvers")).rejects.toThrow(ForbiddenException);
      await expect(workflow.addComment(users.outsider.claims, inst.id, "hello")).rejects.toThrow(ForbiddenException);
      await expect(workflow.addComment(users.a1.claims, inst.id, "  ")).rejects.toThrow(BadRequestException);

      const forSubmitter = await workflow.listComments(users.submitter.claims, inst.id);
      expect(forSubmitter.map((c) => c.body)).toEqual(["Please hurry"]);
      const forApprover = await workflow.listComments(users.a1.claims, inst.id);
      expect(forApprover.map((c) => c.body)).toEqual(["Please hurry", "Internal: check the budget"]);
      await expect(workflow.listComments(users.outsider.claims, inst.id)).rejects.toThrow(ForbiddenException);
    });

    it("attachments are stored, type- and size-checked, and visibility-scoped", async () => {
      await tpl("attach", [{ stepOrder: 1, name: "s", approvers: [user("a1")] }]);
      const inst = await submit("attach");
      const file = (name: string, mime: string, size = 12) => ({ originalname: name, mimetype: mime, size, buffer: Buffer.alloc(size, 1) });
      const att = await inbox.addAttachment(users.submitter.claims, inst.id, file("invoice.pdf", "application/pdf"));
      await expect(inbox.addAttachment(users.submitter.claims, inst.id, file("evil.exe", "application/x-msdownload"))).rejects.toThrow(/not allowed/);
      await expect(inbox.addAttachment(users.submitter.claims, inst.id, file("big.pdf", "application/pdf", 11 * 1024 * 1024))).rejects.toThrow(/limit/);
      await expect(inbox.addAttachment(users.outsider.claims, inst.id, file("x.pdf", "application/pdf"))).rejects.toThrow(ForbiddenException);
      const secret = await inbox.addAttachment(users.a1.claims, inst.id, file("review.pdf", "application/pdf"), "approvers");

      const asSubmitter = await inbox.listAttachments(users.submitter.claims, inst.id);
      expect(asSubmitter.map((a) => a.id)).toEqual([att.id]);
      await expect(inbox.downloadAttachment(users.submitter.claims, inst.id, secret.id)).rejects.toThrow(ForbiddenException);
      const dl = await inbox.downloadAttachment(users.a1.claims, inst.id, att.id);
      expect(dl.fileName).toBe("invoice.pdf");
      expect(dl.buffer.byteLength).toBe(12);
    });
  });

  // ------------------------------------------------------------------ SLA sweeps (WFL-05/07)
  describe("reminders and due dates", () => {
    it("records a reminder once the interval passes and keeps due_at at the earliest open deadline", async () => {
      await tpl("remind", [{ stepOrder: 1, name: "s", slaHours: 72, reminderHours: 2, approvers: [user("a1")] }]);
      const inst = await submit("remind");
      expect(new Date(inst.dueAt!).getTime()).toBeGreaterThan(Date.now() + 70 * 3_600_000);
      expect(await workflow.remindDue()).toBeGreaterThanOrEqual(0);
      const beforeCount = (await db.withClaims(FIXTURE, (c) => c.query("SELECT count(*)::int AS n FROM workflow_comments WHERE workflow_instance_id = $1 AND kind = 'reminder'", [inst.id]))).rows[0].n;
      expect(beforeCount).toBe(0);
      await db.withClaims(FIXTURE, (c) => c.query("UPDATE workflow_step_approvals SET created_at = now() - interval '3 hours' WHERE step_instance_id = $1", [inst.steps[0].id]));
      await workflow.remindDue();
      const after = (await db.withClaims(FIXTURE, (c) => c.query("SELECT count(*)::int AS n FROM workflow_comments WHERE workflow_instance_id = $1 AND kind = 'reminder'", [inst.id]))).rows[0].n;
      expect(after).toBe(1);
      await workflow.remindDue(); // not again until another interval has passed
      const again = (await db.withClaims(FIXTURE, (c) => c.query("SELECT count(*)::int AS n FROM workflow_comments WHERE workflow_instance_id = $1 AND kind = 'reminder'", [inst.id]))).rows[0].n;
      expect(again).toBe(1);
    });

    it("an explicit dueAt wins over step SLAs", async () => {
      await tpl("explicit-due", [{ stepOrder: 1, name: "s", slaHours: 1, approvers: [user("a1")] }]);
      const due = new Date(Date.now() + 10 * 86_400_000).toISOString();
      const inst = await submit("explicit-due", "submitter", {}, { dueAt: due });
      expect(new Date(inst.dueAt!).toISOString()).toBe(due);
    });
  });
});
