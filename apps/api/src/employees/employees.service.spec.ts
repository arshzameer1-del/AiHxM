import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employees-spec-fixtures" };

/**
 * Phase 7's exit criterion, proven the same way Phases 4-6 proved theirs:
 * real Postgres, no mocks. Two isolated fixture companies — one just for
 * Employee Number assignment (Section 5), one for the RBAC/org-chart/
 * document-vault/job-history scenario — so neither test group's shared
 * per-company sequence counter or record set leaks into the other's
 * assertions.
 */
describe("EmployeesService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    employees = new EmployeesService(db, new RbacService(db), new EntitlementsService(db), new AuditService(), new LocalFileStorageService());
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
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)",
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

  describe("employee number assignment (plan doc Section 5)", () => {
    let companyId: string;
    let hrAdminUserId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Numbering Co");
      hrAdminUserId = await createUser(`numbering-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    });

    it("assigns sequential numbers in the tenant's configured prefix/padding format", async () => {
      const first = await employees.create(hrAdminClaims, { firstName: "First", lastName: "Employee" });
      const second = await employees.create(hrAdminClaims, { firstName: "Second", lastName: "Employee" });
      expect(first.employeeNumber).toBe("EMP-0001");
      expect(second.employeeNumber).toBe("EMP-0002");
    });

    it("preserves an explicitly supplied legacy number and advances the sequence past it", async () => {
      const legacy = await employees.create(hrAdminClaims, {
        firstName: "Legacy",
        lastName: "Import",
        employeeNumber: "EMP-0050",
      });
      expect(legacy.employeeNumber).toBe("EMP-0050");

      const next = await employees.create(hrAdminClaims, { firstName: "Third", lastName: "Employee" });
      expect(next.employeeNumber).toBe("EMP-0051");
    });

    it("never lets a write path change employeeNumber once assigned", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Stable", lastName: "Number" });
      const updated = await employees.update(hrAdminClaims, created.id, { department: "Ops" });
      expect(updated.employeeNumber).toBe(created.employeeNumber);
    });
  });

  /**
   * Core Employee Enterprise Phase 12 — Bulk Hiring. Same "real
   * Postgres, no mocks" discipline as every other describe block here,
   * proving the real `ImportExportService.parseAndValidate()` +
   * `create()` pipeline end to end, not a stubbed CSV parser.
   */
  describe("bulk hiring / CSV import (Phase 12)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let noPermissionClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Bulk Hiring Co");
      const hrAdminUserId = await createUser(`bulk-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      const outsiderUserId = await createUser(`bulk-outsider-${Date.now()}@example.com`);
      noPermissionClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };
    });

    it("requires employee.manage.all", async () => {
      await expect(employees.bulkImportEmployees(noPermissionClaims, "firstName,lastName\nA,B")).rejects.toThrow(
        ForbiddenException
      );
    });

    it("creates one real employee per valid row, reusing create()'s own number assignment/hire-history logic", async () => {
      const csv = [
        "firstName,lastName,department,designation,salaryBand",
        "Bilal,Ahmed,Engineering,Software Engineer,E3",
        "Sana,Khan,Finance,Accountant,F2",
      ].join("\n");

      const result = await employees.bulkImportEmployees(hrAdminClaims, csv);
      expect(result.imported).toBe(2);
      expect(result.errors).toEqual([]);
      expect(result.rows.map((r) => r.firstName)).toEqual(["Bilal", "Sana"]);
      expect(result.rows[0].employeeNumber).toMatch(/^EMP-\d{4}$/);
      expect(result.rows[1].department).toBe("Finance");

      const history = await employees.listJobHistory(hrAdminClaims, result.rows[0].id);
      expect(history.map((h) => h.eventType)).toEqual(["hire"]);
    });

    it("reports a real per-row error for a structurally invalid row, without blocking the valid ones", async () => {
      const csv = ["firstName,lastName", "OnlyFirst,", "Valid,Row"].join("\n");
      const result = await employees.bulkImportEmployees(hrAdminClaims, csv);
      expect(result.imported).toBe(1);
      expect(result.rows[0].firstName).toBe("Valid");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ row: 2 });
    });

    /**
     * kumail's own live incident (2026-09-27): a bulk-import file with 6
     * unedited copies of the template's example row created 6 real
     * employees all named "Ayesha Khan" — see `bulkImportEmployees()`'s
     * own doc comment for the full story. This is the regression test for
     * the fix: the whole batch is rejected BEFORE anything is created,
     * and none of the duplicated rows (nor any other row in the same
     * file) makes it into the database.
     */
    it("rejects the whole batch when two or more rows are identical, before creating anything", async () => {
      const csv = [
        "firstName,lastName,department,designation",
        "Ayesha,Khan,Engineering,Software Engineer",
        "Ayesha,Khan,Engineering,Software Engineer",
        "Bilal,Rana,Finance,Accountant",
      ].join("\n");

      await expect(employees.bulkImportEmployees(hrAdminClaims, csv)).rejects.toThrow(BadRequestException);

      const list = await employees.list(hrAdminClaims);
      expect(list.some((e) => e.firstName === "Ayesha" && e.lastName === "Khan")).toBe(false);
      expect(list.some((e) => e.firstName === "Bilal" && e.lastName === "Rana")).toBe(false);
    });

    it("does not flag two different rows that merely share a name", async () => {
      const csv = [
        "firstName,lastName,department,designation,email",
        "Ali,Ahmed,Engineering,Software Engineer,ali.ahmed.1@example.com",
        "Ali,Ahmed,Finance,Accountant,ali.ahmed.2@example.com",
      ].join("\n");

      const result = await employees.bulkImportEmployees(hrAdminClaims, csv);
      expect(result.imported).toBe(2);
    });
  });

  /**
   * Core Employee Enterprise Phase 1 (0081_person_identity.sql /
   * persons.service.ts). Covers PersonsService's real matching behavior
   * end to end through EmployeesService.create()/update() — the same
   * "exercise the real service, real Postgres, no mocks" discipline this
   * whole spec file already follows for employee numbering and RBAC.
   */
  describe("person identity (Core Employee Enterprise Phase 1)", () => {
    let companyId: string;
    let hrAdminUserId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Person Identity Co");
      hrAdminUserId = await createUser(`person-identity-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    });

    async function personRow(personId: string) {
      const result = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT * FROM persons WHERE id = $1", [personId]));
      return result.rows[0];
    }

    it("links two hires that share a CNIC to the same person (a rehire, or a data-entry duplicate), and gives a CNIC-less hire a person of their own", async () => {
      const cnic = `${Date.now()}-REHIRE`;
      const firstStint = await employees.create(hrAdminClaims, { firstName: "Rehired", lastName: "Once", cnic });
      const secondStint = await employees.create(hrAdminClaims, { firstName: "Rehired", lastName: "Twice", cnic });
      expect(firstStint.personId).not.toBeNull();
      expect(secondStint.personId).toBe(firstStint.personId);

      const noCnic = await employees.create(hrAdminClaims, { firstName: "No", lastName: "Cnic" });
      expect(noCnic.personId).not.toBeNull();
      expect(noCnic.personId).not.toBe(firstStint.personId);
    });

    it("keeps the derived person record's name in sync when an employee's own name is edited", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Typo", lastName: "Name" });
      await employees.update(hrAdminClaims, created.id, { firstName: "Fixed", lastName: "Name" });
      const person = await personRow(created.personId!);
      expect(person.full_name).toBe("Fixed Name");
    });

    it("does not touch the person record when an update carries no identity-field change", async () => {
      const created = await employees.create(hrAdminClaims, { firstName: "Untouched", lastName: "Person" });
      const before = await personRow(created.personId!);
      await employees.update(hrAdminClaims, created.id, { department: "Ops" });
      const after = await personRow(created.personId!);
      expect(after.updated_at).toEqual(before.updated_at);
    });

    it("rejects editing an employee's CNIC to one already on file for a different employee's person", async () => {
      const cnicInUse = `${Date.now()}-INUSE`;
      await employees.create(hrAdminClaims, { firstName: "Holds", lastName: "TheCnic", cnic: cnicInUse });
      const other = await employees.create(hrAdminClaims, { firstName: "Wants", lastName: "TheCnic" });

      await expect(employees.update(hrAdminClaims, other.id, { cnic: cnicInUse })).rejects.toThrow(BadRequestException);
    });
  });

  describe("employment type validation against the HR Administration catalog (v2, 2026-09-27)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    // A SEPARATE EmployeesService instance, wired with a real
    // HrReferenceCatalogService — the top-level `employees` instance
    // constructed in this file's own `beforeAll` deliberately omits it
    // (undefined, the same optional-dependency shape `webhooks?` already
    // has), so every other describe block above keeps testing the
    // no-catalog-wired code path unchanged. This block is the one that
    // actually proves `employment_type` is enforced end to end.
    let employeesWithCatalog: EmployeesService;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Employment Type Co");
      const hrAdminUserId = await createUser(`employment-type-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      const hrCatalog = new HrReferenceCatalogService(db, rbac, entitlements, audit);
      employeesWithCatalog = new EmployeesService(
        db,
        rbac,
        entitlements,
        audit,
        new LocalFileStorageService(),
        undefined,
        undefined,
        undefined,
        hrCatalog
      );
    });

    it("accepts a seeded default employment type on create", async () => {
      const created = await employeesWithCatalog.create(hrAdminClaims, { firstName: "Valid", lastName: "Type", employmentType: "contract" });
      expect(created.employmentType).toBe("contract");
    });

    it("rejects an employment type that isn't an active catalog item for this company", async () => {
      await expect(
        employeesWithCatalog.create(hrAdminClaims, { firstName: "Bad", lastName: "Type", employmentType: "made_up_type" })
      ).rejects.toThrow(BadRequestException);
    });

    it("accepts a company-added custom employment type once an hr_admin adds it to the catalog", async () => {
      await db.withClaims(hrAdminClaims, (client) =>
        client.query(
          "INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order) VALUES ($1, 'employment_type', 'seasonal', 'Seasonal', 4)",
          [companyId]
        )
      );
      const created = await employeesWithCatalog.create(hrAdminClaims, { firstName: "Custom", lastName: "Type", employmentType: "seasonal" });
      expect(created.employmentType).toBe("seasonal");
    });

    it("also validates employmentType on update()", async () => {
      const created = await employeesWithCatalog.create(hrAdminClaims, { firstName: "Update", lastName: "Target" });
      await expect(employeesWithCatalog.update(hrAdminClaims, created.id, { employmentType: "not_real" })).rejects.toThrow(
        BadRequestException
      );
      const updated = await employeesWithCatalog.update(hrAdminClaims, created.id, { employmentType: "intern" });
      expect(updated.employmentType).toBe("intern");
    });
  });

  describe("business policy enforcement — Probation and Rehire (HR Administration v2 \"then 2\" Phase 2, 2026-10-02)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    // Same "a separate instance, wired with the real service" shape the
    // employment-type block above uses — the top-level `employees`
    // instance omits `businessPolicy` entirely (undefined), so every
    // other describe block in this file keeps testing the
    // no-policy-wired code path unchanged.
    let employeesWithPolicy: EmployeesService;
    let businessPolicy: HrBusinessPolicyService;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Business Policy Co");
      const hrAdminUserId = await createUser(`business-policy-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      businessPolicy = new HrBusinessPolicyService(db, rbac, entitlements, audit);
      employeesWithPolicy = new EmployeesService(
        db,
        rbac,
        entitlements,
        audit,
        new LocalFileStorageService(),
        undefined,
        undefined,
        undefined,
        undefined,
        businessPolicy
      );
    });

    it("auto-computes a probation_end Important Date from the default Probation Policy's durationDays", async () => {
      const created = await employeesWithPolicy.create(hrAdminClaims, {
        firstName: "Proby",
        lastName: "McProbation",
        employmentType: "probation",
        dateOfJoining: "2026-01-01",
      });
      const dates = await db.withClaims(hrAdminClaims, (client) =>
        client.query("SELECT date_type, date_value, label FROM employee_important_dates WHERE employee_id = $1", [created.id])
      );
      expect(dates.rows).toHaveLength(1);
      expect(dates.rows[0].date_type).toBe("probation_end");
      // Default policy is durationDays: 90, counted from 2026-01-01.
      expect(dates.rows[0].date_value.toISOString().slice(0, 10)).toBe("2026-04-01");
      expect(dates.rows[0].label).toBe("Auto-computed from Probation Policy");
    });

    it("does not seed a probation_end date for a non-probation hire", async () => {
      const created = await employeesWithPolicy.create(hrAdminClaims, {
        firstName: "Perm",
        lastName: "Anent",
        employmentType: "permanent",
        dateOfJoining: "2026-01-01",
      });
      const dates = await db.withClaims(hrAdminClaims, (client) =>
        client.query("SELECT 1 FROM employee_important_dates WHERE employee_id = $1", [created.id])
      );
      expect(dates.rowCount).toBe(0);
    });

    it("allows an immediate rehire when the Rehire Policy's cooldownDays is 0 (the seeded default)", async () => {
      const cnic = `${Date.now()}-REHIRE-ALLOWED`;
      const first = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Rehire", lastName: "Allowed", cnic });
      await db.withClaims(hrAdminClaims, (client) =>
        client.query("UPDATE employees SET employment_status = 'terminated', termination_date = CURRENT_DATE WHERE id = $1", [first.id])
      );
      const second = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Rehire", lastName: "Allowed Again", cnic });
      expect(second.personId).toBe(first.personId);
    });

    it("rejects a rehire inside the configured cooldown window, and allows it once the window has passed", async () => {
      const cnic = `${Date.now()}-REHIRE-BLOCKED`;
      const first = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Rehire", lastName: "Blocked", cnic });

      const policyList = await businessPolicy.listPolicies(hrAdminClaims, "rehire");
      await businessPolicy.update(hrAdminClaims, policyList[0].id, { rules: { cooldownDays: 30 } });

      // Terminated yesterday — well inside a 30-day cooldown.
      await db.withClaims(hrAdminClaims, (client) =>
        client.query(
          "UPDATE employees SET employment_status = 'terminated', termination_date = CURRENT_DATE - INTERVAL '1 day' WHERE id = $1",
          [first.id]
        )
      );
      await expect(
        employeesWithPolicy.create(hrAdminClaims, { firstName: "Rehire", lastName: "Blocked Retry", cnic })
      ).rejects.toThrow(BadRequestException);

      // Terminated 31 days ago — past the 30-day cooldown, now eligible.
      await db.withClaims(hrAdminClaims, (client) =>
        client.query("UPDATE employees SET termination_date = CURRENT_DATE - INTERVAL '31 days' WHERE id = $1", [first.id])
      );
      const rehired = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Rehire", lastName: "Blocked Eventually", cnic });
      expect(rehired.personId).toBe(first.personId);

      // Restore the default cooldown so this doesn't leak into other
      // assertions sharing this fixture company.
      await businessPolicy.update(hrAdminClaims, policyList[0].id, { rules: { cooldownDays: 0 } });
    });

    it("never blocks two concurrently active employments sharing a CNIC (not a rehire — see persons.service.ts)", async () => {
      const policyList = await businessPolicy.listPolicies(hrAdminClaims, "rehire");
      await businessPolicy.update(hrAdminClaims, policyList[0].id, { rules: { cooldownDays: 365 } });

      const cnic = `${Date.now()}-CONCURRENT`;
      const first = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Concurrent", lastName: "One" });
      expect(first).toBeTruthy();
      const second = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Concurrent", lastName: "Two", cnic });
      const third = await employeesWithPolicy.create(hrAdminClaims, { firstName: "Concurrent", lastName: "Three", cnic });
      expect(third.personId).toBe(second.personId);

      await businessPolicy.update(hrAdminClaims, policyList[0].id, { rules: { cooldownDays: 0 } });
    });
  });

  describe("org chart, RBAC field visibility, document vault, and job history", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let managerClaims: RequestClaims;
    let aliceClaims: RequestClaims;
    let outsiderClaims: RequestClaims;
    let managerEmployeeId: string;
    let aliceEmployeeId: string;
    let bobEmployeeId: string;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Scenario Co");
      const stamp = Date.now();

      const hrAdminUserId = await createUser(`scenario-hr-${stamp}@example.com`);
      const managerUserId = await createUser(`scenario-mgr-${stamp}@example.com`);
      const aliceUserId = await createUser(`scenario-alice-${stamp}@example.com`);
      const outsiderUserId = await createUser(`scenario-outsider-${stamp}@example.com`);

      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(managerUserId, companyId, "line_manager");
      await assignRole(aliceUserId, companyId, "employee_self_service");
      // outsiderUserId deliberately gets no role assignment at all.

      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      managerClaims = { is_platform_admin: false, company_id: companyId, sub: managerUserId };
      aliceClaims = { is_platform_admin: false, company_id: companyId, sub: aliceUserId };
      outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

      const manager = await employees.create(hrAdminClaims, {
        firstName: "Maya",
        lastName: "Manager",
        department: "Engineering",
        designation: "Engineering Manager",
        cnic: "11111-1111111-1",
        dateOfBirth: "1985-01-01",
        salaryBand: "M4",
        bankAccountNumber: "ACC-MAYA",
        userAccountId: managerUserId,
      });
      managerEmployeeId = manager.id;

      const alice = await employees.create(hrAdminClaims, {
        firstName: "Alice",
        lastName: "Engineer",
        department: "Engineering",
        designation: "Software Engineer",
        managerId: managerEmployeeId,
        cnic: "22222-2222222-2",
        dateOfBirth: "1995-05-05",
        salaryBand: "E3",
        bankAccountNumber: "ACC-ALICE",
        userAccountId: aliceUserId,
      });
      aliceEmployeeId = alice.id;

      const bob = await employees.create(hrAdminClaims, {
        firstName: "Bob",
        lastName: "Sales",
        department: "Sales",
        designation: "Sales Rep",
      });
      bobEmployeeId = bob.id;
    });

    it("HR Admin sees every employee with every sensitive field, Termination Reason hidden while active", async () => {
      const list = await employees.list(hrAdminClaims);
      expect(list).toHaveLength(3);
      const alice = list.find((e) => e.id === aliceEmployeeId)!;
      expect(alice.cnic).toBe("22222-2222222-2");
      expect(alice.dateOfBirth).toBe("1995-05-05");
      expect(alice.salaryBand).toBe("E3");
      expect(alice.bankAccountNumber).toBe("ACC-ALICE");
      expect("terminationReason" in alice).toBe(false);
    });

    it("a Line Manager sees only their direct reports, with salaryBand visible and everything else sensitive hidden", async () => {
      const list = await employees.list(managerClaims);
      expect(list.map((e) => e.id)).toEqual([aliceEmployeeId]);
      const alice = list[0];
      expect(alice.salaryBand).toBe("E3");
      expect("cnic" in alice).toBe(false);
      expect("dateOfBirth" in alice).toBe(false);
      expect("bankAccountNumber" in alice).toBe(false);
      expect("terminationReason" in alice).toBe(false);
    });

    it("an employee sees only their own record, including their own CNIC/DOB/bank/salary but not Termination Reason", async () => {
      const list = await employees.list(aliceClaims);
      expect(list.map((e) => e.id)).toEqual([aliceEmployeeId]);
      const self = list[0];
      expect(self.cnic).toBe("22222-2222222-2");
      expect(self.dateOfBirth).toBe("1995-05-05");
      expect(self.salaryBand).toBe("E3");
      expect(self.bankAccountNumber).toBe("ACC-ALICE");
      expect("terminationReason" in self).toBe(false);
    });

    it("a caller with no role assignment sees nothing and gets 404 on a direct get", async () => {
      expect(await employees.list(outsiderClaims)).toEqual([]);
      await expect(employees.get(outsiderClaims, aliceEmployeeId)).rejects.toThrow(NotFoundException);
    });

    it("field sensitivity classification names the 5 tiered fields (Phase 11, gap #10)", async () => {
      const classification = await employees.getFieldSensitivityClassification(hrAdminClaims);
      const byKey = Object.fromEntries(classification.map((c) => [c.fieldKey, c.tier]));
      expect(byKey.cnic).toBe("restricted");
      expect(byKey.bankAccountNumber).toBe("highly_restricted");
      expect(byKey.dateOfBirth).toBe("confidential");
      expect(byKey.salaryBand).toBe("confidential");
      expect(byKey.terminationReason).toBe("confidential");
    });

    it("get() audit-logs when a restricted-or-higher field is actually exposed, and stays silent when the viewer's role hides all of them (Phase 11)", async () => {
      async function latestAuditAction(employeeId: string) {
        return db.withClaims(FIXTURE_CLAIMS, async (client) => {
          const result = await client.query(
            "SELECT action, metadata FROM audit_log WHERE target = $1 ORDER BY created_at DESC LIMIT 1",
            [employeeId]
          );
          return result.rows[0];
        });
      }

      // HR Admin sees cnic (restricted) and bankAccountNumber (highly
      // restricted) both — one audit entry naming both fields.
      await employees.get(hrAdminClaims, aliceEmployeeId);
      const hrAudit = await latestAuditAction(aliceEmployeeId);
      expect(hrAudit.action).toBe("employee.sensitive_field_viewed");
      expect(hrAudit.metadata.fields.sort()).toEqual(["bankAccountNumber", "cnic"]);
      expect(hrAudit.metadata.tiers).toMatchObject({ cnic: "restricted", bankAccountNumber: "highly_restricted" });

      // A Line Manager only ever sees `salaryBand` (Confidential, not
      // Restricted/Highly Restricted) on a direct report — no new audit
      // entry should be written for this view (the most recent one for
      // Alice stays the HR Admin's own, from just above).
      await employees.get(managerClaims, aliceEmployeeId);
      const afterManagerView = await latestAuditAction(aliceEmployeeId);
      expect(afterManagerView.action).toBe("employee.sensitive_field_viewed");
      expect(afterManagerView.metadata.fields).not.toContain("salaryBand");
    });

    it("a disabled employee module 404s for list/get exactly like a licensing-gated module always does", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(employees.list(hrAdminClaims)).rejects.toThrow(NotFoundException);
      await expect(employees.get(hrAdminClaims, aliceEmployeeId)).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });

    it("builds an org chart from manager_id, and an employee whose manager isn't visible becomes their own root", async () => {
      const fullTree = await employees.orgChart(hrAdminClaims);
      const mayaNode = fullTree.find((n) => n.id === managerEmployeeId)!;
      expect(mayaNode.directReports.map((n) => n.id)).toEqual([aliceEmployeeId]);
      expect(fullTree.some((n) => n.id === bobEmployeeId)).toBe(true);

      // The manager's own view() only returns their direct reports (Alice)
      // — Maya's own record isn't in that visible set at all (line_manager
      // holds no .self/.all permission), so Alice becomes a ROOT of the
      // manager's own org-chart view rather than the tree silently
      // revealing a manager Alice can't otherwise see.
      const managerTree = await employees.orgChart(managerClaims);
      expect(managerTree.map((n) => n.id)).toEqual([aliceEmployeeId]);
    });

    it("attaches a document to the vault and reads the exact bytes back", async () => {
      const fileBuffer = Buffer.from("fake CNIC scan bytes");
      const doc = await employees.addDocument(hrAdminClaims, aliceEmployeeId, "cnic_copy", {
        originalname: "alice-cnic.pdf",
        mimetype: "application/pdf",
        buffer: fileBuffer,
        size: fileBuffer.byteLength,
      });
      expect(doc.fileName).toBe("alice-cnic.pdf");

      const list = await employees.listDocuments(hrAdminClaims, aliceEmployeeId);
      expect(list).toHaveLength(1);

      const downloaded = await employees.downloadDocument(hrAdminClaims, aliceEmployeeId, doc.id);
      expect(downloaded.buffer.equals(fileBuffer)).toBe(true);
      expect(downloaded.mimeType).toBe("application/pdf");
    });

    it("denies document upload to a caller without employee.manage.all", async () => {
      const fileBuffer = Buffer.from("x");
      await expect(
        employees.addDocument(managerClaims, aliceEmployeeId, "cnic_copy", {
          originalname: "x.txt",
          mimetype: "text/plain",
          buffer: fileBuffer,
          size: fileBuffer.byteLength,
        })
      ).rejects.toThrow(ForbiddenException);
    });

    // Tenant Management gap-fill Phase 1 item #10 — storage quota
    // enforcement + file-type allowlist.
    it("rejects a disallowed file type even for an authorized caller", async () => {
      const fileBuffer = Buffer.from("#!/bin/sh\necho hi\n");
      await expect(
        employees.addDocument(hrAdminClaims, aliceEmployeeId, "other", {
          originalname: "script.sh",
          mimetype: "application/x-sh",
          buffer: fileBuffer,
          size: fileBuffer.byteLength,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("blocks an upload that would push the tenant over its storage quota", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE companies SET storage_quota_mb = 0 WHERE id = $1", [companyId])
      );

      const fileBuffer = Buffer.from("this tenant has zero MB of quota left");
      await expect(
        employees.addDocument(hrAdminClaims, aliceEmployeeId, "cnic_copy", {
          originalname: "over-quota.pdf",
          mimetype: "application/pdf",
          buffer: fileBuffer,
          size: fileBuffer.byteLength,
        })
      ).rejects.toThrow(BadRequestException);

      // Restore quota for any tests that run after this one in the file.
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE companies SET storage_quota_mb = 5120 WHERE id = $1", [companyId])
      );
    });

    it("allows an upload that fits within the tenant's quota", async () => {
      const fileBuffer = Buffer.from("small file, plenty of quota");
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE companies SET storage_quota_mb = 5120 WHERE id = $1", [companyId])
      );

      const doc = await employees.addDocument(hrAdminClaims, aliceEmployeeId, "offer_letter", {
        originalname: "offer.pdf",
        mimetype: "application/pdf",
        buffer: fileBuffer,
        size: fileBuffer.byteLength,
      });
      expect(doc.fileName).toBe("offer.pdf");
    });

    it("auto-records job history on hire, transfer, and termination, and lets HR log a manual entry too", async () => {
      const today = new Date().toISOString().slice(0, 10);

      const afterTransfer = await employees.update(hrAdminClaims, aliceEmployeeId, { department: "Product" });
      expect(afterTransfer.department).toBe("Product");

      await employees.addJobHistory(hrAdminClaims, aliceEmployeeId, {
        eventType: "other",
        effectiveDate: today,
        notes: "Completed leadership training",
      });

      await employees.update(hrAdminClaims, aliceEmployeeId, {
        employmentStatus: "terminated",
        terminationDate: today,
        terminationReason: "Resigned",
      });

      // Auto-logged hire/transfer/termination entries and the manual
      // "other" entry all land on the same effective date (today) in this
      // test, so the tiebreak (created_at ASC) is what actually orders
      // them — i.e. this also proves listJobHistory's ORDER BY tiebreak
      // works, not just its primary sort key.
      const history = await employees.listJobHistory(hrAdminClaims, aliceEmployeeId);
      expect(history.map((h) => h.eventType)).toEqual(["hire", "transfer", "other", "termination"]);

      const asHrAdmin = await employees.get(hrAdminClaims, aliceEmployeeId);
      expect(asHrAdmin.terminationReason).toBe("Resigned");

      const asSelf = await employees.get(aliceClaims, aliceEmployeeId);
      expect("terminationReason" in asSelf).toBe(false);
    });
  });

  /**
   * Phase 3 item #4 — Webhooks & Eventing. Confirms the 2 real trigger
   * points this rollout wires up (see EmployeesService's own doc comment
   * on the scope decision) actually enqueue, end to end through a real
   * WebhookDispatchService — not just that `enqueue()` itself works in
   * isolation (webhook-dispatch.service.spec.ts already covers that), but
   * that EmployeesService really calls it, with the real company/event
   * data, at exactly the two moments intended. `employees` above (this
   * file's shared instance) is built WITHOUT a WebhookDispatchService —
   * proving the optional-dependency design doesn't secretly break
   * anything for it — so this uses its own instance instead.
   */
  describe("sensitivity tiers as an enforced default floor (cross-module integration audit Item 8)", () => {
    let companyId: string;
    let employeeId: string;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const roleKeys = {
      viewer: `item8_viewer_${stamp}`,
      sensitiveViewer: `item8_sensitive_viewer_${stamp}`,
      narrowed: `item8_narrowed_${stamp}`,
      widened: `item8_widened_${stamp}`,
    };
    const claimsByRole: Record<string, RequestClaims> = {};

    /** A throwaway role holding `employee.view.all` plus whatever extra
     * permissions/field rules a scenario needs — and, crucially, NO field
     * rules unless listed, which is the "tenant hasn't configured this
     * field" case the floor exists for. */
    async function createRole(key: string, permissions: string[], rules: Array<{ field: string; access: string }>) {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [key]);
        const roleId = role.rows[0].id;
        await client.query(
          "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2::text[])",
          [roleId, ["employee.view.all", ...permissions]]
        );
        for (const rule of rules) {
          await client.query("INSERT INTO field_permission_rules (role_id, object_key, field_key, access) VALUES ($1, 'employee', $2, $3)", [
            roleId,
            rule.field,
            rule.access,
          ]);
        }
      });
    }

    beforeAll(async () => {
      companyId = await createFixtureCompany("Sensitivity Floor Co");
      const hrUser = await createUser(`item8-hr-${stamp}@example.com`);
      await assignRole(hrUser, companyId, "hr_admin");
      const hrClaims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: hrUser };
      employeeId = (
        await employees.create(hrClaims, {
          firstName: "Zara",
          lastName: "Floor",
          cnic: "33333-3333333-3",
          dateOfBirth: "1990-03-03",
          bankAccountNumber: "PK36SCBL0000001123456702",
        })
      ).id;

      await createRole(roleKeys.viewer, [], []);
      await createRole(roleKeys.sensitiveViewer, ["employee.view_sensitive.all"], []);
      await createRole(roleKeys.narrowed, ["employee.view_sensitive.all"], [{ field: "bankAccountNumber", access: "hidden" }]);
      await createRole(roleKeys.widened, [], [{ field: "cnic", access: "view" }]);
      for (const [name, key] of Object.entries(roleKeys)) {
        const userId = await createUser(`item8-${name}-${stamp}@example.com`);
        await assignRole(userId, companyId, key);
        claimsByRole[name] = { is_platform_admin: false, company_id: companyId, sub: userId };
      }
    });

    afterAll(async () => {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query("DELETE FROM user_role_assignments WHERE role_id IN (SELECT id FROM roles WHERE key = ANY($1::text[]))", [
          Object.values(roleKeys),
        ]);
        await client.query("DELETE FROM roles WHERE key = ANY($1::text[])", [Object.values(roleKeys)]);
      });
    });

    it("an unconfigured Highly Restricted field (bankAccountNumber) and Restricted field (cnic) are redacted for a viewer without employee.view_sensitive.all", async () => {
      const record = await employees.get(claimsByRole.viewer, employeeId);
      expect(record.firstName).toBe("Zara");
      expect("bankAccountNumber" in record).toBe(false);
      expect("cnic" in record).toBe(false);
      const listed = (await employees.list(claimsByRole.viewer)).find((e) => e.id === employeeId)!;
      expect("bankAccountNumber" in listed).toBe(false);
      expect("cnic" in listed).toBe(false);
    });

    it("the same unconfigured fields are visible to a viewer holding employee.view_sensitive.all — and that exposure is audit-logged", async () => {
      const record = await employees.get(claimsByRole.sensitiveViewer, employeeId);
      expect(record.bankAccountNumber).toBe("PK36SCBL0000001123456702");
      expect(record.cnic).toBe("33333-3333333-3");
      // The floor covers only Restricted/Highly Restricted — a Confidential
      // field keeps the engine's plain default-deny.
      expect("dateOfBirth" in record).toBe(false);
      const listed = (await employees.list(claimsByRole.sensitiveViewer)).find((e) => e.id === employeeId)!;
      expect(listed.bankAccountNumber).toBe("PK36SCBL0000001123456702");

      const audit = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
        (
          await client.query(
            "SELECT metadata FROM audit_log WHERE action = 'employee.sensitive_field_viewed' AND target = $1 AND actor = $2 ORDER BY created_at DESC LIMIT 1",
            [employeeId, claimsByRole.sensitiveViewer.sub]
          )
        ).rows[0]
      );
      expect(audit.metadata.fields.sort()).toEqual(["bankAccountNumber", "cnic"]);
    });

    it("an explicit field rule always wins over the floor: 'hidden' narrows a permission holder, 'view' widens a non-holder", async () => {
      const narrowed = await employees.get(claimsByRole.narrowed, employeeId);
      expect("bankAccountNumber" in narrowed).toBe(false);
      expect(narrowed.cnic).toBe("33333-3333333-3");

      const widened = await employees.get(claimsByRole.widened, employeeId);
      expect(widened.cnic).toBe("33333-3333333-3");
      expect("bankAccountNumber" in widened).toBe(false);
    });

    it("hr_admin is seeded with employee.view_sensitive.all (0099)", async () => {
      const granted = await db.withClaims(FIXTURE_CLAIMS, async (client) =>
        (
          await client.query(
            `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
             WHERE r.key = 'hr_admin' AND p.key = 'employee.view_sensitive.all'`
          )
        ).rowCount
      );
      expect(granted).toBe(1);
    });
  });

  describe("webhook events (Phase 3 item #4)", () => {
    let companyId: string;
    let hrAdminUserId: string;
    let hrAdminClaims: RequestClaims;
    let employeesWithWebhooks: EmployeesService;
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "webhook-trigger-spec" };

    beforeAll(async () => {
      companyId = await createFixtureCompany("Webhook Trigger Co");
      hrAdminUserId = await createUser(`webhook-trigger-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "employee-trigger-secret" },
      });

      employeesWithWebhooks = new EmployeesService(
        db,
        new RbacService(db),
        new EntitlementsService(db),
        new AuditService(),
        new LocalFileStorageService(),
        new WebhookDispatchService(db, new AuditService())
      );
    });

    async function latestEventFor(type: string) {
      // enqueue() is fire-and-forget from EmployeesService's own call
      // sites — give its own DB write a moment to land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 200));
      // webhook_events RLS gates on is_platform_admin() OR is_service() —
      // same as tenant_integrations itself — so this reads it back with
      // platformClaims, not the tenant-side hrAdminClaims that drove the
      // create()/update() calls above.
      const result = await db.withClaims(platformClaims, (client) =>
        client.query(
          "SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1",
          [companyId, type]
        )
      );
      return result.rows[0];
    }

    it("enqueues employee.created on create()", async () => {
      const created = await employeesWithWebhooks.create(hrAdminClaims, { firstName: "Webhook", lastName: "Hire" });
      const event = await latestEventFor("employee.created");
      expect(event).toBeDefined();
      expect(event.payload.employee.id).toBe(created.id);
      expect(event.status).toBe("pending");
    });

    it("enqueues employee.terminated when employmentStatus transitions to terminated, but not on an unrelated update", async () => {
      const created = await employeesWithWebhooks.create(hrAdminClaims, { firstName: "Webhook", lastName: "Termination" });

      await employeesWithWebhooks.update(hrAdminClaims, created.id, { department: "Ops" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const noTerminationYet = await db.withClaims(platformClaims, (client) =>
        client.query("SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = 'employee.terminated'", [companyId])
      );
      expect(noTerminationYet.rowCount).toBe(0);

      await employeesWithWebhooks.update(hrAdminClaims, created.id, {
        employmentStatus: "terminated",
        terminationDate: new Date().toISOString().slice(0, 10),
        terminationReason: "Resigned",
      });
      const event = await latestEventFor("employee.terminated");
      expect(event).toBeDefined();
      expect(event.payload.employee.id).toBe(created.id);
      expect(event.payload.employee.employmentStatus).toBe("terminated");
    });
  });
  describe("generic PATCH managerId keeps org_relationships in sync (cross-module integration follow-up, 2026-10-01)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Patch Manager Sync Co");
      const hrAdminUserId = await createUser(`patch-mgr-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    });

    async function relationshipsOf(employeeId: string) {
      const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT * FROM org_relationships WHERE employee_id = $1 ORDER BY created_at", [employeeId])
      );
      return result.rows;
    }
    async function managerIdOf(employeeId: string) {
      const result = await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("SELECT manager_id FROM employees WHERE id = $1", [employeeId]));
      return result.rows[0].manager_id as string | null;
    }

    it("creates a direct relationship on the first PATCH, supersedes it on a change, and ignores unrelated PATCHes", async () => {
      const managerA = (await employees.create(hrAdminClaims, { firstName: "Manager", lastName: "A" })).id;
      const managerB = (await employees.create(hrAdminClaims, { firstName: "Manager", lastName: "B" })).id;
      const report = (await employees.create(hrAdminClaims, { firstName: "Patched", lastName: "Report" })).id;

      const first = await employees.update(hrAdminClaims, report, { managerId: managerA });
      expect(first.managerId).toBe(managerA);
      let rels = await relationshipsOf(report);
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({ relationship_type: "direct", manager_employee_id: managerA, status: "active" });

      await employees.update(hrAdminClaims, report, { managerId: managerB });
      rels = await relationshipsOf(report);
      expect(rels.map((r) => [r.relationship_type, r.manager_employee_id, r.status])).toEqual([
        ["direct", managerA, "ended"],
        ["direct", managerB, "active"],
      ]);
      expect(await managerIdOf(report)).toBe(managerB);

      // Same manager again, or a PATCH that doesn't touch managerId at all:
      // no new relationship rows.
      await employees.update(hrAdminClaims, report, { managerId: managerB });
      await employees.update(hrAdminClaims, report, { designation: "Engineer" });
      expect(await relationshipsOf(report)).toHaveLength(2);

      // Audit trail carries the originating source.
      const audit = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT metadata FROM audit_log WHERE action = 'org_relationship.create' AND company_id = $1 ORDER BY created_at DESC LIMIT 1", [
          companyId,
        ])
      );
      expect(audit.rows[0].metadata.source).toBe("employee_update");
    });

    it("ping-pong guard: a PATCH never re-writes employees.manager_id through the relationship writer, and an org-side-created direct row is reused, not duplicated", async () => {
      const manager = (await employees.create(hrAdminClaims, { firstName: "Org", lastName: "Manager" })).id;
      const report = (await employees.create(hrAdminClaims, { firstName: "Org", lastName: "Report" })).id;

      // Simulate the org_relationships -> employees.manager_id direction
      // (OrgRelationshipsService.create(direct)) having already written both.
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query(
          "INSERT INTO org_relationships (company_id, employee_id, manager_employee_id, relationship_type, status) VALUES ($1, $2, $3, 'direct', 'active')",
          [companyId, report, manager]
        );
        await client.query("UPDATE employees SET manager_id = $2 WHERE id = $1", [report, manager]);
      });

      // PATCHing the same manager is a no-op on the org side.
      await employees.update(hrAdminClaims, report, { managerId: manager, designation: "Analyst" });
      const rels = await relationshipsOf(report);
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({ manager_employee_id: manager, status: "active" });
      expect(await managerIdOf(report)).toBe(manager);
    });

    it("rejects a PATCH that would close a reporting cycle, rolling back the manager_id write too", async () => {
      const top = (await employees.create(hrAdminClaims, { firstName: "Cycle", lastName: "Top" })).id;
      const bottom = (await employees.create(hrAdminClaims, { firstName: "Cycle", lastName: "Bottom" })).id;
      await employees.update(hrAdminClaims, bottom, { managerId: top });

      await expect(employees.update(hrAdminClaims, top, { managerId: bottom })).rejects.toThrow(BadRequestException);
      expect(await managerIdOf(top)).toBeNull();
      expect(await relationshipsOf(top)).toHaveLength(0);
    });
  });

  describe("create() with managerId writes a direct org_relationships row (cross-module integration follow-up, 2026-10-01)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;

    beforeAll(async () => {
      companyId = await createFixtureCompany("Create Manager Sync Co");
      const hrAdminUserId = await createUser(`create-mgr-hr-${Date.now()}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    });

    async function relationshipsOf(employeeId: string) {
      const result = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT * FROM org_relationships WHERE employee_id = $1 ORDER BY created_at", [employeeId])
      );
      return result.rows;
    }

    it("creates an active direct relationship, not just the manager_id column, when a new employee is hired with a manager", async () => {
      const manager = await employees.create(hrAdminClaims, { firstName: "Create", lastName: "Manager" });

      const report = await employees.create(hrAdminClaims, {
        firstName: "Create",
        lastName: "Report",
        managerId: manager.id,
      });
      expect(report.managerId).toBe(manager.id);

      const rels = await relationshipsOf(report.id);
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({ relationship_type: "direct", manager_employee_id: manager.id, status: "active" });

      const audit = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "SELECT metadata FROM audit_log WHERE action = 'org_relationship.create' AND target = $1 ORDER BY created_at DESC LIMIT 1",
          [rels[0].id]
        )
      );
      expect(audit.rows[0].metadata.source).toBe("employee_create");
    });

    it("creates no relationship row when hired without a manager", async () => {
      const noManager = await employees.create(hrAdminClaims, { firstName: "Create", lastName: "NoManager" });
      expect(noManager.managerId).toBeFalsy();
      expect(await relationshipsOf(noManager.id)).toHaveLength(0);
    });

    it("rolls back the whole hire (no employee row left behind) when the given manager is terminated", async () => {
      const manager = await employees.create(hrAdminClaims, { firstName: "Create", lastName: "TerminatedManager" });
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE employees SET employment_status = 'terminated' WHERE id = $1", [manager.id])
      );

      await expect(
        employees.create(hrAdminClaims, { firstName: "Create", lastName: "OrphanReport", managerId: manager.id })
      ).rejects.toThrow(BadRequestException);

      const orphan = await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("SELECT id FROM employees WHERE company_id = $1 AND last_name = 'OrphanReport'", [companyId])
      );
      expect(orphan.rowCount).toBe(0);
    });
  });

  // Cross-module integration audit (2026-10-01), gap #3/#7 —
  // 0111_write_scope_data_scope_enforcement.sql's write-side counterpart
  // to Organization Management Phase 11's read-side `.scoped` permissions
  // (0078/0079_data_scope_*.sql, exercised in positions.service.spec.ts).
  // `update()` is where this is enforced (it's also how termination
  // happens — `employmentStatus: "terminated"` is just a patch).
  describe("Data Scope on write (employee.manage.scoped, gap #3/#7)", () => {
    let companyId: string;
    let hrAdminClaims: RequestClaims;
    let regionalHrClaims: RequestClaims;
    let assignedOrgUnitId: string;
    let otherOrgUnitId: string;
    let employeeInScopeId: string;
    let employeeOutOfScopeId: string;

    async function createOrgUnit(name: string) {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO org_units (company_id, name, unit_type) VALUES ($1, $2, 'division') RETURNING id",
          [companyId, name]
        );
        return result.rows[0].id as string;
      });
    }

    async function assignDataScope(userAccountId: string, scopeType: string, scopeEntityId: string) {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        await client.query(
          "INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1, $2, $3, $4)",
          [userAccountId, companyId, scopeType, scopeEntityId]
        );
      });
    }

    beforeAll(async () => {
      companyId = await createFixtureCompany("Employee Scope Co");
      const stamp = Date.now();
      const hrAdminUserId = await createUser(`emp-scope-hr-${stamp}@example.com`);
      const regionalHrUserId = await createUser(`emp-scope-regional-hr-${stamp}@example.com`);
      await assignRole(hrAdminUserId, companyId, "hr_admin");
      await assignRole(regionalHrUserId, companyId, "regional_hr");
      hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
      regionalHrClaims = { is_platform_admin: false, company_id: companyId, sub: regionalHrUserId };

      assignedOrgUnitId = await createOrgUnit("Scoped Division");
      otherOrgUnitId = await createOrgUnit("Other Division");

      const inScope = await employees.create(hrAdminClaims, {
        firstName: "In",
        lastName: "Scope",
        orgUnitId: assignedOrgUnitId,
      });
      employeeInScopeId = inScope.id;

      const outOfScope = await employees.create(hrAdminClaims, {
        firstName: "Out",
        lastName: "OfScope",
        orgUnitId: otherOrgUnitId,
      });
      employeeOutOfScopeId = outOfScope.id;

      await assignDataScope(regionalHrUserId, "org_unit", assignedOrgUnitId);
    });

    it("regional_hr can update an employee inside their assigned org unit", async () => {
      const updated = await employees.update(regionalHrClaims, employeeInScopeId, { designation: "Regional Lead" });
      expect(updated.designation).toBe("Regional Lead");
    });

    it("regional_hr cannot update (or terminate) an employee outside their assigned org unit", async () => {
      await expect(employees.update(regionalHrClaims, employeeOutOfScopeId, { designation: "Hijacked" })).rejects.toThrow(
        ForbiddenException
      );
      await expect(
        employees.update(regionalHrClaims, employeeOutOfScopeId, {
          employmentStatus: "terminated",
          terminationDate: "2026-10-02",
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("regional_hr cannot move an in-scope employee to an org unit outside their scope", async () => {
      await expect(
        employees.update(regionalHrClaims, employeeInScopeId, { orgUnitId: otherOrgUnitId })
      ).rejects.toThrow(ForbiddenException);
    });

    it("hr_admin (unscoped .all) is unaffected and can still update either employee", async () => {
      const updated = await employees.update(hrAdminClaims, employeeOutOfScopeId, { designation: "Still Fine" });
      expect(updated.designation).toBe("Still Fine");
    });
  });
});
