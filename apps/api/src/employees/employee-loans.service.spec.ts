import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeLoansService } from "./employee-loans.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-loans-spec-fixtures" };

/**
 * Payroll Enterprise Gap Analysis Phase P3 (0112_loans_advances_
 * additional_payments.sql) — the SAP IT0045 equivalent. Core-Employee-
 * owned (`employee.manage.all`/`employee.view`, same gate as every other
 * sub-entity on the profile), covered here the same way
 * `employee-compensation.service.spec.ts` covers compensation: real
 * Postgres, no mocks. `PayrollService.calculateOnePayslip()`'s/
 * `finalizeRun()`'s own use of `listActiveLoansWithinTransaction()`/
 * `recordRepaymentWithinTransaction()` is exercised end-to-end in
 * `payroll.service.spec.ts` instead (it needs a whole payroll run), not
 * duplicated here — this file is this service's own CRUD/permission
 * surface plus the two cross-module read/write methods in isolation.
 */
describe("EmployeeLoansService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let loans: EmployeeLoansService;

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
         VALUES ($1, $2, 'Loan', 'Employee', '2020-01-01') RETURNING id`,
        [companyId, `EL-${employeeCounter}`]
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
    loans = new EmployeeLoansService(db, rbac, entitlements, audit);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Employee Loans Spec Co ${stamp}`,
        `employee-loans-spec-${stamp}`,
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

    const hrAdminUserId = await makeUser(`el-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin", companyId);
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const staffUserId = await makeUser(`el-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service", companyId);
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`el-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    employeeId = await createEmployee();
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("create() / list() / cancel()", () => {
    it("creates a loan with outstanding_balance seeded to the principal, visible via list()", async () => {
      const created = await loans.create(hrAdminClaims, {
        employeeId,
        loanType: "loan",
        reason: "Medical emergency",
        principalAmount: 50000,
        installmentAmount: 10000,
        issuedDate: "2026-01-01",
      });
      expect(created.status).toBe("active");
      expect(created.principalAmount).toBe(50000);
      expect(created.outstandingBalance).toBe(50000);

      const list = await loans.list(hrAdminClaims, employeeId);
      expect(list.some((l) => l.id === created.id)).toBe(true);
    });

    it("rejects a non-positive principal or installment amount", async () => {
      await expect(
        loans.create(hrAdminClaims, { employeeId, loanType: "salary_advance", principalAmount: 0, installmentAmount: 1000, issuedDate: "2026-01-01" })
      ).rejects.toThrow(BadRequestException);
      await expect(
        loans.create(hrAdminClaims, { employeeId, loanType: "salary_advance", principalAmount: 1000, installmentAmount: 0, issuedDate: "2026-01-01" })
      ).rejects.toThrow(BadRequestException);
    });

    it("404s for an employee that doesn't exist in this company", async () => {
      await expect(
        loans.create(hrAdminClaims, {
          employeeId: "00000000-0000-0000-0000-000000000000",
          loanType: "loan",
          principalAmount: 1000,
          installmentAmount: 100,
          issuedDate: "2026-01-01",
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("cancel() moves an active loan to cancelled and refuses a second cancel", async () => {
      const toCancel = await loans.create(hrAdminClaims, {
        employeeId,
        loanType: "salary_advance",
        principalAmount: 20000,
        installmentAmount: 5000,
        issuedDate: "2026-02-01",
      });
      const cancelled = await loans.cancel(hrAdminClaims, toCancel.id, { reason: "Employee repaid in cash" });
      expect(cancelled.status).toBe("cancelled");

      await expect(loans.cancel(hrAdminClaims, toCancel.id)).rejects.toThrow(BadRequestException);
    });

    it("404s cancelling a loan that doesn't exist", async () => {
      await expect(loans.cancel(hrAdminClaims, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(NotFoundException);
    });
  });

  describe("permissions (employee.manage.all / employee.view)", () => {
    it("staff (no manage permission) cannot create or cancel a loan", async () => {
      await expect(
        loans.create(staffClaims, { employeeId, loanType: "loan", principalAmount: 1000, installmentAmount: 100, issuedDate: "2026-01-01" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("an outsider with no employee-module role at all cannot even view", async () => {
      await expect(loans.list(outsiderClaims, employeeId)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listActiveLoansWithinTransaction() — PayrollService's own read", () => {
    it("returns only active loans for the employee, excluding cancelled ones", async () => {
      const activeEmployee = await createEmployee();
      const active = await loans.create(hrAdminClaims, {
        employeeId: activeEmployee,
        loanType: "loan",
        principalAmount: 30000,
        installmentAmount: 5000,
        issuedDate: "2026-03-01",
      });
      const toCancel = await loans.create(hrAdminClaims, {
        employeeId: activeEmployee,
        loanType: "salary_advance",
        principalAmount: 10000,
        installmentAmount: 2000,
        issuedDate: "2026-03-01",
      });
      await loans.cancel(hrAdminClaims, toCancel.id);

      const activeLoans = await db.withClaims(hrAdminClaims, (client) => loans.listActiveLoansWithinTransaction(client, activeEmployee));
      expect(activeLoans.map((l) => l.id)).toEqual([active.id]);
    });
  });

  describe("recordRepaymentWithinTransaction() — PayrollService.finalizeRun()'s own write", () => {
    it("writes a ledger row and decrements outstanding_balance, auto-closing the loan at zero", async () => {
      const payEmployee = await createEmployee();
      const loan = await loans.create(hrAdminClaims, {
        employeeId: payEmployee,
        loanType: "loan",
        principalAmount: 10000,
        installmentAmount: 4000,
        issuedDate: "2026-04-01",
      });

      const run = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id) VALUES ($1, '2026-04-01', '2026-04-30', (SELECT id FROM user_accounts LIMIT 1)) RETURNING id",
          [companyId]
        );
        return result.rows[0].id as string;
      });
      const payslip = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          `INSERT INTO payslips (company_id, payroll_run_id, employee_id, employee_number, days_in_period, paid_days, unpaid_leave_days,
             gross_pay, taxable_gross_this_period, taxable_annual_income, income_tax_monthly, eobi_employee_contribution,
             eobi_employer_contribution, social_security_employer_contribution, net_pay, calculation_breakdown)
           VALUES ($1,$2,$3,'EL-PAY',30,30,0,100000,100000,1200000,0,0,0,0,96000,'[]'::jsonb) RETURNING id`,
          [companyId, run, payEmployee]
        );
        return result.rows[0].id as string;
      });

      await db.withClaims(hrAdminClaims, (client) =>
        loans.recordRepaymentWithinTransaction(client, { loanId: loan.id, payrollRunId: run, payslipId: payslip, amount: 4000 })
      );

      const afterFirst = await loans.list(hrAdminClaims, payEmployee);
      const afterFirstLoan = afterFirst.find((l) => l.id === loan.id)!;
      expect(afterFirstLoan.outstandingBalance).toBe(6000);
      expect(afterFirstLoan.status).toBe("active");

      // Idempotent: calling it again for the SAME payslip must not
      // double-decrement (ON CONFLICT DO NOTHING on (loan_id, payslip_id)).
      await db.withClaims(hrAdminClaims, (client) =>
        loans.recordRepaymentWithinTransaction(client, { loanId: loan.id, payrollRunId: run, payslipId: payslip, amount: 4000 })
      );
      const afterRetry = await loans.list(hrAdminClaims, payEmployee);
      expect(afterRetry.find((l) => l.id === loan.id)!.outstandingBalance).toBe(6000);

      // A second, later payslip (a different run's period — `payslips`
      // has a unique (payroll_run_id, employee_id) constraint, so a
      // second payslip for the same employee needs its own run) whose
      // repayment exactly exhausts the remaining balance auto-closes the
      // loan.
      const run2 = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id) VALUES ($1, '2026-05-01', '2026-05-31', (SELECT id FROM user_accounts LIMIT 1)) RETURNING id",
          [companyId]
        );
        return result.rows[0].id as string;
      });
      const payslip2 = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          `INSERT INTO payslips (company_id, payroll_run_id, employee_id, employee_number, days_in_period, paid_days, unpaid_leave_days,
             gross_pay, taxable_gross_this_period, taxable_annual_income, income_tax_monthly, eobi_employee_contribution,
             eobi_employer_contribution, social_security_employer_contribution, net_pay, calculation_breakdown)
           VALUES ($1,$2,$3,'EL-PAY',30,30,0,100000,100000,1200000,0,0,0,0,94000,'[]'::jsonb) RETURNING id`,
          [companyId, run2, payEmployee]
        );
        return result.rows[0].id as string;
      });
      await db.withClaims(hrAdminClaims, (client) =>
        loans.recordRepaymentWithinTransaction(client, { loanId: loan.id, payrollRunId: run2, payslipId: payslip2, amount: 6000 })
      );
      const final = await loans.list(hrAdminClaims, payEmployee);
      const finalLoan = final.find((l) => l.id === loan.id)!;
      expect(finalLoan.outstandingBalance).toBe(0);
      expect(finalLoan.status).toBe("closed");
    });
  });
});
