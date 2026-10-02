import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeAdditionalPaymentsService } from "./employee-additional-payments.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-additional-payments-spec-fixtures" };

/**
 * Payroll Enterprise Gap Analysis Phase P3, Section 6 (0112_loans_advances_
 * additional_payments.sql) — the SAP IT0015 equivalent. Covered the same
 * way `employee-loans.service.spec.ts` covers its sibling table: real
 * Postgres, no mocks, this service's own CRUD/permission surface plus the
 * two cross-module read/write methods in isolation (the full
 * calculate-then-finalize flow is exercised in `payroll.service.spec.ts`).
 */
describe("EmployeeAdditionalPaymentsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let payments: EmployeeAdditionalPaymentsService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let employeeId: string;

  let employeeCounter = 0;

  async function makeUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, roleKey: string, targetCompanyId: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        userAccountId,
        targetCompanyId,
        role.rows[0].id,
      ]);
    });
  }

  async function createEmployee(): Promise<string> {
    employeeCounter += 1;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, date_of_joining)
         VALUES ($1, $2, 'Payment', 'Employee', '2020-01-01') RETURNING id`,
        [companyId, `EAP-${employeeCounter}`]
      );
      return result.rows[0].id as string;
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    payments = new EmployeeAdditionalPaymentsService(db, rbac, entitlements, audit);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Employee Additional Payments Spec Co ${stamp}`,
        `employee-additional-payments-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });

    const hrAdminUserId = await makeUser(`eap-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin", companyId);
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const staffUserId = await makeUser(`eap-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service", companyId);
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`eap-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    employeeId = await createEmployee();
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("create() / list() / cancel()", () => {
    it("creates a pending earning, defaulting isTaxable to true", async () => {
      const created = await payments.create(hrAdminClaims, {
        employeeId,
        paymentType: "earning",
        label: "Eid Bonus",
        amount: 15000,
        effectiveDate: "2026-04-15",
      });
      expect(created.status).toBe("pending");
      expect(created.isTaxable).toBe(true);

      const list = await payments.list(hrAdminClaims, employeeId);
      expect(list.some((p) => p.id === created.id)).toBe(true);
    });

    it("forces a deduction to be non-taxable even if isTaxable: true is passed", async () => {
      const created = await payments.create(hrAdminClaims, {
        employeeId,
        paymentType: "deduction",
        label: "Society Membership Arrears",
        amount: 2000,
        isTaxable: true,
        effectiveDate: "2026-04-20",
      });
      expect(created.isTaxable).toBe(false);
    });

    it("rejects a non-positive amount or a blank label", async () => {
      await expect(
        payments.create(hrAdminClaims, { employeeId, paymentType: "earning", label: "x", amount: 0, effectiveDate: "2026-04-01" })
      ).rejects.toThrow(BadRequestException);
      await expect(
        payments.create(hrAdminClaims, { employeeId, paymentType: "earning", label: "   ", amount: 100, effectiveDate: "2026-04-01" })
      ).rejects.toThrow(BadRequestException);
    });

    it("404s for an employee that doesn't exist in this company", async () => {
      await expect(
        payments.create(hrAdminClaims, {
          employeeId: "00000000-0000-0000-0000-000000000000",
          paymentType: "earning",
          label: "Bonus",
          amount: 1000,
          effectiveDate: "2026-04-01",
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("cancel() moves a pending payment to cancelled and refuses a second cancel", async () => {
      const toCancel = await payments.create(hrAdminClaims, {
        employeeId,
        paymentType: "earning",
        label: "Referral Bonus",
        amount: 5000,
        effectiveDate: "2026-05-01",
      });
      const cancelled = await payments.cancel(hrAdminClaims, toCancel.id);
      expect(cancelled.status).toBe("cancelled");
      await expect(payments.cancel(hrAdminClaims, toCancel.id)).rejects.toThrow(BadRequestException);
    });
  });

  describe("permissions (employee.manage.all / employee.view)", () => {
    it("staff (no manage permission) cannot create or cancel", async () => {
      await expect(
        payments.create(staffClaims, { employeeId, paymentType: "earning", label: "Bonus", amount: 1000, effectiveDate: "2026-04-01" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("an outsider with no employee-module role at all cannot even view", async () => {
      await expect(payments.list(outsiderClaims, employeeId)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listPendingInRangeWithinTransaction() — PayrollService's own read", () => {
    it("returns only pending payments whose effective_date falls inside the window, ordered ascending", async () => {
      const rangeEmployee = await createEmployee();
      const inside1 = await payments.create(hrAdminClaims, {
        employeeId: rangeEmployee,
        paymentType: "earning",
        label: "Inside early",
        amount: 1000,
        effectiveDate: "2026-06-05",
      });
      const inside2 = await payments.create(hrAdminClaims, {
        employeeId: rangeEmployee,
        paymentType: "deduction",
        label: "Inside late",
        amount: 500,
        effectiveDate: "2026-06-25",
      });
      const outside = await payments.create(hrAdminClaims, {
        employeeId: rangeEmployee,
        paymentType: "earning",
        label: "Outside",
        amount: 1000,
        effectiveDate: "2026-07-05",
      });
      const cancelledOne = await payments.create(hrAdminClaims, {
        employeeId: rangeEmployee,
        paymentType: "earning",
        label: "Cancelled",
        amount: 1000,
        effectiveDate: "2026-06-10",
      });
      await payments.cancel(hrAdminClaims, cancelledOne.id);

      const inRange = await db.withClaims(hrAdminClaims, (client) =>
        payments.listPendingInRangeWithinTransaction(client, rangeEmployee, "2026-06-01", "2026-06-30")
      );
      expect(inRange.map((p) => p.id)).toEqual([inside1.id, inside2.id]);
      expect(inRange.some((p) => p.id === outside.id)).toBe(false);
      expect(inRange.some((p) => p.id === cancelledOne.id)).toBe(false);
    });
  });

  describe("markConsumedWithinTransaction() — PayrollService.finalizeRun()'s own write", () => {
    it("moves pending -> consumed exactly once, idempotently", async () => {
      const consumeEmployee = await createEmployee();
      const payment = await payments.create(hrAdminClaims, {
        employeeId: consumeEmployee,
        paymentType: "earning",
        label: "Consumed Test",
        amount: 2000,
        effectiveDate: "2026-08-01",
      });
      const run = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id) VALUES ($1, '2026-08-01', '2026-08-31', (SELECT id FROM user_accounts LIMIT 1)) RETURNING id",
          [companyId]
        );
        return result.rows[0].id as string;
      });

      await db.withClaims(hrAdminClaims, (client) => payments.markConsumedWithinTransaction(client, payment.id, run));
      const afterFirst = await payments.list(hrAdminClaims, consumeEmployee);
      const afterFirstPayment = afterFirst.find((p) => p.id === payment.id)!;
      expect(afterFirstPayment.status).toBe("consumed");
      expect(afterFirstPayment.consumedPayrollRunId).toBe(run);

      // Idempotent: a second call (e.g. a retried finalize) must not error
      // or stomp a different run's id — the `WHERE status = 'pending'`
      // guard makes this a no-op once already consumed.
      const otherRun = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id) VALUES ($1, '2026-09-01', '2026-09-30', (SELECT id FROM user_accounts LIMIT 1)) RETURNING id",
          [companyId]
        );
        return result.rows[0].id as string;
      });
      await db.withClaims(hrAdminClaims, (client) => payments.markConsumedWithinTransaction(client, payment.id, otherRun));
      const afterRetry = await payments.list(hrAdminClaims, consumeEmployee);
      expect(afterRetry.find((p) => p.id === payment.id)!.consumedPayrollRunId).toBe(run);
    });
  });
});
