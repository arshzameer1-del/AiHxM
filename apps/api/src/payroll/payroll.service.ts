import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { ImportExportService } from "../import-export/import-export.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import type {
  CalculatePayrollRunResponse,
  CompensationView,
  CreatePayrollRunRequest,
  PayrollCalculationError,
  PayrollCalculationStep,
  PayrollRunView,
  PayrollSettingsView,
  PayslipView,
  SetCompensationRequest,
  SetTaxSlabsRequest,
  TaxSlabSetView,
  TaxSlabView,
  UpdatePayrollSettingsRequest,
} from "@boostfactor/shared-types";

const MODULE_KEY = "payroll" as const;
const HR_MANAGE_PERMISSION = "payroll.manage.all";
const SELF_VIEW_PERMISSION = "payroll_review.view.self";

// The default FBR salaried-individual tax slabs (Tax Year 2027 / FY2026-27),
// lazily seeded per-company the first time PayrollService needs a
// tenant's tax_slabs and finds none. Researched, NOT primary-source
// confirmed — see claude/statutory-payroll-rates-pakistan.md and
// Decision #14. A tenant's own HR Admin can (and, before going live with
// real money, should) correct these via updateTaxSlabs().
const DEFAULT_TAX_SLABS = [
  { min: 0, max: 600_000, base: 0, rate: 0 },
  { min: 600_000, max: 1_200_000, base: 0, rate: 1 },
  { min: 1_200_000, max: 2_200_000, base: 6_000, rate: 11 },
  { min: 2_200_000, max: 3_200_000, base: 116_000, rate: 20 },
  { min: 3_200_000, max: 4_100_000, base: 316_000, rate: 25 },
  { min: 4_100_000, max: 5_600_000, base: 541_000, rate: 29 },
  { min: 5_600_000, max: 7_000_000, base: 976_000, rate: 32 },
  { min: 7_000_000, max: null as number | null, base: 1_424_000, rate: 35 },
];

type EmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  bank_account_number: string | null;
  date_of_joining: unknown;
  termination_date: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value === null || value === undefined) return null;
  return value?.toISOString ? value.toISOString() : value;
}

function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

function toIsoDateOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIsoDate(value);
}

// Calendar days, inclusive of both ends. Deliberately not business-day
// aware — the same simplification `LeaveRequestsService`'s own
// `inclusiveDayCount` documents, reused here (copied rather than
// imported since it isn't exported) so payroll's day math matches leave's
// exactly: a day either module counts is the same day the other counts.
function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.UTC(...(startDate.split("-").map(Number) as [number, number, number]));
  const end = Date.UTC(...(endDate.split("-").map(Number) as [number, number, number]));
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function dateMax(a: string, b: string): string {
  return a > b ? a : b;
}

function dateMin(a: string, b: string): string {
  return a < b ? a : b;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCompensation(row: any): CompensationView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    monthlySalary: Number(row.monthly_salary),
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: toIsoDateOrNull(row.effective_to),
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSettings(row: any): PayrollSettingsView {
  return {
    companyId: row.company_id,
    eobiEmployeeRatePercent: Number(row.eobi_employee_rate_percent),
    eobiEmployerRatePercent: Number(row.eobi_employer_rate_percent),
    eobiWageBase: Number(row.eobi_wage_base),
    socialSecurityScheme: row.social_security_scheme,
    socialSecurityEmployerRatePercent: Number(row.social_security_employer_rate_percent),
    socialSecurityWageCeiling: row.social_security_wage_ceiling === null ? null : Number(row.social_security_wage_ceiling),
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTaxSlab(row: any): TaxSlabView {
  return {
    id: row.id,
    companyId: row.company_id,
    minAnnualIncome: Number(row.min_annual_income),
    maxAnnualIncome: row.max_annual_income === null ? null : Number(row.max_annual_income),
    baseTax: Number(row.base_tax),
    ratePercent: Number(row.rate_percent),
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: toIsoDateOrNull(row.effective_to),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRun(row: any): PayrollRunView {
  return {
    id: row.id,
    companyId: row.company_id,
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    status: row.status,
    createdByUserAccountId: row.created_by_user_account_id,
    finalizedAt: toIso(row.finalized_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPayslip(row: any): PayslipView {
  return {
    id: row.id,
    companyId: row.company_id,
    payrollRunId: row.payroll_run_id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    bankAccountNumber: row.bank_account_number,
    daysInPeriod: Number(row.days_in_period),
    paidDays: Number(row.paid_days),
    unpaidLeaveDays: Number(row.unpaid_leave_days),
    grossPay: Number(row.gross_pay),
    taxableAnnualIncome: Number(row.taxable_annual_income),
    incomeTaxMonthly: Number(row.income_tax_monthly),
    eobiEmployeeContribution: Number(row.eobi_employee_contribution),
    eobiEmployerContribution: Number(row.eobi_employer_contribution),
    socialSecurityEmployerContribution: Number(row.social_security_employer_contribution),
    netPay: Number(row.net_pay),
    calculationBreakdown: row.calculation_breakdown ?? [],
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * Phase 12 (plan doc Section 10): "Compensation & Payroll" — the
 * highest-liability phase in this codebase. Every design choice below is
 * documented in Decision #14; the single most important thing to say
 * about this file is the thing said there in full: passing this file's
 * own test suite proves the CODE does what it was designed to do, not
 * that the design's own inputs (the FBR/EOBI/PESSI/SESSI figures
 * defaulted in `payroll_settings`/`tax_slabs`) are current or correct.
 * Nothing in this service should ever be pointed at a real employee's
 * real money without a real accountant reviewing a real calculated run's
 * `calculation_breakdown` first.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly importExport: ImportExportService,
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  // --- Compensation ------------------------------------------------------

  /**
   * Supersedes (not overwrites) the employee's current open-ended
   * compensation row via the shared EffectiveDatingEngine. This is a
   * retrofit, not just a refactor: the original hand-written version had
   * no same-day-collapse guard, so setting compensation twice in one day
   * would have attempted to close a row at (effectiveFrom - 1 day),
   * producing an invalid effective_to < effective_from range — a latent
   * bug nothing had triggered yet. The engine's supersession rule fixes
   * this the same way it already does for Leave Policies and Tax Slabs.
   * A mid-period salary change is this phase's own named edge case —
   * `calculateRun()` reads whichever segments overlap a given run's
   * period, old and new alike.
   */
  async setCompensation(claims: RequestClaims, input: SetCompensationRequest): Promise<CompensationView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");

      const { row } = await this.effectiveDating.applyVersionedRow(client, {
        table: "employee_compensation",
        scope: { employee_id: input.employeeId },
        extraInsertColumns: { company_id: claims.company_id, created_by_user_account_id: claims.sub },
        data: { monthly_salary: input.monthlySalary },
        effectiveFrom: input.effectiveFrom,
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "compensation.set",
        target: input.employeeId,
        metadata: { monthlySalary: input.monthlySalary, effectiveFrom: input.effectiveFrom },
      });
      return rowToCompensation(row);
    });
  }

  async getCompensationHistory(claims: RequestClaims, employeeId: string): Promise<CompensationView[]> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      const rows = await this.effectiveDating.getHistory(client, {
        table: "employee_compensation",
        scope: { employee_id: employeeId },
        orderBy: "effective_from DESC",
      });
      return rows.map(rowToCompensation);
    });
  }

  // --- Settings & tax slabs -----------------------------------------------

  /** Lazily seeds `payroll_settings` from the table's own column
   * defaults the first time a tenant has no row — the same lazy-seed
   * pattern Phase 9 used for `leave_balances`. */
  async getSettings(claims: RequestClaims): Promise<PayrollSettingsView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, (client) => this.loadOrSeedSettings(client, claims));
  }

  async updateSettings(claims: RequestClaims, patch: UpdatePayrollSettingsRequest): Promise<PayrollSettingsView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadOrSeedSettings(client, claims);
      const result = await client.query(
        `UPDATE payroll_settings
         SET eobi_employee_rate_percent = $2,
             eobi_employer_rate_percent = $3,
             eobi_wage_base = $4,
             social_security_scheme = $5,
             social_security_employer_rate_percent = $6,
             social_security_wage_ceiling = $7,
             updated_at = now()
         WHERE company_id = $1 RETURNING *`,
        [
          claims.company_id,
          patch.eobiEmployeeRatePercent ?? current.eobiEmployeeRatePercent,
          patch.eobiEmployerRatePercent ?? current.eobiEmployerRatePercent,
          patch.eobiWageBase ?? current.eobiWageBase,
          patch.socialSecurityScheme ?? current.socialSecurityScheme,
          patch.socialSecurityEmployerRatePercent ?? current.socialSecurityEmployerRatePercent,
          patch.socialSecurityWageCeiling === undefined ? current.socialSecurityWageCeiling : patch.socialSecurityWageCeiling,
        ]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_settings.update" });
      return rowToSettings(result.rows[0]);
    });
  }

  /** Lazily seeds the default FBR 8-bracket table the first time a
   * tenant has no tax_slabs rows. */
  async listTaxSlabs(claims: RequestClaims): Promise<TaxSlabView[]> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, (client) => this.loadOrSeedTaxSlabs(client, claims));
  }

  /**
   * Replaces the tenant's entire tax slab table in one call rather than
   * supporting row-by-row edits — a progressive bracket table has to
   * stay internally consistent (ascending, contiguous, exactly one
   * uncapped top bracket), which is far easier to validate as a whole
   * set than to guarantee through incremental patches.
   */
  async setTaxSlabs(claims: RequestClaims, input: SetTaxSlabsRequest): Promise<TaxSlabView[]> {
    await this.requireHrManage(claims);
    if (input.slabs.length === 0) throw new BadRequestException("At least one tax slab is required");
    const sorted = [...input.slabs].sort((a, b) => a.minAnnualIncome - b.minAnnualIncome);
    for (let i = 0; i < sorted.length; i++) {
      const slab = sorted[i];
      if (slab.maxAnnualIncome !== null && slab.maxAnnualIncome <= slab.minAnnualIncome) {
        throw new BadRequestException("Each slab's maxAnnualIncome must be greater than its minAnnualIncome");
      }
      const isLast = i === sorted.length - 1;
      if (isLast && slab.maxAnnualIncome !== null) {
        throw new BadRequestException("The top tax slab must have a null maxAnnualIncome");
      }
      if (!isLast) {
        if (slab.maxAnnualIncome === null) {
          throw new BadRequestException("Only the top tax slab may have a null maxAnnualIncome");
        }
        if (slab.maxAnnualIncome !== sorted[i + 1].minAnnualIncome) {
          throw new BadRequestException("Tax slabs must be contiguous — each slab's maxAnnualIncome must equal the next slab's minAnnualIncome");
        }
      }
    }

    return this.db.withClaims(claims, async (client) => {
      // Supersession (close-then-insert, with the same-day collapse
      // guard) now lives once, in the shared EffectiveDatingEngine,
      // rather than hand-written here — see this method's own git
      // history / the roadmap doc for why. Behavior is unchanged.
      const { rows } = await this.effectiveDating.applyVersionedSet(client, {
        table: "tax_slabs",
        scope: { company_id: claims.company_id! },
        rows: sorted.map((slab) => ({
          min_annual_income: slab.minAnnualIncome,
          max_annual_income: slab.maxAnnualIncome,
          base_tax: slab.baseTax,
          rate_percent: slab.ratePercent,
        })),
      });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_slabs.set", metadata: { slabCount: sorted.length } });
      return rows.map(rowToTaxSlab);
    });
  }

  /** Full effective-dated history of the tenant's tax slab SETS, oldest
   * first — one entry per (effective_from) generation, each carrying the
   * full bracket table that was in effect for that era. Mirrors
   * `EmployeeGroupsService.getLeavePolicyHistory()`'s shape. */
  async getTaxSlabHistory(claims: RequestClaims): Promise<TaxSlabSetView[]> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const rows = await this.effectiveDating.getHistory(client, {
        table: "tax_slabs",
        scope: { company_id: claims.company_id! },
        orderBy: "effective_from ASC, min_annual_income ASC",
      });
      const byGeneration = new Map<string, TaxSlabSetView>();
      for (const row of rows) {
        const key = toIsoDate(row.effective_from);
        let generation = byGeneration.get(key);
        if (!generation) {
          generation = { effectiveFrom: key, effectiveTo: toIsoDateOrNull(row.effective_to), slabs: [] };
          byGeneration.set(key, generation);
        }
        generation.slabs.push(rowToTaxSlab(row));
      }
      return [...byGeneration.values()];
    });
  }

  // --- Payroll runs --------------------------------------------------------

  async createRun(claims: RequestClaims, input: CreatePayrollRunRequest): Promise<PayrollRunView> {
    await this.requireHrManage(claims);
    if (new Date(input.periodEnd) < new Date(input.periodStart)) {
      throw new BadRequestException("periodEnd cannot be before periodStart");
    }
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT 1 FROM payroll_runs WHERE company_id = $1 AND period_start = $2 AND period_end = $3", [
        claims.company_id,
        input.periodStart,
        input.periodEnd,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException("A payroll run for this exact period already exists");
      }
      const result = await client.query(
        `INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [claims.company_id, input.periodStart, input.periodEnd, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.create", target: result.rows[0].id });
      return rowToRun(result.rows[0]);
    });
  }

  async listRuns(claims: RequestClaims): Promise<PayrollRunView[]> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM payroll_runs ORDER BY period_start DESC");
      return result.rows.map(rowToRun);
    });
  }

  async getRun(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      return rowToRun(run);
    });
  }

  /**
   * The calculation engine. Re-runnable on a `draft`/`calculated` run
   * (never on a `finalized` one) — each call fully REPLACES that run's
   * payslips rather than appending to them, so a compensation correction
   * made before anyone's been paid is reflected cleanly rather than
   * leaving a stale duplicate row behind.
   *
   * A per-employee failure (most commonly: no compensation record
   * covering the period at all) is collected into `errors` rather than
   * aborting the whole run — the same "real error report, never silent
   * partial failure" discipline `ImportExportService.parseAndValidate()`
   * established for Conversions. An employee with an error gets no
   * payslip row for this run; HR sees exactly why in the response.
   */
  async calculateRun(claims: RequestClaims, id: string): Promise<CalculatePayrollRunResponse> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      if (run.status === "finalized") {
        throw new BadRequestException("Cannot recalculate a finalized payroll run");
      }

      const settings = await this.loadOrSeedSettings(client, claims);
      const taxSlabs = await this.loadOrSeedTaxSlabs(client, claims);

      const periodStart = toIsoDate(run.period_start);
      const periodEnd = toIsoDate(run.period_end);
      const daysInPeriod = inclusiveDayCount(periodStart, periodEnd);

      const employeesResult = await client.query<EmployeeRow>(
        `SELECT id, company_id, user_account_id, employee_number, bank_account_number, date_of_joining, termination_date
         FROM employees
         WHERE date_of_joining <= $2
           AND (termination_date IS NULL OR termination_date >= $1)`,
        [periodStart, periodEnd]
      );

      const errors: PayrollCalculationError[] = [];
      const payslipRows: Array<Record<string, unknown>> = [];

      for (const employee of employeesResult.rows) {
        try {
          const payslip = await this.calculateOnePayslip(client, employee, periodStart, periodEnd, daysInPeriod, settings, taxSlabs);
          payslipRows.push(payslip);
        } catch (err) {
          errors.push({ employeeId: employee.id, message: err instanceof Error ? err.message : "Calculation failed" });
        }
      }

      await client.query("DELETE FROM payslips WHERE payroll_run_id = $1", [id]);
      for (const row of payslipRows) {
        await client.query(
          `INSERT INTO payslips (
             company_id, payroll_run_id, employee_id, employee_number, bank_account_number,
             days_in_period, paid_days, unpaid_leave_days, gross_pay, taxable_annual_income,
             income_tax_monthly, eobi_employee_contribution, eobi_employer_contribution,
             social_security_employer_contribution, net_pay, calculation_breakdown
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
          [
            claims.company_id,
            id,
            row.employeeId,
            row.employeeNumber,
            row.bankAccountNumber,
            row.daysInPeriod,
            row.paidDays,
            row.unpaidLeaveDays,
            row.grossPay,
            row.taxableAnnualIncome,
            row.incomeTaxMonthly,
            row.eobiEmployeeContribution,
            row.eobiEmployerContribution,
            row.socialSecurityEmployerContribution,
            row.netPay,
            JSON.stringify(row.calculationBreakdown),
          ]
        );
      }

      const updated = await client.query(
        "UPDATE payroll_runs SET status = 'calculated', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.calculate",
        target: id,
        metadata: { payslipCount: payslipRows.length, errorCount: errors.length },
      });

      return { run: rowToRun(updated.rows[0]), payslipCount: payslipRows.length, errors };
    });
  }

  async finalizeRun(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      if (run.status === "draft") {
        throw new BadRequestException("Cannot finalize a payroll run that has not been calculated yet");
      }
      if (run.status === "finalized") {
        throw new BadRequestException("This payroll run is already finalized");
      }
      const result = await client.query(
        "UPDATE payroll_runs SET status = 'finalized', finalized_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.finalize", target: id });
      return rowToRun(result.rows[0]);
    });
  }

  // --- Payslips ------------------------------------------------------------

  async listPayslips(claims: RequestClaims, filter: { payrollRunId?: string; employeeId?: string }): Promise<PayslipView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const hasAll = await this.rbac.can(claims, HR_MANAGE_PERMISSION);
      const result = await client.query(
        `SELECT p.*, e.user_account_id AS employee_user_account_id, pr.status AS run_status
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE ($1::uuid IS NULL OR p.payroll_run_id = $1)
           AND ($2::uuid IS NULL OR p.employee_id = $2)
         ORDER BY p.created_at DESC`,
        [filter.payrollRunId ?? null, filter.employeeId ?? null]
      );
      const visible = hasAll
        ? result.rows
        : result.rows.filter((row) => row.employee_user_account_id === claims.sub && row.run_status === "finalized");
      return visible.map(rowToPayslip);
    });
  }

  /**
   * Whole-record visibility gate, deliberately NOT the field-conditional
   * engine Phase 11 used for review ratings — see Decision #14. An
   * unfinalized payslip is simply not there yet for a self-scope caller
   * (404, matching the module-disabled convention every phase has used
   * since Phase 5), not a record with some fields hidden.
   */
  async getPayslip(claims: RequestClaims, id: string): Promise<PayslipView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT p.*, e.user_account_id AS employee_user_account_id, pr.status AS run_status
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE p.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Payslip not found");
      const row = result.rows[0];

      const hasAll = await this.rbac.can(claims, HR_MANAGE_PERMISSION);
      if (hasAll) return rowToPayslip(row);

      const hasSelf = await this.rbac.can(claims, SELF_VIEW_PERMISSION, { ownerId: row.employee_user_account_id });
      if (!hasSelf || row.run_status !== "finalized") {
        throw new NotFoundException("Payslip not found");
      }
      return rowToPayslip(row);
    });
  }

  /** The bank disbursement file — Section 5's own external-interface
   * rule ("references employee_number, never the internal UUID"),
   * generated via the same `ImportExportService.toCsv()` utility the
   * Conversions WRICEF pillar built. Only a finalized run's numbers are
   * real enough to hand to a bank. */
  async generateDisbursementFile(claims: RequestClaims, runId: string): Promise<string> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      if (run.status !== "finalized") {
        throw new BadRequestException("Cannot disburse a payroll run that is not finalized yet");
      }
      const result = await client.query(
        "SELECT employee_number, bank_account_number, net_pay FROM payslips WHERE payroll_run_id = $1 ORDER BY employee_number",
        [runId]
      );
      const rows = result.rows.map((r) => ({
        employeeNumber: r.employee_number,
        bankAccountNumber: r.bank_account_number ?? "",
        netPay: Number(r.net_pay).toFixed(2),
      }));
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.disburse", target: runId, metadata: { rowCount: rows.length } });
      return this.importExport.toCsv(["employeeNumber", "bankAccountNumber", "netPay"], rows);
    });
  }

  // --- Internals -------------------------------------------------------

  private async calculateOnePayslip(
    client: PoolClient,
    employee: EmployeeRow,
    periodStart: string,
    periodEnd: string,
    daysInPeriod: number,
    settings: PayrollSettingsView,
    taxSlabs: TaxSlabView[]
  ): Promise<Record<string, unknown>> {
    const breakdown: PayrollCalculationStep[] = [];
    breakdown.push({ label: "Period", value: `${periodStart} to ${periodEnd} (${daysInPeriod} days)` });

    const dateOfJoining = toIsoDate(employee.date_of_joining);
    const terminationDate = toIsoDateOrNull(employee.termination_date);
    const windowStart = dateMax(periodStart, dateOfJoining);
    const windowEnd = terminationDate ? dateMin(periodEnd, terminationDate) : periodEnd;
    if (windowEnd < windowStart) {
      throw new Error("Employee was not employed at any point during this period");
    }
    const employmentWindowDays = inclusiveDayCount(windowStart, windowEnd);
    breakdown.push({ label: "Employment window within period", value: `${windowStart} to ${windowEnd} (${employmentWindowDays} days)` });

    const compensationResult = await client.query(
      `SELECT * FROM employee_compensation
       WHERE employee_id = $1 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $2)
       ORDER BY effective_from ASC`,
      [employee.id, windowStart, windowEnd]
    );
    if (compensationResult.rowCount === 0) {
      throw new Error("No compensation record covers this employee for this period");
    }

    let grossFromSegments = 0;
    let latestMonthlySalary = 0;
    for (const seg of compensationResult.rows) {
      const segStart = dateMax(windowStart, toIsoDate(seg.effective_from));
      const segEnd = dateMin(windowEnd, seg.effective_to ? toIsoDate(seg.effective_to) : windowEnd);
      if (segEnd < segStart) continue;
      const segDays = inclusiveDayCount(segStart, segEnd);
      const monthlySalary = Number(seg.monthly_salary);
      const proratedAmount = (monthlySalary * segDays) / daysInPeriod;
      grossFromSegments += proratedAmount;
      latestMonthlySalary = monthlySalary;
      breakdown.push({
        label: `Compensation segment ${segStart} to ${segEnd} (${segDays} days) @ ${monthlySalary}/mo`,
        value: Number(proratedAmount.toFixed(2)),
      });
    }

    const unpaidLeaveResult = await client.query(
      `SELECT start_date, end_date FROM leave_requests
       WHERE employee_id = $1 AND leave_type = 'unpaid' AND status = 'approved'
         AND start_date <= $3 AND end_date >= $2`,
      [employee.id, windowStart, windowEnd]
    );
    let unpaidLeaveDays = 0;
    for (const leave of unpaidLeaveResult.rows) {
      const leaveStart = dateMax(windowStart, toIsoDate(leave.start_date));
      const leaveEnd = dateMin(windowEnd, toIsoDate(leave.end_date));
      if (leaveEnd < leaveStart) continue;
      unpaidLeaveDays += inclusiveDayCount(leaveStart, leaveEnd);
    }
    breakdown.push({ label: "Unpaid leave days (approved, overlapping period)", value: unpaidLeaveDays });

    // Simplification, documented in Decision #14: the unpaid-leave
    // deduction is computed uniformly against the period's LATEST salary
    // rate, not a per-day rate that tracks which compensation segment
    // each unpaid day actually fell in.
    const unpaidDeduction = unpaidLeaveDays > 0 ? (latestMonthlySalary * unpaidLeaveDays) / daysInPeriod : 0;
    if (unpaidLeaveDays > 0) {
      breakdown.push({ label: `Unpaid-leave deduction @ ${latestMonthlySalary}/mo rate`, value: -Number(unpaidDeduction.toFixed(2)) });
    }

    const paidDays = Math.max(0, employmentWindowDays - unpaidLeaveDays);
    const grossPay = Math.max(0, grossFromSegments - unpaidDeduction);
    breakdown.push({ label: "Gross pay", value: Number(grossPay.toFixed(2)) });

    // Simplification, documented in Decision #14: this period's monthly
    // gross is annualized (x12) to look up a tax bracket, rather than
    // projecting a full tax year across multiple runs.
    const taxableAnnualIncome = grossPay * 12;
    breakdown.push({ label: "Taxable annual income (this period's gross x 12)", value: Number(taxableAnnualIncome.toFixed(2)) });

    const bracket =
      taxSlabs.find((s) => taxableAnnualIncome >= s.minAnnualIncome && (s.maxAnnualIncome === null || taxableAnnualIncome <= s.maxAnnualIncome)) ??
      taxSlabs[taxSlabs.length - 1];
    const annualTax = bracket.baseTax + (bracket.ratePercent / 100) * (taxableAnnualIncome - bracket.minAnnualIncome);
    const incomeTaxMonthly = Math.max(0, annualTax / 12);
    breakdown.push({
      label: `Tax bracket ${bracket.minAnnualIncome}-${bracket.maxAnnualIncome ?? "∞"} @ ${bracket.ratePercent}% (base ${bracket.baseTax})`,
      value: Number(incomeTaxMonthly.toFixed(2)),
    });

    const paidDaysRatio = employmentWindowDays > 0 ? paidDays / employmentWindowDays : 0;
    const eobiEmployeeContribution = settings.eobiWageBase * (settings.eobiEmployeeRatePercent / 100) * paidDaysRatio;
    const eobiEmployerContribution = settings.eobiWageBase * (settings.eobiEmployerRatePercent / 100) * paidDaysRatio;
    breakdown.push({ label: `EOBI employee contribution (${settings.eobiEmployeeRatePercent}% of wage base ${settings.eobiWageBase}, prorated)`, value: Number(eobiEmployeeContribution.toFixed(2)) });
    breakdown.push({ label: `EOBI employer contribution (${settings.eobiEmployerRatePercent}% of wage base ${settings.eobiWageBase}, prorated)`, value: Number(eobiEmployerContribution.toFixed(2)) });

    const ssApplies =
      settings.socialSecurityScheme !== "none" &&
      (settings.socialSecurityWageCeiling === null || grossPay <= settings.socialSecurityWageCeiling);
    const socialSecurityEmployerContribution = ssApplies ? grossPay * (settings.socialSecurityEmployerRatePercent / 100) : 0;
    breakdown.push({
      label: `Social security (${settings.socialSecurityScheme}) employer contribution`,
      value: Number(socialSecurityEmployerContribution.toFixed(2)),
    });

    const netPay = grossPay - incomeTaxMonthly - eobiEmployeeContribution;
    breakdown.push({ label: "Net pay (gross - income tax - EOBI employee contribution)", value: Number(netPay.toFixed(2)) });

    return {
      employeeId: employee.id,
      employeeNumber: employee.employee_number,
      bankAccountNumber: employee.bank_account_number,
      daysInPeriod,
      paidDays: Number(paidDays.toFixed(2)),
      unpaidLeaveDays: Number(unpaidLeaveDays.toFixed(2)),
      grossPay: Number(grossPay.toFixed(2)),
      taxableAnnualIncome: Number(taxableAnnualIncome.toFixed(2)),
      incomeTaxMonthly: Number(incomeTaxMonthly.toFixed(2)),
      eobiEmployeeContribution: Number(eobiEmployeeContribution.toFixed(2)),
      eobiEmployerContribution: Number(eobiEmployerContribution.toFixed(2)),
      socialSecurityEmployerContribution: Number(socialSecurityEmployerContribution.toFixed(2)),
      netPay: Number(netPay.toFixed(2)),
      calculationBreakdown: breakdown,
    };
  }

  private async loadOrSeedSettings(client: PoolClient, claims: RequestClaims): Promise<PayrollSettingsView> {
    const existing = await client.query("SELECT * FROM payroll_settings WHERE company_id = $1", [claims.company_id]);
    if ((existing.rowCount ?? 0) > 0) return rowToSettings(existing.rows[0]);
    const inserted = await client.query(
      "INSERT INTO payroll_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING RETURNING *",
      [claims.company_id]
    );
    if ((inserted.rowCount ?? 0) > 0) return rowToSettings(inserted.rows[0]);
    const retry = await client.query("SELECT * FROM payroll_settings WHERE company_id = $1", [claims.company_id]);
    return rowToSettings(retry.rows[0]);
  }

  private async loadOrSeedTaxSlabs(client: PoolClient, claims: RequestClaims): Promise<TaxSlabView[]> {
    // Reads the CURRENT set only (effective_to IS NULL) — same "live
    // decision paths keep reading current" discipline as leave policies;
    // resolving a run's OWN period against historical slabs is a named,
    // separate follow-on (migration 0033's header comment).
    // "Current" read goes through the shared engine like every other
    // caller; the one-time bootstrap INSERT below is a seeding concern
    // specific to this method (not a supersession), so it stays bespoke.
    const existing = await this.effectiveDating.getCurrentRows(client, {
      table: "tax_slabs",
      scope: { company_id: claims.company_id! },
      orderBy: "min_annual_income ASC",
    });
    if (existing.length > 0) return existing.map(rowToTaxSlab);
    const inserted: unknown[] = [];
    for (const slab of DEFAULT_TAX_SLABS) {
      const result = await client.query(
        `INSERT INTO tax_slabs (company_id, min_annual_income, max_annual_income, base_tax, rate_percent, effective_from)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
         ON CONFLICT (company_id, min_annual_income) WHERE effective_to IS NULL DO NOTHING RETURNING *`,
        [claims.company_id, slab.min, slab.max, slab.base, slab.rate]
      );
      if ((result.rowCount ?? 0) > 0) inserted.push(result.rows[0]);
    }
    if (inserted.length > 0) return inserted.map(rowToTaxSlab);
    const retry = await this.effectiveDating.getCurrentRows(client, {
      table: "tax_slabs",
      scope: { company_id: claims.company_id! },
      orderBy: "min_annual_income ASC",
    });
    return retry.map(rowToTaxSlab);
  }

  private async loadEmployee(client: PoolClient, employeeId: string): Promise<{ id: string } | null> {
    const result = await client.query("SELECT id FROM employees WHERE id = $1", [employeeId]);
    return result.rowCount === 0 ? null : (result.rows[0] as { id: string });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadRun(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM payroll_runs WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Payroll run not found");
    return result.rows[0];
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  private async requireHrManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, HR_MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage payroll");
    }
  }
}
