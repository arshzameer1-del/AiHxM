import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { AttendanceCorrectionsService } from "./attendance-corrections.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "attendance-corrections-fixtures" };

/**
 * Real Postgres, no mocks — same discipline as every other spec in this
 * codebase. Covers: self-submission + on-behalf submission, the
 * "at least one corrected time" / "a new record needs a clock-in"
 * validation, self/team/all view scoping (mirrors
 * LeaveRequestsService.listRequests's own resolveViewScope idiom),
 * decide() actually patching an existing attendance_records row vs.
 * creating a brand-new one, the "already decided" conflict, and that an
 * outsider (no relationship to the employee at all) is refused
 * end to end.
 */
describe("AttendanceCorrectionsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let corrections: AttendanceCorrectionsService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let staffEmployeeId: string;
  let staffEmployeeNumber: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    corrections = new AttendanceCorrectionsService(db, rbac, entitlements, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Corrections Co ${stamp}`,
        `corrections-co-${stamp}`,
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

    const hrAdminUserId = await makeUser(`corr-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const managerUserId = await makeUser(`corr-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    const staffUserId = await makeUser(`corr-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`corr-outsider-${stamp}@example.com`);
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
    staffEmployeeNumber = staffEmployee.employeeNumber;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects a request with no corrected time at all", async () => {
    await expect(
      corrections.submit(staffClaims, { employeeId: staffEmployeeId, requestedDate: "2026-01-05", reason: "Forgot" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a brand-new record request with only a clock-out", async () => {
    await expect(
      corrections.submit(staffClaims, {
        employeeId: staffEmployeeId,
        requestedDate: "2026-01-05",
        requestedClockOut: "2026-01-05T17:00:00.000Z",
        reason: "Forgot to clock in entirely",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses an outsider with no relationship to the employee", async () => {
    await expect(
      corrections.submit(outsiderClaims, {
        employeeId: staffEmployeeId,
        requestedDate: "2026-01-05",
        requestedClockIn: "2026-01-05T09:00:00.000Z",
        reason: "Not my business",
      })
    ).rejects.toThrow(ForbiddenException);
  });

  describe("self-submission creating a brand-new record", () => {
    let requestId: string;

    it("lets the employee submit a correction for a missed punch", async () => {
      const created = await corrections.submit(staffClaims, {
        employeeId: staffEmployeeId,
        requestedDate: "2026-01-05",
        requestedClockIn: "2026-01-05T09:05:00.000Z",
        requestedClockOut: "2026-01-05T17:10:00.000Z",
        reason: "Biometric device was down that morning",
      });
      expect(created.status).toBe("pending");
      expect(created.isOnBehalf).toBe(false);
      expect(created.attendanceRecordId).toBeNull();
      requestId = created.id;
    });

    it("refuses the employee's own manager from deciding an unrelated report — outsider claims can't", async () => {
      await expect(corrections.decide(outsiderClaims, requestId, { decision: "approved" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("lets the manager approve it, which creates the attendance record", async () => {
      const decided = await corrections.decide(managerClaims, requestId, { decision: "approved", comment: "Confirmed with security log" });
      expect(decided.status).toBe("approved");
      expect(decided.attendanceRecordId).not.toBeNull();

      const list = await corrections.listForEmployee(hrAdminClaims, staffEmployeeId);
      const record = list.find((r) => r.id === requestId)!;
      expect(record.status).toBe("approved");
      expect(record.attendanceRecordId).not.toBeNull();
    });

    it("refuses to decide the same request twice", async () => {
      await expect(corrections.decide(managerClaims, requestId, { decision: "rejected" })).rejects.toThrow(ConflictException);
    });
  });

  describe("correcting an existing attendance record", () => {
    let attendanceRecordId: string;
    let requestId: string;

    beforeAll(async () => {
      const inserted = await db.withClaims(hrAdminClaims, (client) =>
        client.query(
          `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
           VALUES ($1, $2, $3, 'manual', '2026-02-10T09:30:00.000Z', '2026-02-10T17:00:00.000Z')
           RETURNING id`,
          [companyId, staffEmployeeId, staffEmployeeNumber]
        )
      );
      attendanceRecordId = inserted.rows[0].id;
    });

    it("lets HR submit an on-behalf correction referencing the existing record", async () => {
      const created = await corrections.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        attendanceRecordId,
        requestedDate: "2026-02-10",
        requestedClockIn: "2026-02-10T09:00:00.000Z",
        reason: "Employee actually badged in at 9:00, device logged it late",
      });
      expect(created.isOnBehalf).toBe(true);
      requestId = created.id;
    });

    it("404s referencing another employee's attendance record", async () => {
      const otherEmployee = await employees.create(hrAdminClaims, { firstName: "Ollie", lastName: "Other" });
      await expect(
        corrections.submit(hrAdminClaims, {
          employeeId: otherEmployee.id,
          attendanceRecordId,
          requestedDate: "2026-02-10",
          requestedClockIn: "2026-02-10T09:00:00.000Z",
          reason: "Wrong employee on purpose, for the test",
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("appears in the manager's pending queue, and approving it patches the existing record in place", async () => {
      const pending = await corrections.listPendingForDecider(managerClaims);
      expect(pending.some((r) => r.id === requestId)).toBe(true);

      const decided = await corrections.decide(managerClaims, requestId, { decision: "approved" });
      expect(decided.attendanceRecordId).toBe(attendanceRecordId);

      const patched = await db.withClaims(hrAdminClaims, (client) =>
        client.query("SELECT clock_in_at, clock_out_at FROM attendance_records WHERE id = $1", [attendanceRecordId])
      );
      expect(patched.rows[0].clock_in_at.toISOString()).toBe("2026-02-10T09:00:00.000Z");
      // Only clock-in was corrected — clock-out must be left untouched.
      expect(patched.rows[0].clock_out_at.toISOString()).toBe("2026-02-10T17:00:00.000Z");
    });
  });

  describe("a one-sided correction that would cross the existing untouched time", () => {
    // Regression coverage: live HTTP verification found that approving a
    // correction which only sets requestedClockIn — leaving the
    // EXISTING, uncorrected clock_out_at in place — threw a raw,
    // unhandled Postgres "violates check constraint
    // attendance_records_check" 500 whenever the new clock-in landed
    // later than that untouched clock-out. Every other test in this file
    // happened to pick times that never crossed that boundary. Fixed by
    // resolving both final values and validating before writing;
    // approving now surfaces a clear 409 instead of a raw DB error, and
    // leaves the correction request itself still pending (the whole
    // decide() call is one transaction).
    let attendanceRecordId: string;
    let requestId: string;

    beforeAll(async () => {
      const inserted = await db.withClaims(hrAdminClaims, (client) =>
        client.query(
          `INSERT INTO attendance_records (company_id, employee_id, employee_number, source, clock_in_at, clock_out_at)
           VALUES ($1, $2, $3, 'manual', '2026-04-01T09:00:00.000Z', '2026-04-01T10:00:00.000Z')
           RETURNING id`,
          [companyId, staffEmployeeId, staffEmployeeNumber]
        )
      );
      attendanceRecordId = inserted.rows[0].id;

      const created = await corrections.submit(staffClaims, {
        employeeId: staffEmployeeId,
        attendanceRecordId,
        requestedDate: "2026-04-01",
        // Later than the existing (untouched) clock_out_at of 10:00.
        requestedClockIn: "2026-04-01T11:00:00.000Z",
        reason: "Actually badged in at 11, not 9",
      });
      requestId = created.id;
    });

    it("refuses the approval with a clear conflict instead of a raw DB error, and leaves the request pending", async () => {
      await expect(corrections.decide(managerClaims, requestId, { decision: "approved" })).rejects.toThrow(
        ConflictException
      );

      const stillPending = await corrections.listForEmployee(hrAdminClaims, staffEmployeeId);
      expect(stillPending.find((r) => r.id === requestId)!.status).toBe("pending");

      const untouched = await db.withClaims(hrAdminClaims, (client) =>
        client.query("SELECT clock_in_at FROM attendance_records WHERE id = $1", [attendanceRecordId])
      );
      expect(untouched.rows[0].clock_in_at.toISOString()).toBe("2026-04-01T09:00:00.000Z");
    });
  });

  it("does not appear in a company-wide pending queue for a rejected outsider", async () => {
    const pending = await corrections.listPendingForDecider(outsiderClaims);
    expect(pending).toHaveLength(0);
  });
});
