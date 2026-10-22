import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { RolesService } from "../rbac/roles.service";
import { verifyPassword } from "../auth/password";
import { SystemAdminService } from "./system-admin.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "system-admin-spec-fixtures" };

/**
 * Decision #20 (Task #52) — proves, against real Postgres (no mocks), the
 * two things this module exists for: (1) a real tenant role — not the
 * Phase 4 `rbac_demo_full_access` proof-of-concept role — can configure a
 * workflow template, closing the P0 gap Decisions #18/#19 both named; and
 * (2) role assignment is genuinely self-service for a tenant's own System
 * Admin, correctly scoped to their own company (never another tenant's).
 * This suite is the committed, CI-run counterpart to the throwaway
 * Playwright/curl fixture used to verify this interactively — see
 * DECISIONS.md's Decision #20 entry.
 */
describe("SystemAdminService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let employees: EmployeesService;
  let systemAdmin: SystemAdminService;

  let companyId: string;
  let otherCompanyId: string;
  let ayeshaId: string; // hr_admin
  let bilalId: string; // will get a login + system_admin
  let sanaId: string; // deliberately never gets a login
  let otherCoEmployeeId: string;

  let ayeshaClaims: RequestClaims;
  let bilalClaims: RequestClaims;
  let sanaSelfServiceClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    workflow = new WorkflowService(db, rbac, audit);
    employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    systemAdmin = new SystemAdminService(db, rbac, audit);

    const stamp = Date.now();

    async function makeCompany(name: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
          name,
          `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`,
        ]);
        const id = company.rows[0].id as string;
        await client.query(
          `INSERT INTO company_config (company_id, employee_number_format)
           VALUES ($1, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
          [id]
        );
        await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
          id,
        ]);
        return id;
      });
    }

    async function makeEmployee(cId: string, num: string, first: string, last: string, email: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, email, employment_type, employment_status, date_of_joining)
           VALUES ($1,$2,$3,$4,$5,'permanent','active', now()) RETURNING id`,
          [cId, num, first, last, email]
        );
        return result.rows[0].id as string;
      });
    }

    companyId = await makeCompany(`SysAdmin Spec Co ${stamp}`);
    otherCompanyId = await makeCompany(`SysAdmin Spec Other Co ${stamp}`);

    ayeshaId = await makeEmployee(companyId, "EMP-0001", "Ayesha", "Khan", `sysadmin-spec-ayesha-${stamp}@example.com`);
    bilalId = await makeEmployee(companyId, "EMP-0002", "Bilal", "Ahmed", `sysadmin-spec-bilal-${stamp}@example.com`);
    sanaId = await makeEmployee(companyId, "EMP-0003", "Sana", "Riaz", `sysadmin-spec-sana-${stamp}@example.com`);
    otherCoEmployeeId = await makeEmployee(otherCompanyId, "OTH-0001", "Other", "Tenant", `sysadmin-spec-other-${stamp}@example.com`);

    // Bootstrap Ayesha as the company's first hr_admin login — the same
    // staff-mediated bootstrap step every prior phase's fixture has needed
    // (see 0024_system_admin.sql's own "Bootstrap note").
    const ayeshaUserAccountId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const acct = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `sysadmin-spec-ayesha-${stamp}@example.com`,
      ]);
      await client.query("UPDATE employees SET user_account_id = $1 WHERE id = $2", [acct.rows[0].id, ayeshaId]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        acct.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return acct.rows[0].id as string;
    });
    ayeshaClaims = { is_platform_admin: false, company_id: companyId, sub: ayeshaUserAccountId };

    // Ayesha (hr_admin) creates Bilal's login and grants system_admin —
    // through the real, already-tested createLogin() path, widened by
    // Decision #20 to allow granting this fourth role.
    const { rolesGranted } = await employees.createLogin(ayeshaClaims, bilalId, {
      initialPassword: "Password123!",
      roleKeys: ["system_admin"],
    });
    expect(rolesGranted).toEqual(["system_admin"]);
    const bilalUserAccountId = await db.withClaims({ ...FIXTURE_CLAIMS, company_id: companyId }, async (client) => {
      const r = await client.query("SELECT user_account_id FROM employees WHERE id = $1", [bilalId]);
      return r.rows[0].user_account_id as string;
    });
    bilalClaims = { is_platform_admin: false, company_id: companyId, sub: bilalUserAccountId };

    const sanaUserAccountId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const acct = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `sysadmin-spec-sana-login-${stamp}@example.com`,
      ]);
      const role = await client.query("SELECT id FROM roles WHERE key = 'employee_self_service'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        acct.rows[0].id,
        companyId,
        role.rows[0].id,
      ]);
      return acct.rows[0].id as string;
    });
    sanaSelfServiceClaims = { is_platform_admin: false, company_id: companyId, sub: sanaUserAccountId };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]])
    );
    await pool.end();
  });

  describe("listAssignableRoles", () => {
    it("returns the six real tenant roles, never the Phase 4 rbac_demo_* roles", async () => {
      const roles = await systemAdmin.listAssignableRoles(bilalClaims);
      const keys = roles.map((r) => r.key).sort();
      expect(keys).toEqual([
        "employee_self_service",
        "ess_portal",
        "hr_admin",
        "line_manager",
        "payroll_approver",
        "system_admin",
      ]);
    });

    it("denies a caller with no role_assignment.manage.all", async () => {
      await expect(systemAdmin.listAssignableRoles(sanaSelfServiceClaims)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listAssignableUsers", () => {
    it("lists every employee in the company with their login/role status, without leaking sensitive employee fields", async () => {
      const users = await systemAdmin.listAssignableUsers(bilalClaims);
      expect(users).toHaveLength(3);
      const ayesha = users.find((u) => u.employeeId === ayeshaId)!;
      const bilal = users.find((u) => u.employeeId === bilalId)!;
      const sana = users.find((u) => u.employeeId === sanaId)!;
      expect(ayesha.roleKeys).toEqual(["hr_admin"]);
      expect(bilal.roleKeys).toEqual(["system_admin"]);
      expect(sana.hasLogin).toBe(false);
      expect(sana.roleKeys).toEqual([]);
      // Deliberately not EmployeeView — no cnic/salaryBand/etc. keys at all.
      expect(Object.keys(ayesha).sort()).toEqual(
        ["email", "employeeId", "employeeNumber", "fullName", "hasLogin", "roleKeys", "userAccountId"].sort()
      );
    });
  });

  describe("assignRole / revokeRole", () => {
    it("promotes Ayesha to also hold system_admin (additive, multi-role)", async () => {
      const assignment = await systemAdmin.assignRole(bilalClaims, { employeeId: ayeshaId, roleKey: "system_admin" });
      expect(assignment.roleKey).toBe("system_admin");
      expect(assignment.employeeName).toBe("Ayesha Khan");

      const users = await systemAdmin.listAssignableUsers(bilalClaims);
      const ayesha = users.find((u) => u.employeeId === ayeshaId)!;
      expect(ayesha.roleKeys.sort()).toEqual(["hr_admin", "system_admin"]);

      await systemAdmin.revokeRole(bilalClaims, assignment.id);
      const usersAfter = await systemAdmin.listAssignableUsers(bilalClaims);
      expect(usersAfter.find((u) => u.employeeId === ayeshaId)!.roleKeys).toEqual(["hr_admin"]);
    });

    it("grants payroll_approver (regression: this role briefly existed in the roles table but was missing from ASSIGNABLE_ROLE_KEYS, so no System Admin could actually grant it)", async () => {
      const assignment = await systemAdmin.assignRole(bilalClaims, { employeeId: ayeshaId, roleKey: "payroll_approver" });
      expect(assignment.roleKey).toBe("payroll_approver");

      const users = await systemAdmin.listAssignableUsers(bilalClaims);
      const ayesha = users.find((u) => u.employeeId === ayeshaId)!;
      expect(ayesha.roleKeys.sort()).toEqual(["hr_admin", "payroll_approver"]);

      await systemAdmin.revokeRole(bilalClaims, assignment.id);
    });

    it("refuses to grant a role to an employee with no login yet", async () => {
      await expect(systemAdmin.assignRole(bilalClaims, { employeeId: sanaId, roleKey: "employee_self_service" })).rejects.toThrow(
        BadRequestException
      );
    });

    it("refuses a duplicate grant", async () => {
      // Bilal already holds system_admin from createLogin() above.
      await expect(systemAdmin.assignRole(bilalClaims, { employeeId: bilalId, roleKey: "system_admin" })).rejects.toThrow(
        ConflictException
      );
    });

    it("never grants a role across tenants — a cross-tenant employeeId 404s, not a silent success", async () => {
      await expect(
        systemAdmin.assignRole(bilalClaims, { employeeId: otherCoEmployeeId, roleKey: "employee_self_service" })
      ).rejects.toThrow(NotFoundException);
    });

    it("404s revoking an assignment from another company", async () => {
      const otherCoAssignment = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const acct = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [
          `sysadmin-spec-other-role-${Date.now()}@example.com`,
        ]);
        const role = await client.query("SELECT id FROM roles WHERE key = 'employee_self_service'");
        const assignment = await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3) RETURNING id",
          [acct.rows[0].id, otherCompanyId, role.rows[0].id]
        );
        return assignment.rows[0].id as string;
      });
      await expect(systemAdmin.revokeRole(bilalClaims, otherCoAssignment)).rejects.toThrow(NotFoundException);
    });

    it("denies a caller with no role_assignment.manage.all", async () => {
      await expect(systemAdmin.assignRole(sanaSelfServiceClaims, { employeeId: bilalId, roleKey: "hr_admin" })).rejects.toThrow(
        ForbiddenException
      );
    });
  });

  describe("the actual P0 fix: a real tenant role, not rbac_demo_full_access, can manage workflow templates", () => {
    it("lets Bilal (system_admin, holds no employee.* permission at all) create a workflow template", async () => {
      const hrAdminRole = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT id FROM roles WHERE key = 'hr_admin'"));
      const template = await workflow.createTemplate(bilalClaims, {
        key: "job_requisition",
        name: "Requisition Approval",
        objectKey: "job_requisition",
        steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: hrAdminRole.rows[0].id }] }],
      });
      expect(template.key).toBe("job_requisition");
    });

    it("still denies a plain employee_self_service session", async () => {
      await expect(
        workflow.createTemplate(sanaSelfServiceClaims, {
          key: "leave_request",
          name: "x",
          objectKey: "leave_request",
          steps: [{ stepOrder: 1, name: "x", approvers: [{ approverType: "manager_of_submitter" }] }],
        })
      ).rejects.toThrow(ForbiddenException);
    });
  });
  describe("custom roles (Roles & Permissions)", () => {
    it("a System Admin can put any permission into a custom role, and the change is audited with the permission list", async () => {
      const roles = new RolesService(db);
      const grantable = await roles.listHeldPermissions(bilalClaims);
      expect(grantable).toContain("employee.view.all");
      expect(grantable.length).toBeGreaterThan(100);

      const custom = await roles.createCustom(bilalClaims, { key: `spec_any_${Date.now() % 100000}`, name: "Any", permissionKeys: ["employee.view.all"] });
      await roles.setPermissions(bilalClaims, custom.id, ["employee.view.all", "leave_request.view.all"]);
      const audit = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const r = await client.query("SELECT metadata FROM audit_log WHERE target = $1 AND action = 'rbac.custom_role_permissions_set'", [custom.id]);
        return r.rows;
      });
      expect(audit[0].metadata.permissionKeys).toEqual(["employee.view.all", "leave_request.view.all"]);

      // Someone without role.manage.all gets nothing to grant and cannot create a role.
      const none = await roles.listHeldPermissions(ayeshaClaims);
      expect(none).toEqual([]);
      await expect(roles.createCustom(ayeshaClaims, { key: "spec_nope", name: "Nope" })).rejects.toThrow(ForbiddenException);
    });

    it("assigns this company's own active custom role to an employee, lists it, and refuses it once deactivated or from another company", async () => {
      const roles = new RolesService(db);
      const custom = await roles.createCustom(bilalClaims, { key: `spec_flow_${Date.now() % 100000}`, name: "Workflow Helper", permissionKeys: ["workflow_template.manage.all"] });

      const assignable = await systemAdmin.listAssignableRoles(bilalClaims);
      expect(assignable.map((r) => r.key)).toContain(custom.key);

      const assignment = await systemAdmin.assignRole(bilalClaims, { employeeId: ayeshaId, roleKey: custom.key });
      expect(assignment.roleName).toBe("Workflow Helper");
      await systemAdmin.revokeRole(bilalClaims, assignment.id);

      await roles.setActive(bilalClaims, custom.id, false);
      await expect(systemAdmin.assignRole(bilalClaims, { employeeId: ayeshaId, roleKey: custom.key })).rejects.toThrow(BadRequestException);
      expect((await systemAdmin.listAssignableRoles(bilalClaims)).map((r) => r.key)).not.toContain(custom.key);

      // A role that belongs to another company is never assignable here.
      const foreignKey = `cffffffff_spec_${Date.now() % 100000}`;
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query("INSERT INTO roles (key, name, company_id) VALUES ($1, 'Foreign', $2)", [foreignKey, otherCompanyId]);
      });
      await expect(systemAdmin.assignRole(bilalClaims, { employeeId: ayeshaId, roleKey: foreignKey })).rejects.toThrow(BadRequestException);
    });
  });
  describe("resetPassword", () => {
    async function passwordFor(employeeId: string): Promise<{ hash: string; id: string }> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const r = await client.query("SELECT ua.id, ua.password_hash FROM employees e JOIN user_accounts ua ON ua.id = e.user_account_id WHERE e.id = $1", [employeeId]);
        return { hash: r.rows[0].password_hash as string, id: r.rows[0].id as string };
      });
    }

    it("a System Admin sets a new password, clears the lockout and signs the person out", async () => {
      const before = await passwordFor(ayeshaId);
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query("UPDATE user_accounts SET failed_login_attempts = 5, locked_until = now() + interval '10 minutes' WHERE id = $1", [before.id]);
        await client.query("INSERT INTO user_sessions (user_account_id, company_id, expires_at) VALUES ($1,$2, now() + interval '1 day')", [before.id, companyId]);
      });

      await systemAdmin.resetPassword(bilalClaims, ayeshaId, "Brand-new-pass-1");

      const after = await passwordFor(ayeshaId);
      expect(after.hash).not.toBe(before.hash);
      expect(await verifyPassword("Brand-new-pass-1", after.hash)).toBe(true);
      const state = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const a = await client.query("SELECT failed_login_attempts, locked_until FROM user_accounts WHERE id = $1", [before.id]);
        const open = await client.query("SELECT count(*)::int AS n FROM user_sessions WHERE user_account_id = $1 AND revoked_at IS NULL", [before.id]);
        return { attempts: a.rows[0].failed_login_attempts, lockedUntil: a.rows[0].locked_until, openSessions: open.rows[0].n };
      });
      expect(state).toEqual({ attempts: 0, lockedUntil: null, openSessions: 0 });
    });

    it("an HR Admin cannot reset the password of a System Admin, but can for an ordinary login", async () => {
      await expect(systemAdmin.resetPassword(ayeshaClaims, bilalId, "Another-pass-123")).rejects.toThrow(ForbiddenException);

      const { rolesGranted } = await employees.createLogin(ayeshaClaims, sanaId, { initialPassword: "Password123!", roleKeys: ["employee_self_service"] });
      expect(rolesGranted).toEqual(["employee_self_service"]);
      await expect(systemAdmin.resetPassword(ayeshaClaims, sanaId, "Another-pass-123")).resolves.toBeUndefined();
    });

    it("refuses an employee with no login, another company's employee, and a caller with no rights", async () => {
      await expect(systemAdmin.resetPassword(bilalClaims, otherCoEmployeeId, "Another-pass-123")).rejects.toThrow(NotFoundException);
      await expect(systemAdmin.resetPassword(sanaSelfServiceClaims, ayeshaId, "Another-pass-123")).rejects.toThrow(ForbiddenException);
    });
  });
});
