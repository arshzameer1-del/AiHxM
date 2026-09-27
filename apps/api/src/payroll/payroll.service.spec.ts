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
import { EmployeeCompensationService } from "../employees/employee-compensation.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payroll-spec-fixtures" };

// --- Independent re-expression of the documented income-tax method -------
// (PayrollService.calculateOnePayslip()'s own doc comment has the
// authoritative version). Kept here, separately typed out from that doc
// comment rather than imported, so these tests exercise the SERVICE's
// actual behavior against an independently-stated expectation, not the
// service checking its own private helpers.
const DEFAULT_SLABS_FOR_TESTS = [
  { min: 0, max: 600_000, base: 0, rate: 0 },
  { min: 600_000, max: 1_200_000, base: 0, rate: 1 },
  { min: 1_200_000, max: 2_200_000, base: 6_000, rate: 11 },
  { min: 2_200_000, max: 3_200_000, base: 116_000, rate: 20 },
  { min: 3_200_000, max: 4_100_000, base: 316_000, rate: 25 },
  { min: 4_100_000, max: 5_600_000, base: 541_000, rate: 29 },
  { min: 5_600_000, max: 7_000_000, base: 976_000, rate: 32 },
  { min: 7_000_000, max: null as number | null, base: 1_424_000, rate: 35 },
];

function taxYearLabelFor(isoDate: string): number {
  const [y, m] = isoDate.split("-").map(Number);
  return m >= 7 ? y + 1 : y;
}
function taxYearBoundsFor(label: number): { start: string; end: string } {
  return { start: `${label - 1}-07-01`, end: `${label}-06-30` };
}
function daysBetweenInclusive(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / (24 * 60 * 60 * 1000)) + 1;
}
function taxFromSlabsForTests(annualIncome: number, slabs = DEFAULT_SLABS_FOR_TESTS): number {
  const bracket = slabs.find((s) => annualIncome >= s.min && (s.max === null || annualIncome <= s.max)) ?? slabs[slabs.length - 1];
  return Math.max(0, bracket.base + (bracket.rate / 100) * (annualIncome - bracket.min));
}
/** Computes the expected `incomeTaxMonthly` for a period under the
 * cumulative average-rate method, given the employee's prior-YTD taxable
 * income/tax withheld from earlier FINALIZED runs in the same tax year
 * (0/0 when this is their first run of the tax year). */
function expectedIncomeTax(opts: {
  periodEnd: string;
  daysInPeriod: number;
  taxableGrossThisPeriod: number;
  priorYtdTaxable?: number;
  priorYtdWithheld?: number;
  slabs?: typeof DEFAULT_SLABS_FOR_TESTS;
}): number {
  const priorYtdTaxable = opts.priorYtdTaxable ?? 0;
  const priorYtdWithheld = opts.priorYtdWithheld ?? 0;
  const taxYear = taxYearLabelFor(opts.periodEnd);
  const { start, end } = taxYearBoundsFor(taxYear);
  const totalDays = daysBetweenInclusive(start, end);
  const elapsed = Math.min(totalDays, daysBetweenInclusive(start, opts.periodEnd));
  const remaining = Math.max(0, totalDays - elapsed);
  const dailyRate = opts.daysInPeriod > 0 ? opts.taxableGrossThisPeriod / opts.daysInPeriod : 0;
  const projected = dailyRate * remaining;
  const estimatedAnnual = priorYtdTaxable + opts.taxableGrossThisPeriod + projected;
  const totalAnnualTax = taxFromSlabsForTests(estimatedAnnual, opts.slabs);
  const fraction = totalDays > 0 ? elapsed / totalDays : 1;
  const dueToDate = totalAnnualTax * fraction;
  return Math.max(0, dueToDate - priorYtdWithheld);
}

/**
 * Phase 12's own exit criterion (plan doc Section 10): real Postgres, no
 * mocks, exercising the REAL `PayrollService` API. Payroll Enterprise Gap
 * Analysis & Roadmap Phase P1 (2026-09-27) rewrote compensation into a
 * component model and income tax into a year-to-date cumulative method —
 * this file was rewritten alongside that change. Tests that need an exact
 * PKR figure use a FRESH, isolated employee (so there is no prior-YTD
 * history to account for) and the `expectedIncomeTax()` helper above;
 * tests about lifecycle/visibility/permissions assert relationships
 * (e.g. `netPay === grossPay - tax - EOBI`) rather than hardcoded amounts,
 * so they stay correct regardless of how much YTD history a shared fixture
 * employee has accumulated from earlier tests in the same tax year.
 */
describe("PayrollService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let entitlements: EntitlementsService;
  let audit: AuditService;
  let importExport: ImportExportService;
  let payroll: PayrollService;
  let compensation: EmployeeCompensationService;

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

  async function createEmployeeIn(
    targetCompanyId: string,
    opts: {
      userAccountId?: string | null;
      dateOfJoining?: string;
      terminationDate?: string | null;
      bankAccountNumber?: string | null;
    }
  ): Promise<{ id: string; employeeNumber: string }> {
    employeeCounter += 1;
    const employeeNumber = `PR-${employeeCounter}`;
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const result = await client.query(
        `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, date_of_joining, termination_date, bank_account_number)
         VALUES ($1, $2, $3, 'Test', 'Employee', $4, $5, $6) RETURNING id, employee_number`,
        [
          targetCompanyId,
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

  async function createEmployee(opts: {
    userAccountId?: string | null;
    dateOfJoining?: string;
    terminationDate?: string | null;
    bankAccountNumber?: string | null;
  }): Promise<{ id: string; employeeNumber: string }> {
    return createEmployeeIn(companyId, opts);
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
    compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, new EffectiveDatingEngine());

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
    // same PKR 150,000/mo Basic Salary for this employee regardless of
    // period length. Uses the back-compat single-component endpoint.
    await compensation.setCompensation(hrAdminClaims, { employeeId: staffEmployeeId, monthlySalary: 150000, effectiveFrom: "2020-01-01" });

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

  // --- Settings & tax slabs (secondary tenant) -------------------------

  describe("getSettings() / updateSettings() — now effective-dated", () => {
    it("lazily seeds the documented default EOBI/social-security rates on first access", async () => {
      const settings = await payroll.getSettings(secondaryHrClaims);
      expect(settings.eobiEmployeeRatePercent).toBe(1);
      expect(settings.eobiEmployerRatePercent).toBe(5);
      expect(settings.eobiWageBase).toBe(40700);
      expect(settings.socialSecurityScheme).toBe("none");
      expect(settings.socialSecurityEmployerRatePercent).toBe(0);
      expect(settings.socialSecurityWageCeiling).toBeNull();
      expect(settings.effectiveTo).toBeNull();
    });

    it("updateSettings SUPERSEDES (not mutates) the current generation, patching only the given fields", async () => {
      const before = await payroll.getSettings(secondaryHrClaims);
      const updated = await payroll.updateSettings(secondaryHrClaims, {
        socialSecurityScheme: "pessi",
        socialSecurityEmployerRatePercent: 6,
        socialSecurityWageCeiling: 50000,
      });
      expect(updated.socialSecurityScheme).toBe("pessi");
      expect(updated.socialSecurityEmployerRatePercent).toBe(6);
      expect(updated.socialSecurityWageCeiling).toBe(50000);
      // Untouched fields keep their previous values.
      expect(updated.eobiEmployeeRatePercent).toBe(1);
      expect(updated.eobiEmployerRatePercent).toBe(5);
      expect(updated.eobiWageBase).toBe(40700);

      const history = await payroll.getSettingsHistory(secondaryHrClaims);
      expect(history.length).toBeGreaterThanOrEqual(1);
      // If this ran on a later calendar day than the seed, the original
      // generation is closed; either way, the current read matches `updated`.
      const current = history.find((h) => h.effectiveTo === null)!;
      expect(current.socialSecurityScheme).toBe("pessi");
      void before;
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

  // --- Phase P1: a run pins to the generation in force during ITS period ---

  describe("period-pinned settings & tax slabs (Phase P1)", () => {
    let pinCompanyId: string;
    let pinHrClaims: RequestClaims;

    beforeAll(async () => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      pinCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
          `Payroll Pin Co ${stamp}`,
          `payroll-pin-${stamp}`,
        ]);
        const id = company.rows[0].id as string;
        await client.query(
          // 'employee' entitlement is needed too — this describe block's
          // tests call compensation.setCompensation(), which now lives on
          // EmployeeCompensationService and gates on the 'employee' module
          // (2026-09-27, kumail's own architecture correction), not
          // 'payroll'.
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'payroll', true), ($1, 'employee', true)",
          [id]
        );
        return id;
      });
      const hrUserId = await makeUser(`payroll-pin-hr-${stamp}@example.com`);
      await assignRole(hrUserId, "hr_admin", pinCompanyId);
      pinHrClaims = { is_platform_admin: false, company_id: pinCompanyId, sub: hrUserId };
    });

    afterAll(async () => {
      await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [pinCompanyId]));
    });

    it("a run for a PAST period uses the tax slabs that were in force THEN, not whatever is current today", async () => {
      // Generation A: flat 0% (seeded via setTaxSlabs), backdated to look
      // like it was already active a while ago.
      await payroll.setTaxSlabs(pinHrClaims, { slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 0 }] });
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE tax_slabs SET effective_from = CURRENT_DATE - INTERVAL '30 days' WHERE company_id = $1 AND effective_to IS NULL", [pinCompanyId])
      );
      // Generation B: flat 50%, superseding today — this is now "current".
      await payroll.setTaxSlabs(pinHrClaims, { slabs: [{ minAnnualIncome: 0, maxAnnualIncome: null, baseTax: 0, ratePercent: 50 }] });

      const employee = await createEmployeeIn(pinCompanyId, { dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(pinHrClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });

      // A one-day run 20 days ago falls inside generation A's window
      // (started 30 days ago), not generation B's (starts today).
      const pastDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const run = await payroll.createRun(pinHrClaims, { periodStart: pastDate, periodEnd: pastDate });
      await payroll.calculateRun(pinHrClaims, run.id);
      const payslips = await payroll.listPayslips(pinHrClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === employee.id)!;

      // Generation A (0%) applied, not generation B (50%) which is
      // "current" today but was NOT in force during this run's period.
      expect(slip.incomeTaxMonthly).toBe(0);
    });

    it("a run for a PAST period uses the EOBI/social-security settings that were in force THEN, not whatever is current today", async () => {
      // Current (today's) settings: a distinctive, high EOBI employee rate.
      await payroll.updateSettings(pinHrClaims, { eobiEmployeeRatePercent: 40 });
      // Backdate that generation so it reads as "already active a while
      // ago", then supersede it with an even-more-current generation of a
      // DIFFERENT rate, so "today's settings" and "settings 20 days ago"
      // are provably different values.
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE payroll_settings SET effective_from = CURRENT_DATE - INTERVAL '30 days' WHERE company_id = $1 AND effective_to IS NULL", [pinCompanyId])
      );
      await payroll.updateSettings(pinHrClaims, { eobiEmployeeRatePercent: 2 });

      const employee = await createEmployeeIn(pinCompanyId, { dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(pinHrClaims, { employeeId: employee.id, monthlySalary: 50000, effectiveFrom: "2020-01-01" });

      // A different past period than the tax-slabs test above (same
      // company, same describe block) uses, so the two runs don't collide
      // on the exact-period-duplicate check.
      const pastDate = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const run = await payroll.createRun(pinHrClaims, { periodStart: pastDate, periodEnd: pastDate });
      await payroll.calculateRun(pinHrClaims, run.id);
      const payslips = await payroll.listPayslips(pinHrClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === employee.id)!;
      const settingsAtThatTime = await payroll.getSettingsHistory(pinHrClaims);
      const wageBase = settingsAtThatTime[0].eobiWageBase;

      // 40% of the wage base (generation active 20 days ago), not 2%
      // (today's "current" generation).
      expect(slip.eobiEmployeeContribution).toBeCloseTo(wageBase * 0.4, 2);
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
    it("computes gross pay, FBR income tax (YTD method, first run of the tax year), and EOBI for a full-period employee", async () => {
      // A FRESH, isolated employee — this is their first-ever payroll run,
      // so priorYtd is 0/0 and expectedIncomeTax() below is directly
      // comparable without needing any other test's history.
      const mathEmployee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: mathEmployee.id, monthlySalary: 150000, effectiveFrom: "2020-01-01" });

      const periodStart = "2027-01-01";
      const periodEnd = "2027-01-31";
      const run = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd });
      const calculated = await payroll.calculateRun(hrAdminClaims, run.id);
      expect(calculated.run.status).toBe("calculated");
      expect(calculated.payslipCount).toBeGreaterThanOrEqual(1);

      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === mathEmployee.id)!;
      expect(slip).toBeDefined();
      expect(slip.grossPay).toBe(150000);
      expect(slip.taxableGrossThisPeriod).toBe(150000);

      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 31, taxableGrossThisPeriod: 150000 });
      expect(slip.incomeTaxMonthly).toBeCloseTo(expectedTax, 2);
      // EOBI: 1% / 5% of the 40,700 wage base, no unpaid leave -> full ratio
      expect(slip.eobiEmployeeContribution).toBe(407);
      expect(slip.eobiEmployerContribution).toBe(2035);
      // Default scheme is 'none' -> no employer social security contribution
      expect(slip.socialSecurityEmployerContribution).toBe(0);
      expect(slip.netPay).toBeCloseTo(150000 - expectedTax - 407, 2);
      expect(slip.calculationBreakdown.length).toBeGreaterThan(0);
    });

    it("sums MULTIPLE compensation components into gross pay, and excludes a non-taxable component from taxable income", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      const catalog = await compensation.listCompensationComponents(hrAdminClaims);
      const basic = catalog.find((c) => c.key === "basic_salary")!;
      const nonTaxable = await compensation.createCompensationComponent(hrAdminClaims, { name: "Tax-Free Perk", isTaxable: false });

      await compensation.setCompensationComponents(hrAdminClaims, {
        employeeId: employee.id,
        effectiveFrom: "2020-01-01",
        components: [
          { componentId: basic.id, amount: 100000 },
          { componentId: nonTaxable.id, amount: 20000 },
        ],
      });

      const periodStart = "2026-08-01";
      const periodEnd = "2026-08-31";
      const run = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const slip = payslips.find((p) => p.employeeId === employee.id)!;

      expect(slip.grossPay).toBe(120000); // both components
      expect(slip.taxableGrossThisPeriod).toBe(100000); // only Basic Salary
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Basic Salary"))).toBe(true);
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Tax-Free Perk") && String(s.label).includes("non-taxable"))).toBe(true);

      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 31, taxableGrossThisPeriod: 100000 });
      expect(slip.incomeTaxMonthly).toBeCloseTo(expectedTax, 2);
    });

    it("prorates a mid-period compensation change across both segments", async () => {
      const raiseEmployee = await createEmployee({});
      await compensation.setCompensation(hrAdminClaims, {
        employeeId: raiseEmployee.id,
        monthlySalary: 100000,
        effectiveFrom: "2020-01-01",
      });
      // 2027-02 has 28 days; raise takes effect exactly halfway through.
      await compensation.setCompensation(hrAdminClaims, {
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
      expect(slip.taxableGrossThisPeriod).toBe(110000);
      expect(slip.unpaidLeaveDays).toBe(0);
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Basic Salary"))).toBe(true);
      // Internal consistency, independent of the exact tax bracket math.
      expect(slip.netPay).toBeCloseTo(slip.grossPay - slip.incomeTaxMonthly - slip.eobiEmployeeContribution, 2);
    });

    it("deducts approved unpaid leave from gross pay, prorating EOBI by the paid-days ratio", async () => {
      const leaveEmployee = await createEmployee({});
      await compensation.setCompensation(hrAdminClaims, {
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
      expect(slip.taxableGrossThisPeriod).toBe(78000);
      // EOBI prorated by paid-days ratio (26/31): 407 * 26/31 ≈ 341.35
      expect(slip.eobiEmployeeContribution).toBeCloseTo(341.35, 2);
      expect(slip.netPay).toBeCloseTo(slip.grossPay - slip.incomeTaxMonthly - slip.eobiEmployeeContribution, 2);
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

  // --- Phase P1: year-to-date cumulative tax accumulation -----------------

  describe("year-to-date income tax accumulation (Phase P1)", () => {
    it("a second FINALIZED run in the same tax year reduces this period's tax by what was already withheld", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 400000, effectiveFrom: "2020-01-01" });

      // First run of tax year 2029 (Jul 2028): priorYtd is 0/0.
      const run1 = await payroll.createRun(hrAdminClaims, { periodStart: "2028-07-01", periodEnd: "2028-07-31" });
      await payroll.calculateRun(hrAdminClaims, run1.id);
      await payroll.finalizeRun(hrAdminClaims, run1.id);
      const slip1 = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run1.id })).find((p) => p.employeeId === employee.id)!;
      const expectedTax1 = expectedIncomeTax({ periodEnd: "2028-07-31", daysInPeriod: 31, taxableGrossThisPeriod: 400000 });
      expect(slip1.incomeTaxMonthly).toBeCloseTo(expectedTax1, 2);

      // Second run, same tax year: priorYtd now reflects run1's ACTUAL
      // finalized taxable income/tax withheld.
      const run2 = await payroll.createRun(hrAdminClaims, { periodStart: "2028-08-01", periodEnd: "2028-08-31" });
      await payroll.calculateRun(hrAdminClaims, run2.id);
      const slip2 = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run2.id })).find((p) => p.employeeId === employee.id)!;
      const expectedTax2 = expectedIncomeTax({
        periodEnd: "2028-08-31",
        daysInPeriod: 31,
        taxableGrossThisPeriod: 400000,
        priorYtdTaxable: slip1.taxableGrossThisPeriod,
        priorYtdWithheld: slip1.incomeTaxMonthly,
      });
      expect(slip2.incomeTaxMonthly).toBeCloseTo(expectedTax2, 2);
    });

    it("a run in a DIFFERENT tax year does not inherit the prior tax year's YTD", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 500000, effectiveFrom: "2020-01-01" });

      // Last month of tax year 2028.
      const run1 = await payroll.createRun(hrAdminClaims, { periodStart: "2028-06-01", periodEnd: "2028-06-30" });
      await payroll.calculateRun(hrAdminClaims, run1.id);
      await payroll.finalizeRun(hrAdminClaims, run1.id);

      // A later month of the NEXT tax year (2029) — must NOT see run1's YTD.
      const run2 = await payroll.createRun(hrAdminClaims, { periodStart: "2028-09-01", periodEnd: "2028-09-30" });
      await payroll.calculateRun(hrAdminClaims, run2.id);
      const slip2 = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run2.id })).find((p) => p.employeeId === employee.id)!;
      const expectedTax2 = expectedIncomeTax({ periodEnd: "2028-09-30", daysInPeriod: 30, taxableGrossThisPeriod: 500000 });
      expect(slip2.incomeTaxMonthly).toBeCloseTo(expectedTax2, 2);
    });

    it("recalculating a not-yet-finalized run never double-counts its own prior calculation", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 250000, effectiveFrom: "2020-01-01" });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-10-01", periodEnd: "2027-10-31" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const first = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === employee.id)!;

      // Recalculate the SAME (still-unfinalized) run several times — since
      // only FINALIZED runs count toward YTD, this must be idempotent.
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.calculateRun(hrAdminClaims, run.id);
      const again = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === employee.id)!;
      expect(again.incomeTaxMonthly).toBeCloseTo(first.incomeTaxMonthly, 2);
    });
  });

  // --- finalizeRun() ------------------------------------------------------

  describe("finalizeRun()", () => {
    it("refuses to finalize a run that has not been calculated yet", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-11-01", periodEnd: "2027-11-01" });
      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("finalizes a calculated run, and refuses to finalize it twice", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-11-02", periodEnd: "2027-11-02" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const finalized = await payroll.finalizeRun(hrAdminClaims, run.id);
      expect(finalized.status).toBe("finalized");
      expect(finalized.finalizedAt).not.toBeNull();

      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without payroll.manage.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-11-03", periodEnd: "2027-11-03" });
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
      // permission/entitlement failure paths — give it a compensation
      // record here, otherwise calculateRun() collects a "No compensation
      // record" error for it instead of producing a payslip.
      await compensation.setCompensation(hrAdminClaims, {
        employeeId: compEmployeeId,
        monthlySalary: 80000,
        effectiveFrom: "2020-01-01",
      });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-12-05", periodEnd: "2027-12-05" });
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
      // Relational check (not a hardcoded PKR figure): this employee has
      // accumulated real YTD history from earlier describe blocks in this
      // same tax year by this point in the file, so the specific tax
      // figure isn't independently meaningful here — internal consistency
      // of the gross-to-net formula is what this test is actually for.
      expect(own.netPay).toBeCloseTo(own.grossPay - own.incomeTaxMonthly - own.eobiEmployeeContribution, 2);

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
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2028-01-01", periodEnd: "2028-01-01" });
      await expect(payroll.generateDisbursementFile(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);

      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.generateDisbursementFile(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("produces a CSV keyed by employee_number (never the internal UUID) for a finalized run", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2028-01-02", periodEnd: "2028-01-02" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      const payslip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === staffEmployeeId)!;

      const csv = await payroll.generateDisbursementFile(hrAdminClaims, run.id);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("employeeNumber,bankAccountNumber,netPay");
      expect(csv).not.toContain(staffEmployeeId); // the internal UUID never appears
      expect(csv).toContain(`${staffEmployeeNumber},PK00-STAFF,${payslip.netPay.toFixed(2)}`);
    });

    it("denies a caller without payroll.manage.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2028-01-03", periodEnd: "2028-01-03" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      await expect(payroll.generateDisbursementFile(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });
});
