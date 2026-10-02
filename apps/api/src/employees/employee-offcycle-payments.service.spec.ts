import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeOffCyclePaymentsService } from "./employee-offcycle-payments.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-offcycle-payments-spec-fixtures" };

/**
 * Payroll Enterprise Gap Analysis Phase P4 (0113_payroll_off_cycle_runs.sql)
 * — the SAP IT0267 equivalent. Covered the same way
 * `employee-additional-payments.service.spec.ts` covers its IT0015
 * sibling: real Postgres, no mocks, this service's own CRUD/permission
 * surface plus the two cross-module read/write methods in isolation (the
 * full calculate-then-finalize flow for an off-cycle run is exercised in
 * `payroll.service.spec.ts`'s own "Off-cycle runs & Final Settlement
 * (Phase P4)" describe block).
 */
describe("EmployeeOffCyclePaymentsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let payments: EmployeeOffCyclePaymentsService;

  let companyId: string;
  let hrAdminUserId: string;
  let hrAdminClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let employeeId: string;

  let employeeCounter = 0;
  let runCounter = 0;

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
         VALUES ($1, $2, 'OffCycle', 'Employee', '2020-01-01') RETURNING id`,
        [companyId, `EOP-${employeeCounter}`]
      );
      return result.rows[0].id as string;
    });
  }

  async function createRun(opts: { runType?: "regular" | "off_cycle"; status?: string } = {}): Promise<string> {
    runCounter += 1;
    const periodStart = `2029-${String((runCounter % 12) + 1).padStart(2, "0")}-01`;
    const periodEnd = `2029-${String((runCounter % 12) + 1).padStart(2, "0")}-28`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, run_type, off_cycle_reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          companyId,
          periodStart,
          periodEnd,
          hrAdminUserId,
          opts.runType ?? "off_cycle",
          opts.runType === "regular" ? null : "bonus",
          opts.status ?? "draft",
        ]
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
    payments = new EmployeeOffCyclePaymentsService(db, rbac, entitlements, audit);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Employee Off-Cycle Payments Spec Co ${stamp}`,
        `employee-offcycle-payments-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "payroll"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'payroll', true)",
        [id]
      );
      return id;
    });

    hrAdminUserId = await makeUser(`eop-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin", companyId);
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const staffUserId = await makeUser(`eop-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service", companyId);
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`eop-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    employeeId = await createEmployee();
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("create() / listForRun() / cancel()", () => {
    it("creates a pending earning against an off-cycle run, defaulting isTaxable to true", async () => {
      const runId = await createRun();
      const created = await payments.create(hrAdminClaims, {
        employeeId,
        payrollRunId: runId,
        paymentType: "earning",
        label: "Eid Bonus",
        amount: 25000,
      });
      expect(created.status).toBe("pending");
      expect(created.isTaxable).toBe(true);
      expect(created.payrollRunId).toBe(runId);

      const list = await payments.listForRun(hrAdminClaims, runId);
      expect(list.some((p) => p.id === created.id)).toBe(true);
    });

    it("forces a deduction to be non-taxable even if isTaxable: true is passed", async () => {
      const runId = await createRun();
      const created = await payments.create(hrAdminClaims, {
        employeeId,
        payrollRunId: runId,
        paymentType: "deduction",
        label: "Recovery",
        amount: 2000,
        isTaxable: true,
      });
      expect(created.isTaxable).toBe(false);
    });

    it("rejects a non-positive amount or a blank label", async () => {
      const runId = await createRun();
      await expect(
        payments.create(hrAdminClaims, { employeeId, payrollRunId: runId, paymentType: "earning", label: "x", amount: 0 })
      ).rejects.toThrow(BadRequestException);
      await expect(
        payments.create(hrAdminClaims, { employeeId, payrollRunId: runId, paymentType: "earning", label: "   ", amount: 100 })
      ).rejects.toThrow(BadRequestException);
    });

    it("404s for an employee that doesn't exist in this company", async () => {
      const runId = await createRun();
      await expect(
        payments.create(hrAdminClaims, {
          employeeId: "00000000-0000-0000-0000-000000000000",
          payrollRunId: runId,
          paymentType: "earning",
          label: "Bonus",
          amount: 1000,
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("404s for a payroll run that doesn't exist, or belongs to another company", async () => {
      await expect(
        payments.create(hrAdminClaims, {
          employeeId,
          payrollRunId: "00000000-0000-0000-0000-000000000000",
          paymentType: "earning",
          label: "Bonus",
          amount: 1000,
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects adding a payment to a REGULAR run — off-cycle only", async () => {
      const regularRunId = await createRun({ runType: "regular" });
      await expect(
        payments.create(hrAdminClaims, { employeeId, payrollRunId: regularRunId, paymentType: "earning", label: "Bonus", amount: 1000 })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects adding a payment to an already finalized or reversed run", async () => {
      const finalizedRunId = await createRun({ status: "finalized" });
      await expect(
        payments.create(hrAdminClaims, { employeeId, payrollRunId: finalizedRunId, paymentType: "earning", label: "Bonus", amount: 1000 })
      ).rejects.toThrow(BadRequestException);

      const reversedRunId = await createRun({ status: "reversed" });
      await expect(
        payments.create(hrAdminClaims, { employeeId, payrollRunId: reversedRunId, paymentType: "earning", label: "Bonus", amount: 1000 })
      ).rejects.toThrow(BadRequestException);
    });

    it("cancel() moves a pending payment to cancelled and refuses a second cancel", async () => {
      const runId = await createRun();
      const toCancel = await payments.create(hrAdminClaims, {
        employeeId,
        payrollRunId: runId,
        paymentType: "earning",
        label: "Referral Bonus",
        amount: 5000,
      });
      const cancelled = await payments.cancel(hrAdminClaims, toCancel.id);
      expect(cancelled.status).toBe("cancelled");
      await expect(payments.cancel(hrAdminClaims, toCancel.id)).rejects.toThrow(BadRequestException);
    });
  });

  describe("permissions (employee.manage.all / employee.view)", () => {
    it("staff (no manage permission) cannot create or cancel", async () => {
      const runId = await createRun();
      await expect(
        payments.create(staffClaims, { employeeId, payrollRunId: runId, paymentType: "earning", label: "Bonus", amount: 1000 })
      ).rejects.toThrow(ForbiddenException);
    });

    it("an outsider with no employee-module role at all cannot even view", async () => {
      const runId = await createRun();
      await expect(payments.listForRun(outsiderClaims, runId)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listPendingForRunWithinTransaction() — PayrollService's own read", () => {
    it("returns only pending payments for this exact run and employee, ordered ascending by creation", async () => {
      const runId = await createRun();
      const otherRunId = await createRun();
      const otherEmployeeId = await createEmployee();

      const first = await payments.create(hrAdminClaims, { employeeId, payrollRunId: runId, paymentType: "earning", label: "First", amount: 1000 });
      const second = await payments.create(hrAdminClaims, { employeeId, payrollRunId: runId, paymentType: "deduction", label: "Second", amount: 500 });
      const cancelledOne = await payments.create(hrAdminClaims, {
        employeeId,
        payrollRunId: runId,
        paymentType: "earning",
        label: "Cancelled",
        amount: 999,
      });
      await payments.cancel(hrAdminClaims, cancelledOne.id);
      // Same employee, a DIFFERENT run — must not leak in.
      await payments.create(hrAdminClaims, { employeeId, payrollRunId: otherRunId, paymentType: "earning", label: "Other run", amount: 1 });
      // Same run, a DIFFERENT employee — must not leak in either.
      await payments.create(hrAdminClaims, { employeeId: otherEmployeeId, payrollRunId: runId, paymentType: "earning", label: "Other employee", amount: 1 });

      const pending = await db.withClaims(hrAdminClaims, (client) => payments.listPendingForRunWithinTransaction(client, runId, employeeId));
      expect(pending.map((p) => p.id)).toEqual([first.id, second.id]);
    });
  });

  describe("markConsumedWithinTransaction() — PayrollService.finalizeRun()'s own write", () => {
    it("moves pending -> consumed exactly once, idempotently", async () => {
      const runId = await createRun();
      const payment = await payments.create(hrAdminClaims, {
        employeeId,
        payrollRunId: runId,
        paymentType: "earning",
        label: "Consumed Test",
        amount: 2000,
      });

      await db.withClaims(hrAdminClaims, (client) => payments.markConsumedWithinTransaction(client, payment.id));
      const afterFirst = await payments.listForRun(hrAdminClaims, runId);
      expect(afterFirst.find((p) => p.id === payment.id)!.status).toBe("consumed");

      // Idempotent: a second call (e.g. a retried finalize) must not error.
      await db.withClaims(hrAdminClaims, (client) => payments.markConsumedWithinTransaction(client, payment.id));
      const afterRetry = await payments.listForRun(hrAdminClaims, runId);
      expect(afterRetry.find((p) => p.id === payment.id)!.status).toBe("consumed");
    });
  });
});
