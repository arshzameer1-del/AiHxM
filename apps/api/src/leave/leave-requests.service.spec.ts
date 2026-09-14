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
describe("LeaveRequestsService + AttendanceService", () => {
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

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let teammateClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

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
    groups = new EmployeeGroupsService(db, rbac, entitlements);
    workflow = new WorkflowService(db, rbac, audit);
    leaveRequests = new LeaveRequestsService(db, rbac, entitlements, audit, groups, workflow);
    attendance = new AttendanceService(db, rbac, entitlements, audit);

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
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("submit()", () => {
    it("resolves the tenant's default leave policy, seeds the balance, and routes to the submitter's manager", async () => {
      const response = await leaveRequests.submit(staffClaims, {
        employeeId: staffEmployeeId,
        leaveType: "annual",
        startDate: "2026-03-01",
        endDate: "2026-03-03",
        reason: "Family trip",
      });

      expect(response.request.status).toBe("pending");
      expect(response.request.daysRequested).toBe(3);
      expect(response.request.isOnBehalf).toBe(false);
      expect(response.request.workflowInstanceId).not.toBeNull();

      const instance = await workflow.getInstance(staffClaims, response.request.workflowInstanceId as string);
      expect(instance.steps[0].approvals[0].approverType).toBe("manager_of_submitter");
      expect(instance.steps[0].approvals[0].userAccountId).toBe(managerUserId);

      const balances = await leaveRequests.getBalances(hrAdminClaims, staffEmployeeId);
      const annual = balances.find((b) => b.leaveType === "annual")!;
      expect(annual.entitledDays).toBe(14);
      expect(annual.usedDays).toBe(0); // not yet approved — no decrement until decide()
    });

    it("generates a non-blocking overlap notice for a same-manager teammate's overlapping request", async () => {
      // Tina (same manager as Sam) already has a pending request covering
      // part of the date range Sam is about to request.
      await leaveRequests.submit(teammateClaims, {
        employeeId: teammateEmployeeId,
        leaveType: "casual",
        startDate: "2026-04-10",
        endDate: "2026-04-12",
      });

      const response = await leaveRequests.submit(staffClaims, {
        employeeId: staffEmployeeId,
        leaveType: "casual",
        startDate: "2026-04-11",
        endDate: "2026-04-14",
      });

      expect(response.overlapWarnings).toHaveLength(1);
      expect(response.overlapWarnings[0].employeeId).toBe(teammateEmployeeId);
      expect(response.overlapWarnings[0].employeeFullName).toBe("Tina Teammate");
      // Non-blocking — the request itself still went through as 'pending'.
      expect(response.request.status).toBe("pending");
    });

    it("supports an On-Behalf submission by an HR Admin, correctly flagged and correctly routed to the SUBJECT's manager", async () => {
      const response = await leaveRequests.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        leaveType: "sick",
        startDate: "2026-05-01",
        endDate: "2026-05-01",
        reason: "Submitted by HR while Sam is unwell",
      });

      expect(response.request.isOnBehalf).toBe(true);
      expect(response.request.submittedByUserAccountId).toBe(hrAdminClaims.sub);

      const instance = await workflow.getInstance(hrAdminClaims, response.request.workflowInstanceId as string);
      // Routed to SAM's manager (Maya), not HR Admin's own (nonexistent) one.
      expect(instance.subjectUserAccountId).toBe(staffUserId);
      expect(instance.steps[0].approvals[0].userAccountId).toBe(managerUserId);
    });

    it("denies a caller with neither create.self (for someone else) nor manage.all", async () => {
      await expect(
        leaveRequests.submit(outsiderClaims, {
          employeeId: staffEmployeeId,
          leaveType: "annual",
          startDate: "2026-06-01",
          endDate: "2026-06-01",
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects a request that exceeds the employee's remaining balance", async () => {
      await expect(
        leaveRequests.submit(staffClaims, {
          employeeId: staffEmployeeId,
          leaveType: "sick",
          startDate: "2026-07-01",
          endDate: "2026-07-20", // 20 days, entitlement is only 8
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("404s when the leave module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'leave'", [
          companyId,
        ])
      );
      await expect(
        leaveRequests.submit(staffClaims, {
          employeeId: staffEmployeeId,
          leaveType: "annual",
          startDate: "2026-08-01",
          endDate: "2026-08-01",
        })
      ).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'leave'", [
          companyId,
        ])
      );
    });
  });

  describe("decide()", () => {
    it("only the resolved manager_of_submitter approver can approve, and approval decrements the balance", async () => {
      const submitted = await leaveRequests.submit(staffClaims, {
        employeeId: staffEmployeeId,
        leaveType: "annual",
        startDate: "2026-09-01",
        endDate: "2026-09-02",
      });

      // The submitter themselves is not the resolved approver.
      await expect(leaveRequests.decide(staffClaims, submitted.request.id, { decision: "approved" })).rejects.toThrow();

      const before = await leaveRequests.getBalances(hrAdminClaims, staffEmployeeId);
      const annualBefore = before.find((b) => b.leaveType === "annual")!;

      const decided = await leaveRequests.decide(managerClaims, submitted.request.id, {
        decision: "approved",
        comment: "Approved",
      });
      expect(decided.status).toBe("approved");

      const after = await leaveRequests.getBalances(hrAdminClaims, staffEmployeeId);
      const annualAfter = after.find((b) => b.leaveType === "annual")!;
      expect(annualAfter.usedDays).toBe(annualBefore.usedDays + 2);
      expect(annualAfter.remainingDays).toBe(annualBefore.remainingDays - 2);
    });

    it("a rejection sets the request to rejected without touching the balance", async () => {
      const submitted = await leaveRequests.submit(staffClaims, {
        employeeId: staffEmployeeId,
        leaveType: "casual",
        startDate: "2026-10-01",
        endDate: "2026-10-01",
      });
      const before = await leaveRequests.getBalances(hrAdminClaims, staffEmployeeId);
      const casualBefore = before.find((b) => b.leaveType === "casual")!;

      const decided = await leaveRequests.decide(managerClaims, submitted.request.id, { decision: "rejected" });
      expect(decided.status).toBe("rejected");

      const after = await leaveRequests.getBalances(hrAdminClaims, staffEmployeeId);
      const casualAfter = after.find((b) => b.leaveType === "casual")!;
      expect(casualAfter.usedDays).toBe(casualBefore.usedDays);
    });

    it("cannot decide a request that is already decided", async () => {
      const submitted = await leaveRequests.submit(staffClaims, {
        employeeId: staffEmployeeId,
        leaveType: "casual",
        startDate: "2026-11-01",
        endDate: "2026-11-01",
      });
      await leaveRequests.decide(managerClaims, submitted.request.id, { decision: "approved" });
      await expect(leaveRequests.decide(managerClaims, submitted.request.id, { decision: "approved" })).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("an employee record with no user account", () => {
    it("cannot have a leave request submitted for it at all — safe-deny, not a silent skip of approval routing", async () => {
      const ghostEmployee = await employees.create(hrAdminClaims, {
        firstName: "Ghost",
        lastName: "NoLogin",
        managerId: managerEmployeeId,
      });
      await expect(
        leaveRequests.submit(hrAdminClaims, {
          employeeId: ghostEmployee.id,
          leaveType: "annual",
          startDate: "2026-12-01",
          endDate: "2026-12-01",
        })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("cancel()", () => {
    it("manage.all can cancel a pending request; a stranger cannot", async () => {
      const submitted = await leaveRequests.submit(staffClaims, {
        employeeId: staffEmployeeId,
        leaveType: "annual",
        startDate: "2026-09-10",
        endDate: "2026-09-10",
      });
      await expect(leaveRequests.cancel(outsiderClaims, submitted.request.id)).rejects.toThrow(ForbiddenException);
      await leaveRequests.cancel(hrAdminClaims, submitted.request.id);
      const cancelled = await leaveRequests.getRequest(hrAdminClaims, submitted.request.id);
      expect(cancelled.status).toBe("cancelled");
    });
  });

  describe("AttendanceService", () => {
    it("clocks in and out by employee_number, and refuses a second clock-in while already clocked in", async () => {
      const employeeNumber = (await employees.get(hrAdminClaims, staffEmployeeId)).employeeNumber;

      const clockedIn = await attendance.clockIn(staffClaims, { employeeNumber, source: "manual" });
      expect(clockedIn.clockOutAt).toBeNull();

      await expect(attendance.clockIn(staffClaims, { employeeNumber, source: "manual" })).rejects.toThrow(ConflictException);

      const clockedOut = await attendance.clockOut(staffClaims, { employeeNumber });
      expect(clockedOut.id).toBe(clockedIn.id);
      expect(clockedOut.clockOutAt).not.toBeNull();

      // Now clocking in again is fine — the previous record is closed.
      const secondClockIn = await attendance.clockIn(staffClaims, { employeeNumber, source: "gps", gpsLat: 24.8607, gpsLng: 67.0011 });
      expect(secondClockIn.gpsLat).toBeCloseTo(24.8607, 4);
      await attendance.clockOut(staffClaims, { employeeNumber });
    });

    it("rejects clocking out an employee who isn't currently clocked in", async () => {
      const employeeNumber = (await employees.get(hrAdminClaims, teammateEmployeeId)).employeeNumber;
      await expect(attendance.clockOut(teammateClaims, { employeeNumber })).rejects.toThrow(BadRequestException);
    });

    it("denies a stranger recording attendance for someone else", async () => {
      const employeeNumber = (await employees.get(hrAdminClaims, staffEmployeeId)).employeeNumber;
      await expect(attendance.clockIn(outsiderClaims, { employeeNumber, source: "manual" })).rejects.toThrow(
        ForbiddenException
      );
    });
  });
});
