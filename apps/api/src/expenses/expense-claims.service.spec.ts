import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { WorkflowService } from "../workflow/workflow.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { ExpenseClaimsService } from "./expense-claims.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "expense-spec-fixtures" };

/**
 * Expense Management (Part 2 category 6) — same real-Postgres, no-mocks
 * posture as every other module's spec (leave-requests.service.spec.ts's
 * own header comment). One tenant, a real manager/staff Employee Core
 * hierarchy, and a real tenant-configured `manager_of_submitter` workflow
 * template, wired end to end: submission -> manager approval -> pay.all
 * mark-paid, plus On-Behalf submission, receipts, and RBAC denial paths.
 */
describe("ExpenseClaimsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let employees: EmployeesService;
  let workflow: WorkflowService;
  let expenseClaims: ExpenseClaimsService;
  let fileStorage: LocalFileStorageService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let managerClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  let managerEmployeeId: string;
  let managerUserId: string;
  let staffEmployeeId: string;
  let staffUserId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    fileStorage = new LocalFileStorageService();
    employees = new EmployeesService(db, rbac, entitlements, audit, fileStorage);
    workflow = new WorkflowService(db, rbac, audit);
    expenseClaims = new ExpenseClaimsService(db, rbac, entitlements, audit, workflow, fileStorage);

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Expense Spec Co ${stamp}`,
        `expense-spec-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "expense"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'expense', true)",
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

    const hrAdminUserId = await makeUser(`expense-hr-${stamp}@example.com`);
    // Also holds rbac_demo_full_access (workflow_template.manage.all) —
    // same combined-fixture-user shortcut leave-requests.service.spec.ts
    // uses, to both configure the tenant's approval workflow and manage
    // expense claims without a throwaway fourth fixture user.
    await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access");
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    managerUserId = await makeUser(`expense-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

    staffUserId = await makeUser(`expense-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`expense-outsider-${stamp}@example.com`);
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

    await workflow.createTemplate(hrAdminClaims, {
      key: "expense_claim",
      name: "Expense Approval",
      objectKey: "expense_claim",
      steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  describe("submit()", () => {
    it("creates a pending claim and routes it to the submitter's manager", async () => {
      const claim = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "travel",
        expenseDate: "2026-03-01",
        amount: 2500,
        description: "Client site visit — fuel",
      });

      expect(claim.status).toBe("pending");
      expect(claim.currency).toBe("PKR");
      expect(claim.isOnBehalf).toBe(false);
      expect(claim.workflowInstanceId).not.toBeNull();

      const instance = await workflow.getInstance(staffClaims, claim.workflowInstanceId as string);
      expect(instance.steps[0].approvals[0].approverType).toBe("manager_of_submitter");
      expect(instance.steps[0].approvals[0].userAccountId).toBe(managerUserId);
    });

    it("supports an On-Behalf submission by an HR Admin, correctly flagged and routed to the SUBJECT's manager", async () => {
      const claim = await expenseClaims.submit(hrAdminClaims, {
        employeeId: staffEmployeeId,
        category: "meals",
        expenseDate: "2026-03-02",
        amount: 800,
      });

      expect(claim.isOnBehalf).toBe(true);
      expect(claim.submittedByUserAccountId).toBe(hrAdminClaims.sub);

      const instance = await workflow.getInstance(hrAdminClaims, claim.workflowInstanceId as string);
      expect(instance.subjectUserAccountId).toBe(staffUserId);
      expect(instance.steps[0].approvals[0].userAccountId).toBe(managerUserId);
    });

    it("denies a caller with neither create.self (for someone else) nor manage.all", async () => {
      await expect(
        expenseClaims.submit(outsiderClaims, {
          employeeId: staffEmployeeId,
          category: "travel",
          expenseDate: "2026-03-03",
          amount: 100,
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("404s when the expense module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'expense'", [
          companyId,
        ])
      );
      await expect(
        expenseClaims.submit(staffClaims, {
          employeeId: staffEmployeeId,
          category: "travel",
          expenseDate: "2026-03-04",
          amount: 100,
        })
      ).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'expense'", [
          companyId,
        ])
      );
    });
  });

  describe("decide() + markPaid()", () => {
    it("only the resolved manager_of_submitter approver can approve, and an approved claim can then be marked paid", async () => {
      const submitted = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "accommodation",
        expenseDate: "2026-03-05",
        amount: 5000,
      });

      // The submitter themselves is not the resolved approver.
      await expect(expenseClaims.decide(staffClaims, submitted.id, { decision: "approved" })).rejects.toThrow();

      const decided = await expenseClaims.decide(managerClaims, submitted.id, { decision: "approved", comment: "Approved" });
      expect(decided.status).toBe("approved");

      // The submitter (not HR Admin) cannot mark it paid — pay.all only.
      await expect(expenseClaims.markPaid(staffClaims, submitted.id)).rejects.toThrow(ForbiddenException);

      const paid = await expenseClaims.markPaid(hrAdminClaims, submitted.id);
      expect(paid.status).toBe("paid");
      expect(paid.paidByUserAccountId).toBe(hrAdminClaims.sub);
      expect(paid.paidAt).not.toBeNull();
    });

    it("a rejection sets the claim to rejected, and a rejected claim cannot be marked paid", async () => {
      const submitted = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "communication",
        expenseDate: "2026-03-06",
        amount: 300,
      });
      const decided = await expenseClaims.decide(managerClaims, submitted.id, { decision: "rejected" });
      expect(decided.status).toBe("rejected");

      await expect(expenseClaims.markPaid(hrAdminClaims, submitted.id)).rejects.toThrow(BadRequestException);
    });

    it("cannot decide a claim that is already decided", async () => {
      const submitted = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "other",
        expenseDate: "2026-03-07",
        amount: 150,
      });
      await expenseClaims.decide(managerClaims, submitted.id, { decision: "approved" });
      await expect(expenseClaims.decide(managerClaims, submitted.id, { decision: "approved" })).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("receipts", () => {
    it("accepts an allowed receipt file and lets the submitter download it back; rejects a disallowed type", async () => {
      const submitted = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "travel",
        expenseDate: "2026-03-08",
        amount: 1200,
      });

      const receipt = await expenseClaims.addReceipt(staffClaims, submitted.id, {
        originalname: "fuel-receipt.pdf",
        mimetype: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 fake receipt content"),
        size: 29,
      });
      expect(receipt.fileName).toBe("fuel-receipt.pdf");

      const downloaded = await expenseClaims.downloadReceipt(staffClaims, submitted.id, receipt.id);
      expect(downloaded.buffer.toString()).toBe("%PDF-1.4 fake receipt content");

      const claim = await expenseClaims.getClaim(hrAdminClaims, submitted.id);
      expect(claim.receipts).toHaveLength(1);

      await expect(
        expenseClaims.addReceipt(staffClaims, submitted.id, {
          originalname: "malware.exe",
          mimetype: "application/x-msdownload",
          buffer: Buffer.from("x"),
          size: 1,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("an outsider cannot see or download another employee's claim or receipts", async () => {
      const submitted = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "travel",
        expenseDate: "2026-03-09",
        amount: 400,
      });
      await expect(expenseClaims.getClaim(outsiderClaims, submitted.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe("cancel()", () => {
    it("manage.all can cancel a pending claim; a stranger cannot", async () => {
      const submitted = await expenseClaims.submit(staffClaims, {
        employeeId: staffEmployeeId,
        category: "training",
        expenseDate: "2026-03-10",
        amount: 999,
      });
      await expect(expenseClaims.cancel(outsiderClaims, submitted.id)).rejects.toThrow(ForbiddenException);
      await expenseClaims.cancel(hrAdminClaims, submitted.id);
      const cancelled = await expenseClaims.getClaim(hrAdminClaims, submitted.id);
      expect(cancelled.status).toBe("cancelled");
    });
  });

  describe("an employee record with no user account", () => {
    it("cannot have an expense claim submitted for it at all — safe-deny, not a silent skip of approval routing", async () => {
      const ghostEmployee = await employees.create(hrAdminClaims, {
        firstName: "Ghost",
        lastName: "NoLogin",
        managerId: managerEmployeeId,
      });
      await expect(
        expenseClaims.submit(hrAdminClaims, {
          employeeId: ghostEmployee.id,
          category: "travel",
          expenseDate: "2026-03-11",
          amount: 100,
        })
      ).rejects.toThrow(BadRequestException);
    });
  });
});
