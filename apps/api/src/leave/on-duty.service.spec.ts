import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OnDutyService } from "./on-duty.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "on-duty-fixtures" };

/**
 * Real Postgres, no mocks — same discipline as every other spec in this
 * codebase. Covers: self-submission + on-behalf submission, endDate <
 * startDate validation, the same-employee overlapping-date-range 409,
 * self/team/all view scoping, decide() approve/reject, the "already
 * decided" conflict, an outsider being refused end to end, and the
 * pending-queue's "degrade to [] rather than 403" convention.
 */
describe("OnDutyService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let onDuty: OnDutyService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let staffEmployeeId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    onDuty = new OnDutyService(db, rbac, entitlements, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `On-Duty Co ${stamp}`,
        `on-duty-co-${stamp}`,
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
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
          userAccountId,
          companyId,
          role.rows[0].id,
        ]);
      });
    }

    const hrAdminUserId = await makeUser(`od-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const managerUserId = await makeUser(`od-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    const staffUserId = await makeUser(`od-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`od-outsider-${stamp}@example.com`);
    await assignRole(outsiderUserId, "employee_self_service");
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    const managerEmployeeId = (
      await employees.create(hrAdminClaims, { firstName: "Maya", lastName: "Manager", userAccountId: managerUserId })
    ).id;
    const staffEmployee = await employees.create(hrAdminClaims, {
      firstName: "Sam",
      lastName: "Staff",
      managerId: managerEmployeeId,
      userAccountId: staffUserId,
    });
    staffEmployeeId = staffEmployee.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects an endDate before startDate", async () => {
    await expect(
      onDuty.submit(staffClaims, { employeeId: staffEmployeeId, startDate: "2026-05-10", endDate: "2026-05-05" })
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses an outsider with no relationship to the employee", async () => {
    await expect(
      onDuty.submit(outsiderClaims, {
        employeeId: staffEmployeeId,
        startDate: "2026-05-01",
        endDate: "2026-05-02",
        reason: "Not my business",
      })
    ).rejects.toThrow(ForbiddenException);
  });

  describe("self-submission", () => {
    let requestId: string;

    it("lets the employee submit an on-duty request for themselves", async () => {
      const created = await onDuty.submit(staffClaims, {
        employeeId: staffEmployeeId,
        startDate: "2026-05-01",
        endDate: "2026-05-03",
        location: "Client site — Lahore",
        reason: "On-site implementation support",
      });
      expect(created.status).toBe("pending");
      expect(created.isOnBehalf).toBe(false);
      expect(created.location).toBe("Client site — Lahore");
      requestId = created.id;
    });

    it("refuses a second request overlapping the same range", async () => {
      await expect(
        onDuty.submit(staffClaims, { employeeId: staffEmployeeId, startDate: "2026-05-02", endDate: "2026-05-04" })
      ).rejects.toThrow(ConflictException);
    });

    it("allows a non-overlapping request for the same employee", async () => {
      const created = await onDuty.submit(staffClaims, {
        employeeId: staffEmployeeId,
        startDate: "2026-05-10",
        endDate: "2026-05-10",
        reason: "One-day training",
      });
      expect(created.status).toBe("pending");
      // Reject it immediately so it doesn't collide with later tests that
      // reuse this employee's overlap-free date range.
      await onDuty.decide(hrAdminClaims, created.id, { decision: "rejected" });
    });

    it("refuses an outsider trying to decide it", async () => {
      await expect(onDuty.decide(outsiderClaims, requestId, { decision: "approved" })).rejects.toThrow(ForbiddenException);
    });

    it("appears in the manager's pending queue, and the manager can approve it", async () => {
      const pending = await onDuty.listPendingForDecider(managerClaims);
      expect(pending.some((r) => r.id === requestId)).toBe(true);

      const decided = await onDuty.decide(managerClaims, requestId, { decision: "approved", comment: "Approved, has client sign-off" });
      expect(decided.status).toBe("approved");
      expect(decided.decisionComment).toBe("Approved, has client sign-off");
    });

    it("refuses to decide the same request twice", async () => {
      await expect(onDuty.decide(managerClaims, requestId, { decision: "rejected" })).rejects.toThrow(ConflictException);
    });

    it("a resubmission overlapping an already-APPROVED request is still refused", async () => {
      await expect(
        onDuty.submit(hrAdminClaims, { employeeId: staffEmployeeId, startDate: "2026-05-03", endDate: "2026-05-06" })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("on-behalf submission", () => {
    let requestId: string;

    it("lets HR submit on the employee's behalf, marked isOnBehalf", async () => {
      const created = await onDuty.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "HR-arranged offsite audit",
      });
      expect(created.isOnBehalf).toBe(true);
      requestId = created.id;
    });

    it("the employee can view their own request submitted on their behalf", async () => {
      const list = await onDuty.listForEmployee(staffClaims, staffEmployeeId);
      expect(list.find((r) => r.id === requestId)?.isOnBehalf).toBe(true);
    });

    it("HR rejects it", async () => {
      const decided = await onDuty.decide(hrAdminClaims, requestId, { decision: "rejected", comment: "Audit postponed" });
      expect(decided.status).toBe("rejected");
    });

    it("a new request for the same, now-freed dates succeeds (rejected doesn't block resubmission)", async () => {
      const created = await onDuty.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Audit rescheduled, resubmitting",
      });
      expect(created.status).toBe("pending");
    });
  });

  it("does not appear in a company-wide pending queue for an outsider (degrades to [], not 403)", async () => {
    const pending = await onDuty.listPendingForDecider(outsiderClaims);
    expect(pending).toHaveLength(0);
  });

  it("refuses an outsider viewing the employee's on-duty list", async () => {
    await expect(onDuty.listForEmployee(outsiderClaims, staffEmployeeId)).rejects.toThrow(ForbiddenException);
  });
});
