import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { OnboardingService } from "./onboarding.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "onboarding-spec-fixtures" };

/**
 * Real Postgres, no mocks — same discipline as every other service spec
 * in this codebase. Covers: item-template CRUD, initiating an onboarding
 * (cloning active templates into real items, guarding duplicate
 * in-progress and terminated-employee cases), self/team/all scoped
 * viewing AND item-completion (narrower than viewing — a manager may see
 * a `self`-responsible item without being allowed to tick it off), and
 * the checklist auto-completing once every item is out of `pending`.
 */
describe("OnboardingService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let onboarding: OnboardingService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    onboarding = new OnboardingService(db, rbac, entitlements, audit);
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
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
         VALUES ($1, '["employee", "recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'recruitment', true)",
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

  describe("item templates", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let staffClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Onboarding Templates Co");
      const hrAdminUserId = await createUser(`onb-tmpl-hr-${Date.now()}@example.com`);
      const staffUserId = await createUser(`onb-tmpl-staff-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(staffUserId, companyId, "employee_self_service");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
    });

    it("creates, lists, updates, and deactivates a checklist item template", async () => {
      const created = await onboarding.createItemTemplate(hrAdminClaims, {
        title: "Set up laptop",
        category: "it",
        responsibleRole: "all",
      });
      expect(created.isActive).toBe(true);

      const listed = await onboarding.listItemTemplates(hrAdminClaims);
      expect(listed.some((t) => t.id === created.id)).toBe(true);

      const updated = await onboarding.updateItemTemplate(hrAdminClaims, created.id, { title: "Provision laptop" });
      expect(updated.title).toBe("Provision laptop");

      await onboarding.deactivateItemTemplate(hrAdminClaims, created.id);
      const afterDeactivate = await onboarding.listItemTemplates(hrAdminClaims);
      expect(afterDeactivate.find((t) => t.id === created.id)?.isActive).toBe(false);
    });

    it("rejects a non-hr_admin from managing templates", async () => {
      await expect(
        onboarding.createItemTemplate(staffClaims, { title: "Sneaky", category: "general", responsibleRole: "self" })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("instance lifecycle and scoped access", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let staffClaims: RequestClaims;
    let otherStaffClaims: RequestClaims;
    let employeeId: string;
    let selfItemId: string;
    let teamItemId: string;
    let allItemId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Onboarding Flow Co");
      const hrAdminUserId = await createUser(`onb-flow-hr-${Date.now()}@example.com`);
      const managerUserId = await createUser(`onb-flow-mgr-${Date.now()}@example.com`);
      const staffUserId = await createUser(`onb-flow-staff-${Date.now()}@example.com`);
      const otherStaffUserId = await createUser(`onb-flow-other-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      await assignRole(staffUserId, companyId, "employee_self_service");
      await assignRole(otherStaffUserId, companyId, "employee_self_service");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };
      staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };
      otherStaffClaims = { is_platform_admin: false, company_id: companyId, sub: otherStaffUserId };

      const managerEmployee = await employees.create(hrAdminClaims, { firstName: "Manager", lastName: "Person" });
      await linkEmployeeToUser(managerEmployee.id, managerUserId);
      const newHire = await employees.create(hrAdminClaims, {
        firstName: "New",
        lastName: "Hire",
        managerId: managerEmployee.id,
      });
      employeeId = newHire.id;
      await linkEmployeeToUser(employeeId, staffUserId);

      await onboarding.createItemTemplate(hrAdminClaims, { title: "Read handbook", category: "hr", responsibleRole: "self" });
      await onboarding.createItemTemplate(hrAdminClaims, {
        title: "Assign onboarding buddy",
        category: "hr",
        responsibleRole: "team",
      });
      await onboarding.createItemTemplate(hrAdminClaims, {
        title: "Provision payroll",
        category: "finance",
        responsibleRole: "all",
      });
    });

    it("rejects initiating onboarding for a nonexistent employee", async () => {
      await expect(
        onboarding.initiateOnboarding(hrAdminClaims, "00000000-0000-0000-0000-000000000000")
      ).rejects.toThrow(NotFoundException);
    });

    it("initiates onboarding, cloning every active template into a real item", async () => {
      const view = await onboarding.initiateOnboarding(hrAdminClaims, employeeId);
      expect(view.status).toBe("in_progress");
      expect(view.employeeName).toBe("New Hire");
      expect(view.employeeNumber).toMatch(/^EMP/);
      expect(view.items).toHaveLength(3);
      selfItemId = view.items.find((i) => i.responsibleRole === "self")!.id;
      teamItemId = view.items.find((i) => i.responsibleRole === "team")!.id;
      allItemId = view.items.find((i) => i.responsibleRole === "all")!.id;
      expect(selfItemId).toBeDefined();
      expect(teamItemId).toBeDefined();
      expect(allItemId).toBeDefined();
    });

    it("rejects starting a second onboarding while one is already in progress", async () => {
      await expect(onboarding.initiateOnboarding(hrAdminClaims, employeeId)).rejects.toThrow(ConflictException);
    });

    it("lets the employee, their manager, and hr_admin each view the checklist; a stranger cannot", async () => {
      const asSelf = await onboarding.getForEmployee(staffClaims, employeeId);
      const asManager = await onboarding.getForEmployee(managerClaims, employeeId);
      const asHr = await onboarding.getForEmployee(hrAdminClaims, employeeId);
      expect(asSelf?.items).toHaveLength(3);
      expect(asManager?.items).toHaveLength(3);
      expect(asHr?.items).toHaveLength(3);

      await expect(onboarding.getForEmployee(otherStaffClaims, employeeId)).rejects.toThrow(ForbiddenException);
    });

    it("lets the employee complete their own 'self' item but not the 'team' or 'all' items", async () => {
      const updated = await onboarding.updateItem(staffClaims, selfItemId, { status: "completed" });
      expect(updated.status).toBe("completed");
      expect(updated.completedAt).toBeDefined();

      await expect(onboarding.updateItem(staffClaims, teamItemId, { status: "completed" })).rejects.toThrow(
        ForbiddenException
      );
      await expect(onboarding.updateItem(staffClaims, allItemId, { status: "completed" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("lets the manager complete the 'team' item but not the 'all' item", async () => {
      const updated = await onboarding.updateItem(managerClaims, teamItemId, { status: "completed" });
      expect(updated.status).toBe("completed");

      await expect(onboarding.updateItem(managerClaims, allItemId, { status: "completed" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("lets hr_admin complete the remaining 'all' item, which auto-completes the onboarding", async () => {
      await onboarding.updateItem(hrAdminClaims, allItemId, { status: "completed" });

      const view = await onboarding.getForEmployee(hrAdminClaims, employeeId);
      expect(view?.status).toBe("completed");
      expect(view?.completedAt).toBeDefined();
    });

    it("rejects a stranger employee from completing any item, even one hr_admin could", async () => {
      await expect(onboarding.updateItem(otherStaffClaims, allItemId, { status: "pending" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("lists the current in-progress onboardings for hr_admin only", async () => {
      const fresh = await employees.create(hrAdminClaims, { firstName: "Second", lastName: "Hire" });
      await onboarding.initiateOnboarding(hrAdminClaims, fresh.id);

      const inProgress = await onboarding.listInProgress(hrAdminClaims);
      expect(inProgress.some((o) => o.employeeId === fresh.id)).toBe(true);
      // the first employee's onboarding auto-completed above, so it must
      // NOT show up in the in-progress list anymore
      expect(inProgress.some((o) => o.employeeId === employeeId)).toBe(false);

      await expect(onboarding.listInProgress(staffClaims)).rejects.toThrow(ForbiddenException);
    });

    it("rejects starting onboarding for an already-terminated employee", async () => {
      const terminated = await employees.create(hrAdminClaims, { firstName: "Already", lastName: "Gone" });
      await employees.update(hrAdminClaims, terminated.id, {
        employmentStatus: "terminated",
        terminationDate: "2026-01-01",
      });
      await expect(onboarding.initiateOnboarding(hrAdminClaims, terminated.id)).rejects.toThrow(BadRequestException);
    });
  });
});
