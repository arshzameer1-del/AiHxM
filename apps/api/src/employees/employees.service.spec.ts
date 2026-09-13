import { Pool } from "pg";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { EmployeesService } from "./employees.service";

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
    employees = new EmployeesService(db, new RbacService(db), new EntitlementsService(db), new LocalFileStorageService());
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
});
