import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { WorkflowService } from "../workflow/workflow.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { LeaveRequestsService } from "./leave-requests.service";
import { AttendanceService } from "./attendance.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { HolidaysService } from "../holidays/holidays.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { RulesEngine } from "../rules-engine/rules-engine.engine";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "leave-spec-fixtures" };

/**
 * Phase 9's own exit criterion (plan doc Section 7 — "the real go/no-go
 * checkpoint"), proven the same way every prior phase's was: real
 * Postgres, no mocks, real HTTP-shaped claims. One tenant, a real
 * manager/staff Employee Core hierarchy (Phase 7), a real employee-group
 * leave policy (Phase 8), and a real tenant-configured `manager_of_submitter`
 * workflow template (Phase 6/9) all wired together end to end: policy
 * resolution -> balance seeding -> submission -> manager approval ->
 * balance decrement, plus overlap notices, On-Behalf submission, and
 * attendance clock-in/out.
 */
describe("LeaveRequestsService LV-UP: edit, approvals, team calendar", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let groups: EmployeeGroupsService;
  let workflow: WorkflowService;
  let leaveRequests: LeaveRequestsService;
  let attendance: AttendanceService;
  let holidays: HolidaysService;
  let shiftsService: ShiftsService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let teammateClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let otherCompanyId: string;
  let otherHrClaims: RequestClaims;
  let otherStaffClaims: RequestClaims;
  let otherStaffEmployeeId: string;

  let managerEmployeeId: string;
  let managerUserId: string;
  let staffEmployeeId: string;
  let staffUserId: string;
  let teammateEmployeeId: string;
  let teammateUserId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    groups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    workflow = new WorkflowService(db, rbac, audit);
    holidays = new HolidaysService(db, rbac, entitlements, audit);
    shiftsService = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    const workSchedule = new WorkScheduleResolutionService(db, shiftsService, holidays);
    leaveRequests = new LeaveRequestsService(db, rbac, entitlements, audit, groups, workflow, workSchedule);
    attendance = new AttendanceService(db, rbac, entitlements, audit, workSchedule);

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Leave Spec Co ${stamp}`,
        `leave-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true)",
        [id]
      );
      return id;
    });

    async function makeUser(email: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
          email,
        ]);
        return result.rows[0].id as string;
      });
    }
    async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      });
    }

    const hrAdminUserId = await makeUser(`leave-hr-${stamp}@example.com`);
    // Also holds rbac_demo_full_access (workflow_template.manage.all) so
    // this same fixture user can both configure the tenant's leave
    // approval workflow AND submit/manage leave requests — a real tenant
    // would likely split "IT/workflow admin" from "HR Admin," but nothing
    // stops one person from holding both in a small SMB, and combining
    // them here avoids a fourth throwaway fixture user for a permission
    // this spec doesn't otherwise need to isolate.
    await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    managerUserId = await makeUser(`leave-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    staffUserId = await makeUser(`leave-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    teammateUserId = await makeUser(`leave-teammate-${stamp}@example.com`);
    await assignRole(teammateUserId, "employee_self_service");
    teammateClaims = { is_platform_admin: false, company_id: companyId, sub: teammateUserId };

    const outsiderUserId = await makeUser(`leave-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    managerEmployeeId = (
      await employees.create(hrAdminClaims, {
        firstName: "Maya",
        lastName: "Manager",
        department: "Engineering",
        userAccountId: managerUserId,
      })
    ).id;
    staffEmployeeId = (
      await employees.create(hrAdminClaims, {
        firstName: "Sam",
        lastName: "Staff",
        department: "Engineering",
        managerId: managerEmployeeId,
        userAccountId: staffUserId,
      })
    ).id;
    teammateEmployeeId = (
      await employees.create(hrAdminClaims, {
        firstName: "Tina",
        lastName: "Teammate",
        department: "Engineering",
        managerId: managerEmployeeId,
        userAccountId: teammateUserId,
      })
    ).id;

    // A tenant-wide default leave policy (Phase 8) — the safe-deny
    // fallback every employee here resolves to, since no employee group
    // is configured in this spec (that combination is Phase 8's own exit
    // criterion, already proven in employee-groups.service.spec.ts).
    await groups.createLeavePolicy(hrAdminClaims, {
      name: "Default Policy",
      annualLeaveDays: 14,
      casualLeaveDays: 10,
      sickLeaveDays: 8,
      isDefault: true,
    });

    // The tenant-configured approval workflow this phase's own exit
    // criterion asks for: a single manager_of_submitter step, routing
    // every leave request to the submitter's actual manager.
    await workflow.createTemplate(hrAdminClaims, {
      key: "leave_request",
      name: "Leave Approval",
      objectKey: "leave_request",
      steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }],
    });
  
    // A second, unrelated tenant: nothing it owns may ever show up for the first one.
    otherCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`Leave Other Co ${stamp}`, `leave-other-${stamp}`]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true)", [id]);
      return id;
    });
    const otherHrUserId = await makeUser(`leave-other-hr-${stamp}@example.com`);
    const otherStaffUserId = await makeUser(`leave-other-staff-${stamp}@example.com`);
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      for (const [user, key] of [[otherHrUserId, "hr_admin"], [otherHrUserId, "rbac_demo_full_access"], [otherStaffUserId, "employee_self_service"]] as const) {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [key]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [user, otherCompanyId, role.rows[0].id]);
      }
    });
    otherHrClaims = { is_platform_admin: false, company_id: otherCompanyId, sub: otherHrUserId };
    otherStaffClaims = { is_platform_admin: false, company_id: otherCompanyId, sub: otherStaffUserId };
    otherStaffEmployeeId = (await employees.create(otherHrClaims, { firstName: "Olga", lastName: "Other", department: "Sales", userAccountId: otherStaffUserId })).id;
    await groups.createLeavePolicy(otherHrClaims, { name: "Other Default", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true });
    await workflow.createTemplate(otherHrClaims, {
      key: "leave_request",
      name: "Leave Approval",
      objectKey: "leave_request",
      steps: [{ stepOrder: 1, name: "HR approves", approvers: [{ approverType: "specific_user", userAccountId: otherHrUserId }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]));
    await pool.end();
  });


  async function submitFor(claims: RequestClaims, employeeId: string, startDate: string, endDate: string, extra: Record<string, unknown> = {}) {
    return (await leaveRequests.submit(claims, { employeeId, leaveType: "annual", startDate, endDate, ...extra })).request;
  }

  describe("list / get views", () => {
    it("carry the employee, the relief person, calendar days and the approval chain", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-03-01", "2027-03-03", { delegateEmployeeId: teammateEmployeeId });
      const view = await leaveRequests.getRequest(staffClaims, created.id);
      expect(view.employeeName).toBe("Sam Staff");
      expect(view.employeeNumber).toMatch(/^EMP/);
      expect(view.leaveTypeName).toBe("Annual leave");
      expect(view.delegateEmployeeName).toBe("Tina Teammate");
      expect(view.absenceDays).toBe(3);
      expect(view.approvals).toEqual([
        expect.objectContaining({ stepOrder: 1, stepName: "Manager approves", approverName: "Maya Manager", status: "pending", decidedAt: null }),
      ]);
      const listed = (await leaveRequests.listRequests(staffClaims)).find((r) => r.id === created.id);
      expect(listed?.approvals?.[0]?.approverName).toBe("Maya Manager");
      expect(listed?.employeeName).toBe("Sam Staff");
    });

    it("shows a decided line as approved with its decision time", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-03-08", "2027-03-08");
      await leaveRequests.decide(managerClaims, created.id, { decision: "approved" });
      const view = await leaveRequests.getRequest(staffClaims, created.id);
      expect(view.status).toBe("approved");
      expect(view.approvals?.[0]).toEqual(expect.objectContaining({ status: "approved", approverName: "Maya Manager" }));
      expect(view.approvals?.[0]?.decidedAt).toEqual(expect.any(String));
    });
  });

  describe("update()", () => {
    it("lets the owner change a pending request; days are recounted and the workflow instance is kept", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-04-05", "2027-04-06");
      expect(created.daysRequested).toBe(2);
      const { request } = await leaveRequests.update(staffClaims, created.id, { endDate: "2027-04-08", reason: "Family trip", delegateEmployeeId: teammateEmployeeId });
      expect(request.status).toBe("pending");
      expect(request.endDate).toBe("2027-04-08");
      expect(request.daysRequested).toBe(4);
      expect(request.reason).toBe("Family trip");
      expect(request.delegateEmployeeId).toBe(teammateEmployeeId);
      expect(request.workflowInstanceId).toBe(created.workflowInstanceId);
      expect(request.returnDate).toBe("2027-04-09");
    });

    it("clears the relief person with null and leaves untouched fields alone", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-04-12", "2027-04-12", { delegateEmployeeId: teammateEmployeeId, reason: "Dentist" });
      const { request } = await leaveRequests.update(staffClaims, created.id, { delegateEmployeeId: null });
      expect(request.delegateEmployeeId).toBeNull();
      expect(request.reason).toBe("Dentist");
      expect(request.startDate).toBe("2027-04-12");
    });

    it("turns a full day into a half day and back", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-04-14", "2027-04-14");
      const half = await leaveRequests.update(staffClaims, created.id, { dayPart: "first_half" });
      expect(half.request.daysRequested).toBe(0.5);
      expect(half.request.returnDate).toBe("2027-04-14");
      const full = await leaveRequests.update(staffClaims, created.id, { dayPart: "full" });
      expect(full.request.daysRequested).toBe(1);
    });

    it("does not clash with its own row, but does clash with another of the employee's requests", async () => {
      const first = await submitFor(staffClaims, staffEmployeeId, "2027-04-19", "2027-04-20");
      const second = await submitFor(staffClaims, staffEmployeeId, "2027-04-22", "2027-04-22");
      await expect(leaveRequests.update(staffClaims, first.id, { endDate: "2027-04-21" })).resolves.toBeDefined();
      await expect(leaveRequests.update(staffClaims, second.id, { startDate: "2027-04-21", endDate: "2027-04-22" })).rejects.toBeInstanceOf(ConflictException);
    });

    it("re-checks the rules: end before start, a type that is not available, and balance", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-05-03", "2027-05-03");
      await expect(leaveRequests.update(staffClaims, created.id, { startDate: "2027-05-05", endDate: "2027-05-04" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(leaveRequests.update(staffClaims, created.id, { leaveType: "no_such_type" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(leaveRequests.update(staffClaims, created.id, { startDate: "2027-06-01", endDate: "2027-06-30" })).rejects.toThrow(/Insufficient/);
      const unchanged = await leaveRequests.getRequest(staffClaims, created.id);
      expect(unchanged.startDate).toBe("2027-05-03");
    });

    it("refuses once the request is decided or cancelled", async () => {
      const approved = await submitFor(staffClaims, staffEmployeeId, "2027-05-10", "2027-05-10");
      await leaveRequests.decide(managerClaims, approved.id, { decision: "approved" });
      await expect(leaveRequests.update(staffClaims, approved.id, { reason: "late edit" })).rejects.toBeInstanceOf(BadRequestException);

      const cancelled = await submitFor(staffClaims, staffEmployeeId, "2027-05-12", "2027-05-12");
      await leaveRequests.cancel(hrAdminClaims, cancelled.id);
      await expect(leaveRequests.update(staffClaims, cancelled.id, { reason: "late edit" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("is allowed for HR on someone else's behalf, but not for a teammate", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-05-17", "2027-05-17");
      const edited = await leaveRequests.update(hrAdminClaims, created.id, { reason: "Edited by HR" });
      expect(edited.request.reason).toBe("Edited by HR");
      await expect(leaveRequests.update(teammateClaims, created.id, { reason: "not mine" })).rejects.toBeInstanceOf(NotFoundException);
      await expect(leaveRequests.update(outsiderClaims, created.id, { reason: "not mine" })).rejects.toThrow();
    });

    it("cannot reach a request that belongs to another tenant", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-05-24", "2027-05-24");
      await expect(leaveRequests.update(otherHrClaims, created.id, { reason: "cross-tenant" })).rejects.toBeInstanceOf(NotFoundException);
      await expect(leaveRequests.update(otherStaffClaims, created.id, { reason: "cross-tenant" })).rejects.toBeInstanceOf(NotFoundException);
      expect((await leaveRequests.getRequest(staffClaims, created.id)).reason).toBeNull();
    });

    it("writes an audit entry with the before and after values", async () => {
      const created = await submitFor(staffClaims, staffEmployeeId, "2027-05-31", "2027-05-31");
      await leaveRequests.update(staffClaims, created.id, { endDate: "2027-06-01" });
      const rows = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT metadata FROM audit_log WHERE action = 'leave_request.update' AND target = $1", [created.id]));
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].metadata.after.endDate).toBe("2027-06-01");
      expect(rows.rows[0].metadata.before.endDate).toBe("2027-05-31");
    });
  });

  describe("teamCalendar()", () => {
    it("shows the employee and the colleagues under the same manager, pending and approved only, dates and status only", async () => {
      const mine = await submitFor(staffClaims, staffEmployeeId, "2027-08-02", "2027-08-03");
      const theirs = await submitFor(teammateClaims, teammateEmployeeId, "2027-08-04", "2027-08-04", { reason: "private reason" });
      await leaveRequests.decide(managerClaims, theirs.id, { decision: "approved" });
      const rejected = await submitFor(teammateClaims, teammateEmployeeId, "2027-08-09", "2027-08-09");
      await leaveRequests.decide(managerClaims, rejected.id, { decision: "rejected", comment: "no" });
      const otherTenant = await submitFor(otherStaffClaims, otherStaffEmployeeId, "2027-08-02", "2027-08-03");

      const entries = await leaveRequests.teamCalendar(staffClaims, { from: "2027-08-01", to: "2027-08-31" });
      const ids = entries.map((e) => e.leaveRequestId);
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(ids).not.toContain(rejected.id);
      expect(ids).not.toContain(otherTenant.id);
      const entry = entries.find((e) => e.leaveRequestId === theirs.id)!;
      expect(entry).toEqual({ leaveRequestId: theirs.id, employeeId: teammateEmployeeId, employeeName: "Tina Teammate", employeeNumber: expect.any(String), startDate: "2027-08-04", endDate: "2027-08-04", dayPart: "full", status: "approved" });
      expect(Object.keys(entry)).not.toContain("reason");
      expect(Object.keys(entry)).not.toContain("leaveType");
    });

    it("limits the window and filters by date", async () => {
      const entries = await leaveRequests.teamCalendar(staffClaims, { from: "2027-09-01", to: "2027-09-30" });
      expect(entries.filter((e) => e.startDate.startsWith("2027-08"))).toHaveLength(0);
      await expect(leaveRequests.teamCalendar(staffClaims, { from: "2027-01-01", to: "2027-12-31" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(leaveRequests.teamCalendar(staffClaims, { from: "2027-09-30", to: "2027-09-01" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("an employee with no manager sees only their own leave", async () => {
      // Olga (second tenant) has no manager; another employee in her company must not appear next to her.
      const mine = await submitFor(otherStaffClaims, otherStaffEmployeeId, "2027-10-04", "2027-10-04");
      const entries = await leaveRequests.teamCalendar(otherStaffClaims, { from: "2027-10-01", to: "2027-10-31" });
      expect(entries.map((e) => e.leaveRequestId)).toEqual([mine.id]);
    });

    it("only shows a team to someone allowed to see that employee", async () => {
      await expect(leaveRequests.teamCalendar(teammateClaims, { from: "2027-08-01", to: "2027-08-31", employeeId: staffEmployeeId })).rejects.toBeInstanceOf(NotFoundException);
      await expect(leaveRequests.teamCalendar(otherHrClaims, { from: "2027-08-01", to: "2027-08-31", employeeId: staffEmployeeId })).rejects.toBeInstanceOf(NotFoundException);
      const asHr = await leaveRequests.teamCalendar(hrAdminClaims, { from: "2027-08-01", to: "2027-08-31", employeeId: staffEmployeeId });
      expect(asHr.length).toBeGreaterThan(0);
      await expect(leaveRequests.teamCalendar(outsiderClaims, { from: "2027-08-01", to: "2027-08-31" })).rejects.toThrow();
    });
  });

  describe("listColleagues()", () => {
    it("lists the colleagues under the same manager, never the employee, and nobody from another tenant", async () => {
      const mine = await leaveRequests.listColleagues(staffClaims);
      expect(mine).toEqual([{ employeeId: teammateEmployeeId, employeeName: "Tina Teammate", employeeNumber: expect.any(String) }]);
      const theirs = await leaveRequests.listColleagues(teammateClaims);
      expect(theirs.map((c) => c.employeeId)).toEqual([staffEmployeeId]);
      expect(await leaveRequests.listColleagues(otherStaffClaims)).toEqual([]);
    });

    it("is empty for someone with no manager, and respects who may see whom", async () => {
      expect(await leaveRequests.listColleagues(managerClaims)).toEqual([]);
      await expect(leaveRequests.listColleagues(teammateClaims, staffEmployeeId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(leaveRequests.listColleagues(otherHrClaims, staffEmployeeId)).rejects.toBeInstanceOf(NotFoundException);
      const asHr = await leaveRequests.listColleagues(hrAdminClaims, staffEmployeeId);
      expect(asHr.map((c) => c.employeeId)).toEqual([teammateEmployeeId]);
      await expect(leaveRequests.listColleagues(outsiderClaims)).rejects.toThrow();
    });
  });
});
