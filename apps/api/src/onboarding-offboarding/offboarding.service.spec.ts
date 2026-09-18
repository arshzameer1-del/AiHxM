import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OffboardingService } from "./offboarding.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "offboarding-spec-fixtures" };

/**
 * Real Postgres, no mocks. Covers the same item-template CRUD and
 * self/team/all scoping shape OnboardingService's own spec covers, plus
 * the one thing offboarding has that onboarding doesn't: `complete()`
 * genuinely terminating the employee via the real `EmployeesService.
 * update()` (not a duplicated code path), gated on every item first
 * being out of `pending`.
 */
describe("OffboardingService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let offboarding: OffboardingService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    offboarding = new OffboardingService(db, rbac, entitlements, audit, employees);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureCompany(namePrefix: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `${namePrefix} ${stamp}`,
        `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${stamp}`,
      ]);
      const companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "exit"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'exit', true)",
        [companyId]
      );
      return companyId as string;
    });
  }

  async function createUser(email: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function assignRole(userAccountId: string, companyId: string, roleKey: string) {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [userAccountId, companyId, role.rows[0].id]
      );
    });
  }

  async function linkEmployeeToUser(employeeId: string, userAccountId: string) {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [userAccountId, employeeId])
    );
  }

  async function getEmploymentStatus(employeeId: string) {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("SELECT employment_status, termination_date, termination_reason FROM employees WHERE id = $1", [
        employeeId,
      ]);
      return result.rows[0];
    });
  }

  describe("item templates", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let staffClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Offboarding Templates Co");
      const hrAdminUserId = await createUser(`off-tmpl-hr-${Date.now()}@example.com`);
      const staffUserId = await createUser(`off-tmpl-staff-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(staffUserId, companyId, "employee_self_service");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
    });

    it("creates, lists, updates, and deactivates a checklist item template", async () => {
      const created = await offboarding.createItemTemplate(hrAdminClaims, {
        title: "Return laptop",
        category: "it",
        responsibleRole: "self",
      });
      expect(created.isActive).toBe(true);

      const updated = await offboarding.updateItemTemplate(hrAdminClaims, created.id, { title: "Return company laptop" });
      expect(updated.title).toBe("Return company laptop");

      await offboarding.deactivateItemTemplate(hrAdminClaims, created.id);
      const listed = await offboarding.listItemTemplates(hrAdminClaims);
      expect(listed.find((t) => t.id === created.id)?.isActive).toBe(false);
    });

    it("rejects a non-hr_admin from managing templates", async () => {
      await expect(
        offboarding.createItemTemplate(staffClaims, { title: "Sneaky", category: "general", responsibleRole: "self" })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("instance lifecycle, scoped access, and finalization", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let staffClaims: RequestClaims;
    let otherStaffClaims: RequestClaims;
    let employeeId: string;
    let selfItemId: string;
    let teamItemId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Offboarding Flow Co");
      const hrAdminUserId = await createUser(`off-flow-hr-${Date.now()}@example.com`);
      const managerUserId = await createUser(`off-flow-mgr-${Date.now()}@example.com`);
      const staffUserId = await createUser(`off-flow-staff-${Date.now()}@example.com`);
      const otherStaffUserId = await createUser(`off-flow-other-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      await assignRole(staffUserId, companyId, "employee_self_service");
      await assignRole(otherStaffUserId, companyId, "employee_self_service");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
      otherStaffClaims = { is_platform_admin: false, company_id: companyId, sub: otherStaffUserId };

      const managerEmployee = await employees.create(hrAdminClaims, { firstName: "Exit", lastName: "Manager" });
      await linkEmployeeToUser(managerEmployee.id, managerUserId);
      const leaver = await employees.create(hrAdminClaims, {
        firstName: "Leaving",
        lastName: "Soon",
        managerId: managerEmployee.id,
      });
      employeeId = leaver.id;
      await linkEmployeeToUser(employeeId, staffUserId);

      await offboarding.createItemTemplate(hrAdminClaims, { title: "Return laptop", category: "it", responsibleRole: "self" });
      await offboarding.createItemTemplate(hrAdminClaims, {
        title: "Conduct exit interview",
        category: "hr",
        responsibleRole: "team",
      });
    });

    it("initiates offboarding, cloning every active template into a real item", async () => {
      const view = await offboarding.initiateOffboarding(hrAdminClaims, employeeId, {
        reason: "resignation",
        lastWorkingDay: "2026-12-31",
        notes: "Two weeks' notice given",
      });
      expect(view.status).toBe("in_progress");
      expect(view.employeeName).toBe("Leaving Soon");
      expect(view.employeeNumber).toMatch(/^EMP/);
      expect(view.reason).toBe("resignation");
      expect(view.lastWorkingDay).toBe("2026-12-31");
      expect(view.items).toHaveLength(2);
      selfItemId = view.items.find((i) => i.responsibleRole === "self")!.id;
      teamItemId = view.items.find((i) => i.responsibleRole === "team")!.id;
    });

    it("rejects starting a second offboarding while one is already in progress", async () => {
      await expect(
        offboarding.initiateOffboarding(hrAdminClaims, employeeId, { reason: "termination", lastWorkingDay: "2026-11-01" })
      ).rejects.toThrow(ConflictException);
    });

    it("lets the employee, their manager, and hr_admin each view it; a stranger cannot", async () => {
      expect((await offboarding.getForEmployee(staffClaims, employeeId))?.items).toHaveLength(2);
      expect((await offboarding.getForEmployee(managerClaims, employeeId))?.items).toHaveLength(2);
      expect((await offboarding.getForEmployee(hrAdminClaims, employeeId))?.items).toHaveLength(2);
      await expect(offboarding.getForEmployee(otherStaffClaims, employeeId)).rejects.toThrow(ForbiddenException);
    });

    it("rejects finalizing while checklist items are still pending", async () => {
      await expect(offboarding.completeOffboarding(hrAdminClaims, employeeId)).rejects.toThrow(BadRequestException);
    });

    it("lets the employee complete their own item but not the manager's item", async () => {
      await offboarding.updateItem(staffClaims, selfItemId, { status: "completed" });
      await expect(offboarding.updateItem(staffClaims, teamItemId, { status: "completed" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("lets the manager complete their own item", async () => {
      const updated = await offboarding.updateItem(managerClaims, teamItemId, { status: "skipped" });
      expect(updated.status).toBe("skipped");
    });

    it("finalizes the offboarding once every item is out of 'pending', genuinely terminating the employee", async () => {
      const before = await getEmploymentStatus(employeeId);
      expect(before.employment_status).not.toBe("terminated");

      const view = await offboarding.completeOffboarding(hrAdminClaims, employeeId);
      expect(view.status).toBe("completed");
      expect(view.completedAt).toBeDefined();

      const after = await getEmploymentStatus(employeeId);
      expect(after.employment_status).toBe("terminated");
      expect(new Date(after.termination_date).toISOString().slice(0, 10)).toBe("2026-12-31");
      expect(after.termination_reason).toBe("resignation");
    });

    it("rejects starting a new offboarding for an employee already terminated by the prior one", async () => {
      await expect(
        offboarding.initiateOffboarding(hrAdminClaims, employeeId, { reason: "other", lastWorkingDay: "2027-01-01" })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects finalizing an offboarding that doesn't exist / isn't in progress", async () => {
      const fresh = await employees.create(hrAdminClaims, { firstName: "Never", lastName: "Offboarded" });
      await expect(offboarding.completeOffboarding(hrAdminClaims, fresh.id)).rejects.toThrow(NotFoundException);
    });

    it("lists the current in-progress offboardings for hr_admin only", async () => {
      const fresh = await employees.create(hrAdminClaims, { firstName: "Currently", lastName: "Exiting" });
      await offboarding.initiateOffboarding(hrAdminClaims, fresh.id, { reason: "retirement", lastWorkingDay: "2026-10-01" });

      const inProgress = await offboarding.listInProgress(hrAdminClaims);
      expect(inProgress.some((o) => o.employeeId === fresh.id)).toBe(true);
      // the earlier employee's offboarding was already finalized above
      expect(inProgress.some((o) => o.employeeId === employeeId)).toBe(false);

      await expect(offboarding.listInProgress(staffClaims)).rejects.toThrow(ForbiddenException);
    });
  });
});
