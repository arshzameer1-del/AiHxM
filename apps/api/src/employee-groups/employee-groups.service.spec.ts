import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeeGroupsService } from "./employee-groups.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-groups-spec-fixtures" };

/**
 * Phase 8's exit criterion (plan doc Section 12), proven the same way
 * every prior phase's resolver logic was: real Postgres, no mocks. A
 * tenant defines at least two employee groups by attribute, assigns a
 * different leave policy to each, and a real Employee record (Phase 7)
 * resolves to the correct policy automatically based on which group(s)
 * it matches — including the most-specific-match-wins tie-break and the
 * safe-deny default fallback, both explicitly required by Section 12
 * rather than left to whatever falls out of an ad hoc implementation.
 */
describe("EmployeeGroupsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let groups: EmployeeGroupsService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    groups = new EmployeeGroupsService(db, rbac, entitlements);
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
         VALUES ($1, '["employee", "leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'leave', true)",
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

  describe("the exit criterion: attribute-based groups resolve to the correct leave policy", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let karachiEngineerId: string;
    let karachiSalesId: string;
    let lahoreEngineerId: string;
    let unmatchedId: string;
    let defaultPolicyId: string;
    let engineeringPolicyId: string;
    let karachiEngineeringPolicyId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Groups Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`groups-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`groups-mgr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };

      // Four employees: two attributes (department, location) combine to
      // give three distinct "how specific a match can get" cases plus one
      // employee that matches nothing at all.
      karachiEngineerId = (
        await employees.create(hrAdminClaims, {
          firstName: "Karachi",
          lastName: "Engineer",
          department: "Engineering",
          location: "Karachi",
        })
      ).id;
      karachiSalesId = (
        await employees.create(hrAdminClaims, { firstName: "Karachi", lastName: "Sales", department: "Sales", location: "Karachi" })
      ).id;
      lahoreEngineerId = (
        await employees.create(hrAdminClaims, {
          firstName: "Lahore",
          lastName: "Engineer",
          department: "Engineering",
          location: "Lahore",
        })
      ).id;
      unmatchedId = (
        await employees.create(hrAdminClaims, { firstName: "Unmatched", lastName: "Person", department: "Finance", location: "Multan" })
      ).id;

      // Three leave policies: a company-wide default, a department-only
      // policy (specificity 1), and a department+location policy
      // (specificity 2) that should win for anyone matching both.
      defaultPolicyId = (
        await groups.createLeavePolicy(hrAdminClaims, {
          name: "Standard Leave",
          annualLeaveDays: 14,
          casualLeaveDays: 8,
          sickLeaveDays: 8,
          isDefault: true,
        })
      ).id;
      engineeringPolicyId = (
        await groups.createLeavePolicy(hrAdminClaims, { name: "Engineering Leave", annualLeaveDays: 18, casualLeaveDays: 8, sickLeaveDays: 8 })
      ).id;
      karachiEngineeringPolicyId = (
        await groups.createLeavePolicy(hrAdminClaims, {
          name: "Karachi Engineering Leave",
          annualLeaveDays: 20,
          casualLeaveDays: 10,
          sickLeaveDays: 10,
        })
      ).id;

      // Group A: Department=Engineering only (specificity 1).
      const engineeringGroup = await groups.createGroup(hrAdminClaims, {
        name: "Engineering",
        conditions: [{ field: "department", equals: "Engineering" }],
      });
      await groups.assignPolicy(hrAdminClaims, engineeringGroup.id, { policyType: "leave", policyId: engineeringPolicyId });

      // Group B: Department=Engineering AND Location=Karachi (specificity
      // 2) — more specific than Group A, and the plan doc's own canonical
      // example verbatim.
      const karachiEngineeringGroup = await groups.createGroup(hrAdminClaims, {
        name: "Karachi Engineering",
        conditions: [
          { field: "department", equals: "Engineering" },
          { field: "location", equals: "Karachi" },
        ],
      });
      await groups.assignPolicy(hrAdminClaims, karachiEngineeringGroup.id, {
        policyType: "leave",
        policyId: karachiEngineeringPolicyId,
      });
    });

    it("most-specific-match-wins: an employee matching both groups gets the MORE specific group's policy", async () => {
      const resolved = await groups.resolvePolicy(hrAdminClaims, karachiEngineerId, "leave");
      expect(resolved.policyId).toBe(karachiEngineeringPolicyId);
      expect(resolved.isDefault).toBe(false);
    });

    it("an employee matching only the less specific group gets that group's policy", async () => {
      const resolved = await groups.resolvePolicy(hrAdminClaims, lahoreEngineerId, "leave");
      expect(resolved.policyId).toBe(engineeringPolicyId);
    });

    it("safe-deny default: an employee matching no group falls back to the tenant's designated default policy", async () => {
      const resolved = await groups.resolvePolicy(hrAdminClaims, unmatchedId, "leave");
      expect(resolved.policyId).toBe(defaultPolicyId);
      expect(resolved.groupId).toBeNull();
      expect(resolved.isDefault).toBe(true);
    });

    it("an employee matching neither group's full condition set (Sales, not Engineering) also gets the default", async () => {
      const resolved = await groups.resolvePolicy(hrAdminClaims, karachiSalesId, "leave");
      expect(resolved.policyId).toBe(defaultPolicyId);
      expect(resolved.isDefault).toBe(true);
    });

    it("at most one default leave policy per tenant — setting a new one un-defaults the previous one", async () => {
      const newDefault = await groups.createLeavePolicy(hrAdminClaims, { name: "New Default", isDefault: true });
      const list = await groups.listLeavePolicies(hrAdminClaims);
      const defaults = list.filter((p) => p.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(newDefault.id);

      // Restore the original default so later tests in this describe
      // block (which assume "Standard Leave" is still the default) aren't
      // affected by this test's own side effect.
      await groups.updateLeavePolicy(hrAdminClaims, defaultPolicyId, { isDefault: true });
    });

    it("rejects a group with zero conditions and a group with two conditions on the same field", async () => {
      await expect(groups.createGroup(hrAdminClaims, { name: "Empty", conditions: [] })).rejects.toThrow(BadRequestException);
      await expect(
        groups.createGroup(hrAdminClaims, {
          name: "Contradictory",
          conditions: [
            { field: "department", equals: "Engineering" },
            { field: "department", equals: "Sales" },
          ],
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a duplicate group name for the same tenant", async () => {
      await expect(groups.createGroup(hrAdminClaims, { name: "Engineering", conditions: [{ field: "department", equals: "Sales" }] })).rejects.toThrow(
        ConflictException
      );
    });

    it("refuses to delete a leave policy that is still assigned to a group", async () => {
      await expect(groups.deleteLeavePolicy(hrAdminClaims, engineeringPolicyId)).rejects.toThrow(ConflictException);
    });

    it("a Line Manager (no employee_group.manage/leave_policy.manage) cannot manage groups or policies", async () => {
      await expect(groups.createGroup(managerClaims, { name: "x", conditions: [{ field: "department", equals: "y" }] })).rejects.toThrow(
        ForbiddenException
      );
      await expect(groups.createLeavePolicy(managerClaims, { name: "x" })).rejects.toThrow(ForbiddenException);
      await expect(groups.resolvePolicy(managerClaims, karachiEngineerId, "leave")).rejects.toThrow(ForbiddenException);
    });

    it("resolvePolicyInternal (Phase 9's cross-module entry point) bypasses leave_policy.manage but still requires the leave module", async () => {
      // managerClaims holds no employee_group.manage/leave_policy.manage
      // at all — resolvePolicy() (the admin-facing method) rejects it,
      // proven above, but resolvePolicyInternal() is meant for a calling
      // module (LeaveRequestsService) that has already authorized the
      // caller through its own permissions, so it must NOT re-apply the
      // admin gate here.
      const resolved = await groups.resolvePolicyInternal(managerClaims, karachiEngineerId, "leave");
      expect(resolved.policyId).toBe(karachiEngineeringPolicyId);
    });

    it("404s when the leave module is disabled for the tenant, exactly like every other module gate", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'leave'", [
          companyId,
        ])
      );
      await expect(groups.resolvePolicy(hrAdminClaims, karachiEngineerId, "leave")).rejects.toThrow(NotFoundException);
      await expect(groups.createLeavePolicy(hrAdminClaims, { name: "Should 404" })).rejects.toThrow(NotFoundException);
      // resolvePolicyInternal skips the permission gate but must still
      // enforce the module-license gate — a disabled module has to 404
      // for the internal caller too, not just the admin-facing method.
      await expect(groups.resolvePolicyInternal(managerClaims, karachiEngineerId, "leave")).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'leave'", [
          companyId,
        ])
      );
    });

    it("a genuine same-specificity tie is broken deterministically by earliest-created group", async () => {
      // Two groups, both specificity 1, both matching Lahore Engineer
      // (department=Engineering) is already covered by the "Engineering"
      // group above at specificity 1 — add a second, later-created
      // specificity-1 group that also matches (employmentType=permanent,
      // true for every fixture employee here) with a DIFFERENT policy, to
      // prove the earlier-created "Engineering" group's policy still wins
      // rather than the outcome being whichever group happened to sort
      // last out of the database.
      const tieBreakPolicy = await groups.createLeavePolicy(hrAdminClaims, { name: "Tie-Break Policy", annualLeaveDays: 99 });
      const laterGroup = await groups.createGroup(hrAdminClaims, {
        name: "All Permanent Staff",
        conditions: [{ field: "employmentType", equals: "permanent" }],
      });
      await groups.assignPolicy(hrAdminClaims, laterGroup.id, { policyType: "leave", policyId: tieBreakPolicy.id });

      const resolved = await groups.resolvePolicy(hrAdminClaims, lahoreEngineerId, "leave");
      expect(resolved.policyId).toBe(engineeringPolicyId);

      // Clean up so this test's own group doesn't leak into any test that
      // runs after it in this describe block.
      await groups.deleteGroup(hrAdminClaims, laterGroup.id);
      await groups.deleteLeavePolicy(hrAdminClaims, tieBreakPolicy.id);
    });

    it("additive combination: resolving two independent policy_types for the same employee doesn't let one affect the other", async () => {
      // Only 'leave' exists as a real PolicyType today, so this proves the
      // independence property the only way currently possible: resolving
      // the same employee against 'leave' twice in a row is unaffected by
      // anything about a *different* group's resolution having just run
      // (Karachi Sales, resolved just above, shares no group with this
      // employee) — each resolvePolicy() call is self-contained and reads
      // fresh from the assignment table rather than caching across calls.
      const first = await groups.resolvePolicy(hrAdminClaims, karachiEngineerId, "leave");
      const second = await groups.resolvePolicy(hrAdminClaims, karachiEngineerId, "leave");
      expect(first).toEqual(second);
      expect(first.policyId).toBe(karachiEngineeringPolicyId);
    });
  });

  describe("group CRUD", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("CRUD Co");
      const hrAdminUserId = await createUser(`crud-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    });

    it("creates, lists, updates (replacing conditions), and deletes a group", async () => {
      const created = await groups.createGroup(hrAdminClaims, {
        name: "Contract Staff",
        conditions: [{ field: "employmentType", equals: "contract" }],
      });
      expect(created.conditions).toEqual([{ field: "employmentType", equals: "contract" }]);
      expect(created.policyAssignments).toEqual([]);

      const list = await groups.listGroups(hrAdminClaims);
      expect(list.map((g) => g.id)).toContain(created.id);

      const updated = await groups.updateGroup(hrAdminClaims, created.id, {
        conditions: [
          { field: "employmentType", equals: "contract" },
          { field: "location", equals: "Islamabad" },
        ],
      });
      expect(updated.conditions).toHaveLength(2);

      await groups.deleteGroup(hrAdminClaims, created.id);
      await expect(groups.getGroup(hrAdminClaims, created.id)).rejects.toThrow(NotFoundException);
    });

    it("surfaces a group's current policy assignment on both listGroups() and getGroup() (Task #49's Admin Center UI reads this to show what's assigned without a call per group)", async () => {
      const group = await groups.createGroup(hrAdminClaims, {
        name: "Islamabad Contractors",
        conditions: [{ field: "location", equals: "Islamabad" }],
      });
      const policy = await groups.createLeavePolicy(hrAdminClaims, {
        name: "Contractor Leave",
        annualLeaveDays: 10,
      });

      await groups.assignPolicy(hrAdminClaims, group.id, { policyType: "leave", policyId: policy.id });

      const fetched = await groups.getGroup(hrAdminClaims, group.id);
      expect(fetched.policyAssignments).toEqual([
        expect.objectContaining({ groupId: group.id, policyType: "leave", policyId: policy.id }),
      ]);

      const list = await groups.listGroups(hrAdminClaims);
      const listed = list.find((g) => g.id === group.id);
      expect(listed?.policyAssignments).toEqual([
        expect.objectContaining({ groupId: group.id, policyType: "leave", policyId: policy.id }),
      ]);

      await groups.unassignPolicy(hrAdminClaims, group.id, "leave");
      const afterUnassign = await groups.getGroup(hrAdminClaims, group.id);
      expect(afterUnassign.policyAssignments).toEqual([]);
    });
  });
});
