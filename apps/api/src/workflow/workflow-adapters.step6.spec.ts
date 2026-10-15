import { Pool } from "pg";
import { ConflictException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "../employees/employees.service";
import { AttendanceCorrectionsService } from "../leave/attendance-corrections.service";
import { OnDutyService } from "../leave/on-duty.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { OvertimeService } from "../leave/overtime.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { WorkflowService } from "./workflow.service";
import { WorkflowAdapterRegistry } from "./workflow-adapter.registry";
import { InboxService } from "./inbox.service";
import { OnboardingService } from "../onboarding-offboarding/onboarding.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "workflow-adapters-step6" };

/** Gap Register WFL-01: modules route through the engine when a template is active; My Inbox is the single approval center. */
describe("Workflow adapters (Step 6, WFL-01)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let inbox: InboxService;
  let corrections: AttendanceCorrectionsService;
  let onDuty: OnDutyService;
  let onboarding: OnboardingService;
  let companyId: string;
  let staffEmployeeId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const claimsOf = (id: string): RequestClaims => ({ is_platform_admin: false, company_id: companyId, sub: id });
  let admin: RequestClaims, hr: RequestClaims, staff: RequestClaims, approver: RequestClaims;
  let approverId: string;

  async function mkUser(name: string, roleKey: string): Promise<string> {
    return db.withClaims(FIXTURE, async (c) => {
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`wfa6-${name}-${stamp}@example.com`]);
      const r = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, r.rows[0].id]);
      return u.rows[0].id as string;
    });
  }
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) =>
    db.withClaims(FIXTURE, async (c) => (await c.query(q, p)).rows as T[]);

  async function activateTemplate(objectKey: string, steps = 1) {
    await workflow.createTemplate(admin, {
      key: `${objectKey}-${stamp}`,
      name: objectKey,
      objectKey,
      steps: Array.from({ length: steps }, (_, i) => ({ stepOrder: i + 1, name: `Step ${i + 1}`, approvers: [{ approverType: "specific_user" as const, userAccountId: approverId }] })),
    });
  }
  async function deactivate(objectKey: string) {
    await workflow.setTemplateActive(admin, `${objectKey}-${stamp}`, false);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    const registry = new WorkflowAdapterRegistry();
    workflow = new WorkflowService(db, rbac, audit, registry);
    inbox = new InboxService(db, rbac, audit, workflow, registry, new LocalFileStorageService());
    corrections = new AttendanceCorrectionsService(db, rbac, entitlements, audit, workflow);
    onDuty = new OnDutyService(db, rbac, entitlements, audit, workflow);
    // constructing the services registers their adapters on the shared workflow registry
    new OvertimeService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), undefined as unknown as WorkScheduleResolutionService, workflow);
    onboarding = new OnboardingService(db, rbac, entitlements, audit, workflow);
    const employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());

    companyId = await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`WFA6 Co ${stamp}`, `wfa6-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee","leave","recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true), ($1, 'recruitment', true)",
        [co.rows[0].id]
      );
      return co.rows[0].id as string;
    });
    admin = claimsOf(await mkUser("admin", "rbac_demo_full_access"));
    hr = claimsOf(await mkUser("hr", "hr_admin"));
    const managerId = await mkUser("mgr", "line_manager");
    const staffId = await mkUser("staff", "employee_self_service");
    staff = claimsOf(staffId);
    approverId = await mkUser("approver", "employee_self_service");
    approver = claimsOf(approverId);

    const mgrEmp = await employees.create(hr, { firstName: "Maya", lastName: "Manager", userAccountId: managerId });
    const staffEmp = await employees.create(hr, { firstName: "Sam", lastName: "Staff", managerId: mgrEmp.id, userAccountId: staffId });
    staffEmployeeId = staffEmp.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("attendance corrections", () => {
    const submitCorrection = (date: string, extra: Record<string, unknown> = {}) =>
      corrections.submit(staff, { employeeId: staffEmployeeId, requestedDate: date, requestedClockIn: `${date}T09:00:00.000Z`, requestedClockOut: `${date}T17:00:00.000Z`, reason: "Forgot", ...extra });

    it("keeps the direct manager/HR path when no template is active", async () => {
      const req = await submitCorrection("2026-03-02");
      const [row] = await sql<{ workflow_instance_id: string | null }>("SELECT workflow_instance_id FROM attendance_correction_requests WHERE id = $1", [req.id]);
      expect(row.workflow_instance_id).toBeNull();
      const decided = await corrections.decide(hr, req.id, { decision: "approved" });
      expect(decided.status).toBe("approved");
    });

    it("routes through the engine once a template is active: approval creates the attendance record in the same transaction", async () => {
      await activateTemplate("attendance_correction");
      const req = await submitCorrection("2026-03-03");
      expect(req.status).toBe("pending");
      const [row] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM attendance_correction_requests WHERE id = $1", [req.id]);
      expect(row.workflow_instance_id).not.toBeNull();

      // it is in the approver's inbox, not in the legacy decider queue
      expect((await corrections.listPendingForDecider(hr)).map((r) => r.id)).not.toContain(req.id);
      const items = await inbox.list(approver, {});
      const item = items.find((i) => i.recordId === req.id);
      expect(item?.objectKey).toBe("attendance_correction");
      expect(item?.title).toMatch(/Sam Staff/);

      // HR (not a configured approver) cannot decide it
      await expect(corrections.decide(hr, req.id, { decision: "approved" })).rejects.toThrow(/not an approver/);
      const approved = await corrections.decide(approver, req.id, { decision: "approved" });
      expect(approved.status).toBe("approved");
      expect(approved.attendanceRecordId).not.toBeNull();
      const [rec] = await sql<{ clock_in_at: Date }>("SELECT clock_in_at FROM attendance_records WHERE id = $1", [approved.attendanceRecordId]);
      expect(new Date(rec.clock_in_at).toISOString()).toBe("2026-03-03T09:00:00.000Z");
      await expect(corrections.decide(approver, req.id, { decision: "approved" })).rejects.toThrow(ConflictException);
    });

    it("send back -> returned, resubmit -> pending again, withdraw -> cancelled; rejection stays rejected", async () => {
      const req = await submitCorrection("2026-03-04");
      const [{ workflow_instance_id: instanceId }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM attendance_correction_requests WHERE id = $1", [req.id]);
      await inbox.decide(approver, instanceId, { decision: "send_back", comment: "Please add the reason in detail" });
      expect((await sql<{ status: string }>("SELECT status FROM attendance_correction_requests WHERE id = $1", [req.id]))[0].status).toBe("returned");
      await workflow.resubmit(staff, instanceId, { comment: "Added detail" });
      expect((await sql<{ status: string }>("SELECT status FROM attendance_correction_requests WHERE id = $1", [req.id]))[0].status).toBe("pending");
      await workflow.cancel(staff, instanceId, "no longer needed");
      expect((await sql<{ status: string }>("SELECT status FROM attendance_correction_requests WHERE id = $1", [req.id]))[0].status).toBe("cancelled");

      const rejected = await submitCorrection("2026-03-05");
      await expect(corrections.decide(approver, rejected.id, { decision: "rejected", comment: "x" })).resolves.toMatchObject({ status: "rejected" });
    });

    it("a failing in-transaction effect rolls the whole decision back", async () => {
      // an existing record whose clock-out is before the requested clock-in: the approval must 409 and leave the request pending
      const [rec] = await sql<{ id: string }>(
        `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
         SELECT $1, e.id, e.employee_number, 'manual', '2026-03-06T09:00:00Z', '2026-03-06T10:00:00Z' FROM employees e WHERE e.id = $2 RETURNING id`,
        [companyId, staffEmployeeId]
      );
      const req = await corrections.submit(staff, { employeeId: staffEmployeeId, attendanceRecordId: rec.id, requestedDate: "2026-03-06", requestedClockIn: "2026-03-06T12:00:00.000Z", reason: "bad" });
      await expect(corrections.decide(approver, req.id, { decision: "approved" })).rejects.toThrow(ConflictException);
      expect((await sql<{ status: string }>("SELECT status FROM attendance_correction_requests WHERE id = $1", [req.id]))[0].status).toBe("pending");
      const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM attendance_correction_requests WHERE id = $1", [req.id]);
      expect((await sql<{ status: string }>("SELECT status FROM workflow_instances WHERE id = $1", [iid]))[0].status).toBe("in_progress");
    });

    afterAll(() => deactivate("attendance_correction"));
  });

  describe("on-duty requests", () => {
    it("are approved through the engine and stay direct without a template", async () => {
      const direct = await onDuty.submit(staff, { employeeId: staffEmployeeId, startDate: "2026-04-01", endDate: "2026-04-02", location: "Client site" });
      expect((await sql("SELECT workflow_instance_id FROM on_duty_requests WHERE id = $1", [direct.id]))[0]).toMatchObject({ workflow_instance_id: null });

      await activateTemplate("on_duty_request");
      const routed = await onDuty.submit(staff, { employeeId: staffEmployeeId, startDate: "2026-04-10", endDate: "2026-04-11", location: "Branch" });
      expect((await sql<{ workflow_instance_id: string | null }>("SELECT workflow_instance_id FROM on_duty_requests WHERE id = $1", [routed.id]))[0].workflow_instance_id).not.toBeNull();
      expect((await inbox.list(approver, {})).some((i) => i.recordId === routed.id && i.objectLabel === "On-duty request")).toBe(true);
      const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM on_duty_requests WHERE id = $1", [routed.id]);
      await inbox.decide(approver, iid, { decision: "approved" });
      const [after] = await sql<{ status: string; decided_by_user_account_id: string }>("SELECT status, decided_by_user_account_id FROM on_duty_requests WHERE id = $1", [routed.id]);
      expect(after.status).toBe("approved");
      expect(after.decided_by_user_account_id).toBe(approver.sub);
      await deactivate("on_duty_request");
    });
  });

  describe("overtime claims", () => {
    it("the engine's approval prices and approves the claim inside the decision transaction", async () => {
      await activateTemplate("overtime_claim");
      const [ot] = await sql<{ id: string }>(
        `INSERT INTO overtime_records (company_id, employee_id, work_date, scheduled_minutes, actual_minutes, overtime_minutes, day_type, rate_multiplier, submitted_by_user_account_id)
         VALUES ($1, $2, '2026-05-04', 480, 600, 120, 'weekday', 1.5, $3) RETURNING id`,
        [companyId, staffEmployeeId, staff.sub]
      );
      const instance = await db.withClaims(staff, async (c) => {
        const inst = await workflow.submitForApprovalInTx(c, staff, { templateKey: `overtime_claim-${stamp}`, objectKey: "overtime_claim", recordId: ot.id, record: { overtimeMinutes: 120 }, subjectUserAccountId: staff.sub });
        await c.query("UPDATE overtime_records SET workflow_instance_id = $2 WHERE id = $1", [ot.id, inst.id]);
        return inst;
      });
      await inbox.decide(approver, instance.id, { decision: "approved", comment: "ok" });
      const [row] = await sql<{ status: string; decision_comment: string; decided_by_user_account_id: string }>("SELECT status, decision_comment, decided_by_user_account_id FROM overtime_records WHERE id = $1", [ot.id]);
      expect(row.status).toBe("approved");
      expect(row.decision_comment).toBe("ok");
      expect(row.decided_by_user_account_id).toBe(approver.sub);
      const [audit] = await sql<{ n: string }>("SELECT count(*) n FROM audit_log WHERE action = 'overtime.approved' AND target = $1", [ot.id]);
      expect(Number(audit.n)).toBe(1);
      await deactivate("overtime_claim");
    });
  });

  describe("module-owned requests (legacy decide) in My Inbox", () => {
    it("a data subject request is decided from My Inbox through the module's own decide, and by step id", async () => {
      const { DataSubjectRequestsService } = await import("../data-subject-requests/data-subject-requests.service");
      const rbac = new RbacService(db);
      const dsr = new DataSubjectRequestsService(db, rbac, new EntitlementsService(db), new AuditService(), workflow);
      expect(workflow.adapters.get("data_subject_request")?.legacyDecide).toBeDefined();
      await workflow.createTemplate(admin, {
        key: "data_subject_request",
        name: "DSR",
        objectKey: "data_subject_request",
        steps: [{ stepOrder: 1, name: "DPO", approvers: [{ approverType: "specific_user", userAccountId: approverId }] }],
      });
      const created = await dsr.submit(staff, { employeeId: staffEmployeeId, requestType: "access", description: "Please send my data" });
      const [{ workflow_instance_id: iid }] = await sql<{ workflow_instance_id: string }>("SELECT workflow_instance_id FROM data_subject_requests WHERE id = $1", [created.id]);
      const detail = await inbox.get(approver, iid);
      const step = detail.instance.steps.find((st) => st.status === "pending")!;
      await inbox.decideStep(approver, step.id, { decision: "approved", comment: "granted" });
      expect((await sql<{ status: string }>("SELECT status FROM data_subject_requests WHERE id = $1", [created.id]))[0].status).toBe("approved");
    });
  });

  describe("onboarding tasks in My Inbox", () => {
    it("lists a person's open onboarding items as tasks", async () => {
      const onb = await sql<{ id: string }>(
        `INSERT INTO employee_onboarding (company_id, employee_id, status) VALUES ($1, $2, 'in_progress') RETURNING id`,
        [companyId, staffEmployeeId]
      );
      await sql(
        `INSERT INTO employee_onboarding_items (onboarding_id, company_id, title, category, responsible_role, assigned_to_user_account_id, assigned_at, due_date)
         VALUES ($1, $2, 'Collect laptop', 'it', 'self', $3, now(), CURRENT_DATE + 3)`,
        [onb[0].id, companyId, staff.sub]
      );
      const items = await inbox.list(staff, {});
      const task = items.find((i) => i.objectKey === "onboarding_item");
      expect(task?.title).toBe("Collect laptop");
      expect(task?.reason).toBe("task");
      expect(task?.dueAt).not.toBeNull();
      expect((await inbox.list(approver, {})).some((i) => i.objectKey === "onboarding_item")).toBe(false);
      void onboarding;
    });
  });

  it("a hire cancelled while awaiting approval closes its workflow instance without firing an outcome", async () => {
    await activateTemplate("withdraw_probe");
    const recordId = "00000000-0000-4000-8000-0000000000a1";
    const inst = await workflow.submitForApproval(staff, { templateKey: `withdraw_probe-${stamp}`, objectKey: "withdraw_probe", recordId, record: {} });
    await db.withClaims(staff, (c) => workflow.withdrawInstanceInTx(c, staff, inst.id, "record cancelled"));
    expect((await workflow.getInstance(staff, inst.id)).status).toBe("cancelled");
    // idempotent
    await db.withClaims(staff, (c) => workflow.withdrawInstanceInTx(c, staff, inst.id, "again"));
    expect((await inbox.list(approver, {})).some((i) => i.instanceId === inst.id)).toBe(false);
  });
});
