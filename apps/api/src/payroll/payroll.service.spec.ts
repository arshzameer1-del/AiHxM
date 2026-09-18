import { randomUUID } from "crypto";
import { Pool } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ImportExportService } from "../import-export/import-export.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { PayrollService } from "./payroll.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payroll-spec-fixtures" };

/**
 * Phase 12's own exit criterion (plan doc Section 10): real Postgres, no
 * mocks, exercising the REAL `PayrollService` API — compensation
 * versioning, lazily-seeded settings/tax slabs, the calculation engine
 * (`calculateRun` -> `calculateOnePayslip`), the draft -> calculated ->
 * finalized run lifecycle, self- vs manage-scoped payslip visibility, and
 * the bank disbursement export — gated the same way every other module in
 * this codebase is: `tenant_module_entitlement` (404 when disabled) and
 * RBAC (`payroll.manage.all` for HR, `payroll_review.view.self` for an
 * employee's own finalized payslip).
 *
 * This file replaces an earlier version that tested a fictional flat
 * function API (`calculateGrossSalary`, `calculateIncomeTax`, ...) that
 * never existed on `PayrollService`. The real service is a stateful,
 * claims-gated workflow service — see `payroll.service.ts` and
 * `payroll.e2e.spec.ts` (the HTTP-level counterpart to this file).
 */
describe("PayrollService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let importExport: ImportExportService;
  let payroll: PayrollService;

  // --- Primary company: compensation/run/payslip/disbursement flows ---
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  let staffUserId: string;

  let staffEmployeeId: string;
  let staffEmployeeNumber: string;
  let compEmployeeId: string;

  // --- Secondary company: settings/tax-slabs isolation (kept away from
  // the primary company so those tests never disturb the tax bracket /
  // EOBI rate assumptions the calculation-math tests below depend on) ---
  let secondaryCompanyId: string;
  let secondaryHrClaims: RequestClaims;

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

  async function createEmployee(opts: {
    userAccountId?: string | null;
    dateOfJoining?: string;
    terminationDate?: string | null;
    bankAccountNumber?: string | null;
  }): Promise<{ id: string; employeeNumber: string }> {
    employeeCounter += 1;
    const employeeNumber = `PR-${employeeCounter}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, date_of_joining, termination_date, bank_account_number)
         VALUES ($1, $2, $3, 'Test', 'Employee', $4, $5, $6) RETURNING id, employee_number`,
        [
          companyId,
          opts.userAccountId ?? null,
          employeeNumber,
          opts.dateOfJoining ?? "2020-01-01",
          opts.terminationDate ?? null,
          opts.bankAccountNumber ?? null,
        ]
      );
      return { id: result.rows[0].id as string, employeeNumber: result.rows[0].employee_number as string };
    });
  }

  async function insertUnpaidLeave(employeeId: string, startDate: string, endDate: string): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / (24 * 60 * 60 * 1000)) + 1;
      await client.query(
        `INSERT INTO leave_requests (company_id, employee_id, leave_type, start_date, end_date, days_requested, status, submitted_by_user_account_id)
         VALUES ($1, $2, 'unpaid', $3, $4, $5, 'approved', $6)`,
        [companyId, employeeId, startDate, endDate, days, staffUserId]
      );
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    importExport = new ImportExportService();
    payroll = new PayrollService(db, rbac, entitlements, audit, importExport, new EffectiveDatingEngine());

    const stamp = Date.now();

    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Payroll Spec Co ${stamp}`,
        `payroll-spec-${stamp}`,
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

    const hrAdminUserId = await makeUser(`payroll-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin", companyId);
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    staffUserId = await makeUser(`payroll-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service", companyId);
    staffClaims = { is_platform_admin: false, company_id: companyId, sub: staffUserId };

    const outsiderUserId = await makeUser(`payroll-outsider-${stamp}@example.com`);
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };

    const staffEmployee = await createEmployee({ userAccountId: staffUserId, bankAccountNumber: "PK00-STAFF" });
    staffEmployeeId = staffEmployee.id;
    staffEmployeeNumber = staffEmployee.employeeNumber;
    // Open-ended compensation, deliberately never superseded again in this
    // file, so every later payroll run in this spec calculates the exact
    // same PKR 150,000/mo for this employee regardless of period length.
    await payroll.setCompensation(hrAdminClaims, { employeeId: staffEmployeeId, monthlySalary: 150000, effectiveFrom: "2020-01-01" });

    const compEmployee = await createEmployee({});
    compEmployeeId = compEmployee.id;

    // Secondary tenant, used only for settings/tax-slab tests so they
    // never disturb the DEFAULT_TAX_SLABS / default EOBI rates the
    // calculation-math assertions below depend on.
    secondaryCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Payroll Spec Co 2 ${stamp}`,
        `payroll-spec-2-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'payroll', true)",
        [id]
      );
      return id;
    });
    const secondaryHrUserId = await makeUser(`payroll-hr2-${stamp}@example.com`);
    await assignRole(secondaryHrUserId, "hr_admin", secondaryCompanyId);
    secondaryHrClaims = { is_platform_admin: false, company_id: secondaryCompanyId, sub: secondaryHrUserId };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, secondaryCompanyId]])
    );
    await pool.end();
  });

  // --- Compensation ---------------------------------------------------

  describe("setCompensation() / getCompensationHistory()", () => {
    it("sets an open-ended compensation row, then a later raise supersedes (not overwrites) it", async () => {
      const raiseEmployee = await createEmployee({});

      const original = await payroll.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 100000,
        effectiveFrom: "2020-01-01",
      });
      expect(original.monthlySalary).toBe(100000);
      expect(original.effectiveTo).toBeNull();

      const historyAfterFirst = await payroll.getCompensationHistory(hrAdminClaims, raiseEmployee.id);
      expect(historyAfterFirst).toHaveLength(1);

      const raised = await payroll.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 120000,
        effectiveFrom: "2025-06-01",
      });
      expect(raised.effectiveTo).toBeNull();

      const history = await payroll.getCompensationHistory(hrAdminClaims, raiseEmployee.id);
      expect(history).toHaveLength(2);
      const supersededOriginal = history.find((c) => c.id === original.id)!;
      // Superseded (day before the new row's effectiveFrom), never deleted.
      expect(supersededOriginal.effectiveTo).toBe("2025-05-31");
      const current = history.find((c) => c.id === raised.id)!;
      expect(current.monthlySalary).toBe(120000);
      expect(current.effectiveTo).toBeNull();
    });

    it("collapses a same-day second edit into the still-open row rather than opening a second one (fixed via the shared EffectiveDatingEngine retrofit)", async () => {
      const employee = await createEmployee({});

      const first = await payroll.setCompensation(hrAdminClaims, {
        employeeId: employee.id,
        monthlySalary: 90000,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      });

      // Before the shared-engine retrofit, this second same-day call had
      // no collapse guard at all and would attempt to close the row
      // opened above at (today - 1 day) < its own effective_from — an
      // invalid range. This is the regression test for that fix.
      const second = await payroll.setCompensation(hrAdminClaims, {
        employeeId: employee.id,
        monthlySalary: 95000,
        effectiveFrom: new Date().toISOString().slice(0, 10),
      });
      expect(second.id).toBe(first.id);
      expect(second.monthlySalary).toBe(95000);

      const history = await payroll.getCompensationHistory(hrAdminClaims, employee.id);
      expect(history).toHaveLength(1);
    });

    it("404s for an employee that does not exist", async () => {
      await expect(
        payroll.setCompensation(hrAdminClaims, { employeeId: randomUUID(), monthlySalary: 50000, effectiveFrom: "2026-01-01" })
      ).rejects.toThrow(NotFoundException);
      await expect(payroll.getCompensationHistory(hrAdminClaims, randomUUID())).rejects.toThrow(NotFoundException);
    });

    it("denies a caller without payroll.manage.all", async () => {
      await expect(
        payroll.setCompensation(outsiderClaims, { employeeId: compEmployeeId, monthlySalary: 50000, effectiveFrom: "2026-01-01" })
      ).rejects.toThrow(ForbiddenException);
      await expect(payroll.getCompensationHistory(outsiderClaims, compEmployeeId)).rejects.toThrow(ForbiddenException);
      // Even the employee's own self-view permission doesn't grant this —
      // compensation management is manage.all only, per Decision #14.
      await expect(payroll.getCompensationHistory(staffClaims, staffEmployeeId)).rejects.toThrow(ForbiddenException);
    });

    it("404s when the payroll module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'payroll'", [
          companyId,
        ])
      );
      await expect(
        payroll.setCompensation(hrAdminClaims, { employeeId: compEmployeeId, monthlySalary: 50000, effectiveFrom: "2026-01-01" })
      ).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'payroll'", [
          companyId,
        ])
      );
    });
  });

  // --- Settings & tax slabs (secondary tenant) -------------------------

  describe("getSettings() / updateSettings()", () => {
    it("lazily seeds the documented default EOBI/social-security rates on first access", async () => {
      const settings = await payroll.getSettings(secondaryHrClaims);
      expect(settings.eobiEmployeeRatePercent).toBe(1);
      expect(settings.eobiEmployerRatePercent).toBe(5);
      expect(settings.eobiWageBase).toBe(40700);
      expect(settings.socialSecurityScheme).toBe("none");
      expect(settings.socialSecurityEmployerRatePercent).toBe(0);
      expect(settings.socialSecurityWageCeiling).toBeNull();
    });

    it("updateSettings patches only the given fields, leaving the rest untouched", async () => {
      const updated = await payroll.updateSettings(secondaryHrClaims, {
        socialSecurityScheme: "pessi",
        socialSecurityEmployerRatePercent: 6,
        socialSecurityWageCeiling: 50000,
      });
      expect(updated.socialSecurityScheme).toBe("pessi");
      expect(updated.socialSecurityEmployerRatePercent).toBe(6);
      expect(updated.socialSecurityWageCeiling).toBe(50000);
      // Untouched fields keep their previous (default) values.
      expect(updated.eobiEmployeeRatePercent).toBe(1);
      expect(updated.eobiEmployerRatePercent).toBe(5);
      expect(updated.eobiWageBase).toBe(40700);
    });

    it("denies a caller without payroll.manage.all", async () => {
      await expect(payroll.getSettings(outsiderClaims)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listTaxSlabs() / setTaxSlabs()", () => {
    it("lazily seeds the real DEFAULT_TAX_SLABS (FBR TY2027 8-bracket table) on first access", async () => {
      const slabs = await payroll.listTaxSlabs(secondaryHrClaims);
      expect(slabs).toHaveLength(8);
      const expected = [
        { minAnnualIncome: 0, maxAnnualIncome: 600_000, baseTax: 0, ratePercent: 0 },
        { minAnnualIncome: 600_000, maxAnnualIncome: 1_200_000, baseTax: 0, ratePercent: 1 },
        { minAnnualIncome: 1_200_000, maxAnnualIncome: 2_200_000, baseTax: 6_000, ratePercent: 11 },
        { minAnnualIncome: 2_200_000, maxAnnualIncome: 3_200_000, baseTax: 116_000, ratePercent: 20 },
        { minAnnualIncome: 3_200_000, maxAnnualIncome: 4_100_000, baseTax: 316_000, ratePercent: 25 },
        { minAnnualIncome: 4_100_000, maxAnnualIncome: 5_600_000, baseTax: 541_000, ratePercent: 29 },
        { minAnnualIncome: 5_600_000, maxAnnualIncome: 7_000_000, baseTax: 976_000, ratePercent: 32 },
        { minAnnualIncome: 7_000_000, maxAnnualIncome: null, baseTax: 1_424_000, ratePercent: 35 },
      ];
      const sorted = [...slabs].sort((a, b) => a.minAnnualIncome - b.minAnnualIncome);
      sorted.forEach((slab, i) => {
        expect(slab.minAnnualIncome).toBe(expected[i].minAnnualIncome);
        expect(slab.maxAnnualIncome).toBe(expected[i].maxAnnualIncome);
        expect(slab.baseTax).toBe(expected[i].baseTax);
        expect(slab.ratePercent).toBe(expected[i].ratePercent);
      });
    });

    it("setTaxSlabs replaces the whole table (not a partial edit)", async () => {
      const replaced = await payroll.setTaxSlabs(secondaryHrClaims, {
        slabs: [
          { minAnnualIncome: 0, maxAnnualIncome: 500_000, baseTax: 0, ratePercent: 0 },
          { minAnnualIncome: 500_000, maxAnnualIncome: null, baseTax: 0, ratePercent: 10 },
        ],
      });
      expect(replaced).toHaveLength(2);

      const after = await payroll.listTaxSlabs(secondaryHrClaims);
      expect(after).toHaveLength(2);
      expect(after.find((s) => s.maxAnnualIncome === null)?.ratePercent).toBe(10);
    });

    it("rejects an empty slab set", async () => {
      await expect(payroll.setTaxSlabs(secondaryHrClaims, { slabs: [] })).rejects.toThrow(BadRequestException);
    });

    it("rejects a slab whose maxAnnualIncome is not greater than its minAnnualIncome", async () => {
      await expect(
        payroll.setTaxSlabs(secondaryHrClaims, {
          slabs: [{ minAnnualIncome: 100_000, maxAnnualIncome: 50_000, baseTax: 0, ratePercent: 5 }],
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a top slab with a non-null maxAnnualIncome", async () => {
      await expect(
        payroll.setTaxSlabs(secondaryHrClaims, {
          slabs: [{ minAnnualIncome: 0, maxAnnualIncome: 500_000, baseTax: 0, ratePercent: 5 }],
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a non-top slab with a null maxAnnualIncome", async () => {
      await expect(
        payroll.setTaxSlabs(secondaryHrClaims, {
          slabs: [
            { minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 0 },
            { minAnnualIncome: 500_000, maxAnnualIncome: null, baseTax: 0, ratePercent: 10 },
          ],
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-contiguous slabs", async () => {
      await expect(
        payroll.setTaxSlabs(secondaryHrClaims, {
          slabs: [
            { minAnnualIncome: 0, maxAnnualIncome: 400_000, baseTax: 0, ratePercent: 0 },
            { minAnnualIncome: 500_000, maxAnnualIncome: null, baseTax: 0, ratePercent: 10 },
          ],
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without payroll.manage.all", async () => {
      await expect(payroll.listTaxSlabs(outsiderClaims)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("getTaxSlabHistory() / tax slab effective-dating (migration 0033)", () => {
    // Its own tenant so backdating/versioning here never disturbs the
    // seeded-defaults or replace-whole-table assertions above.
    let versioningCompanyId: string;
    let versioningHrClaims: RequestClaims;

    beforeAll(async () => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      versioningCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
          `Payroll Versioning Co ${stamp}`,
          `payroll-versioning-${stamp}`,
        ]);
        const id = company.rows[0].id as string;
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'payroll', true)",
          [id]
        );
        return id;
      });
      const hrUserId = await makeUser(`payroll-versioning-hr-${stamp}@example.com`);
      await assignRole(hrUserId, "hr_admin", versioningCompanyId);
      versioningHrClaims = { is_platform_admin: false, company_id: versioningCompanyId, sub: hrUserId };
    });

    afterAll(async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("DELETE FROM companies WHERE id = $1", [versioningCompanyId])
      );
    });

    it("the seeded defaults form a single generation with today's effectiveFrom", async () => {
      const slabs = await payroll.listTaxSlabs(versioningHrClaims);
      const today = new Date().toISOString().slice(0, 10);
      for (const slab of slabs) {
        expect(slab.effectiveFrom).toBe(today);
        expect(slab.effectiveTo).toBeNull();
      }

      const history = await payroll.getTaxSlabHistory(versioningHrClaims);
      expect(history).toHaveLength(1);
      expect(history[0].effectiveFrom).toBe(today);
      expect(history[0].effectiveTo).toBeNull();
      expect(history[0].slabs).toHaveLength(slabs.length);
    });

    it("same-day collapse: setTaxSlabs called twice the same day replaces the one open generation instead of versioning twice", async () => {
      await payroll.setTaxSlabs(versioningHrClaims, {
        slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 5 }],
      });
      await payroll.setTaxSlabs(versioningHrClaims, {
        slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 8 }],
      });

      const history = await payroll.getTaxSlabHistory(versioningHrClaims);
      expect(history).toHaveLength(1);
      expect(history[0].slabs).toHaveLength(1);
      expect(history[0].slabs[0].ratePercent).toBe(8);
    });

    it("setTaxSlabs on a generation opened on a PRIOR day closes it and opens a new one, preserving history", async () => {
      // Backdate the currently-open generation (from the previous test) so
      // this exercises the "not opened today" branch deterministically.
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          "UPDATE tax_slabs SET effective_from = CURRENT_DATE - INTERVAL '10 days' WHERE company_id = $1 AND effective_to IS NULL",
          [versioningCompanyId]
        )
      );

      const today = new Date().toISOString().slice(0, 10);
      const replaced = await payroll.setTaxSlabs(versioningHrClaims, {
        slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 12 }],
      });
      expect(replaced[0].effectiveFrom).toBe(today);
      expect(replaced[0].effectiveTo).toBeNull();

      const history = await payroll.getTaxSlabHistory(versioningHrClaims);
      expect(history).toHaveLength(2);
      expect(history[0].slabs[0].ratePercent).toBe(8); // the now-closed prior generation
      expect(history[0].effectiveTo).not.toBeNull();
      expect(history[1].slabs[0].ratePercent).toBe(12); // the new open generation
      expect(history[1].effectiveFrom).toBe(today);
      expect(history[1].effectiveTo).toBeNull();

      // No gap or overlap between generations.
      const closedTo = new Date(history[0].effectiveTo as string);
      const reopenedFrom = new Date(history[1].effectiveFrom);
      expect(reopenedFrom.getTime() - closedTo.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it("listTaxSlabs/calculateRun-facing loadOrSeedTaxSlabs only ever sees the CURRENT generation", async () => {
      const current = await payroll.listTaxSlabs(versioningHrClaims);
      expect(current).toHaveLength(1);
      expect(current[0].ratePercent).toBe(12);
    });

    it("denies a caller without payroll.manage.all", async () => {
      await expect(payroll.getTaxSlabHistory(outsiderClaims)).rejects.toThrow(ForbiddenException);
    });
  });

  // --- Payroll runs: create/list/get -----------------------------------

  describe("createRun() / listRuns() / getRun()", () => {
    it("creates a run in 'draft' status", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-01", periodEnd: "2027-06-30" });
      expect(run.status).toBe("draft");
      expect(run.finalizedAt).toBeNull();

      const fetched = await payroll.getRun(hrAdminClaims, run.id);
      expect(fetched.id).toBe(run.id);

      const runs = await payroll.listRuns(hrAdminClaims);
      expect(runs.find((r) => r.id === run.id)).toBeDefined();
    });

    it("rejects a duplicate run for the exact same period", async () => {
      await payroll.createRun(hrAdminClaims, { periodStart: "2027-07-01", periodEnd: "2027-07-31" });
      await expect(payroll.createRun(hrAdminClaims, { periodStart: "2027-07-01", periodEnd: "2027-07-31" })).rejects.toThrow(
        BadRequestException
      );
    });

    it("rejects periodEnd before periodStart", async () => {
      await expect(payroll.createRun(hrAdminClaims, { periodStart: "2027-08-31", periodEnd: "2027-08-01" })).rejects.toThrow(
        BadRequestException
      );
    });

    it("404s for a run that does not exist", async () => {
      await expect(payroll.getRun(hrAdminClaims, randomUUID())).rejects.toThrow(NotFoundException);
    });

    it("denies a caller without payroll.manage.all", async () => {
      await expect(payroll.createRun(outsiderClaims, { periodStart: "2027-09-01", periodEnd: "2027-09-30" })).rejects.toThrow(
        ForbiddenException
      );
    });

    it("404s when the payroll module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'payroll'", [
          companyId,
        ])
      );
      await expect(payroll.createRun(hrAdminClaims, { periodStart: "2027-10-01", periodEnd: "2027-10-31" })).rejects.toThrow(
        NotFoundException
      );
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'payroll'", [
          companyId,
        ])
      );
    });
  });

  // --- calculateRun(): the actual statutory math ------------------------

  describe("calculateRun()", () => {
    it("computes gross pay, FBR income tax, and EOBI deductions for a full-period employee", async () => {
      // 150,000/mo for the whole period -> gross pay equals the monthly
      // salary exactly regardless of days-in-period (full proration).
      // Annualized: 1,800,000 -> FBR bracket 1,200,000-2,200,000
      // (base 6,000 + 11% of the excess over 1,200,000).
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-01-01", periodEnd: "2027-01-31" });
      const calculated = await payroll.calculateRun(hrAdminClaims, run.id);
      expect(calculated.run.status).toBe("calculated");
      expect(calculated.payslipCount).toBeGreaterThanOrEqual(1);

      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === staffEmployeeId)!;
      expect(slip).toBeDefined();
      expect(slip.grossPay).toBe(150000);
      expect(slip.taxableAnnualIncome).toBe(1_800_000);
      // base 6,000 + 11% * (1,800,000 - 1,200,000) = 72,000/yr -> 6,000/mo
      expect(slip.incomeTaxMonthly).toBe(6000);
      // EOBI: 1% / 5% of the 40,700 wage base, no unpaid leave -> full ratio
      expect(slip.eobiEmployeeContribution).toBe(407);
      expect(slip.eobiEmployerContribution).toBe(2035);
      // Default scheme is 'none' -> no employer social security contribution
      expect(slip.socialSecurityEmployerContribution).toBe(0);
      expect(slip.netPay).toBe(150000 - 6000 - 407);
      expect(slip.calculationBreakdown.length).toBeGreaterThan(0);
    });

    it("prorates a mid-period compensation change across both segments", async () => {
      const raiseEmployee = await createEmployee({});
      await payroll.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 100000,
        effectiveFrom: "2020-01-01",
      });
      // 2027-02 has 28 days; raise takes effect exactly halfway through.
      await payroll.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 120000,
        effectiveFrom: "2027-02-15",
      });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-02-01", periodEnd: "2027-02-28" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === raiseEmployee.id)!;

      // 14 days @ 100,000/mo + 14 days @ 120,000/mo, over a 28-day period:
      // (100000*14/28) + (120000*14/28) = 50000 + 60000 = 110000
      expect(slip.grossPay).toBe(110000);
      expect(slip.taxableAnnualIncome).toBe(110000 * 12);
      expect(slip.unpaidLeaveDays).toBe(0);
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Compensation segment"))).toBe(true);
    });

    it("deducts approved unpaid leave from gross pay, prorating EOBI by the paid-days ratio", async () => {
      const leaveEmployee = await createEmployee({});
      await payroll.setCompensation(hrAdminClaims, {
        employeeId: leaveEmployee.id,
        monthlySalary: 93000, // divides evenly by 31 days -> exact PKR 3,000/day
        effectiveFrom: "2020-01-01",
      });
      await insertUnpaidLeave(leaveEmployee.id, "2027-03-05", "2027-03-09"); // 5 approved unpaid days

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-03-01", periodEnd: "2027-03-31" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === leaveEmployee.id)!;

      expect(slip.unpaidLeaveDays).toBe(5);
      expect(slip.paidDays).toBe(26);
      // 93000 - (93000 * 5 / 31) = 93000 - 15000 = 78000
      expect(slip.grossPay).toBe(78000);
      // Annualized 936,000 -> bracket 600,000-1,200,000 @ 1%, base 0
      expect(slip.incomeTaxMonthly).toBe(280);
      // EOBI prorated by paid-days ratio (26/31): 407 * 26/31 ≈ 341.35
      expect(slip.eobiEmployeeContribution).toBeCloseTo(341.35, 2);
      expect(slip.netPay).toBeCloseTo(78000 - 280 - 341.35, 2);
    });

    it("collects a per-employee error (rather than aborting the run) when no compensation record covers the period", async () => {
      const noCompEmployee = await createEmployee({});
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-04-01", periodEnd: "2027-04-30" });
      const result = await payroll.calculateRun(hrAdminClaims, run.id);

      const error = result.errors.find((e) => e.employeeId === noCompEmployee.id);
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/No compensation record/);

      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      expect(payslips.find((p) => p.employeeId === noCompEmployee.id)).toBeUndefined();
      // A different, properly-compensated employee still gets a payslip in
      // the same run — one bad employee doesn't abort the whole run.
      expect(payslips.find((p) => p.employeeId === staffEmployeeId)).toBeDefined();
    });

    it("is re-runnable on a draft/calculated run (fully replaces payslips) but refuses a finalized one", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-05-01", periodEnd: "2027-05-15" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      // Recalculating a merely-calculated (not finalized) run is fine.
      const second = await payroll.calculateRun(hrAdminClaims, run.id);
      expect(second.run.status).toBe("calculated");

      await payroll.finalizeRun(hrAdminClaims, run.id);
      await expect(payroll.calculateRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without payroll.manage.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-05-16", periodEnd: "2027-05-31" });
      await expect(payroll.calculateRun(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });

  // --- finalizeRun() ------------------------------------------------------

  describe("finalizeRun()", () => {
    it("refuses to finalize a run that has not been calculated yet", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-01", periodEnd: "2027-06-01" });
      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("finalizes a calculated run, and refuses to finalize it twice", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-02", periodEnd: "2027-06-02" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const finalized = await payroll.finalizeRun(hrAdminClaims, run.id);
      expect(finalized.status).toBe("finalized");
      expect(finalized.finalizedAt).not.toBeNull();

      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without payroll.manage.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-03", periodEnd: "2027-06-03" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.finalizeRun(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });

  // --- listPayslips() / getPayslip(): visibility gating -------------------

  describe("listPayslips() / getPayslip()", () => {
    let visRunId: string;
    let staffPayslipId: string;
    let otherPayslipId: string;

    beforeAll(async () => {
      // compEmployeeId was only ever used above to exercise setCompensation's
      // permission/entitlement failure paths (every call that would have
      // actually set a compensation row threw) — it has no compensation
      // record of its own, so give it one here, otherwise calculateRun()
      // collects a "No compensation record" error for it instead of
      // producing a payslip (see the "collects a per-employee error"
      // test above), and this describe block's own payslip lookup for it
      // would never find one.
      await payroll.setCompensation(hrAdminClaims, {
        employeeId: compEmployeeId,
        monthlySalary: 80000,
        effectiveFrom: "2020-01-01",
      });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-07-05", periodEnd: "2027-07-05" });
      visRunId = run.id;
      await payroll.calculateRun(hrAdminClaims, run.id);
      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: visRunId });
      staffPayslipId = payslips.find((p) => p.employeeId === staffEmployeeId)!.id;
      otherPayslipId = payslips.find((p) => p.employeeId === compEmployeeId)!.id;
    });

    it("HR (manage.all) can see any payslip in a run that isn't finalized yet", async () => {
      const slip = await payroll.getPayslip(hrAdminClaims, staffPayslipId);
      expect(slip.employeeId).toBe(staffEmployeeId);
      expect(slip.employeeNumber).toBe(staffEmployeeNumber);

      const list = await payroll.listPayslips(hrAdminClaims, { payrollRunId: visRunId });
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it("a self-view employee sees nothing from a run that isn't finalized yet", async () => {
      const list = await payroll.listPayslips(staffClaims, { payrollRunId: visRunId });
      expect(list).toHaveLength(0);
      await expect(payroll.getPayslip(staffClaims, staffPayslipId)).rejects.toThrow(NotFoundException);
    });

    it("once finalized, the self-view employee sees only their own payslip", async () => {
      await payroll.finalizeRun(hrAdminClaims, visRunId);

      const list = await payroll.listPayslips(staffClaims, { payrollRunId: visRunId });
      expect(list).toHaveLength(1);
      expect(list[0].employeeId).toBe(staffEmployeeId);

      const own = await payroll.getPayslip(staffClaims, staffPayslipId);
      expect(own.netPay).toBe(150000 - 6000 - 407);

      await expect(payroll.getPayslip(staffClaims, otherPayslipId)).rejects.toThrow(NotFoundException);
    });

    it("denies a caller with neither manage.all nor a matching self-view permission", async () => {
      await expect(payroll.getPayslip(outsiderClaims, staffPayslipId)).rejects.toThrow(NotFoundException);
    });

    it("404s for a payslip that does not exist", async () => {
      await expect(payroll.getPayslip(hrAdminClaims, randomUUID())).rejects.toThrow(NotFoundException);
    });

    it("404s when the payroll module is disabled for the tenant", async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = false WHERE company_id = $1 AND module_key = 'payroll'", [
          companyId,
        ])
      );
      await expect(payroll.getPayslip(hrAdminClaims, staffPayslipId)).rejects.toThrow(NotFoundException);
      await expect(payroll.listPayslips(hrAdminClaims, {})).rejects.toThrow(NotFoundException);
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tenant_module_entitlement SET enabled = true WHERE company_id = $1 AND module_key = 'payroll'", [
          companyId,
        ])
      );
    });
  });

  // --- generateDisbursementFile() ------------------------------------------

  describe("generateDisbursementFile()", () => {
    it("refuses to disburse a run that is not finalized yet", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-08-01", periodEnd: "2027-08-01" });
      await expect(payroll.generateDisbursementFile(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);

      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.generateDisbursementFile(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("produces a CSV keyed by employee_number (never the internal UUID) for a finalized run", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-08-02", periodEnd: "2027-08-02" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);

      const csv = await payroll.generateDisbursementFile(hrAdminClaims, run.id);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("employeeNumber,bankAccountNumber,netPay");
      expect(csv).not.toContain(staffEmployeeId); // the internal UUID never appears
      expect(csv).toContain(`${staffEmployeeNumber},PK00-STAFF,143593.00`);
    });

    it("denies a caller without payroll.manage.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-08-03", periodEnd: "2027-08-03" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      await expect(payroll.generateDisbursementFile(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });
});
