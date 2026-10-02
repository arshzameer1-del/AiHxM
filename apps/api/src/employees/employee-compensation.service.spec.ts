import { randomUUID } from "crypto";
import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { EmployeeCompensationService } from "./employee-compensation.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-compensation-spec-fixtures" };

/**
 * Core Employee master data (SAP IT0008/IT0014-equivalent). Split out of
 * `payroll.service.spec.ts` (2026-09-27, kumail's own architecture
 * correction — "why compensation is maintained in payroll i think this is
 * master data in employee") when `EmployeeCompensationService` took over
 * from `PayrollService` as the owner of every write to
 * `compensation_components`/`employee_compensation_components`. Real
 * Postgres, no mocks — same discipline `payroll.service.spec.ts` already
 * established for this data.
 */
describe("EmployeeCompensationService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let compensation: EmployeeCompensationService;

  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let staffEmployeeId: string;
  let compEmployeeId: string;

  let employeeCounter = 0;

  async function makeUser(email: string): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        email,
      ]);
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

  async function createEmployee(): Promise<{ id: string; employeeNumber: string }> {
    employeeCounter += 1;
    const employeeNumber = `EC-${employeeCounter}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, date_of_joining)
         VALUES ($1, $2, 'Test', 'Employee', '2020-01-01') RETURNING id, employee_number`,
        [companyId, employeeNumber]
      );
      return { id: result.rows[0].id as string, employeeNumber: result.rows[0].employee_number as string };
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, new EffectiveDatingEngine());

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Employee Compensation Spec Co ${stamp}`,
        `employee-compensation-spec-${stamp}`,
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

    const hrAdminUserId = await makeUser(`ec-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin", companyId);
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    const staffUserId = await makeUser(`ec-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service", companyId);
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`ec-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    const staffEmployee = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, date_of_joining)
         VALUES ($1, $2, 'EC-STAFF', 'Test', 'Employee', '2020-01-01') RETURNING id`,
        [companyId, staffUserId]
      );
      return result.rows[0].id as string;
    });
    staffEmployeeId = staffEmployee;

    const compEmployee = await createEmployee();
    compEmployeeId = compEmployee.id;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  // --- Compensation (back-compat single component) ----------------------

  describe("setCompensation() / getCompensationHistory() — back-compat Basic Salary convenience", () => {
    it("sets an open-ended Basic Salary row, then a later raise supersedes (not overwrites) it", async () => {
      const raiseEmployee = await createEmployee();

      const original = await compensation.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 100000,
        effectiveFrom: "2020-01-01",
      });
      expect(original.componentKey).toBe("basic_salary");
      expect(original.amount).toBe(100000);
      expect(original.effectiveTo).toBeNull();

      const historyAfterFirst = await compensation.getCompensationHistory(hrAdminClaims, raiseEmployee.id);
      expect(historyAfterFirst).toHaveLength(1);

      const raised = await compensation.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 120000,
        effectiveFrom: "2025-06-01",
      });
      expect(raised.effectiveTo).toBeNull();

      const history = await compensation.getCompensationHistory(hrAdminClaims, raiseEmployee.id);
      expect(history).toHaveLength(2);
      const supersededOriginal = history.find((c) => c.id === original.id)!;
      // Superseded (day before the new row's effectiveFrom), never deleted.
      expect(supersededOriginal.effectiveTo).toBe("2025-05-31");
      const current = history.find((c) => c.id === raised.id)!;
      expect(current.amount).toBe(120000);
      expect(current.effectiveTo).toBeNull();
    });

    it("collapses a same-day second edit into the still-open row rather than opening a second one", async () => {
      const employee = await createEmployee();
      const today = new Date().toISOString().slice(0, 10);

      const first = await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 90000, effectiveFrom: today });
      const second = await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 95000, effectiveFrom: today });
      expect(second.id).toBe(first.id);
      expect(second.amount).toBe(95000);

      const history = await compensation.getCompensationHistory(hrAdminClaims, employee.id);
      expect(history).toHaveLength(1);
    });

    it("404s for an employee that does not exist", async () => {
      await expect(
        compensation.setCompensation(hrAdminClaims, { employeeId: randomUUID(), monthlySalary: 50000, effectiveFrom: "2026-01-01" })
      ).rejects.toThrow(NotFoundException);
      await expect(compensation.getCompensationHistory(hrAdminClaims, randomUUID())).rejects.toThrow(NotFoundException);
    });

    it("denies a caller without employee.manage.all", async () => {
      await expect(
        compensation.setCompensation(outsiderClaims, { employeeId: compEmployeeId, monthlySalary: 50000, effectiveFrom: "2026-01-01" })
      ).rejects.toThrow(ForbiddenException);
      await expect(compensation.getCompensationHistory(outsiderClaims, compEmployeeId)).rejects.toThrow(ForbiddenException);
      // Even the employee's own self-view permission doesn't grant this —
      // compensation management is manage.all only, same as every other
      // Core Employee sub-entity.
      await expect(compensation.getCompensationHistory(staffClaims, staffEmployeeId)).rejects.toThrow(ForbiddenException);
    });

    it("404s when the employee module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
      await expect(
        compensation.setCompensation(hrAdminClaims, { employeeId: compEmployeeId, monthlySalary: 50000, effectiveFrom: "2026-01-01" })
      ).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'employee'", [
          companyId,
        ])
      );
    });
  });

  // --- Compensation components (Phase P1) --------------------------------

  describe("compensation components — catalog & multi-component amounts", () => {
    it("lazily seeds the standard 6-component catalog, all taxable, in a stable sort order", async () => {
      const components = await compensation.listCompensationComponents(hrAdminClaims);
      expect(components.length).toBeGreaterThanOrEqual(6);
      const keys = components.map((c) => c.key);
      expect(keys).toEqual(
        expect.arrayContaining(["basic_salary", "house_rent_allowance", "medical_allowance", "conveyance_allowance", "utilities_allowance", "other_allowance"])
      );
      expect(components.every((c) => c.isTaxable)).toBe(true);
      expect(components.every((c) => c.isActive)).toBe(true);
      const basic = components.find((c) => c.key === "basic_salary")!;
      expect(basic.sortOrder).toBe(0);
    });

    it("creates a custom component, defaulting to taxable, and rejects a duplicate key", async () => {
      const created = await compensation.createCompensationComponent(hrAdminClaims, { name: "Fuel Allowance" });
      expect(created.key).toBe("fuel_allowance");
      expect(created.isTaxable).toBe(true);
      expect(created.isActive).toBe(true);

      await expect(compensation.createCompensationComponent(hrAdminClaims, { name: "Fuel Allowance" })).rejects.toThrow(BadRequestException);
    });

    it("can create a non-taxable custom component explicitly", async () => {
      const created = await compensation.createCompensationComponent(hrAdminClaims, { name: "Loan Reimbursement", isTaxable: false });
      expect(created.isTaxable).toBe(false);
    });

    it("Phase P3, Section 1 — a 'deduction'-type component is forced non-taxable even if isTaxable: true is passed, and stays immutable across updates", async () => {
      const created = await compensation.createCompensationComponent(hrAdminClaims, {
        name: "Society Membership Fee",
        componentType: "deduction",
        isTaxable: true, // deliberately asked for — must still be forced false
      });
      expect(created.componentType).toBe("deduction");
      expect(created.isTaxable).toBe(false);

      // componentType is immutable after creation (same posture as `key`)
      // — updateCompensationComponent has no field for it — and isTaxable
      // stays forced false even if a later patch asks to retax it.
      const updated = await compensation.updateCompensationComponent(hrAdminClaims, created.id, { isTaxable: true });
      expect(updated.componentType).toBe("deduction");
      expect(updated.isTaxable).toBe(false);
    });

    it("an 'earning'-type component defaults componentType to 'earning' when not specified", async () => {
      const created = await compensation.createCompensationComponent(hrAdminClaims, { name: "Explicit Earning Default" });
      expect(created.componentType).toBe("earning");
    });

    it("loadCurrentCompensation() splits totals into totalEarnings/totalDeductions, with totalMonthly as their difference", async () => {
      const employee = await createEmployee();
      const catalog = await compensation.listCompensationComponents(hrAdminClaims);
      const basic = catalog.find((c) => c.key === "basic_salary")!;
      const deduction = await compensation.createCompensationComponent(hrAdminClaims, {
        name: "Health Insurance Premium (Comp Spec)",
        componentType: "deduction",
      });

      const result = await compensation.setCompensationComponents(hrAdminClaims, {
        employeeId: employee.id,
        effectiveFrom: "2026-01-01",
        components: [
          { componentId: basic.id, amount: 100000 },
          { componentId: deduction.id, amount: 4000 },
        ],
      });
      expect(result.totalEarnings).toBe(100000);
      expect(result.totalDeductions).toBe(4000);
      expect(result.totalMonthly).toBe(96000);

      const current = await compensation.getCurrentCompensation(hrAdminClaims, employee.id);
      expect(current.totalEarnings).toBe(100000);
      expect(current.totalDeductions).toBe(4000);
      expect(current.totalMonthly).toBe(96000);
    });

    it("updateCompensationComponent can rename, retax, and deactivate a component", async () => {
      const created = await compensation.createCompensationComponent(hrAdminClaims, { name: "Temp Component" });
      const updated = await compensation.updateCompensationComponent(hrAdminClaims, created.id, {
        name: "Renamed Component",
        isTaxable: false,
        isActive: false,
      });
      expect(updated.name).toBe("Renamed Component");
      expect(updated.isTaxable).toBe(false);
      expect(updated.isActive).toBe(false);
    });

    it("setCompensationComponents sets multiple components at once; an omitted component is left untouched", async () => {
      const employee = await createEmployee();
      const catalog = await compensation.listCompensationComponents(hrAdminClaims);
      const basic = catalog.find((c) => c.key === "basic_salary")!;
      const hra = catalog.find((c) => c.key === "house_rent_allowance")!;

      const first = await compensation.setCompensationComponents(hrAdminClaims, {
        employeeId: employee.id,
        effectiveFrom: "2026-01-01",
        components: [
          { componentId: basic.id, amount: 80000 },
          { componentId: hra.id, amount: 20000 },
        ],
      });
      expect(first.totalMonthly).toBe(100000);
      expect(first.components).toHaveLength(2);

      // Bump ONLY Basic Salary — HRA's existing effective-dated row must
      // survive untouched (still 20000, still the same row).
      const hraRowBefore = first.components.find((c) => c.componentId === hra.id)!;
      const second = await compensation.setCompensationComponents(hrAdminClaims, {
        employeeId: employee.id,
        effectiveFrom: "2026-06-01",
        components: [{ componentId: basic.id, amount: 90000 }],
      });
      expect(second.totalMonthly).toBe(110000);
      const hraRowAfter = second.components.find((c) => c.componentId === hra.id)!;
      expect(hraRowAfter.id).toBe(hraRowBefore.id);
      expect(hraRowAfter.amount).toBe(20000);

      const current = await compensation.getCurrentCompensation(hrAdminClaims, employee.id);
      expect(current.totalMonthly).toBe(110000);
    });

    it("rejects an unknown or inactive component, and a negative amount", async () => {
      const employee = await createEmployee();
      await expect(
        compensation.setCompensationComponents(hrAdminClaims, { employeeId: employee.id, effectiveFrom: "2026-01-01", components: [{ componentId: randomUUID(), amount: 1000 }] })
      ).rejects.toThrow(BadRequestException);

      const inactive = await compensation.createCompensationComponent(hrAdminClaims, { name: "Will Deactivate" });
      await compensation.updateCompensationComponent(hrAdminClaims, inactive.id, { isActive: false });
      await expect(
        compensation.setCompensationComponents(hrAdminClaims, { employeeId: employee.id, effectiveFrom: "2026-01-01", components: [{ componentId: inactive.id, amount: 1000 }] })
      ).rejects.toThrow(BadRequestException);

      const catalog = await compensation.listCompensationComponents(hrAdminClaims);
      const basic = catalog.find((c) => c.key === "basic_salary")!;
      await expect(
        compensation.setCompensationComponents(hrAdminClaims, { employeeId: employee.id, effectiveFrom: "2026-01-01", components: [{ componentId: basic.id, amount: -5 }] })
      ).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without employee.manage.all", async () => {
      await expect(compensation.listCompensationComponents(outsiderClaims)).rejects.toThrow(ForbiddenException);
      await expect(compensation.createCompensationComponent(outsiderClaims, { name: "X" })).rejects.toThrow(ForbiddenException);
    });
  });
});
