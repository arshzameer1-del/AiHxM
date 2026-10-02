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
import { WorkflowService } from "../workflow/workflow.service";
import { PayrollService } from "./payroll.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { HolidaysService } from "../holidays/holidays.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { LeaveRequestsService } from "../leave/leave-requests.service";
import { OvertimeService } from "../leave/overtime.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { IntegrationsService } from "../tenant-management/integrations.service";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../employees/employee-offcycle-payments.service";

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
  /** One-off taxable earnings inside `taxableGrossThisPeriod` (approved
   * overtime) — counted in this period but NOT projected forward. */
  oneOffTaxableThisPeriod?: number;
}): number {
  const priorYtdTaxable = opts.priorYtdTaxable ?? 0;
  const priorYtdWithheld = opts.priorYtdWithheld ?? 0;
  const taxYear = taxYearLabelFor(opts.periodEnd);
  const { start, end } = taxYearBoundsFor(taxYear);
  const totalDays = daysBetweenInclusive(start, end);
  const elapsed = Math.min(totalDays, daysBetweenInclusive(start, opts.periodEnd));
  const remaining = Math.max(0, totalDays - elapsed);
  const recurring = opts.taxableGrossThisPeriod - (opts.oneOffTaxableThisPeriod ?? 0);
  const dailyRate = opts.daysInPeriod > 0 ? recurring / opts.daysInPeriod : 0;
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
  let workflow: WorkflowService;
  let shifts: ShiftsService;
  let workSchedule: WorkScheduleResolutionService;
  let leaveRequests: LeaveRequestsService;
  let overtime: OvertimeService;
  let loans: EmployeeLoansService;
  let additionalPayments: EmployeeAdditionalPaymentsService;
  let offCyclePayments: EmployeeOffCyclePaymentsService;

  // --- Primary company: compensation/run/payslip/disbursement flows ---
  let companyId: string;
  let hrAdminClaims: RequestClaims;
  let staffClaims: RequestClaims;
  let outsiderClaims: RequestClaims;
  // Phase P2 — a distinct login holding ONLY `payroll_approver`, never
  // `hr_admin` (and none of `hr_admin`'s calculate/finalize/disburse
  // permissions), so approval tests genuinely exercise the segregation of
  // duties rather than a role that happens to hold both.
  let approverClaims: RequestClaims;
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

  /** Phase P2 helper: takes a freshly-`calculated` run all the way to
   * `approved` via the real workflow engine (submit as the preparer,
   * decide as the distinct approver) — every pre-existing test in this
   * file that finalizes a run now needs this step first, since
   * `finalizeRun()` no longer accepts a run straight off `calculated`. */
  async function submitAndApprove(runId: string): Promise<void> {
    await payroll.submitForApproval(hrAdminClaims, runId);
    await payroll.decideApproval(approverClaims, runId, { decision: "approved" });
  }

  /** Phase P2 (Correction/Reversal) helper: takes a period all the way to
   * `finalized` via the real lifecycle (create -> calculate -> submit ->
   * approve -> finalize) using the fixture employee who already has
   * open-ended compensation set (`staffEmployeeId`), so the run actually
   * carries a real payslip rather than an empty one. */
  async function createFinalizedRun(periodStart: string, periodEnd: string): Promise<string> {
    const run = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd });
    await payroll.calculateRun(hrAdminClaims, run.id);
    await submitAndApprove(run.id);
    await payroll.finalizeRun(hrAdminClaims, run.id);
    return run.id;
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

  /** Inserts an overtime_records row directly, already decided, with the
   * given SNAPSHOTTED amount — OvertimeService's own spec covers how
   * approval prices a claim; these tests only care that Payroll reads the
   * snapshot faithfully (and never re-prices it). */
  async function insertOvertime(
    employeeId: string,
    opts: { workDate: string; minutes: number; multiplier: number; hourlyRate: number | null; amount: number | null; status?: string; dayType?: string }
  ): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query(
        `INSERT INTO overtime_records
           (company_id, employee_id, work_date, scheduled_minutes, actual_minutes, overtime_minutes, day_type,
            rate_multiplier, status, submitted_by_user_account_id, hourly_rate, amount)
         VALUES ($1, $2, $3, 480, 480 + $4, $4, $5, $6, $7, $8, $9, $10)`,
        [
          companyId,
          employeeId,
          opts.workDate,
          opts.minutes,
          opts.dayType ?? "weekday",
          opts.multiplier,
          opts.status ?? "approved",
          staffUserId,
          opts.hourlyRate,
          opts.amount,
        ]
      )
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    entitlements = new EntitlementsService(db);
    audit = new AuditService();
    importExport = new ImportExportService();
    workflow = new WorkflowService(db, rbac, audit);
    // Integration gap audit remediation (2026-10-01): Payroll now reads
    // unpaid leave / approved overtime / work schedules through the real
    // owning services rather than raw SQL, so this fixture wires the real
    // ones (no mocks — same "real Postgres, real collaborators" rule as
    // the rest of this file).
    shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    workSchedule = new WorkScheduleResolutionService(db, shifts, new HolidaysService(db, rbac, entitlements, audit));
    const employeeGroups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    leaveRequests = new LeaveRequestsService(db, rbac, entitlements, audit, employeeGroups, workflow, workSchedule);
    overtime = new OvertimeService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), workSchedule);
    // Payroll Enterprise Gap Analysis Phase P3 (2026-10-02) — Loans/
    // Additional Payments joined the same required-collaborator set as
    // leaveRequests/overtime/workSchedule (see PayrollService's own
    // constructor comment); real instances, no mocks, same rule as every
    // other collaborator in this fixture.
    loans = new EmployeeLoansService(db, rbac, entitlements, audit);
    additionalPayments = new EmployeeAdditionalPaymentsService(db, rbac, entitlements, audit);
    // Payroll Enterprise Gap Analysis Phase P4 (2026-10-02) — Off-cycle
    // runs' own Additional Off-Cycle Payments (IT0267) joined the same
    // required-collaborator set; real instance, same rule as every
    // other collaborator in this fixture.
    offCyclePayments = new EmployeeOffCyclePaymentsService(db, rbac, entitlements, audit);
    payroll = new PayrollService(
      db,
      rbac,
      entitlements,
      audit,
      importExport,
      new EffectiveDatingEngine(),
      workflow,
      leaveRequests,
      overtime,
      workSchedule,
      undefined,
      undefined,
      loans,
      additionalPayments,
      offCyclePayments
    );
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
    // Also holds rbac_demo_full_access purely to configure the payroll-run
    // approval workflow template below — same fixture shortcut
    // recruitment.service.spec.ts/leave-requests.service.spec.ts already
    // use (a real tenant would do this via a System Admin login instead).
    await assignRole(hrAdminUserId, "rbac_demo_full_access", companyId);
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };

    // A distinct login holding ONLY payroll_approver — never hr_admin —
    // so decideApproval() tests genuinely exercise the segregation of
    // duties 0093_payroll_approval_workflow.sql was built for.
    const approverUserId = await makeUser(`payroll-approver-${stamp}@example.com`);
    await assignRole(approverUserId, "payroll_approver", companyId);
    approverClaims = { is_platform_admin: false, company_id: companyId, sub: approverUserId };

    const payrollApproverRole = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("SELECT id FROM roles WHERE key = 'payroll_approver'")
    );
    await workflow.createTemplate(hrAdminClaims, {
      key: "payroll_run",
      name: "Payroll Run Approval",
      objectKey: "payroll_run",
      steps: [
        { stepOrder: 1, name: "Payroll Approver reviews", approvers: [{ approverType: "role", roleId: payrollApproverRole.rows[0].id }] },
      ],
    });

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

    it("denies a caller without payroll.calculate.all", async () => {
      await expect(payroll.getSettings(outsiderClaims)).rejects.toThrow(ForbiddenException);
    });

    // 0100_overtime_standard_monthly_hours.sql — the 208-hour divisor
    // OvertimeService.priceClaim() uses is now this same effective-dated
    // per-tenant setting, not a hardcoded global constant.
    it("defaults standardMonthlyHours to 208 for a tenant that has never configured it", async () => {
      const settings = await payroll.getSettings(secondaryHrClaims);
      expect(settings.standardMonthlyHours).toBe(208);
    });

    it("lets an admin configure a different standardMonthlyHours, which SUPERSEDES like every other field here", async () => {
      const updated = await payroll.updateSettings(secondaryHrClaims, { standardMonthlyHours: 176 });
      expect(updated.standardMonthlyHours).toBe(176);
      // Untouched fields keep their previous values.
      expect(updated.eobiEmployeeRatePercent).toBe(1);

      const current = await payroll.getSettings(secondaryHrClaims);
      expect(current.standardMonthlyHours).toBe(176);
    });

    it("rejects an out-of-bounds standardMonthlyHours as a fat-finger sanity check, not a business rule", async () => {
      await expect(payroll.updateSettings(secondaryHrClaims, { standardMonthlyHours: 50 })).rejects.toThrow(BadRequestException);
      await expect(payroll.updateSettings(secondaryHrClaims, { standardMonthlyHours: 400 })).rejects.toThrow(BadRequestException);
      // The rejected attempt superseded nothing.
      const current = await payroll.getSettings(secondaryHrClaims);
      expect(current.standardMonthlyHours).toBe(176);
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

    it("denies a caller without payroll.calculate.all", async () => {
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

    it("denies a caller without payroll.calculate.all", async () => {
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
      // A brand-new run has no payslips yet — zero, never undefined/null,
      // so the UI can render "0 employees" straight away instead of
      // special-casing a missing summary.
      expect(run.payslipCount).toBe(0);
      expect(run.totalGrossPay).toBe(0);
      expect(run.totalNetPay).toBe(0);

      const fetched = await payroll.getRun(hrAdminClaims, run.id);
      expect(fetched.id).toBe(run.id);
      expect(fetched.payslipCount).toBe(0);

      const runs = await payroll.listRuns(hrAdminClaims);
      const listed = runs.find((r) => r.id === run.id);
      expect(listed).toBeDefined();
      expect(listed!.payslipCount).toBe(0);
    });

    it("carries real payslip totals (regression: a live production test found an approver could click Approve with no numbers on screen at all — payslipCount/totalGrossPay/totalNetPay exist precisely so the UI always has something to show before that decision) through calculate -> submit -> approve -> finalize, matching getRun() and listRuns() at every stage", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 200000, effectiveFrom: "2020-01-01" });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-11-01", periodEnd: "2027-11-30" });
      const calculated = await payroll.calculateRun(hrAdminClaims, run.id);
      expect(calculated.run.payslipCount).toBeGreaterThanOrEqual(1);
      expect(calculated.run.totalNetPay).toBeGreaterThan(0);
      expect(calculated.run.totalGrossPay).toBeGreaterThanOrEqual(calculated.run.totalNetPay);

      // The summary calculateRun() returns in memory must match a fresh
      // read from the database, not just an in-process echo of what it
      // just computed.
      const fetchedAfterCalc = await payroll.getRun(hrAdminClaims, run.id);
      expect(fetchedAfterCalc.payslipCount).toBe(calculated.run.payslipCount);
      expect(fetchedAfterCalc.totalGrossPay).toBe(calculated.run.totalGrossPay);
      expect(fetchedAfterCalc.totalNetPay).toBe(calculated.run.totalNetPay);

      const submitted = await payroll.submitForApproval(hrAdminClaims, run.id);
      expect(submitted.payslipCount).toBe(calculated.run.payslipCount);
      expect(submitted.totalNetPay).toBe(calculated.run.totalNetPay);

      const approved = await payroll.decideApproval(approverClaims, run.id, { decision: "approved" });
      expect(approved.payslipCount).toBe(calculated.run.payslipCount);
      expect(approved.totalNetPay).toBe(calculated.run.totalNetPay);

      const finalized = await payroll.finalizeRun(hrAdminClaims, run.id);
      expect(finalized.payslipCount).toBe(calculated.run.payslipCount);
      expect(finalized.totalNetPay).toBe(calculated.run.totalNetPay);

      const listed = (await payroll.listRuns(hrAdminClaims)).find((r) => r.id === run.id)!;
      expect(listed.payslipCount).toBe(calculated.run.payslipCount);
      expect(listed.totalGrossPay).toBe(calculated.run.totalGrossPay);
      expect(listed.totalNetPay).toBe(calculated.run.totalNetPay);
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

    it("denies a caller without payroll.calculate.all", async () => {
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

    it("a 'deduction'-type component (Phase P3, Section 1 — Benefits-style recurring deduction) reduces NET pay only, never gross/taxable gross", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      const catalog = await compensation.listCompensationComponents(hrAdminClaims);
      const basic = catalog.find((c) => c.key === "basic_salary")!;
      const healthPremium = await compensation.createCompensationComponent(hrAdminClaims, {
        name: "Health Insurance Premium",
        componentType: "deduction",
      });
      // A deduction is forced non-taxable regardless of what was asked for.
      expect(healthPremium.isTaxable).toBe(false);
      expect(healthPremium.componentType).toBe("deduction");

      await compensation.setCompensationComponents(hrAdminClaims, {
        employeeId: employee.id,
        effectiveFrom: "2020-01-01",
        components: [
          { componentId: basic.id, amount: 100000 },
          { componentId: healthPremium.id, amount: 3000 },
        ],
      });

      const periodStart = "2026-09-01";
      const periodEnd = "2026-09-30";
      const run = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const slip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === employee.id)!;

      // Gross/taxable gross see ONLY Basic Salary — the deduction never
      // touches either.
      expect(slip.grossPay).toBe(100000);
      expect(slip.taxableGrossThisPeriod).toBe(100000);
      expect(
        slip.calculationBreakdown.some((s) => String(s.label).includes("Health Insurance Premium") && String(s.label).includes("recurring deduction"))
      ).toBe(true);

      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 30, taxableGrossThisPeriod: 100000 });
      // EOBI is wage-base-flat, unaffected by this deduction.
      expect(slip.netPay).toBeCloseTo(100000 - expectedTax - 407 - 3000, 2);
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

    it("adds APPROVED overtime inside the employment window to gross (and taxable) pay at its snapshotted amount, as its own breakdown lines (0097)", async () => {
      // Employed for exactly this period only, so this fixture never adds a
      // payslip to any OTHER test's run (several of which assert exact sums).
      const otEmployee = await createEmployee({ dateOfJoining: "2029-01-01", terminationDate: "2029-01-31" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: otEmployee.id, monthlySalary: 93000, effectiveFrom: "2020-01-01" });
      // Snapshotted hourly rate deliberately NOT what today's 93,000/mo would
      // price at (93000/208 = 447.12) — proves Payroll pays the approval-time
      // snapshot and never re-prices it from current compensation.
      await insertOvertime(otEmployee.id, { workDate: "2029-01-10", minutes: 120, multiplier: 1.5, hourlyRate: 500, amount: 1500 });
      await insertOvertime(otEmployee.id, { workDate: "2029-01-20", minutes: 60, multiplier: 2, hourlyRate: 500, amount: 1000, dayType: "rest_day" });
      // Excluded: still pending, and approved but outside the period.
      await insertOvertime(otEmployee.id, { workDate: "2029-01-21", minutes: 600, multiplier: 1.5, hourlyRate: null, amount: null, status: "pending" });
      await insertOvertime(otEmployee.id, { workDate: "2029-02-05", minutes: 600, multiplier: 1.5, hourlyRate: 500, amount: 7500 });

      const periodEnd = "2029-01-31";
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2029-01-01", periodEnd });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const slip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === otEmployee.id)!;

      expect(slip.grossPay).toBe(93000 + 2500);
      expect(slip.taxableGrossThisPeriod).toBe(93000 + 2500);
      // Overtime counts in this period's taxable income but is NOT projected
      // across the rest of the tax year as if it recurred.
      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 31, taxableGrossThisPeriod: 95500, oneOffTaxableThisPeriod: 2500 });
      expect(slip.incomeTaxMonthly).toBeCloseTo(expectedTax, 2);
      // Overtime is never prorated by EOBI's paid-days ratio, and doesn't change it.
      expect(slip.eobiEmployeeContribution).toBe(407);
      expect(slip.netPay).toBeCloseTo(slip.grossPay - slip.incomeTaxMonthly - slip.eobiEmployeeContribution, 2);

      const labels = slip.calculationBreakdown.map((s) => String(s.label));
      const summary = slip.calculationBreakdown.find((s) => String(s.label).startsWith("Overtime pay"))!;
      expect(summary.value).toBe(2500);
      expect(summary.label).toContain("2 approved claim(s)");
      expect(labels.some((l) => l.startsWith("Overtime 2029-01-10 (weekday) — 120 min @ 500/hr x 1.5"))).toBe(true);
      expect(labels.some((l) => l.startsWith("Overtime 2029-01-20 (rest_day)"))).toBe(true);
      expect(labels.some((l) => l.includes("2029-01-21") || l.includes("2029-02-05"))).toBe(false);
    });

    it("refuses (per-employee error, never a silent zero) an approved overtime claim that has no snapshotted amount", async () => {
      const unpricedEmployee = await createEmployee({ dateOfJoining: "2029-02-01", terminationDate: "2029-02-28" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: unpricedEmployee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      await insertOvertime(unpricedEmployee.id, { workDate: "2029-02-14", minutes: 90, multiplier: 1.5, hourlyRate: null, amount: null });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2029-02-01", periodEnd: "2029-02-28" });
      const result = await payroll.calculateRun(hrAdminClaims, run.id);
      const error = result.errors.find((e) => e.employeeId === unpricedEmployee.id);
      expect(error?.message).toMatch(/overtime claim\(s\) dated 2029-02-14 have no snapshotted amount/);
      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      expect(payslips.some((p) => p.employeeId === unpricedEmployee.id)).toBe(false);
      // Everyone else in the run still gets a payslip.
      expect(payslips.some((p) => p.employeeId === staffEmployeeId)).toBe(true);
    });

    /**
     * Integration gap audit item 5/10 — work-schedule-aware proration. A
     * Mon/Wed/Fri part-timer with an explicit (individual) schedule
     * assignment is prorated over THEIR scheduled working days; an
     * otherwise-identical employee with no assignment (only the company's
     * default shift) keeps the flat calendar-day baseline unchanged.
     *
     * March 2029: the 1st is a Thursday, so Mon/Wed/Fri working days are
     * 2,5,7,9,12,14,16,19,21,23,26,28,30 = 13. Both employees join Friday
     * 2029-03-16 and take approved unpaid leave Tue 20 - Wed 21.
     */
    it("prorates an employee on an assigned part-time (Mon/Wed/Fri) schedule over scheduled working days, leaving the no-assignment calendar baseline unchanged", async () => {
      async function insertShift(name: string, workingDays: number[], isDefault: boolean): Promise<string> {
        return db.withClaims(FIXTURE_CLAIMS, async (client) => {
          const shift = await client.query(
            `INSERT INTO shifts (company_id, name, start_time, end_time, is_default) VALUES ($1, $2, '09:00', '17:00', $3) RETURNING id`,
            [companyId, name, isDefault]
          );
          const shiftId = shift.rows[0].id as string;
          for (let dow = 0; dow <= 6; dow++) {
            const working = workingDays.includes(dow);
            await client.query(
              `INSERT INTO work_schedule_days (company_id, shift_id, day_of_week, is_working, start_time, end_time)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [companyId, shiftId, dow, working, working ? "09:00" : null, working ? "17:00" : null]
            );
          }
          return shiftId;
        });
      }
      // A company default (Mon-Fri) shift exists too — falling back to it is
      // NOT an explicit assignment and must not switch anyone to working days.
      await insertShift(`Payroll Default Office ${Date.now()}`, [1, 2, 3, 4, 5], true);
      const partTimeShiftId = await insertShift(`Part-Time MWF ${Date.now()}`, [1, 3, 5], false);

      const partTimer = await createEmployee({ dateOfJoining: "2029-03-16", terminationDate: "2029-03-31" });
      const baseline = await createEmployee({ dateOfJoining: "2029-03-16", terminationDate: "2029-03-31" });
      for (const e of [partTimer, baseline]) {
        await compensation.setCompensation(hrAdminClaims, { employeeId: e.id, monthlySalary: 130000, effectiveFrom: "2020-01-01" });
        await insertUnpaidLeave(e.id, "2029-03-20", "2029-03-21");
      }
      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query(
          `INSERT INTO shift_assignments (company_id, employee_id, shift_id, effective_from, created_by_user_account_id)
           VALUES ($1, $2, $3, '2020-01-01', $4)`,
          [companyId, partTimer.id, partTimeShiftId, staffUserId]
        )
      );

      const periodEnd = "2029-03-31";
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2029-03-01", periodEnd });
      const result = await payroll.calculateRun(hrAdminClaims, run.id);
      expect(result.errors.filter((e) => e.employeeId === partTimer.id || e.employeeId === baseline.id)).toEqual([]);
      const payslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const partTimeSlip = payslips.find((p) => p.employeeId === partTimer.id)!;
      const baselineSlip = payslips.find((p) => p.employeeId === baseline.id)!;

      // Independent re-expression of the expected working-day count.
      const mwf = (start: string, end: string) => {
        let n = 0;
        for (let t = Date.parse(start); t <= Date.parse(end); t += 86_400_000) {
          if ([1, 3, 5].includes(new Date(t).getUTCDay())) n++;
        }
        return n;
      };
      expect(mwf("2029-03-01", "2029-03-31")).toBe(13);
      expect(mwf("2029-03-16", "2029-03-31")).toBe(7);
      expect(mwf("2029-03-20", "2029-03-21")).toBe(1);

      // Schedule-aware: 130000 x 7/13 = 70000, minus 1 unpaid working day
      // (Tue 20 is a rest day for this employee) x 130000/13 = 10000.
      expect(partTimeSlip.daysInPeriod).toBe(13);
      expect(partTimeSlip.unpaidLeaveDays).toBe(1);
      expect(partTimeSlip.paidDays).toBe(6);
      expect(partTimeSlip.grossPay).toBe(60000);
      expect(partTimeSlip.eobiEmployeeContribution).toBeCloseTo(407 * (6 / 7), 2);
      // Tax projection stays calendar-based (31-day period) by design.
      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 31, taxableGrossThisPeriod: 60000 });
      expect(partTimeSlip.incomeTaxMonthly).toBeCloseTo(expectedTax, 2);
      expect(partTimeSlip.calculationBreakdown.some((s) => String(s.label).startsWith("Proration basis: scheduled working days") && String(s.label).includes("Part-Time MWF"))).toBe(true);

      // Calendar baseline, byte-for-byte the pre-existing formula:
      // 130000 x 16/31 - 130000 x 2/31 = 130000 x 14/31 = 58709.68
      expect(baselineSlip.daysInPeriod).toBe(31);
      expect(baselineSlip.unpaidLeaveDays).toBe(2);
      expect(baselineSlip.paidDays).toBe(14);
      expect(baselineSlip.grossPay).toBe(Number(((130000 * 16) / 31 - (130000 * 2) / 31).toFixed(2)));
      expect(baselineSlip.grossPay).toBe(58709.68);
      expect(baselineSlip.calculationBreakdown.some((s) => String(s.label).startsWith("Proration basis: calendar days"))).toBe(true);

      expect(partTimeSlip.grossPay).not.toBe(baselineSlip.grossPay);
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

      await submitAndApprove(run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      await expect(payroll.calculateRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without payroll.calculate.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-05-16", periodEnd: "2027-05-31" });
      await expect(payroll.calculateRun(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });

  // --- Phase P3: Loans/Advances (IT0045) and Additional Payments (IT0015) -

  describe("Loans/Advances and Additional Payments (Phase P3)", () => {
    it("previews a loan installment and a taxable additional earning at calculate(), then commits both only at finalize()", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });

      const loan = await loans.create(hrAdminClaims, {
        employeeId: employee.id,
        loanType: "loan",
        reason: "Medical emergency",
        principalAmount: 20000,
        installmentAmount: 5000,
        issuedDate: "2026-10-01",
      });
      const earning = await additionalPayments.create(hrAdminClaims, {
        employeeId: employee.id,
        paymentType: "earning",
        label: "Eid Bonus",
        amount: 10000,
        effectiveDate: "2026-10-15",
      });
      const deduction = await additionalPayments.create(hrAdminClaims, {
        employeeId: employee.id,
        paymentType: "deduction",
        label: "Uniform Cost Recovery",
        amount: 1500,
        effectiveDate: "2026-10-15",
      });

      const periodStart = "2026-10-01";
      const periodEnd = "2026-10-31";
      const run = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd });
      await payroll.calculateRun(hrAdminClaims, run.id);

      const calculatedPayslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id });
      const slip = calculatedPayslips.find((p) => p.employeeId === employee.id)!;

      // Gross/taxable gross include the taxable additional earning
      // (same treatment as overtime — a one-off, not annualized).
      expect(slip.grossPay).toBe(110000); // 100000 salary + 10000 bonus
      expect(slip.taxableGrossThisPeriod).toBe(110000);
      // Net pay is gross - tax - EOBI - loan installment - the deduction,
      // and the deduction never touched gross/taxable gross.
      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 31, taxableGrossThisPeriod: 110000, oneOffTaxableThisPeriod: 10000 });
      expect(slip.netPay).toBeCloseTo(110000 - expectedTax - 407 - 5000 - 1500, 2);

      // Previewed, not yet committed: the loan/payment rows themselves
      // are untouched until finalize().
      expect(slip.loanDeductions).toEqual([{ loanId: loan.id, amount: 5000 }]);
      expect(slip.consumedAdditionalPayments.sort((a, b) => a.additionalPaymentId.localeCompare(b.additionalPaymentId))).toEqual(
        [
          { additionalPaymentId: earning.id, amount: 10000 },
          { additionalPaymentId: deduction.id, amount: 1500 },
        ].sort((a, b) => a.additionalPaymentId.localeCompare(b.additionalPaymentId))
      );
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Eid Bonus"))).toBe(true);
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Uniform Cost Recovery"))).toBe(true);
      expect(slip.calculationBreakdown.some((s) => String(s.label).includes("Loan repayment installment"))).toBe(true);

      const loanBeforeFinalize = (await loans.list(hrAdminClaims, employee.id)).find((l) => l.id === loan.id)!;
      expect(loanBeforeFinalize.outstandingBalance).toBe(20000); // untouched
      const earningBeforeFinalize = (await additionalPayments.list(hrAdminClaims, employee.id)).find((p) => p.id === earning.id)!;
      expect(earningBeforeFinalize.status).toBe("pending"); // untouched

      // Recalculating (still draft) must not double-preview — same
      // structured preview, not an accumulating one.
      await payroll.calculateRun(hrAdminClaims, run.id);
      const recalculated = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === employee.id)!;
      expect(recalculated.loanDeductions).toEqual([{ loanId: loan.id, amount: 5000 }]);

      await submitAndApprove(run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);

      // Now committed: the ledger row exists, outstanding_balance is
      // decremented, and the additional payments are marked consumed.
      const loanAfterFinalize = (await loans.list(hrAdminClaims, employee.id)).find((l) => l.id === loan.id)!;
      expect(loanAfterFinalize.outstandingBalance).toBe(15000);
      expect(loanAfterFinalize.status).toBe("active");

      const afterFinalizePayments = await additionalPayments.list(hrAdminClaims, employee.id);
      expect(afterFinalizePayments.find((p) => p.id === earning.id)!.status).toBe("consumed");
      expect(afterFinalizePayments.find((p) => p.id === deduction.id)!.status).toBe("consumed");
      expect(afterFinalizePayments.find((p) => p.id === earning.id)!.consumedPayrollRunId).toBe(run.id);
    });

    it("a non-taxable additional earning adds to gross pay but not taxable gross", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      await additionalPayments.create(hrAdminClaims, {
        employeeId: employee.id,
        paymentType: "earning",
        label: "Tax-Free Travel Reimbursement",
        amount: 4000,
        isTaxable: false,
        effectiveDate: "2026-11-10",
      });

      const periodEnd = "2026-11-30";
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2026-11-01", periodEnd });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const slip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === employee.id)!;

      expect(slip.grossPay).toBe(104000);
      expect(slip.taxableGrossThisPeriod).toBe(100000);
    });

    it("a loan's installment is capped at the outstanding balance on its final payment", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      const loan = await loans.create(hrAdminClaims, {
        employeeId: employee.id,
        loanType: "salary_advance",
        principalAmount: 3000,
        installmentAmount: 5000, // deliberately larger than the principal
        issuedDate: "2027-08-01",
      });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-08-01", periodEnd: "2027-08-31" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const slip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === employee.id)!;
      expect(slip.loanDeductions).toEqual([{ loanId: loan.id, amount: 3000 }]); // capped, not 5000

      await submitAndApprove(run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      const closedLoan = (await loans.list(hrAdminClaims, employee.id)).find((l) => l.id === loan.id)!;
      expect(closedLoan.outstandingBalance).toBe(0);
      expect(closedLoan.status).toBe("closed");
    });

    it("reverseRun() leaves committed loan repayments and consumed additional payments untouched (permanent historical record, same posture as the original payslips themselves)", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      const loan = await loans.create(hrAdminClaims, {
        employeeId: employee.id,
        loanType: "loan",
        principalAmount: 20000,
        installmentAmount: 5000,
        issuedDate: "2027-09-01",
      });

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-09-01", periodEnd: "2027-09-30" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await submitAndApprove(run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);

      const loanAfterFinalize = (await loans.list(hrAdminClaims, employee.id)).find((l) => l.id === loan.id)!;
      expect(loanAfterFinalize.outstandingBalance).toBe(15000);

      await payroll.reverseRun(hrAdminClaims, run.id, { reason: "Correcting an unrelated figure" });

      const loanAfterReversal = (await loans.list(hrAdminClaims, employee.id)).find((l) => l.id === loan.id)!;
      expect(loanAfterReversal.outstandingBalance).toBe(15000); // unchanged by the reversal
    });
  });

  // --- Phase P4: Off-cycle runs & Final Settlement ------------------------

  describe("createRun() off-cycle validation (Phase P4)", () => {
    it("rejects offCycleReason/targetEmployeeId on a regular run", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2029-01-01", periodEnd: "2029-01-31", offCycleReason: "bonus" })
      ).rejects.toThrow(BadRequestException);
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2029-01-01", periodEnd: "2029-01-31", targetEmployeeId: employee.id })
      ).rejects.toThrow(BadRequestException);
    });

    it("requires offCycleReason for an off-cycle run", async () => {
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2029-01-01", periodEnd: "2029-01-31", runType: "off_cycle" })
      ).rejects.toThrow(BadRequestException);
    });

    it("requires targetEmployeeId for final_settlement, and a terminated employee whose termination date falls inside the period", async () => {
      await expect(
        payroll.createRun(hrAdminClaims, {
          periodStart: "2029-01-01",
          periodEnd: "2029-01-31",
          runType: "off_cycle",
          offCycleReason: "final_settlement",
        })
      ).rejects.toThrow(BadRequestException);

      const stillActive = await createEmployee({ dateOfJoining: "2020-01-01" });
      await expect(
        payroll.createRun(hrAdminClaims, {
          periodStart: "2029-01-01",
          periodEnd: "2029-01-31",
          runType: "off_cycle",
          offCycleReason: "final_settlement",
          targetEmployeeId: stillActive.id,
        })
      ).rejects.toThrow(BadRequestException);

      const terminatedOutsidePeriod = await createEmployee({ dateOfJoining: "2020-01-01", terminationDate: "2029-02-15" });
      await expect(
        payroll.createRun(hrAdminClaims, {
          periodStart: "2029-01-01",
          periodEnd: "2029-01-31",
          runType: "off_cycle",
          offCycleReason: "final_settlement",
          targetEmployeeId: terminatedOutsidePeriod.id,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a second non-reversed final_settlement run for the same employee", async () => {
      const terminated = await createEmployee({ dateOfJoining: "2020-01-01", terminationDate: "2029-03-15" });
      await payroll.createRun(hrAdminClaims, {
        periodStart: "2029-03-01",
        periodEnd: "2029-03-31",
        runType: "off_cycle",
        offCycleReason: "final_settlement",
        targetEmployeeId: terminated.id,
      });
      await expect(
        payroll.createRun(hrAdminClaims, {
          periodStart: "2029-03-01",
          periodEnd: "2029-03-31",
          runType: "off_cycle",
          offCycleReason: "final_settlement",
          targetEmployeeId: terminated.id,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("an off-cycle run freely coexists with a regular run for the exact same period (the relaxed unique index)", async () => {
      const periodStart = "2029-04-01";
      const periodEnd = "2029-04-30";
      const regular = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd });
      const bonus = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd, runType: "off_cycle", offCycleReason: "bonus" });
      expect(regular.id).not.toBe(bonus.id);
      expect(bonus.runType).toBe("off_cycle");
      expect(bonus.offCycleReason).toBe("bonus");
    });
  });

  describe("Off-cycle bonus/arrears runs (Phase P4)", () => {
    it("pays exactly what's queued against this run, taxed as a one-off (no EOBI, no loan deduction even if the employee has one)", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      await loans.create(hrAdminClaims, {
        employeeId: employee.id,
        loanType: "loan",
        principalAmount: 20000,
        installmentAmount: 5000,
        issuedDate: "2029-05-01",
      });

      const periodStart = "2029-05-01";
      const periodEnd = "2029-05-31";
      const bonusRun = await payroll.createRun(hrAdminClaims, { periodStart, periodEnd, runType: "off_cycle", offCycleReason: "bonus" });
      const earning = await offCyclePayments.create(hrAdminClaims, {
        employeeId: employee.id,
        payrollRunId: bonusRun.id,
        paymentType: "earning",
        label: "Performance Bonus",
        amount: 50000,
      });
      const deduction = await offCyclePayments.create(hrAdminClaims, {
        employeeId: employee.id,
        payrollRunId: bonusRun.id,
        paymentType: "deduction",
        label: "Advance Recovery",
        amount: 3000,
      });

      await payroll.calculateRun(hrAdminClaims, bonusRun.id);
      const slip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: bonusRun.id })).find((p) => p.employeeId === employee.id)!;

      expect(slip.grossPay).toBe(50000);
      expect(slip.taxableGrossThisPeriod).toBe(50000);
      expect(slip.eobiEmployeeContribution).toBe(0);
      expect(slip.eobiEmployerContribution).toBe(0);
      expect(slip.loanDeductions).toEqual([]); // never touches the regular run's loan
      const expectedTax = expectedIncomeTax({ periodEnd, daysInPeriod: 31, taxableGrossThisPeriod: 50000 });
      expect(slip.incomeTaxMonthly).toBeCloseTo(expectedTax, 2);
      expect(slip.netPay).toBeCloseTo(50000 - expectedTax - 3000, 2);
      expect(slip.consumedOffCyclePayments.sort((a, b) => a.offCyclePaymentId.localeCompare(b.offCyclePaymentId))).toEqual(
        [
          { offCyclePaymentId: earning.id, amount: 50000 },
          { offCyclePaymentId: deduction.id, amount: 3000 },
        ].sort((a, b) => a.offCyclePaymentId.localeCompare(b.offCyclePaymentId))
      );

      // Previewed, not committed, until finalize().
      expect((await offCyclePayments.listForRun(hrAdminClaims, bonusRun.id)).find((p) => p.id === earning.id)!.status).toBe("pending");

      await submitAndApprove(bonusRun.id);
      await payroll.finalizeRun(hrAdminClaims, bonusRun.id);
      const afterFinalize = await offCyclePayments.listForRun(hrAdminClaims, bonusRun.id);
      expect(afterFinalize.find((p) => p.id === earning.id)!.status).toBe("consumed");
      expect(afterFinalize.find((p) => p.id === deduction.id)!.status).toBe("consumed");
    });

    it("a batch bonus run collects a per-employee error (not an empty payslip) for anyone with nothing queued against it", async () => {
      const withBonus = await createEmployee({ dateOfJoining: "2020-01-01" });
      const withoutBonus = await createEmployee({ dateOfJoining: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: withBonus.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: withoutBonus.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });

      const bonusRun = await payroll.createRun(hrAdminClaims, {
        periodStart: "2029-06-01",
        periodEnd: "2029-06-30",
        runType: "off_cycle",
        offCycleReason: "bonus",
      });
      await offCyclePayments.create(hrAdminClaims, {
        employeeId: withBonus.id,
        payrollRunId: bonusRun.id,
        paymentType: "earning",
        label: "Bonus",
        amount: 10000,
      });

      const result = await payroll.calculateRun(hrAdminClaims, bonusRun.id);
      expect(result.payslipCount).toBe(1);
      expect(result.errors.some((e) => e.employeeId === withoutBonus.id)).toBe(true);
    });
  });

  describe("Final Settlement (Phase P4)", () => {
    it("pays the final prorated salary + full loan payoff + HR-entered settlement lines (gratuity/leave encashment), with a full tax true-up", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01", terminationDate: "2029-07-15" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 100000, effectiveFrom: "2020-01-01" });
      const loan = await loans.create(hrAdminClaims, {
        employeeId: employee.id,
        loanType: "loan",
        principalAmount: 40000,
        installmentAmount: 5000, // the normal installment — settlement pays the FULL remaining balance instead
        issuedDate: "2029-07-01",
      });

      const periodStart = "2029-07-01";
      const periodEnd = "2029-07-31";
      const settlementRun = await payroll.createRun(hrAdminClaims, {
        periodStart,
        periodEnd,
        runType: "off_cycle",
        offCycleReason: "final_settlement",
        targetEmployeeId: employee.id,
      });
      expect(settlementRun.targetEmployeeId).toBe(employee.id);

      const gratuity = await offCyclePayments.create(hrAdminClaims, {
        employeeId: employee.id,
        payrollRunId: settlementRun.id,
        paymentType: "earning",
        label: "Gratuity (HR-computed)",
        amount: 150000,
      });
      const leaveEncashment = await offCyclePayments.create(hrAdminClaims, {
        employeeId: employee.id,
        payrollRunId: settlementRun.id,
        paymentType: "earning",
        label: "Leave Encashment (HR-computed)",
        amount: 30000,
      });

      await payroll.calculateRun(hrAdminClaims, settlementRun.id);
      const slip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: settlementRun.id })).find((p) => p.employeeId === employee.id)!;

      // Final prorated salary (1-15 Jul of a 31-day month) + gratuity + leave encashment.
      const finalSalary = (100000 * 15) / 31;
      expect(slip.grossPay).toBeCloseTo(finalSalary + 150000 + 30000, 2);
      expect(slip.taxableGrossThisPeriod).toBeCloseTo(finalSalary + 150000 + 30000, 2);

      // FULL loan payoff (40000), not the normal 5000 installment.
      expect(slip.loanDeductions).toEqual([{ loanId: loan.id, amount: 40000 }]);

      // Full tax true-up: fractionElapsed forced to 1, nothing projected
      // — the estimated annual taxable income is exactly this
      // settlement's own taxable total (no prior YTD for this fresh employee).
      const expectedAnnualTax = taxFromSlabsForTests(slip.taxableGrossThisPeriod);
      expect(slip.incomeTaxMonthly).toBeCloseTo(expectedAnnualTax, 2);
      expect(slip.taxableAnnualIncome).toBeCloseTo(slip.taxableGrossThisPeriod, 2);

      expect(slip.netPay).toBeCloseTo(slip.grossPay - slip.incomeTaxMonthly - slip.eobiEmployeeContribution - 40000, 2);
      expect(slip.consumedOffCyclePayments.sort((a, b) => a.offCyclePaymentId.localeCompare(b.offCyclePaymentId))).toEqual(
        [
          { offCyclePaymentId: gratuity.id, amount: 150000 },
          { offCyclePaymentId: leaveEncashment.id, amount: 30000 },
        ].sort((a, b) => a.offCyclePaymentId.localeCompare(b.offCyclePaymentId))
      );

      await submitAndApprove(settlementRun.id);
      await payroll.finalizeRun(hrAdminClaims, settlementRun.id);

      const closedLoan = (await loans.list(hrAdminClaims, employee.id)).find((l) => l.id === loan.id)!;
      expect(closedLoan.outstandingBalance).toBe(0);
      expect(closedLoan.status).toBe("closed");
      const settledPayments = await offCyclePayments.listForRun(hrAdminClaims, settlementRun.id);
      expect(settledPayments.find((p) => p.id === gratuity.id)!.status).toBe("consumed");
      expect(settledPayments.find((p) => p.id === leaveEncashment.id)!.status).toBe("consumed");
    });

    it("refuses to calculate a final_settlement run when a regular run already paid this employee for an overlapping period", async () => {
      const employee = await createEmployee({ dateOfJoining: "2020-01-01", terminationDate: "2029-08-20" });
      await compensation.setCompensation(hrAdminClaims, { employeeId: employee.id, monthlySalary: 80000, effectiveFrom: "2020-01-01" });

      const regularRun = await payroll.createRun(hrAdminClaims, { periodStart: "2029-08-01", periodEnd: "2029-08-31" });
      await payroll.calculateRun(hrAdminClaims, regularRun.id);
      await submitAndApprove(regularRun.id);
      await payroll.finalizeRun(hrAdminClaims, regularRun.id);

      const settlementRun = await payroll.createRun(hrAdminClaims, {
        periodStart: "2029-08-01",
        periodEnd: "2029-08-31",
        runType: "off_cycle",
        offCycleReason: "final_settlement",
        targetEmployeeId: employee.id,
      });
      await offCyclePayments.create(hrAdminClaims, {
        employeeId: employee.id,
        payrollRunId: settlementRun.id,
        paymentType: "earning",
        label: "Gratuity",
        amount: 50000,
      });

      await expect(payroll.calculateRun(hrAdminClaims, settlementRun.id)).rejects.toThrow(BadRequestException);
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
      await submitAndApprove(run1.id);
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
      await submitAndApprove(run1.id);
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

  // --- Phase P2: submitForApproval() / decideApproval() -------------------

  describe("submitForApproval() / decideApproval() (Phase P2)", () => {
    it("submitting moves a calculated run to pending_approval, and refuses a run that isn't freshly calculated", async () => {
      const draftRun = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-01", periodEnd: "2027-06-01" });
      await expect(payroll.submitForApproval(hrAdminClaims, draftRun.id)).rejects.toThrow(BadRequestException);

      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-02", periodEnd: "2027-06-02" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      const submitted = await payroll.submitForApproval(hrAdminClaims, run.id);
      expect(submitted.status).toBe("pending_approval");
      expect(submitted.workflowInstanceId).not.toBeNull();

      // Already pending — cannot resubmit.
      await expect(payroll.submitForApproval(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("denies submitForApproval to a caller without payroll.calculate.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-03", periodEnd: "2027-06-03" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.submitForApproval(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
      // The Payroll Approver role itself holds none of hr_admin's
      // calculate/finalize/disburse permissions either — segregation of
      // duties cuts both ways.
      await expect(payroll.submitForApproval(approverClaims, run.id)).rejects.toThrow(ForbiddenException);
    });

    it("approving moves the run to approved, which can then be finalized", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-04", periodEnd: "2027-06-04" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.submitForApproval(hrAdminClaims, run.id);
      const decided = await payroll.decideApproval(approverClaims, run.id, { decision: "approved" });
      expect(decided.status).toBe("approved");

      const finalized = await payroll.finalizeRun(hrAdminClaims, run.id);
      expect(finalized.status).toBe("finalized");
    });

    it("rejecting reverts the run to calculated, so it can be recalculated and resubmitted", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-05", periodEnd: "2027-06-05" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.submitForApproval(hrAdminClaims, run.id);
      const decided = await payroll.decideApproval(approverClaims, run.id, { decision: "rejected", comment: "Wrong period" });
      expect(decided.status).toBe("calculated");

      // Not a dead end — HR can recalculate and resubmit the same run.
      await payroll.calculateRun(hrAdminClaims, run.id);
      const resubmitted = await payroll.submitForApproval(hrAdminClaims, run.id);
      expect(resubmitted.status).toBe("pending_approval");
    });

    it("denies decideApproval to a caller without payroll.approve.all — segregation of duties, not just workflow routing", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-06", periodEnd: "2027-06-06" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await payroll.submitForApproval(hrAdminClaims, run.id);
      // The preparer (hr_admin) cannot approve their own submission —
      // holding payroll.calculate.all is not enough, by design.
      await expect(payroll.decideApproval(hrAdminClaims, run.id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
      await expect(payroll.decideApproval(outsiderClaims, run.id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
    });

    it("refuses to finalize a run that is only pending_approval or merely calculated", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-06-07", periodEnd: "2027-06-07" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);

      await payroll.submitForApproval(hrAdminClaims, run.id);
      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
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
      await submitAndApprove(run.id);
      const finalized = await payroll.finalizeRun(hrAdminClaims, run.id);
      expect(finalized.status).toBe("finalized");
      expect(finalized.finalizedAt).not.toBeNull();

      await expect(payroll.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
    });

    it("denies a caller without payroll.finalize.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-11-03", periodEnd: "2027-11-03" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.finalizeRun(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });

  // --- reverseRun(): Correction/Reversal (Phase P2) ------------------------

  describe("reverseRun()", () => {
    it("reverses a finalized run, preserving its original payslips untouched, and opens a fresh draft run for the same period", async () => {
      const runId = await createFinalizedRun("2027-12-10", "2027-12-10");
      const beforePayslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: runId });
      expect(beforePayslips.length).toBeGreaterThan(0);
      const originalNetPay = beforePayslips.reduce((sum, p) => sum + p.netPay, 0);

      const reversed = await payroll.reverseRun(hrAdminClaims, runId, { reason: "Wrong bank account on file" });
      expect(reversed.status).toBe("reversed");
      expect(reversed.reversedAt).not.toBeNull();
      expect(reversed.reversedByUserAccountId).toBe(hrAdminClaims.sub);
      expect(reversed.reversalReason).toBe("Wrong bank account on file");
      expect(reversed.correctiveRunId).not.toBeNull();
      // The original payslips are the entire point of "preserve original
      // result" (Section 36) — reversing must never touch them.
      expect(reversed.payslipCount).toBe(beforePayslips.length);
      // toBeCloseTo, not toBe: every payslip in a run shares one
      // `created_at` (confirmed against the real table), so listPayslips'
      // order isn't guaranteed stable across calls — summing the same
      // currency values in a different order is exactly the case
      // floating-point addition isn't associative for, so an exact `toBe`
      // here was flaky (two payslip sums, same values, different order,
      // off by a few e-10s), not a real mismatch in what reversal preserved.
      expect(reversed.totalNetPay).toBeCloseTo(originalNetPay, 2);
      const afterPayslips = await payroll.listPayslips(hrAdminClaims, { payrollRunId: runId });
      expect(afterPayslips).toEqual(beforePayslips);

      const corrective = await payroll.getRun(hrAdminClaims, reversed.correctiveRunId!);
      expect(corrective.status).toBe("draft");
      expect(corrective.periodStart).toBe(reversed.periodStart);
      expect(corrective.periodEnd).toBe(reversed.periodEnd);
      expect(corrective.payslipCount).toBe(0);

      // The whole chain is reconstructable from listRuns() alone.
      const allRuns = await payroll.listRuns(hrAdminClaims);
      expect(allRuns.find((r) => r.id === runId)?.correctiveRunId).toBe(corrective.id);
    });

    it("refuses to reverse a run that is not finalized yet", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2027-12-11", periodEnd: "2027-12-11" });
      await expect(payroll.reverseRun(hrAdminClaims, run.id, { reason: "Too early" })).rejects.toThrow(BadRequestException);

      await payroll.calculateRun(hrAdminClaims, run.id);
      await expect(payroll.reverseRun(hrAdminClaims, run.id, { reason: "Still too early" })).rejects.toThrow(BadRequestException);
    });

    it("requires a non-empty reason", async () => {
      const runId = await createFinalizedRun("2027-12-12", "2027-12-12");
      await expect(payroll.reverseRun(hrAdminClaims, runId, { reason: "" })).rejects.toThrow(BadRequestException);
      await expect(payroll.reverseRun(hrAdminClaims, runId, { reason: "   " })).rejects.toThrow(BadRequestException);
    });

    it("refuses to reverse the same run twice", async () => {
      const runId = await createFinalizedRun("2027-12-13", "2027-12-13");
      await payroll.reverseRun(hrAdminClaims, runId, { reason: "First reversal" });
      await expect(payroll.reverseRun(hrAdminClaims, runId, { reason: "Second attempt" })).rejects.toThrow(BadRequestException);
    });

    it("denies reversal to a caller who does not hold BOTH payroll.finalize.all and payroll.disburse.all — 'elevated authorization' per the master instruction", async () => {
      const runId = await createFinalizedRun("2027-12-14", "2027-12-14");
      // Outsider holds neither.
      await expect(payroll.reverseRun(outsiderClaims, runId, { reason: "Not my call" })).rejects.toThrow(ForbiddenException);
      // The Payroll Approver holds payroll.approve.all only — approving a
      // run is not the same authorization as being able to undo a
      // finalized one, by design.
      await expect(payroll.reverseRun(approverClaims, runId, { reason: "Not my call either" })).rejects.toThrow(ForbiddenException);
    });

    it("blocks a new manual run for the same period while the corrective run is still active, exactly like any other duplicate period", async () => {
      const runId = await createFinalizedRun("2027-12-15", "2027-12-15");
      await payroll.reverseRun(hrAdminClaims, runId, { reason: "Data entry error" });
      // The corrective run itself is a real, non-reversed row occupying
      // this period now — the relaxed constraint only ever allowed the
      // REVERSED original to stop blocking new rows, not a second
      // simultaneously-active run for the same period.
      await expect(
        payroll.createRun(hrAdminClaims, { periodStart: "2027-12-15", periodEnd: "2027-12-15" })
      ).rejects.toThrow(BadRequestException);
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
      await submitAndApprove(visRunId);
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
      await submitAndApprove(run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      const payslip = (await payroll.listPayslips(hrAdminClaims, { payrollRunId: run.id })).find((p) => p.employeeId === staffEmployeeId)!;

      const csv = await payroll.generateDisbursementFile(hrAdminClaims, run.id);
      const lines = csv.split("\n");
      expect(lines[0]).toBe("employeeNumber,bankAccountNumber,netPay");
      expect(csv).not.toContain(staffEmployeeId); // the internal UUID never appears
      expect(csv).toContain(`${staffEmployeeNumber},PK00-STAFF,${payslip.netPay.toFixed(2)}`);
    });

    it("denies a caller without payroll.disburse.all", async () => {
      const run = await payroll.createRun(hrAdminClaims, { periodStart: "2028-01-03", periodEnd: "2028-01-03" });
      await payroll.calculateRun(hrAdminClaims, run.id);
      await submitAndApprove(run.id);
      await payroll.finalizeRun(hrAdminClaims, run.id);
      await expect(payroll.generateDisbursementFile(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * Integration gap audit item 9 — Payroll emits `payroll_run.finalized`
   * and `payroll_run.disbursed`, following employees.service.spec.ts's
   * own webhook-test shape: a SEPARATE service instance built WITH a real
   * WebhookDispatchService (this file's shared `payroll` is built without
   * one, proving the optional dependency breaks nothing), a real webhook
   * integration configured for the tenant, and the real `webhook_events`
   * row read back — plus a jest spy on `enqueue()` to assert the exact
   * event name and payload keys PayrollService passed it.
   */
  describe("webhook events (integration gap audit item 9)", () => {
    const platformClaims: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payroll-webhook-spec" };
    let webhooks: WebhookDispatchService;
    let payrollWithWebhooks: PayrollService;
    let enqueueSpy: jest.SpyInstance;

    beforeAll(async () => {
      await new IntegrationsService(db, new AuditService()).configure(platformClaims, companyId, "webhook", {
        enabled: true,
        config: { url: "http://127.0.0.1:1/hook", signingSecret: "payroll-trigger-secret" },
      });
      webhooks = new WebhookDispatchService(db, new AuditService());
      enqueueSpy = jest.spyOn(webhooks, "enqueue");
      payrollWithWebhooks = new PayrollService(
        db,
        rbac,
        entitlements,
        audit,
        importExport,
        new EffectiveDatingEngine(),
        workflow,
        leaveRequests,
        overtime,
        workSchedule,
        webhooks,
        undefined,
        loans,
        additionalPayments,
        offCyclePayments
      );
    });

    afterAll(() => {
      enqueueSpy.mockRestore();
    });

    beforeEach(() => {
      enqueueSpy.mockClear();
    });

    async function latestEventFor(type: string, runId: string) {
      // enqueue() is fire-and-forget — give its own DB write a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await db.withClaims(platformClaims, (client) =>
        client.query(
          `SELECT * FROM webhook_events WHERE company_id = $1 AND event_type = $2 AND payload->>'payrollRunId' = $3
           ORDER BY created_at DESC LIMIT 1`,
          [companyId, type, runId]
        )
      );
      return result.rows[0];
    }

    it("enqueues payroll_run.finalized with the run's id, company, period, employee count and totals — only once the run really finalizes", async () => {
      const run = await payrollWithWebhooks.createRun(hrAdminClaims, { periodStart: "2029-05-01", periodEnd: "2029-05-31" });
      await payrollWithWebhooks.calculateRun(hrAdminClaims, run.id);

      // A refused finalize (not yet approved) must announce nothing.
      await expect(payrollWithWebhooks.finalizeRun(hrAdminClaims, run.id)).rejects.toThrow(BadRequestException);
      expect(enqueueSpy).not.toHaveBeenCalled();

      await payrollWithWebhooks.submitForApproval(hrAdminClaims, run.id);
      await payrollWithWebhooks.decideApproval(approverClaims, run.id, { decision: "approved" });
      const finalized = await payrollWithWebhooks.finalizeRun(hrAdminClaims, run.id);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const [eventCompanyId, eventType, payload] = enqueueSpy.mock.calls[0];
      expect(eventCompanyId).toBe(companyId);
      expect(eventType).toBe("payroll_run.finalized");
      expect(payload).toEqual(
        expect.objectContaining({
          payrollRunId: run.id,
          companyId,
          periodStart: "2029-05-01",
          periodEnd: "2029-05-31",
          totalEmployees: finalized.payslipCount,
          totalGrossPay: finalized.totalGrossPay,
          totalNetPay: finalized.totalNetPay,
          finalizedByUserAccountId: hrAdminClaims.sub,
        })
      );
      expect(finalized.payslipCount).toBeGreaterThan(0);
      expect(payload.finalizedAt).toBe(finalized.finalizedAt);

      const event = await latestEventFor("payroll_run.finalized", run.id);
      expect(event).toBeDefined();
      expect(event.status).toBe("pending");
      expect(event.payload.totalEmployees).toBe(finalized.payslipCount);
    });

    it("enqueues payroll_run.disbursed with the acting user and a total that reconciles to the bank file", async () => {
      const run = await payrollWithWebhooks.createRun(hrAdminClaims, { periodStart: "2029-06-01", periodEnd: "2029-06-30" });
      await payrollWithWebhooks.calculateRun(hrAdminClaims, run.id);
      await payrollWithWebhooks.submitForApproval(hrAdminClaims, run.id);
      await payrollWithWebhooks.decideApproval(approverClaims, run.id, { decision: "approved" });
      await payrollWithWebhooks.finalizeRun(hrAdminClaims, run.id);
      enqueueSpy.mockClear();

      // Refused for a caller without payroll.disburse.all -> no event.
      await expect(payrollWithWebhooks.generateDisbursementFile(outsiderClaims, run.id)).rejects.toThrow(ForbiddenException);
      expect(enqueueSpy).not.toHaveBeenCalled();

      const csv = await payrollWithWebhooks.generateDisbursementFile(hrAdminClaims, run.id);
      const dataLines = csv.split("\n").slice(1).filter((l) => l.trim().length > 0);
      const csvTotal = Number(dataLines.reduce((sum, l) => sum + Number(l.split(",").pop()), 0).toFixed(2));

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const [eventCompanyId, eventType, payload] = enqueueSpy.mock.calls[0];
      expect(eventCompanyId).toBe(companyId);
      expect(eventType).toBe("payroll_run.disbursed");
      expect(payload).toEqual(
        expect.objectContaining({
          payrollRunId: run.id,
          companyId,
          periodStart: "2029-06-01",
          periodEnd: "2029-06-30",
          totalEmployees: dataLines.length,
          totalNetPay: csvTotal,
          disbursedByUserAccountId: hrAdminClaims.sub,
        })
      );
      expect(typeof payload.disbursedAt).toBe("string");

      const event = await latestEventFor("payroll_run.disbursed", run.id);
      expect(event).toBeDefined();
      expect(event.payload.disbursedByUserAccountId).toBe(hrAdminClaims.sub);
    });
  });
});
