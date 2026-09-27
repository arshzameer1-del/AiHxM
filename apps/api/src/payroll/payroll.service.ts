import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { ImportExportService } from "../import-export/import-export.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import type {
  CalculatePayrollRunResponse,
  CreatePayrollRunRequest,
  DecideLeaveRequestRequest,
  PayrollCalculationError,
  PayrollCalculationStep,
  PayrollRunView,
  PayrollSettingsView,
  PayslipView,
  SetTaxSlabsRequest,
  TaxSlabSetView,
  TaxSlabView,
  UpdatePayrollSettingsRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const HR_MANAGE_PERMISSION = "payroll.manage.all";
const APPROVE_PERMISSION = "payroll.approve.all";
const SELF_VIEW_PERMISSION = "payroll_review.view.self";

// Phase P2 — same "own constants per consumer module" pattern
// RecruitmentService/LeaveRequestsService already use, not shared state.
const WORKFLOW_TEMPLATE_KEY = "payroll_run";
const WORKFLOW_OBJECT_KEY = "payroll_run";

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
  // NOTE: `Date.UTC(year, monthIndex, day)` takes a 0-indexed month — the
  // ISO date strings we parse here use 1-indexed calendar months, so each
  // component must be adjusted before being handed to `Date.UTC`. Passing
  // the raw calendar month (as this function's counterpart in
  // `LeaveRequestsService` still does) silently shifts every date forward
  // by "one month's worth" of index; that shift cancels out for a
  // same-calendar-month span (both ends shift identically) but corrupts
  // any span crossing a month boundary — which is exactly what the
  // Phase P1 tax-year day-count arithmetic below does (a 365/366-day span
  // from 1 July to 30 June). Fixed here for payroll's own copy.
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function dateMax(a: string, b: string): string {
  return a > b ? a : b;
}

function dateMin(a: string, b: string): string {
  return a < b ? a : b;
}

// Pakistan's tax year for salaried individuals runs 1 July - 30 June,
// labeled by the calendar year it ENDS in (the same convention
// `DEFAULT_TAX_SLABS`' own comment uses: "Tax Year 2027" = 1 Jul 2026 -
// 30 Jun 2027). Used only to bound the year-to-date accumulation window
// below — NOT a claim about exactly how FBR's own withholding rules
// work in every particular; see this file's header doc comment.
function taxYearLabelFor(isoDate: string): number {
  const [y, m] = isoDate.split("-").map(Number);
  return m >= 7 ? y + 1 : y;
}

function taxYearBounds(label: number): { start: string; end: string } {
  const startYear = label - 1;
  return { start: `${startYear}-07-01`, end: `${label}-06-30` };
}

function taxFromSlabs(annualIncome: number, slabs: TaxSlabView[]): number {
  const bracket =
    slabs.find((s) => annualIncome >= s.minAnnualIncome && (s.maxAnnualIncome === null || annualIncome <= s.maxAnnualIncome)) ??
    slabs[slabs.length - 1];
  return Math.max(0, bracket.baseTax + (bracket.ratePercent / 100) * (annualIncome - bracket.minAnnualIncome));
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
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: toIsoDateOrNull(row.effective_to),
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
    workflowInstanceId: row.workflow_instance_id,
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
    taxableGrossThisPeriod: Number(row.taxable_gross_this_period),
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
 *
 * Payroll Enterprise Gap Analysis & Roadmap, Phase P1 (2026-09-27,
 * claude/payroll-enterprise-gap-analysis-and-roadmap.md) rebuilt this
 * file's tax-calculation core:
 *
 *  - Compensation is a real component model (Basic Salary + named
 *    allowances), not one flat `monthly_salary` figure — see
 *    `compensation_components`/`employee_compensation_components`
 *    (migration 0092). Compensation is Core Employee master data (moved
 *    2026-09-27, kumail's own architecture correction — the SAP
 *    IT0008/IT0014 equivalent): `EmployeeCompensationService`
 *    (`apps/api/src/employees/employee-compensation.service.ts`) owns
 *    every write to it. This service only ever READS it — a direct SQL
 *    join inside `calculateOnePayslip()` below, exactly like it reads
 *    `leave_requests` for unpaid leave — never through that service.
 *  - `payroll_settings` (EOBI/social-security) is effective-dated like
 *    `tax_slabs` already was, and a run resolves BOTH as of its own
 *    `periodEnd` (`loadSettingsAsOf()`/`loadTaxSlabsAsOf()`) instead of
 *    always reading "whatever is current right now".
 *  - Income tax uses a real year-to-date cumulative average-rate method
 *    (`calculateOnePayslip()`'s own doc comment has the full formula and
 *    its documented limits) instead of annualizing one period's gross
 *    forever.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly importExport: ImportExportService,
    private readonly effectiveDating: EffectiveDatingEngine,
    private readonly workflow: WorkflowService
  ) {}

  // --- Settings & tax slabs -----------------------------------------------

  /** Lazily seeds `payroll_settings` from the table's own column
   * defaults the first time a tenant has no row — the same lazy-seed
   * pattern Phase 9 used for `leave_balances`. Reads the CURRENT
   * generation via the shared EffectiveDatingEngine now that this table
   * is effective-dated (Phase P1). */
  async getSettings(claims: RequestClaims): Promise<PayrollSettingsView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, (client) => this.loadOrSeedSettings(client, claims));
  }

  /**
   * SUPERSEDES the current settings generation (rather than mutating it
   * in place) via the shared EffectiveDatingEngine, so a payroll run for
   * a past period can resolve the EOBI/social-security rates that were
   * actually in force during THAT period (`loadSettingsAsOf()`) instead
   * of whatever is current today.
   */
  async updateSettings(claims: RequestClaims, patch: UpdatePayrollSettingsRequest): Promise<PayrollSettingsView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadOrSeedSettings(client, claims);
      const { row } = await this.effectiveDating.applyVersionedRow(client, {
        table: "payroll_settings",
        scope: { company_id: claims.company_id! },
        data: {
          eobi_employee_rate_percent: patch.eobiEmployeeRatePercent ?? current.eobiEmployeeRatePercent,
          eobi_employer_rate_percent: patch.eobiEmployerRatePercent ?? current.eobiEmployerRatePercent,
          eobi_wage_base: patch.eobiWageBase ?? current.eobiWageBase,
          social_security_scheme: patch.socialSecurityScheme ?? current.socialSecurityScheme,
          social_security_employer_rate_percent: patch.socialSecurityEmployerRatePercent ?? current.socialSecurityEmployerRatePercent,
          social_security_wage_ceiling:
            patch.socialSecurityWageCeiling === undefined ? current.socialSecurityWageCeiling : patch.socialSecurityWageCeiling,
          updated_at: new Date(),
        },
      });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_settings.update" });
      return rowToSettings(row);
    });
  }

  /** Every effective-dated generation of this tenant's EOBI/social-security
   * settings, oldest first — mirrors `getTaxSlabHistory()`'s shape. */
  async getSettingsHistory(claims: RequestClaims): Promise<PayrollSettingsView[]> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.loadOrSeedSettings(client, claims);
      const rows = await this.effectiveDating.getHistory(client, {
        table: "payroll_settings",
        scope: { company_id: claims.company_id! },
        orderBy: "effective_from ASC",
      });
      return rows.map(rowToSettings);
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

  /** Readable by either the preparer (`payroll.manage.all`) or the
   * approver (`payroll.approve.all`, Phase P2) — a Payroll Approver needs
   * to see the runs list to find the one awaiting their decision, even
   * though they can't create/calculate/finalize any of them. */
  async listRuns(claims: RequestClaims): Promise<PayrollRunView[]> {
    await this.requireViewRuns(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM payroll_runs ORDER BY period_start DESC");
      return result.rows.map(rowToRun);
    });
  }

  async getRun(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    await this.requireViewRuns(claims);
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
   *
   * Phase P1: settings/tax slabs are resolved AS OF this run's own
   * `periodEnd` (`loadSettingsAsOf()`/`loadTaxSlabsAsOf()`), not
   * "whatever is current today" — a run recalculated after a later rate
   * change still uses the rates that were actually in force during its
   * own period.
   */
  async calculateRun(claims: RequestClaims, id: string): Promise<CalculatePayrollRunResponse> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      if (run.status === "finalized") {
        throw new BadRequestException("Cannot recalculate a finalized payroll run");
      }

      const periodStart = toIsoDate(run.period_start);
      const periodEnd = toIsoDate(run.period_end);
      const daysInPeriod = inclusiveDayCount(periodStart, periodEnd);

      // Compensation is Core Employee master data now (moved 2026-09-27,
      // kumail's own architecture correction — see
      // EmployeeCompensationService's own doc comment) — this service only
      // reads it (the direct SQL join inside calculateOnePayslip() below),
      // never seeds or writes it. A tenant with no compensation catalog
      // yet simply has every employee collect a "No compensation record
      // covers this employee for this period" error below, the same as
      // any other genuinely-missing-data case this loop already handles.
      const settings = await this.loadSettingsAsOf(client, claims, periodEnd);
      const taxSlabs = await this.loadTaxSlabsAsOf(client, claims, periodEnd);

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
             days_in_period, paid_days, unpaid_leave_days, gross_pay, taxable_gross_this_period,
             taxable_annual_income, income_tax_monthly, eobi_employee_contribution, eobi_employer_contribution,
             social_security_employer_contribution, net_pay, calculation_breakdown
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
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
            row.taxableGrossThisPeriod,
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

  /**
   * Phase P2: a run must be `approved` (submitted, then decided through
   * the workflow engine) before it can be finalized — no more finalizing
   * straight off a calculation. See this file's own header note and
   * 0093_payroll_approval_workflow.sql for the full reasoning.
   */
  async finalizeRun(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    await this.requireHrManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      if (run.status === "finalized") {
        throw new BadRequestException("This payroll run is already finalized");
      }
      if (run.status !== "approved") {
        throw new BadRequestException(
          run.status === "pending_approval"
            ? "This payroll run is still awaiting approval"
            : "This payroll run must be calculated, submitted for approval, and approved before it can be finalized"
        );
      }
      const result = await client.query(
        "UPDATE payroll_runs SET status = 'finalized', finalized_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.finalize", target: id });
      return rowToRun(result.rows[0]);
    });
  }

  /**
   * Routes the run through the tenant's configured approval chain — same
   * pattern as `RecruitmentService.submitRequisition()`: a separate
   * `WorkflowService` transaction (see KNOWN_ISSUES.md for the same
   * cross-service non-atomicity tradeoff Decision #9 already documents),
   * `NotFoundException` surfacing as-is if the tenant hasn't configured a
   * `payroll_run` template yet (System Admin > Configuration > Workflow
   * Templates), deliberately not auto-approved.
   */
  async submitForApproval(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    await this.requireHrManage(claims);
    const run = await this.db.withClaims(claims, (client) => this.loadRun(client, id));
    if (run.status !== "calculated") {
      throw new BadRequestException(`Payroll run is ${run.status}, must be freshly calculated before it can be submitted for approval`);
    }

    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: id,
      record: { periodStart: toIsoDate(run.period_start), periodEnd: toIsoDate(run.period_end) },
    });

    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `UPDATE payroll_runs SET status = 'pending_approval', workflow_instance_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, instance.id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.submit", target: id });
      return rowToRun(result.rows[0]);
    });
  }

  /**
   * Gated by `payroll.approve.all` — deliberately NOT `payroll.manage.all`
   * (the preparer's permission) — this is the actual segregation-of-duties
   * enforcement kumail chose: a login without the Payroll Approver role
   * gets a 403 here regardless of what the tenant's workflow template
   * says, and `WorkflowService.decide()` itself separately verifies the
   * caller resolves against that specific step's configured approver.
   * Rejecting reverts the run to `calculated` (not a terminal `rejected`)
   * so HR can review, recalculate if needed, and resubmit — see this
   * file's header note.
   */
  async decideApproval(claims: RequestClaims, id: string, dto: DecideLeaveRequestRequest): Promise<PayrollRunView> {
    await this.requirePayrollApprove(claims);
    const run = await this.db.withClaims(claims, (client) => this.loadRun(client, id));
    if (run.status !== "pending_approval") {
      throw new BadRequestException(`Payroll run is ${run.status}, not awaiting approval`);
    }
    if (!run.workflow_instance_id) {
      throw new BadRequestException("Payroll run has no workflow instance to decide on");
    }

    const instance = await this.workflow.getInstance(claims, run.workflow_instance_id);
    const pendingStep = instance.steps.find((s) => s.status === "pending");
    if (!pendingStep) throw new BadRequestException("No pending approval step found on this payroll run");
    const decidedInstance = await this.workflow.decide(claims, pendingStep.id, dto);

    return this.db.withClaims(claims, async (client) => {
      let newStatus = run.status;
      if (decidedInstance.status === "approved") newStatus = "approved";
      else if (decidedInstance.status === "rejected") newStatus = "calculated";
      const result = await client.query(
        `UPDATE payroll_runs SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, newStatus]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.decide",
        target: id,
        metadata: { decision: dto.decision },
      });
      return rowToRun(result.rows[0]);
    });
  }

  // --- Payslips ------------------------------------------------------------

  /** Phase P2: a Payroll Approver (read-only here — this endpoint never
   * writes) can see every payslip too, same as hr_admin — reviewing the
   * actual numbers is the entire point of an approval step, not just the
   * run's period dates. */
  async listPayslips(claims: RequestClaims, filter: { payrollRunId?: string; employeeId?: string }): Promise<PayslipView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const hasAll = (await this.rbac.can(claims, HR_MANAGE_PERMISSION)) || (await this.rbac.can(claims, APPROVE_PERMISSION));
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

      const hasAll = (await this.rbac.can(claims, HR_MANAGE_PERMISSION)) || (await this.rbac.can(claims, APPROVE_PERMISSION));
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

  /**
   * Gross-to-net for one employee, one run. Phase P1 rewrite — two things
   * changed from the original single-`monthly_salary` version:
   *
   *  1. Gross pay is now the sum of every compensation component's own
   *     prorated segment (Basic Salary + whichever allowances the
   *     employee has), not one number — each component gets its own
   *     breakdown line, and only TAXABLE components feed the tax
   *     calculation below.
   *
   *  2. Income tax uses a cumulative "average rate" year-to-date method
   *     instead of annualizing this one period's gross forever:
   *       - `priorYtd` = actual taxable income/tax already recorded on
   *         this employee's FINALIZED payslips earlier in the same tax
   *         year (1 Jul - 30 Jun) — never a draft/calculated run, so
   *         recalculating a not-yet-finalized run can never double-count.
   *       - This period's taxable income is projected forward at its own
   *         daily rate across the tax year's remaining days to estimate
   *         a full-year taxable figure.
   *       - Tax on that estimate, times the fraction of the tax year
   *         elapsed so far, gives the total tax that SHOULD have been
   *         withheld to date; subtracting what was already withheld
   *         gives this period's tax.
   *     This is the standard "average rate"/cumulative withholding
   *     approach used by many South Asian payroll systems to approximate
   *     FBR salary-tax withholding — it is a documented simplification
   *     (assumes one employer, doesn't model mid-year rate-schedule
   *     changes mid-tax-year), not a certified reproduction of FBR's own
   *     Income Tax Rules formula. Per this file's own header comment: an
   *     accountant should review a real calculated run's breakdown
   *     before this is trusted with real money.
   */
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

    const componentSegments = await client.query(
      `SELECT ecc.*, cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable
       FROM employee_compensation_components ecc
       JOIN compensation_components cc ON cc.id = ecc.component_id
       WHERE ecc.employee_id = $1 AND cc.is_active = true
         AND ecc.effective_from <= $3 AND (ecc.effective_to IS NULL OR ecc.effective_to >= $2)
       ORDER BY cc.sort_order ASC, ecc.effective_from ASC`,
      [employee.id, windowStart, windowEnd]
    );
    if (componentSegments.rowCount === 0) {
      throw new Error("No compensation record covers this employee for this period");
    }

    let grossFromSegments = 0;
    let taxableGrossFromSegments = 0;
    const latestAmountByComponent = new Map<string, number>();
    for (const seg of componentSegments.rows) {
      const segStart = dateMax(windowStart, toIsoDate(seg.effective_from));
      const segEnd = dateMin(windowEnd, seg.effective_to ? toIsoDate(seg.effective_to) : windowEnd);
      if (segEnd < segStart) continue;
      const segDays = inclusiveDayCount(segStart, segEnd);
      const amount = Number(seg.amount);
      const proratedAmount = (amount * segDays) / daysInPeriod;
      grossFromSegments += proratedAmount;
      if (seg.component_is_taxable) taxableGrossFromSegments += proratedAmount;
      latestAmountByComponent.set(seg.component_id, amount);
      breakdown.push({
        label: `${seg.component_name} — ${segStart} to ${segEnd} (${segDays} days) @ ${amount}/mo${seg.component_is_taxable ? "" : " (non-taxable)"}`,
        value: Number(proratedAmount.toFixed(2)),
      });
    }
    const latestTotalMonthlyRate = [...latestAmountByComponent.values()].reduce((a, b) => a + b, 0);

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

    // Simplification, documented since Decision #14: the unpaid-leave
    // deduction is computed uniformly against the period's LATEST total
    // monthly rate (across every component), not a per-day rate that
    // tracks which compensation segment each unpaid day actually fell
    // in. The deduction is then split between taxable/non-taxable pay
    // proportionally to this period's own taxable share — there's no
    // way to know which specific component an unpaid day "came out of",
    // so a proportional split is the least-arbitrary allocation.
    const unpaidDeduction = unpaidLeaveDays > 0 ? (latestTotalMonthlyRate * unpaidLeaveDays) / daysInPeriod : 0;
    if (unpaidLeaveDays > 0) {
      breakdown.push({ label: `Unpaid-leave deduction @ ${latestTotalMonthlyRate}/mo total rate`, value: -Number(unpaidDeduction.toFixed(2)) });
    }
    const taxableShare = grossFromSegments > 0 ? taxableGrossFromSegments / grossFromSegments : 0;
    const taxableUnpaidDeduction = unpaidDeduction * taxableShare;

    const paidDays = Math.max(0, employmentWindowDays - unpaidLeaveDays);
    const grossPay = Math.max(0, grossFromSegments - unpaidDeduction);
    const taxableGrossThisPeriod = Math.max(0, taxableGrossFromSegments - taxableUnpaidDeduction);
    breakdown.push({ label: "Gross pay", value: Number(grossPay.toFixed(2)) });
    breakdown.push({ label: "Of which taxable this period", value: Number(taxableGrossThisPeriod.toFixed(2)) });

    // --- Year-to-date cumulative tax withholding (Phase P1) -------------
    const taxYear = taxYearLabelFor(periodEnd);
    const { start: taxYearStart, end: taxYearEnd } = taxYearBounds(taxYear);
    const ytdResult = await client.query(
      `SELECT COALESCE(SUM(p.taxable_gross_this_period), 0) AS taxable, COALESCE(SUM(p.income_tax_monthly), 0) AS tax
       FROM payslips p
       JOIN payroll_runs pr ON pr.id = p.payroll_run_id
       WHERE p.employee_id = $1 AND pr.status = 'finalized' AND pr.period_end >= $2 AND pr.period_end < $3`,
      [employee.id, taxYearStart, periodStart]
    );
    const priorYtdTaxable = Number(ytdResult.rows[0].taxable);
    const priorYtdTaxWithheld = Number(ytdResult.rows[0].tax);
    breakdown.push({
      label: `Tax year ${taxYear} (${taxYearStart} to ${taxYearEnd}) — YTD taxable income before this period (finalized runs only)`,
      value: Number(priorYtdTaxable.toFixed(2)),
    });

    const totalDaysInTaxYear = inclusiveDayCount(taxYearStart, taxYearEnd);
    const daysElapsedInclusive = Math.min(totalDaysInTaxYear, inclusiveDayCount(taxYearStart, periodEnd));
    const daysRemaining = Math.max(0, totalDaysInTaxYear - daysElapsedInclusive);
    const dailyTaxableRate = daysInPeriod > 0 ? taxableGrossThisPeriod / daysInPeriod : 0;
    const projectedRemainingIncome = dailyTaxableRate * daysRemaining;
    const estimatedAnnualTaxableIncome = priorYtdTaxable + taxableGrossThisPeriod + projectedRemainingIncome;
    breakdown.push({
      label: "Estimated full tax-year taxable income (YTD + this period + projected remainder)",
      value: Number(estimatedAnnualTaxableIncome.toFixed(2)),
    });

    const totalAnnualTaxEstimate = taxFromSlabs(estimatedAnnualTaxableIncome, taxSlabs);
    const fractionElapsed = totalDaysInTaxYear > 0 ? daysElapsedInclusive / totalDaysInTaxYear : 1;
    const totalTaxDueToDate = totalAnnualTaxEstimate * fractionElapsed;
    const bracket =
      taxSlabs.find(
        (s) => estimatedAnnualTaxableIncome >= s.minAnnualIncome && (s.maxAnnualIncome === null || estimatedAnnualTaxableIncome <= s.maxAnnualIncome)
      ) ?? taxSlabs[taxSlabs.length - 1];
    breakdown.push({
      label: `Tax bracket ${bracket.minAnnualIncome}-${bracket.maxAnnualIncome ?? "∞"} @ ${bracket.ratePercent}% (base ${bracket.baseTax}) — estimated full-year tax`,
      value: Number(totalAnnualTaxEstimate.toFixed(2)),
    });
    breakdown.push({
      label: `Tax due to date (${daysElapsedInclusive}/${totalDaysInTaxYear} days elapsed this tax year)`,
      value: Number(totalTaxDueToDate.toFixed(2)),
    });
    breakdown.push({ label: "Already withheld this tax year (finalized runs only)", value: Number(priorYtdTaxWithheld.toFixed(2)) });

    const incomeTaxMonthly = Math.max(0, totalTaxDueToDate - priorYtdTaxWithheld);
    breakdown.push({ label: "Income tax this period", value: Number(incomeTaxMonthly.toFixed(2)) });

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
      taxableGrossThisPeriod: Number(taxableGrossThisPeriod.toFixed(2)),
      taxableAnnualIncome: Number(estimatedAnnualTaxableIncome.toFixed(2)),
      incomeTaxMonthly: Number(incomeTaxMonthly.toFixed(2)),
      eobiEmployeeContribution: Number(eobiEmployeeContribution.toFixed(2)),
      eobiEmployerContribution: Number(eobiEmployerContribution.toFixed(2)),
      socialSecurityEmployerContribution: Number(socialSecurityEmployerContribution.toFixed(2)),
      netPay: Number(netPay.toFixed(2)),
      calculationBreakdown: breakdown,
    };
  }

  private async loadOrSeedSettings(client: PoolClient, claims: RequestClaims): Promise<PayrollSettingsView> {
    const existing = await this.effectiveDating.getCurrentRow(client, { table: "payroll_settings", scope: { company_id: claims.company_id! } });
    if (existing) return rowToSettings(existing);
    const inserted = await client.query(
      `INSERT INTO payroll_settings (company_id, effective_from) VALUES ($1, CURRENT_DATE)
       ON CONFLICT (company_id) WHERE effective_to IS NULL DO NOTHING RETURNING *`,
      [claims.company_id]
    );
    if ((inserted.rowCount ?? 0) > 0) return rowToSettings(inserted.rows[0]);
    const retry = await this.effectiveDating.getCurrentRow(client, { table: "payroll_settings", scope: { company_id: claims.company_id! } });
    return rowToSettings(retry);
  }

  /** Resolves the EOBI/social-security settings generation that was
   * actually in force on `asOfDate` — used by `calculateRun()` so a
   * run's own period, not "today", decides which rates apply. Falls back
   * to lazily seeding + using the current generation if a tenant somehow
   * has no generation covering that date at all (e.g. a run dated before
   * the tenant's very first settings row — the same edge case tax slabs
   * already had to handle). */
  private async loadSettingsAsOf(client: PoolClient, claims: RequestClaims, asOfDate: string): Promise<PayrollSettingsView> {
    await this.loadOrSeedSettings(client, claims);
    const result = await client.query(
      `SELECT * FROM payroll_settings WHERE company_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)
       ORDER BY effective_from DESC LIMIT 1`,
      [claims.company_id, asOfDate]
    );
    if ((result.rowCount ?? 0) > 0) return rowToSettings(result.rows[0]);
    return this.loadOrSeedSettings(client, claims);
  }

  private async loadOrSeedTaxSlabs(client: PoolClient, claims: RequestClaims): Promise<TaxSlabView[]> {
    // Reads the CURRENT set only (effective_to IS NULL) — same "live
    // decision paths keep reading current" discipline as leave policies.
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

  /** Resolves the tax slab GENERATION that was actually in force on
   * `asOfDate` — Phase P1's fix for the gap migration 0033's own header
   * comment named up front ("resolving a run's OWN period against
   * historical slabs is a real, separately named follow-on"). Falls back
   * to lazily seeding + using the current generation for a date before
   * the tenant's first-ever slab set. */
  private async loadTaxSlabsAsOf(client: PoolClient, claims: RequestClaims, asOfDate: string): Promise<TaxSlabView[]> {
    await this.loadOrSeedTaxSlabs(client, claims);
    const result = await client.query(
      `SELECT * FROM tax_slabs WHERE company_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)
       ORDER BY min_annual_income ASC`,
      [claims.company_id, asOfDate]
    );
    if (result.rowCount && result.rowCount > 0) return result.rows.map(rowToTaxSlab);
    return this.loadOrSeedTaxSlabs(client, claims);
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

  private async requirePayrollApprove(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, APPROVE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to approve payroll runs");
    }
  }

  private async requireViewRuns(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, HR_MANAGE_PERMISSION)) && !(await this.rbac.can(claims, APPROVE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to view payroll runs");
    }
  }
}
