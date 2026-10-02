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
import { LeaveRequestsService, inclusiveDayCount } from "../leave/leave-requests.service";
import { OvertimeService } from "../leave/overtime.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { WebhookDispatchService } from "../webhooks/webhook-dispatch.service";
import { isPayrollAreaInScope, resolvePayrollAreaAccess, type PayrollAreaAccess } from "./payroll-area-access";
import { FormulaExpressionEngine } from "./formula-expression.engine";
import { PayrollFormulaService, type ResolvedPayrollFormulas } from "./payroll-formula.service";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../employees/employee-offcycle-payments.service";
import type {
  CalculatePayrollRunResponse,
  CreatePayrollRunRequest,
  DecideLeaveRequestRequest,
  OffCycleReason,
  PayrollCalculationError,
  PayrollCalculationStep,
  PayrollRunType,
  PayrollRunView,
  PayrollSettingsView,
  PayslipView,
  ReversePayrollRunRequest,
  SetTaxSlabsRequest,
  TaxSlabSetView,
  TaxSlabView,
  UpdatePayrollSettingsRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
// Phase P2 (0094_payroll_correction_reversal_and_permission_split.sql)
// split the original single, broad `payroll.manage.all` into three
// permissions matching each high-stakes lifecycle step — see that
// migration's own header comment for the full reasoning. The old
// `payroll.manage.all` permission row still exists (kept for any
// tenant/audit reference to it) but nothing here checks it anymore.
const CALCULATE_PERMISSION = "payroll.calculate.all";
const FINALIZE_PERMISSION = "payroll.finalize.all";
const DISBURSE_PERMISSION = "payroll.disburse.all";
const APPROVE_PERMISSION = "payroll.approve.all";
// Payroll Areas (0101_payroll_areas.sql / 0102 seed): the run-level
// calculate/finalize/disburse actions accept either `<base>.all`
// (unrestricted — exactly the pre-Payroll-Area behavior) or
// `<base>.scoped` (only runs whose payroll_area_id resolves inside the
// caller's data scope; a company-wide run never does). See
// `requireRunAction()`/`assertRunInScope()` and payroll-area-access.ts.
const CALCULATE_PERMISSION_BASE = "payroll.calculate";
const FINALIZE_PERMISSION_BASE = "payroll.finalize";
const DISBURSE_PERMISSION_BASE = "payroll.disburse";
const RUN_SCOPED_VIEW_BASES = [CALCULATE_PERMISSION_BASE, FINALIZE_PERMISSION_BASE, DISBURSE_PERMISSION_BASE] as const;
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

// Calendar-day arithmetic (`inclusiveDayCount`) is imported from
// LeaveRequestsService's own exported helper (integration gap audit item
// 6, 2026-10-01) rather than hand-copied here as it used to be — one
// copy, so a day either module counts is, by construction, the same day
// the other counts. The month-index fix this file's old copy carried now
// lives in that shared copy (see its own doc comment).

function addOneDayIso(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** How one employee's salary is prorated within a run — see
 * `PayrollService.resolveProrationBasis()`. */
type ProrationBasis =
  | { mode: "calendar"; note?: string }
  | { mode: "working_days"; workingDates: string[]; scheduleNames: string[] };

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
    standardMonthlyHours: Number(row.standard_monthly_hours),
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

// Payroll Formula Engine: used only when PayrollService is hand-constructed
// without a PayrollFormulaService (spec fixtures that predate it). Both
// classes are stateless and dependency-free beyond the pure engine, so
// this is the identical resolver NestJS DI would inject — a configured
// override is therefore NEVER silently skipped, whichever way this
// service was built.
const FALLBACK_FORMULA_SERVICE = new PayrollFormulaService(new FormulaExpressionEngine());

type RunSummary = { payslipCount: number; totalGrossPay: number; totalNetPay: number };
const ZERO_RUN_SUMMARY: RunSummary = { payslipCount: 0, totalGrossPay: 0, totalNetPay: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRun(row: any, summary: RunSummary = ZERO_RUN_SUMMARY): PayrollRunView {
  return {
    id: row.id,
    companyId: row.company_id,
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    status: row.status,
    // Phase P4 (0113_payroll_off_cycle_runs.sql) — `run_type` defaults
    // 'regular' at the column level, so every run created before this
    // phase reads back unchanged.
    runType: row.run_type as PayrollRunType,
    offCycleReason: (row.off_cycle_reason ?? null) as OffCycleReason | null,
    targetEmployeeId: row.target_employee_id ?? null,
    workflowInstanceId: row.workflow_instance_id,
    createdByUserAccountId: row.created_by_user_account_id,
    finalizedAt: toIso(row.finalized_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
    payslipCount: summary.payslipCount,
    totalGrossPay: summary.totalGrossPay,
    totalNetPay: summary.totalNetPay,
    reversedAt: toIso(row.reversed_at),
    reversedByUserAccountId: row.reversed_by_user_account_id ?? null,
    reversalReason: row.reversal_reason ?? null,
    correctiveRunId: row.corrective_run_id ?? null,
    // Unrelated to this task's overtime-settings work: 0101_payroll_areas.sql
    // (a concurrently-landed migration) added payroll_runs.payroll_area_id
    // and shared-types' PayrollRunView.payrollAreaId, but this mapping
    // function hadn't been updated yet, which broke compilation of this
    // whole file. One-line, mechanical wiring of an already-existing
    // column to an already-existing type field — not a design decision.
    payrollAreaId: row.payroll_area_id ?? null,
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
    loanDeductions: row.loan_deductions ?? [],
    consumedAdditionalPayments: row.consumed_additional_payments ?? [],
    consumedOffCyclePayments: row.consumed_offcycle_payments ?? [],
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
 *    join inside `calculateOnePayslip()` below — never through that service.
 *    (Unpaid leave, by contrast, is no longer read by raw SQL: since the
 *    2026-10-01 integration gap audit, item 6, it comes from
 *    `LeaveRequestsService.getApprovedUnpaidLeaveDaysInRange()`; approved
 *    overtime likewise from `OvertimeService.getApprovedOvertimeInRange()`.)
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
    private readonly workflow: WorkflowService,
    // Integration gap audit remediation (2026-10-01). All four are
    // appended (never inserted mid-list) and typed optional for the same
    // reason EmployeesService's own `webhooks?` is: other feature areas'
    // spec files (configuration-center.service.spec.ts) hand-construct
    // PayrollService with the original 7 arguments purely to exercise
    // settings/tax-slab reads. NestJS DI (PayrollModule -> LeaveModule /
    // ShiftsModule / WebhooksModule) always supplies real instances.
    // `webhooks` is genuinely optional (a missing one just skips the
    // event, exactly like `EmployeesService`); the other three are NOT
    // optional for calculation — `requireCalculationCollaborators()`
    // fails loudly rather than ever silently skipping unpaid leave,
    // overtime, or schedule-aware proration.
    private readonly leaveRequests?: LeaveRequestsService,
    private readonly overtime?: OvertimeService,
    private readonly workSchedule?: WorkScheduleResolutionService,
    private readonly webhooks?: WebhookDispatchService,
    // Payroll Formula Engine (0105_payroll_formulas.sql) — appended for the
    // same hand-constructed-fixture reason as the four above. Unlike them,
    // a missing one is harmless: `formulaService()` falls back to an
    // identical stateless instance, never to "skip overrides".
    private readonly formulas?: PayrollFormulaService,
    // Payroll Enterprise Gap Analysis Phase P3 (2026-10-02) — Loans/
    // Salary Advances and the IT0015-equivalent Additional Payments.
    // Optional for the same hand-constructed-fixture reason as
    // leaveRequests/overtime/workSchedule above, and NOT optional for
    // calculation once present — `requireCalculationCollaborators()`
    // fails loudly if either is missing, same posture as those three
    // (a loan deduction silently skipped would be a real payroll
    // correctness bug, not a cosmetic gap).
    private readonly loans?: EmployeeLoansService,
    private readonly additionalPayments?: EmployeeAdditionalPaymentsService,
    // Payroll Enterprise Gap Analysis Phase P4 (2026-10-02) — Off-cycle
    // runs & Final Settlement's own Additional Off-Cycle Payments
    // (IT0267 equivalent). Same optional-but-required-for-calculation
    // posture as `loans`/`additionalPayments` immediately above.
    private readonly offCyclePayments?: EmployeeOffCyclePaymentsService
  ) {}

  // --- Settings & tax slabs -----------------------------------------------

  /** Lazily seeds `payroll_settings` from the table's own column
   * defaults the first time a tenant has no row — the same lazy-seed
   * pattern Phase 9 used for `leave_balances`. Reads the CURRENT
   * generation via the shared EffectiveDatingEngine now that this table
   * is effective-dated (Phase P1). */
  async getSettings(claims: RequestClaims): Promise<PayrollSettingsView> {
    await this.requirePayrollCalculate(claims);
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
    await this.requirePayrollCalculate(claims);
    // Sanity guardrail against fat-finger input (e.g. hours/day typed in
    // place of hours/month), not a business rule — see
    // 0100_overtime_standard_monthly_hours.sql's header comment. The DTO
    // enforces the same bounds at the HTTP boundary; this re-checks at
    // the service boundary so a direct caller (every existing test calls
    // this service method directly, never through the controller) gets
    // the same guarantee.
    if (
      patch.standardMonthlyHours !== undefined &&
      (patch.standardMonthlyHours < 100 || patch.standardMonthlyHours > 300)
    ) {
      throw new BadRequestException("standardMonthlyHours must be between 100 and 300");
    }
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
          standard_monthly_hours: patch.standardMonthlyHours ?? current.standardMonthlyHours,
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
    await this.requirePayrollCalculate(claims);
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
    await this.requirePayrollCalculate(claims);
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
    await this.requirePayrollCalculate(claims);
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
    await this.requirePayrollCalculate(claims);
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
    const access = await this.requireRunAction(claims, CALCULATE_PERMISSION_BASE, "Not permitted to calculate payroll");
    const payrollAreaId = input.payrollAreaId ?? null;
    if (!isPayrollAreaInScope(access, payrollAreaId)) {
      throw new ForbiddenException(
        payrollAreaId
          ? "This payroll area is outside your data scope"
          : "Only a caller with payroll.calculate.all can create a company-wide payroll run"
      );
    }
    if (new Date(input.periodEnd) < new Date(input.periodStart)) {
      throw new BadRequestException("periodEnd cannot be before periodStart");
    }
    // Phase P4 — off-cycle fields. `runType` defaults 'regular' (every
    // call site before this phase, unchanged). An off-cycle run skips
    // the period-uniqueness checks below entirely (see
    // `payroll_runs_active_period_key`'s own relaxed WHERE clause,
    // 0113_payroll_off_cycle_runs.sql) — it is explicitly allowed to
    // coexist with a regular run, or with other off-cycle runs, covering
    // the exact same period.
    const runType: PayrollRunType = input.runType ?? "regular";
    const offCycleReason = input.offCycleReason ?? null;
    const targetEmployeeId = input.targetEmployeeId ?? null;
    if (runType === "regular") {
      if (offCycleReason || targetEmployeeId) {
        throw new BadRequestException("offCycleReason/targetEmployeeId are only valid on an off-cycle run");
      }
    } else if (!offCycleReason) {
      throw new BadRequestException("offCycleReason is required for an off-cycle run");
    }
    // final_settlement is the one off-cycle reason that MUST target
    // exactly one employee (a batch settlement makes no sense — each
    // termination is reviewed on its own) and that employee must
    // actually be terminated, with this run's own period covering the
    // termination date (calculateOnePayslip()'s employment-window clamp,
    // further down, otherwise has nothing to compute against).
    if (offCycleReason === "final_settlement") {
      if (!targetEmployeeId) {
        throw new BadRequestException("final_settlement requires a targetEmployeeId");
      }
    }
    return this.db.withClaims(claims, async (client) => {
      let targetTerminationDate: string | null = null;
      if (targetEmployeeId) {
        const target = await client.query<{ termination_date: unknown }>(
          "SELECT termination_date FROM employees WHERE id = $1 AND company_id = $2",
          [targetEmployeeId, claims.company_id]
        );
        if (target.rowCount === 0) throw new NotFoundException("Target employee not found");
        targetTerminationDate = toIsoDateOrNull(target.rows[0].termination_date);
        if (offCycleReason === "final_settlement") {
          if (!targetTerminationDate) {
            throw new BadRequestException("Target employee has no termination date set — final settlement requires a terminated employee");
          }
          if (targetTerminationDate < input.periodStart || targetTerminationDate > input.periodEnd) {
            throw new BadRequestException(
              `This run's period must cover the employee's termination date (${targetTerminationDate})`
            );
          }
          // One non-reversed final_settlement run per employee, ever —
          // also enforced by `payroll_runs_one_final_settlement_per_employee`
          // (0113), this pre-check just turns that constraint violation
          // into a clean 400.
          const existingSettlement = await client.query(
            "SELECT 1 FROM payroll_runs WHERE target_employee_id = $1 AND off_cycle_reason = 'final_settlement' AND status <> 'reversed'",
            [targetEmployeeId]
          );
          if (existingSettlement.rowCount! > 0) {
            throw new BadRequestException("A final settlement run already exists for this employee");
          }
        }
      }

      // Phase P2: excludes `reversed` rows — the table's own unique index
      // (0094_payroll_correction_reversal_and_permission_split.sql) does
      // the same, allowing a period to accumulate reversed history while
      // still guaranteeing only one ACTIVE run at a time. This pre-check
      // exists purely to turn that constraint violation into a clean
      // 400 instead of a raw database error; `reverseRun()` itself
      // creates its own corrective run directly, bypassing this method.
      //
      // Payroll Areas: one active run per {period, payroll area} (the
      // widened 0101 index), and never a company-wide run alongside area
      // runs for the same period — that would pay the same employees twice.
      //
      // Phase P4: every check in this block is REGULAR-run-only — an
      // off-cycle run never participates in period-uniqueness at all
      // (see this method's own comment above).
      if (runType === "regular") {
        if (payrollAreaId) {
          const area = await client.query("SELECT is_active FROM payroll_areas WHERE id = $1", [payrollAreaId]);
          if (area.rowCount === 0) throw new NotFoundException("Payroll area not found");
          if (!area.rows[0].is_active) throw new BadRequestException("Cannot create a payroll run for an inactive payroll area");
        }
        const existing = await client.query<{ payroll_area_id: string | null }>(
          "SELECT payroll_area_id FROM payroll_runs WHERE company_id = $1 AND period_start = $2 AND period_end = $3 AND status <> 'reversed' AND run_type = 'regular'",
          [claims.company_id, input.periodStart, input.periodEnd]
        );
        if (existing.rows.some((r) => (r.payroll_area_id ?? null) === payrollAreaId)) {
          throw new BadRequestException(
            payrollAreaId
              ? "A payroll run for this exact period already exists for this payroll area"
              : "A payroll run for this exact period already exists"
          );
        }
        if (payrollAreaId && existing.rows.some((r) => r.payroll_area_id === null)) {
          throw new BadRequestException("A company-wide payroll run already covers this exact period");
        }
        if (!payrollAreaId && existing.rows.length > 0) {
          throw new BadRequestException(
            "Payroll-area runs already exist for this exact period; a company-wide run would pay their employees twice"
          );
        }
      }
      const result = await client.query(
        `INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, payroll_area_id, run_type, off_cycle_reason, target_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, input.periodStart, input.periodEnd, claims.sub, payrollAreaId, runType, offCycleReason, targetEmployeeId]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.create",
        target: result.rows[0].id,
        metadata: { payrollAreaId: payrollAreaId ?? undefined, runType, offCycleReason: offCycleReason ?? undefined, targetEmployeeId: targetEmployeeId ?? undefined },
      });
      return rowToRun(result.rows[0]);
    });
  }

  /** Readable by anyone holding at least one of the four payroll-staff
   * permissions (`payroll.calculate.all` / `.finalize.all` /
   * `.disburse.all` / `payroll.approve.all`, see `hasAnyPayrollStaffPermission()`)
   * — a Payroll Approver, for instance, needs to see the runs list to
   * find the one awaiting their decision, even though they can't
   * create/calculate/finalize any of them. */
  async listRuns(claims: RequestClaims): Promise<PayrollRunView[]> {
    const access = await this.requireViewRuns(claims);
    return this.db.withClaims(claims, async (client) => {
      // Payroll Areas: a `payroll.*.scoped`-only caller sees only runs of
      // payroll areas inside their data scope (never company-wide runs).
      const result = access.unrestricted
        ? await client.query("SELECT * FROM payroll_runs ORDER BY period_start DESC")
        : await client.query("SELECT * FROM payroll_runs WHERE payroll_area_id = ANY($1::uuid[]) ORDER BY period_start DESC", [
            access.payrollAreaIds,
          ]);
      const ids = result.rows.map((r) => r.id);
      // One batched aggregate for every run on the page rather than N+1
      // separate `loadRunSummary()` calls — `= ANY($1::uuid[])` is a no-op
      // (empty result set) when `ids` is empty, so an empty runs list
      // never even reaches this query in practice but stays correct if it did.
      const summaries = await client.query(
        `SELECT payroll_run_id,
                COUNT(*)::int AS payslip_count,
                COALESCE(SUM(gross_pay), 0) AS total_gross_pay,
                COALESCE(SUM(net_pay), 0) AS total_net_pay
         FROM payslips WHERE payroll_run_id = ANY($1::uuid[]) GROUP BY payroll_run_id`,
        [ids]
      );
      const summaryByRunId = new Map<string, RunSummary>(
        summaries.rows.map((s) => [
          s.payroll_run_id,
          { payslipCount: Number(s.payslip_count), totalGrossPay: Number(s.total_gross_pay), totalNetPay: Number(s.total_net_pay) },
        ])
      );
      return result.rows.map((r) => rowToRun(r, summaryByRunId.get(r.id)));
    });
  }

  async getRun(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    const access = await this.requireViewRuns(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      // Out of scope reads as "not found" — Organization's scoped get() convention.
      if (!isPayrollAreaInScope(access, run.payroll_area_id)) throw new NotFoundException("Payroll run not found");
      const summary = await this.loadRunSummary(client, id);
      return rowToRun(run, summary);
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
    const access = await this.requireRunAction(claims, CALCULATE_PERMISSION_BASE, "Not permitted to calculate payroll");
    // Fail the whole call up front (not per employee inside the loop's
    // error collection) if a collaborator is missing — see the helper.
    this.requireCalculationCollaborators();
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      this.assertRunInScope(access, run);
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
      // Payroll Formula Engine: tenant overrides in force at periodEnd —
      // the same as-of rule as settings/tax slabs above, resolved once per
      // run. Empty (the default for every tenant) = built-in math only.
      const formulas = await this.formulaService().resolveAsOf(client, claims.company_id!, periodEnd);
      // Once per run, not per employee — see resolveProrationBasis().
      const companyHasScheduleRules = await this.companyHasActiveScheduleAssignmentRules(client, claims.company_id!);

      // Phase P4 — employee selection branches on run_type/target_employee_id:
      //  - A TARGETED run (final_settlement always; bonus/arrears/other
      //    optionally) selects exactly that one employee, regardless of
      //    termination status — a final settlement run's whole point is
      //    paying someone the normal active-population filter below
      //    would exclude.
      //  - Every other case (a regular run, or a BATCH bonus/arrears/
      //    other run with no target) uses the same active-population
      //    filter as always.
      const runType = (run.run_type ?? "regular") as PayrollRunType;
      const offCycleReason = (run.off_cycle_reason ?? null) as OffCycleReason | null;
      const targetEmployeeId: string | null = run.target_employee_id ?? null;
      const employeesResult = targetEmployeeId
        ? await client.query<EmployeeRow>(
            `SELECT id, company_id, user_account_id, employee_number, bank_account_number, date_of_joining, termination_date
             FROM employees WHERE id = $1 AND company_id = $2`,
            [targetEmployeeId, claims.company_id]
          )
        : await client.query<EmployeeRow>(
            `SELECT id, company_id, user_account_id, employee_number, bank_account_number, date_of_joining, termination_date
             FROM employees
             WHERE date_of_joining <= $2
               AND (termination_date IS NULL OR termination_date >= $1)
               AND ($3::uuid IS NULL OR payroll_area_id = $3)`,
            [periodStart, periodEnd, run.payroll_area_id ?? null]
          );

      // Final Settlement's own double-pay guard: `calculateOnePayslip()`
      // computes this employee's full regular pay for the window — if a
      // REGULAR run already has a non-reversed payslip for this exact
      // employee overlapping this settlement's period, that salary was
      // already paid once; final_settlement would pay it a second time
      // on top of gratuity/leave-encashment/loan-payoff. Reverse that
      // regular run (or correct the settlement's own period so it
      // doesn't overlap) before calculating — the same "never silently
      // double-pay" posture as the Payroll Areas guard just below.
      if (offCycleReason === "final_settlement") {
        const overlapping = await client.query(
          `SELECT 1 FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
           WHERE p.employee_id = $1 AND pr.company_id = $2 AND pr.run_type = 'regular' AND pr.status <> 'reversed'
             AND pr.period_start <= $4 AND pr.period_end >= $3`,
          [targetEmployeeId, claims.company_id, periodStart, periodEnd]
        );
        if ((overlapping.rowCount ?? 0) > 0) {
          throw new BadRequestException(
            "This employee already has a regular-run payslip overlapping this settlement's period — reverse that run first, or choose a final settlement period that doesn't overlap it, to avoid paying their final salary twice"
          );
        }
      }

      // Payroll Areas double-pay guard: an employee who moved between
      // areas after one area's run for this exact period was calculated
      // must not be paid again by another area's run. A company-wide run
      // can never coexist with another active REGULAR run for the same
      // period (createRun() refuses it), so this only ever bites area
      // runs — and, as of Phase P4, only ever other REGULAR runs: an
      // off-cycle run (bonus/arrears/final settlement) is explicitly
      // allowed to pay someone who already has a regular-run payslip for
      // the identical period, and never blocks (or is blocked by) this
      // guard itself.
      const alreadyPaid =
        runType === "regular"
          ? await client.query<{ employee_id: string }>(
              `SELECT DISTINCT p.employee_id
               FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
               WHERE pr.company_id = $1 AND pr.id <> $2 AND pr.status <> 'reversed' AND pr.run_type = 'regular'
                 AND pr.period_start = $3 AND pr.period_end = $4`,
              [claims.company_id, id, periodStart, periodEnd]
            )
          : { rows: [] as { employee_id: string }[] };
      const alreadyPaidIds = new Set(alreadyPaid.rows.map((r) => r.employee_id));

      const errors: PayrollCalculationError[] = [];
      const payslipRows: Array<Record<string, unknown>> = [];

      for (const employee of employeesResult.rows) {
        if (alreadyPaidIds.has(employee.id)) {
          errors.push({
            employeeId: employee.id,
            message: "Already has a payslip in another active payroll run for this exact period (moved between payroll areas?)",
          });
          continue;
        }
        try {
          const payslip =
            runType === "off_cycle" && offCycleReason !== "final_settlement"
              ? // Bonus / arrears / other: a lean, self-contained
                // calculation — no compensation proration, no unpaid
                // leave, no loan deduction. It pays exactly what's
                // queued against THIS run in `employee_offcycle_payments`
                // (IT0267), nothing else. See the method's own doc comment.
                await this.calculateOffCyclePayslip(client, employee, run.id, periodStart, periodEnd, taxSlabs, formulas)
              : // Regular run, OR a final_settlement off-cycle run: both
                // go through the full, tested engine. `offCycleOptions`
                // is undefined for a regular run (byte-identical
                // behavior to before this phase) and set for
                // final_settlement (forces the tax true-up and full loan
                // payoff, and additionally consumes this run's own
                // IT0267 lines — see that option's own doc comment).
                await this.calculateOnePayslip(
                  client,
                  employee,
                  periodStart,
                  periodEnd,
                  daysInPeriod,
                  settings,
                  taxSlabs,
                  companyHasScheduleRules,
                  formulas,
                  offCycleReason === "final_settlement" ? { isFinalSettlement: true, offCycleRunId: run.id } : undefined
                );
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
             social_security_employer_contribution, net_pay, calculation_breakdown,
             loan_deductions, consumed_additional_payments, consumed_offcycle_payments
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb)`,
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
            JSON.stringify(row.loanDeductions ?? []),
            JSON.stringify(row.consumedAdditionalPayments ?? []),
            JSON.stringify(row.consumedOffCyclePayments ?? []),
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

      // Sums straight from the rows this call just computed and wrote —
      // no reason to re-query `payslips` for numbers already sitting in
      // memory (unlike finalize/submit/decide below, which didn't just
      // compute these payslips themselves and so ask loadRunSummary()).
      const summary: RunSummary = {
        payslipCount: payslipRows.length,
        totalGrossPay: payslipRows.reduce((sum, r) => sum + Number(r.grossPay), 0),
        totalNetPay: payslipRows.reduce((sum, r) => sum + Number(r.netPay), 0),
      };
      return { run: rowToRun(updated.rows[0], summary), payslipCount: payslipRows.length, errors };
    });
  }

  /**
   * Phase P2: a run must be `approved` (submitted, then decided through
   * the workflow engine) before it can be finalized — no more finalizing
   * straight off a calculation. See this file's own header note and
   * 0093_payroll_approval_workflow.sql for the full reasoning.
   */
  async finalizeRun(claims: RequestClaims, id: string): Promise<PayrollRunView> {
    const access = await this.requireRunAction(claims, FINALIZE_PERMISSION_BASE, "Not permitted to finalize payroll runs");
    const finalized = await this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      this.assertRunInScope(access, run);
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
      // Phase P3 — commit the loan-repayment ledger and mark consumed
      // additional payments, reading back the structured PREVIEWS
      // calculateOnePayslip() wrote onto each payslip row (see that
      // method's own doc comment and 0112's header comment for why a
      // preview column beats re-deriving this from calculation_breakdown).
      // Deliberately done BEFORE the run's own status flips to
      // 'finalized' below, inside the same transaction, so a failure here
      // leaves the run un-finalized rather than finalized with a
      // half-written ledger. Both collaborators' own write methods are
      // idempotent (ON CONFLICT DO NOTHING / `WHERE status = 'pending'`),
      // so this is safe even if finalize were ever retried.
      // Phase P4 — same idempotent commit, for this run's own IT0267
      // lines (`consumed_offcycle_payments`). `markConsumedWithinTransaction()`
      // takes no `payrollRunId` argument the way `additionalPayments`'
      // does — an off-cycle payment is already scoped to exactly one run
      // at creation, so there is no "which run consumed it" to record.
      const { loans, additionalPayments, offCyclePayments } = this.requireCalculationCollaborators();
      const payslipsToCommit = await client.query(
        "SELECT id, loan_deductions, consumed_additional_payments, consumed_offcycle_payments FROM payslips WHERE payroll_run_id = $1",
        [id]
      );
      for (const payslip of payslipsToCommit.rows) {
        const loanDeductions = (payslip.loan_deductions ?? []) as Array<{ loanId: string; amount: number }>;
        for (const deduction of loanDeductions) {
          await loans.recordRepaymentWithinTransaction(client, {
            loanId: deduction.loanId,
            payrollRunId: id,
            payslipId: payslip.id,
            amount: deduction.amount,
          });
        }
        const consumed = (payslip.consumed_additional_payments ?? []) as Array<{ additionalPaymentId: string; amount: number }>;
        for (const entry of consumed) {
          await additionalPayments.markConsumedWithinTransaction(client, entry.additionalPaymentId, id);
        }
        const consumedOffCycle = (payslip.consumed_offcycle_payments ?? []) as Array<{ offCyclePaymentId: string; amount: number }>;
        for (const entry of consumedOffCycle) {
          await offCyclePayments.markConsumedWithinTransaction(client, entry.offCyclePaymentId);
        }
      }

      const result = await client.query(
        "UPDATE payroll_runs SET status = 'finalized', finalized_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.finalize", target: id });
      return rowToRun(result.rows[0], await this.loadRunSummary(client, id));
    });

    // Integration gap audit item 9 — the same fire-and-forget
    // `webhooks?.enqueue()` pattern EmployeesService (`employee.created`)
    // and the Organization services already use: a slow/misconfigured/
    // absent webhook target must never make finalizing payroll fail.
    // Deliberately enqueued only AFTER the finalize transaction above has
    // committed (enqueue() writes on its own connection), so a rolled-back
    // finalize can never have announced itself to a subscriber.
    this.webhooks
      ?.enqueue(finalized.companyId, "payroll_run.finalized", {
        payrollRunId: finalized.id,
        companyId: finalized.companyId,
        periodStart: finalized.periodStart,
        periodEnd: finalized.periodEnd,
        totalEmployees: finalized.payslipCount,
        totalGrossPay: finalized.totalGrossPay,
        totalNetPay: finalized.totalNetPay,
        finalizedAt: finalized.finalizedAt,
        finalizedByUserAccountId: claims.sub,
      })
      .catch(() => undefined);

    return finalized;
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
    const access = await this.requireRunAction(claims, CALCULATE_PERMISSION_BASE, "Not permitted to calculate payroll");
    const run = await this.db.withClaims(claims, (client) => this.loadRun(client, id));
    this.assertRunInScope(access, run);
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
      return rowToRun(result.rows[0], await this.loadRunSummary(client, id));
    });
  }

  /**
   * Gated by `payroll.approve.all` — deliberately NOT any of the
   * preparer's own permissions (`payroll.calculate.all` / `.finalize.all` /
   * `.disburse.all`) — this is the actual segregation-of-duties
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
      return rowToRun(result.rows[0], await this.loadRunSummary(client, id));
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
      const hasAll = await this.hasAnyPayrollStaffPermission(claims);
      const result = await client.query(
        `SELECT p.*, e.user_account_id AS employee_user_account_id, pr.status AS run_status, pr.payroll_area_id AS run_payroll_area_id
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE ($1::uuid IS NULL OR p.payroll_run_id = $1)
           AND ($2::uuid IS NULL OR p.employee_id = $2)
         ORDER BY p.created_at DESC`,
        [filter.payrollRunId ?? null, filter.employeeId ?? null]
      );
      // Payroll Areas: a `payroll.*.scoped` holder also sees every payslip
      // of in-scope runs (reviewing the numbers they calculate/finalize).
      const scoped = hasAll ? null : await resolvePayrollAreaAccess(this.db, this.rbac, claims, RUN_SCOPED_VIEW_BASES);
      const visible = hasAll
        ? result.rows
        : result.rows.filter(
            (row) =>
              (scoped !== null && isPayrollAreaInScope(scoped, row.run_payroll_area_id)) ||
              (row.employee_user_account_id === claims.sub && row.run_status === "finalized")
          );
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
        `SELECT p.*, e.user_account_id AS employee_user_account_id, pr.status AS run_status, pr.payroll_area_id AS run_payroll_area_id
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE p.id = $1`,
        [id]
      );
      if (result.rowCount === 0) throw new NotFoundException("Payslip not found");
      const row = result.rows[0];

      const hasAll = await this.hasAnyPayrollStaffPermission(claims);
      if (hasAll) return rowToPayslip(row);

      const scoped = await resolvePayrollAreaAccess(this.db, this.rbac, claims, RUN_SCOPED_VIEW_BASES);
      if (scoped && isPayrollAreaInScope(scoped, row.run_payroll_area_id)) return rowToPayslip(row);

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
    const access = await this.requireRunAction(claims, DISBURSE_PERMISSION_BASE, "Not permitted to generate payroll disbursement files");
    const { csv, event } = await this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertRunInScope(access, run);
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
      // Summed from the exact rows written into the bank file (each already
      // rounded to 2dp, as the bank sees them), so the event's total always
      // reconciles to the file a subscriber would receive.
      const totalNetPay = Number(rows.reduce((sum, r) => sum + Number(r.netPay), 0).toFixed(2));
      return {
        csv: this.importExport.toCsv(["employeeNumber", "bankAccountNumber", "netPay"], rows),
        event: {
          payrollRunId: run.id as string,
          companyId: run.company_id as string,
          periodStart: toIsoDate(run.period_start),
          periodEnd: toIsoDate(run.period_end),
          totalEmployees: rows.length,
          totalNetPay,
        },
      };
    });

    // Integration gap audit item 9 — see finalizeRun()'s own comment on
    // the fire-and-forget, enqueue-after-commit pattern. "Disbursed" here
    // means exactly what this endpoint does: the bank disbursement file
    // was generated (the point money moves, per requirePayrollDisburse()),
    // so the acting user is part of the payload. Re-generating the file
    // for the same run emits the event again — every generation is a real,
    // separately audited action (see the audit record above), and a
    // subscriber can de-duplicate on `payrollRunId` if it only cares
    // about the first.
    this.webhooks
      ?.enqueue(event.companyId, "payroll_run.disbursed", {
        ...event,
        disbursedByUserAccountId: claims.sub,
        disbursedAt: new Date().toISOString(),
      })
      .catch(() => undefined);

    return csv;
  }

  /**
   * Correction/Reversal (Phase P2, master engineering instruction Section
   * 36: "capture reason; identify original run/result; require elevated
   * authorization; preserve original result; generate correction/reversal
   * transaction; ... audit entire chain"). Only a `finalized` run can be
   * reversed — a run still in flight (draft/calculated/pending_approval/
   * approved) is fixed by recalculating or rejecting it, not by this
   * endpoint (see `requirePayrollReverse()`'s own doc comment for why
   * this needs BOTH `payroll.finalize.all` and `payroll.disburse.all`).
   *
   * Preserves the original run and its payslips completely untouched:
   * the ORIGINAL row moves to the terminal `reversed` status (capturing
   * who/when/why), and a brand new `draft` run opens for the identical
   * period so HR can correct the underlying data and take the corrected
   * run through calculate -> submit -> approve -> finalize again, same as
   * any other run. `corrective_run_id` on the original links forward to
   * it, so the whole chain (original -> reversed -> corrective) is
   * reconstructable from the runs list alone.
   *
   * Done as UPDATE-then-INSERT-then-UPDATE, deliberately in that order:
   * the table's own partial unique index
   * (`payroll_runs_active_period_key`, non-reversed rows only) would
   * reject the corrective INSERT if it ran while the original row were
   * still `finalized` — the original has to already be `reversed` first.
   * `corrective_run_id` can only be set on the original in a final third
   * statement, once the corrective row's own id actually exists.
   *
   * This codebase has no separate in-process domain-event bus — the
   * `this.audit.record()` calls below are the established mechanism every
   * module since Phase 4 has used for an auditable trail, applied here to
   * both halves of the reversal. (Outbound webhooks — WebhookDispatchService
   * — are emitted for `payroll_run.finalized`/`payroll_run.disbursed`
   * since integration gap audit item 9; a `payroll_run.reversed` event was
   * not part of that item's scope and is not emitted yet.)
   *
   * Deliberately does NOT undo `finalizeRun()`'s Phase P3/P4 side effects
   * (the `employee_loan_repayments` ledger rows / decremented
   * `outstanding_balance`, the `employee_additional_payments` /
   * `employee_offcycle_payments` rows marked `consumed`) — exactly the
   * same posture as the ORIGINAL run's payslips themselves, which this
   * method also leaves completely untouched. Both are permanent
   * historical record of what was actually paid under the original run;
   * HR corrects the underlying data and the money (a new loan/
   * additional/off-cycle payment, an adjustment on the corrective run)
   * going forward, the same way every other correction in this codebase
   * works. Reversing a `final_settlement` run therefore does NOT reopen
   * the loans it paid off in full — HR would issue a fresh loan if that
   * money genuinely needs to go back out, same as any other correction.
   */
  async reverseRun(claims: RequestClaims, id: string, dto: ReversePayrollRunRequest): Promise<PayrollRunView> {
    await this.requirePayrollReverse(claims);
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new BadRequestException("A reason is required to reverse a payroll run");
    }
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      if (run.status !== "finalized") {
        throw new BadRequestException(`Payroll run is ${run.status}, only a finalized run can be reversed`);
      }

      await client.query(
        `UPDATE payroll_runs
         SET status = 'reversed', reversed_at = now(), reversed_by_user_account_id = $2, reversal_reason = $3, updated_at = now()
         WHERE id = $1`,
        [id, claims.sub, reason]
      );

      // Phase P4 — the corrective run carries over the SAME run_type/
      // off_cycle_reason/target_employee_id as the run it's correcting
      // (reversing a bonus run opens a fresh bonus-run slot for the same
      // employee/period; reversing a final_settlement run opens a fresh
      // one for the same employee — safe against
      // `payroll_runs_one_final_settlement_per_employee` because the
      // original row's own status already flipped to 'reversed' in the
      // UPDATE just above, inside this same transaction, before this
      // INSERT runs).
      const corrective = await client.query(
        `INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, payroll_area_id, run_type, off_cycle_reason, target_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          run.company_id,
          run.period_start,
          run.period_end,
          claims.sub,
          run.payroll_area_id ?? null,
          run.run_type ?? "regular",
          run.off_cycle_reason ?? null,
          run.target_employee_id ?? null,
        ]
      );
      const correctiveRunId = corrective.rows[0].id as string;

      const result = await client.query(
        `UPDATE payroll_runs SET corrective_run_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, correctiveRunId]
      );

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.reverse",
        target: id,
        metadata: { reason, correctiveRunId },
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.create",
        target: correctiveRunId,
        metadata: { reversalOf: id },
      });

      return rowToRun(result.rows[0], await this.loadRunSummary(client, id));
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
   *
   * Payroll Formula Engine (0105_payroll_formulas.sql): income tax and the
   * two EOBI contributions may each be REPLACED by a tenant-configured,
   * effective-dated formula override (`formulas`, resolved once per run as
   * of periodEnd). Each of the three call sites below always computes the
   * built-in figure exactly as before and only substitutes the override's
   * result when one is configured — see PayrollFormulaService for the
   * per-key evaluation-context contract.
   */
  private async calculateOnePayslip(
    client: PoolClient,
    employee: EmployeeRow,
    periodStart: string,
    periodEnd: string,
    daysInPeriod: number,
    settings: PayrollSettingsView,
    taxSlabs: TaxSlabView[],
    companyHasScheduleRules: boolean,
    formulas: ResolvedPayrollFormulas,
    // Phase P4 — set ONLY for a `final_settlement` off-cycle run (never
    // for a regular run: every existing call site omits this, and the
    // behavior below is byte-identical to before this phase when it's
    // undefined — the whole point of threading it through as an option
    // rather than duplicating this method, see this file's own P4
    // comments for why that duplication risk wasn't worth taking).
    //  - `isFinalSettlement: true` forces the year-to-date tax
    //    calculation's `fractionElapsed` to 1 (a full true-up — the
    //    employee won't earn more from this employer this tax year, so
    //    there is nothing left to project) and pays off each active
    //    loan's FULL outstanding balance instead of one installment.
    //  - `offCycleRunId` additionally reads+consumes THIS run's own
    //    `employee_offcycle_payments` (IT0267 — gratuity, leave
    //    encashment, or anything else HR entered against this specific
    //    settlement run), merged into gross/taxable gross exactly like
    //    the date-range-matched IT0015 entity just below, BEFORE tax is
    //    computed — so a final settlement's tax true-up is computed on
    //    the WHOLE settlement, not just the final period's regular pay.
    offCycleOptions?: { isFinalSettlement: boolean; offCycleRunId: string }
  ): Promise<Record<string, unknown>> {
    const breakdown: PayrollCalculationStep[] = [];
    breakdown.push({ label: "Period", value: `${periodStart} to ${periodEnd} (${daysInPeriod} days)` });

    // --- Proration basis (integration gap audit item 5/10) ---------------
    // `daysInPeriod` stays the CALENDAR day count throughout (the tax
    // projection below is calendar-based and must stay so). Every salary
    // PRORATION figure — the denominator, each compensation segment's
    // days, the employment window, unpaid-leave days — instead goes
    // through `countDays()`/`prorationDays`, which are calendar days for
    // an employee with no explicit work schedule assignment (exactly the
    // pre-existing behavior, unchanged) and scheduled WORKING days for
    // one who has one. See resolveProrationBasis() for which is which.
    const basis = await this.resolveProrationBasis(client, employee.id, periodStart, periodEnd, companyHasScheduleRules);
    const countDays = (start: string, end: string): number =>
      basis.mode === "calendar" ? inclusiveDayCount(start, end) : basis.workingDates.filter((d) => d >= start && d <= end).length;
    const prorationDays = basis.mode === "calendar" ? daysInPeriod : basis.workingDates.length;
    const dayUnit = basis.mode === "calendar" ? "days" : "scheduled working days";
    breakdown.push(
      basis.mode === "calendar"
        ? { label: `Proration basis: calendar days${basis.note ? ` (${basis.note})` : ""}`, value: prorationDays }
        : {
            label: `Proration basis: scheduled working days per assigned work schedule (${basis.scheduleNames.join(", ")}) — weekly pattern minus mandatory holidays`,
            value: prorationDays,
          }
    );

    const dateOfJoining = toIsoDate(employee.date_of_joining);
    const terminationDate = toIsoDateOrNull(employee.termination_date);
    const windowStart = dateMax(periodStart, dateOfJoining);
    const windowEnd = terminationDate ? dateMin(periodEnd, terminationDate) : periodEnd;
    if (windowEnd < windowStart) {
      throw new Error("Employee was not employed at any point during this period");
    }
    const employmentWindowDays = countDays(windowStart, windowEnd);
    breakdown.push({ label: "Employment window within period", value: `${windowStart} to ${windowEnd} (${employmentWindowDays} ${dayUnit})` });

    const componentSegments = await client.query(
      `SELECT ecc.*, cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable, cc.component_type
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
    // Phase P3, Section 1 — a 'deduction'-type component (a recurring
    // Benefits-style deduction: health-insurance premium, society
    // membership fee, ...) is never part of gross/taxable gross and never
    // part of the unpaid-leave rate base below (a society fee is owed
    // regardless of attendance) — see 0112's own header comment. It
    // reduces NET pay only, alongside loan repayments/additional
    // deductions further down.
    let recurringDeductionTotal = 0;
    const latestAmountByComponent = new Map<string, number>();
    for (const seg of componentSegments.rows) {
      const segStart = dateMax(windowStart, toIsoDate(seg.effective_from));
      const segEnd = dateMin(windowEnd, seg.effective_to ? toIsoDate(seg.effective_to) : windowEnd);
      if (segEnd < segStart) continue;
      const segDays = countDays(segStart, segEnd);
      const amount = Number(seg.amount);
      const proratedAmount = (amount * segDays) / prorationDays;
      if (seg.component_type === "deduction") {
        recurringDeductionTotal += proratedAmount;
        breakdown.push({
          label: `${seg.component_name} — ${segStart} to ${segEnd} (${segDays} ${dayUnit}) @ ${amount}/mo (recurring deduction, reduces net pay only)`,
          value: -Number(proratedAmount.toFixed(2)),
        });
        continue;
      }
      grossFromSegments += proratedAmount;
      if (seg.component_is_taxable) taxableGrossFromSegments += proratedAmount;
      latestAmountByComponent.set(seg.component_id, amount);
      breakdown.push({
        label: `${seg.component_name} — ${segStart} to ${segEnd} (${segDays} ${dayUnit}) @ ${amount}/mo${seg.component_is_taxable ? "" : " (non-taxable)"}`,
        value: Number(proratedAmount.toFixed(2)),
      });
    }
    const latestTotalMonthlyRate = [...latestAmountByComponent.values()].reduce((a, b) => a + b, 0);

    // Integration gap audit item 6: asks Leave (the owner of
    // leave_requests) via its own exported service method instead of
    // querying the table directly — identical filters (unpaid, approved,
    // overlapping the employment window) and identical calendar-day,
    // window-clipped counting as the raw query this replaced.
    const { leaveRequests } = this.requireCalculationCollaborators();
    const unpaidLeave = await leaveRequests.getApprovedUnpaidLeaveDaysInRange(client, employee.id, windowStart, windowEnd);
    // Calendar mode: Leave's own calendar-day count, exactly as before.
    // Working-day mode: only the scheduled working days inside each
    // unpaid segment — an unpaid Tuesday-Wednesday for a Mon/Wed/Fri
    // part-timer costs one working day, not two.
    const unpaidLeaveDays =
      basis.mode === "calendar"
        ? unpaidLeave.totalDays
        : unpaidLeave.segments.reduce((sum, seg) => sum + countDays(seg.startDate, seg.endDate), 0);
    breakdown.push({ label: `Unpaid leave ${dayUnit} (approved, overlapping period)`, value: unpaidLeaveDays });

    // Simplification, documented since Decision #14: the unpaid-leave
    // deduction is computed uniformly against the period's LATEST total
    // monthly rate (across every component), not a per-day rate that
    // tracks which compensation segment each unpaid day actually fell
    // in. The deduction is then split between taxable/non-taxable pay
    // proportionally to this period's own taxable share — there's no
    // way to know which specific component an unpaid day "came out of",
    // so a proportional split is the least-arbitrary allocation.
    const unpaidDeduction = unpaidLeaveDays > 0 ? (latestTotalMonthlyRate * unpaidLeaveDays) / prorationDays : 0;
    if (unpaidLeaveDays > 0) {
      breakdown.push({ label: `Unpaid-leave deduction @ ${latestTotalMonthlyRate}/mo total rate`, value: -Number(unpaidDeduction.toFixed(2)) });
    }
    const taxableShare = grossFromSegments > 0 ? taxableGrossFromSegments / grossFromSegments : 0;
    const taxableUnpaidDeduction = unpaidDeduction * taxableShare;

    // --- Approved overtime (integration gap audit item 4, 0097) ----------
    // Every APPROVED overtime claim whose work_date falls inside this
    // employee's employment window for the period, read through
    // OvertimeService (the owner of overtime_records), never a raw query
    // here. Each claim's `amount` was priced and SNAPSHOTTED at approval
    // time (see 0097_overtime_amount_snapshot.sql) — Payroll never
    // re-prices it, so recalculating a draft run, or re-running a reversed
    // period's corrective run, always pays exactly what the approver saw.
    // An approved-but-unpriced claim (approved while no compensation
    // covered its work_date) is a loud per-employee error, never a silent
    // zero. Overtime is earnings, so it is taxable — and it is added AFTER
    // the unpaid-leave deduction, which is a proration of regular salary
    // only and must not eat into hours actually worked.
    const { overtime } = this.requireCalculationCollaborators();
    const overtimeClaims = await overtime.getApprovedOvertimeInRange(client, employee.id, windowStart, windowEnd);
    const unpricedOvertime = overtimeClaims.filter((c) => c.amount === null);
    if (unpricedOvertime.length > 0) {
      throw new Error(
        `Approved overtime claim(s) dated ${unpricedOvertime.map((c) => c.workDate).join(", ")} have no snapshotted amount — no compensation record covered the work date when they were approved. Correct the compensation history, then reject and resubmit the claim(s)`
      );
    }
    let overtimePay = 0;
    let overtimeMinutes = 0;
    for (const claim of overtimeClaims) {
      overtimePay += claim.amount as number;
      overtimeMinutes += claim.overtimeMinutes;
      breakdown.push({
        label: `Overtime ${claim.workDate} (${claim.dayType}) — ${claim.overtimeMinutes} min @ ${claim.hourlyRate}/hr x ${claim.rateMultiplier}`,
        value: Number((claim.amount as number).toFixed(2)),
      });
    }
    breakdown.push({
      label: `Overtime pay (${overtimeClaims.length} approved claim(s), ${overtimeMinutes} min, amounts snapshotted at approval)`,
      value: Number(overtimePay.toFixed(2)),
    });

    // --- Additional Payments (Phase P3, Section 6 — IT0015 equivalent) --
    // Every PENDING one-time earning/deduction whose `effective_date`
    // falls inside this employee's employment window this period, read
    // through EmployeeAdditionalPaymentsService (Core Employee's own
    // table — same "cross-module reads for calculation-correctness go
    // through an injected service" rule leaveRequests/overtime above
    // already follow). A one-time EARNING is taxable income exactly like
    // overtime — added to gross/taxable-gross here, AFTER the
    // unpaid-leave deduction (same reasoning: it must not be eaten by a
    // proration of regular salary) and excluded from the recurring
    // year-end projection below (it is one-off, not a recurring raise). A
    // one-time DEDUCTION is never taxable (enforced at create() time) and
    // reduces NET pay only, never gross/taxable gross — the same posture
    // this migration's own header comment gives deduction-type
    // compensation components and loan repayments below, applied here for
    // the identical reason: there is no statutory basis to presume a tax
    // treatment for "money taken back out" absent an accountant's say.
    const { additionalPayments } = this.requireCalculationCollaborators();
    const pendingAdditionalPayments = await additionalPayments.listPendingInRangeWithinTransaction(client, employee.id, windowStart, windowEnd);
    let additionalEarningsTaxable = 0;
    let additionalEarningsNonTaxable = 0;
    let additionalDeductionTotal = 0;
    const consumedAdditionalPayments: Array<{ additionalPaymentId: string; amount: number }> = [];
    for (const payment of pendingAdditionalPayments) {
      if (payment.paymentType === "earning") {
        if (payment.isTaxable) additionalEarningsTaxable += payment.amount;
        else additionalEarningsNonTaxable += payment.amount;
        breakdown.push({
          label: `Additional payment: ${payment.label} (${payment.effectiveDate})${payment.isTaxable ? "" : " (non-taxable)"}`,
          value: Number(payment.amount.toFixed(2)),
        });
      } else {
        additionalDeductionTotal += payment.amount;
        breakdown.push({ label: `Additional deduction: ${payment.label} (${payment.effectiveDate})`, value: -Number(payment.amount.toFixed(2)) });
      }
      consumedAdditionalPayments.push({ additionalPaymentId: payment.id, amount: Number(payment.amount.toFixed(2)) });
    }

    // --- Additional Off-Cycle Payments (Phase P4 — IT0267 equivalent) ---
    // ONLY when this call is a `final_settlement` run (`offCycleOptions.
    // offCycleRunId` set) — every PENDING line HR entered against THIS
    // SPECIFIC run via EmployeeOffCyclePaymentsService (gratuity, leave
    // encashment, or anything else; this platform computes neither from
    // a statutory formula, see that service's own class doc comment).
    // Merged into the exact same taxable/non-taxable-earning and
    // deduction totals as the IT0015 block above, for the identical
    // reason: a one-time final-settlement earning is taxed this period,
    // never projected into the recurring year-end estimate below.
    const consumedOffCyclePayments: Array<{ offCyclePaymentId: string; amount: number }> = [];
    if (offCycleOptions) {
      const { offCyclePayments } = this.requireCalculationCollaborators();
      const pendingOffCyclePayments = await offCyclePayments.listPendingForRunWithinTransaction(
        client,
        offCycleOptions.offCycleRunId,
        employee.id
      );
      for (const payment of pendingOffCyclePayments) {
        if (payment.paymentType === "earning") {
          if (payment.isTaxable) additionalEarningsTaxable += payment.amount;
          else additionalEarningsNonTaxable += payment.amount;
          breakdown.push({
            label: `Final settlement: ${payment.label}${payment.isTaxable ? "" : " (non-taxable)"}`,
            value: Number(payment.amount.toFixed(2)),
          });
        } else {
          additionalDeductionTotal += payment.amount;
          breakdown.push({ label: `Final settlement deduction: ${payment.label}`, value: -Number(payment.amount.toFixed(2)) });
        }
        consumedOffCyclePayments.push({ offCyclePaymentId: payment.id, amount: Number(payment.amount.toFixed(2)) });
      }
    }
    const additionalEarningsTotal = additionalEarningsTaxable + additionalEarningsNonTaxable;

    const paidDays = Math.max(0, employmentWindowDays - unpaidLeaveDays);
    const grossPay = Math.max(0, grossFromSegments - unpaidDeduction) + overtimePay + additionalEarningsTotal;
    const taxableGrossThisPeriod = Math.max(0, taxableGrossFromSegments - taxableUnpaidDeduction) + overtimePay + additionalEarningsTaxable;
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
    // Final Settlement (Phase P4): the employee won't earn anything more
    // from THIS employer for the rest of this tax year, so there is
    // nothing left to project — forcing `daysRemaining` to 0 makes
    // `estimatedAnnualTaxableIncome` below exactly "actual YTD + this
    // period, no projection," and forcing `fractionElapsed` to 1 (right
    // below) then compares the FULL year's tax on that actual total
    // against what was actually withheld — a genuine full true-up,
    // instead of the normal running estimate every other run uses.
    const daysRemaining = offCycleOptions?.isFinalSettlement ? 0 : Math.max(0, totalDaysInTaxYear - daysElapsedInclusive);
    // Only RECURRING taxable pay is projected forward across the rest of
    // the tax year — overtime is a one-off earning for this period (it is
    // still fully counted in this period's own taxable income below), and
    // annualizing it would overstate the full-year estimate and push the
    // employee into a higher bracket for hours they may never work again.
    // With no overtime/additional earnings this is exactly the
    // pre-overtime formula. A one-time additional earning is excluded
    // from the projection for the identical reason overtime is (see the
    // Additional Payments block above) — one taxable windfall this period
    // must not get annualized into every remaining period's estimate.
    const recurringTaxableThisPeriod = Math.max(0, taxableGrossThisPeriod - overtimePay - additionalEarningsTaxable);
    const dailyTaxableRate = daysInPeriod > 0 ? recurringTaxableThisPeriod / daysInPeriod : 0;
    const projectedRemainingIncome = dailyTaxableRate * daysRemaining;
    const estimatedAnnualTaxableIncome = priorYtdTaxable + taxableGrossThisPeriod + projectedRemainingIncome;
    breakdown.push({
      label: offCycleOptions?.isFinalSettlement
        ? "Final tax-year taxable income from this employer (YTD + this settlement, no projection — final true-up)"
        : "Estimated full tax-year taxable income (YTD + this period + projected remainder)",
      value: Number(estimatedAnnualTaxableIncome.toFixed(2)),
    });

    const totalAnnualTaxEstimate = taxFromSlabs(estimatedAnnualTaxableIncome, taxSlabs);
    const fractionElapsed = offCycleOptions?.isFinalSettlement ? 1 : totalDaysInTaxYear > 0 ? daysElapsedInclusive / totalDaysInTaxYear : 1;
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

    // --- Payroll Formula Engine, call site 1 of 3: income_tax -----------
    // The built-in figure is computed exactly as before, always. A tenant
    // override (payroll_formulas, in force at periodEnd) only REPLACES it
    // when one is configured; with none, `incomeTaxOverride` is null and
    // both the amount and the breakdown line are byte-identical to the
    // pre-formula-engine output. A configured-but-failing override throws
    // (per-employee calculation error), never quietly falls back.
    const builtInIncomeTaxMonthly = Math.max(0, totalTaxDueToDate - priorYtdTaxWithheld);
    const incomeTaxOverride = formulas.evaluate("income_tax", {
      defaultAmount: builtInIncomeTaxMonthly,
      grossPay,
      taxableGrossThisPeriod,
      recurringTaxableThisPeriod,
      overtimePay,
      taxableAnnualIncome: estimatedAnnualTaxableIncome,
      priorYtdTaxableIncome: priorYtdTaxable,
      priorYtdTaxWithheld,
      slabAnnualTax: totalAnnualTaxEstimate,
      taxDueToDate: totalTaxDueToDate,
      bracketMinAnnualIncome: bracket.minAnnualIncome,
      bracketBaseTax: bracket.baseTax,
      bracketRatePercent: bracket.ratePercent,
      daysInPeriod,
      taxYearDaysElapsed: daysElapsedInclusive,
      taxYearTotalDays: totalDaysInTaxYear,
      taxYearFractionElapsed: fractionElapsed,
    });
    const incomeTaxMonthly = incomeTaxOverride === null ? builtInIncomeTaxMonthly : incomeTaxOverride.value;
    breakdown.push(
      incomeTaxOverride === null
        ? { label: "Income tax this period", value: Number(incomeTaxMonthly.toFixed(2)) }
        : {
            label: `Income tax this period — tenant formula override effective ${incomeTaxOverride.effectiveFrom} (built-in calculation: ${builtInIncomeTaxMonthly.toFixed(2)})`,
            value: Number(incomeTaxMonthly.toFixed(2)),
          }
    );

    const paidDaysRatio = employmentWindowDays > 0 ? paidDays / employmentWindowDays : 0;
    // --- Payroll Formula Engine, call sites 2 and 3: eobi_employee /
    // eobi_employer — same zero-risk rule as income_tax above: built-in
    // figures computed exactly as before; an override only replaces them
    // when configured, and with none the breakdown lines are unchanged.
    const builtInEobiEmployeeContribution = settings.eobiWageBase * (settings.eobiEmployeeRatePercent / 100) * paidDaysRatio;
    const builtInEobiEmployerContribution = settings.eobiWageBase * (settings.eobiEmployerRatePercent / 100) * paidDaysRatio;
    const eobiEmployeeOverride = formulas.evaluate("eobi_employee", {
      defaultAmount: builtInEobiEmployeeContribution,
      wageBase: settings.eobiWageBase,
      ratePercent: settings.eobiEmployeeRatePercent,
      paidDays,
      employmentWindowDays,
      paidDaysRatio,
      grossPay,
    });
    const eobiEmployerOverride = formulas.evaluate("eobi_employer", {
      defaultAmount: builtInEobiEmployerContribution,
      wageBase: settings.eobiWageBase,
      ratePercent: settings.eobiEmployerRatePercent,
      paidDays,
      employmentWindowDays,
      paidDaysRatio,
      grossPay,
    });
    const eobiEmployeeContribution = eobiEmployeeOverride === null ? builtInEobiEmployeeContribution : eobiEmployeeOverride.value;
    const eobiEmployerContribution = eobiEmployerOverride === null ? builtInEobiEmployerContribution : eobiEmployerOverride.value;
    breakdown.push(
      eobiEmployeeOverride === null
        ? { label: `EOBI employee contribution (${settings.eobiEmployeeRatePercent}% of wage base ${settings.eobiWageBase}, prorated)`, value: Number(eobiEmployeeContribution.toFixed(2)) }
        : {
            label: `EOBI employee contribution — tenant formula override effective ${eobiEmployeeOverride.effectiveFrom} (built-in calculation: ${builtInEobiEmployeeContribution.toFixed(2)})`,
            value: Number(eobiEmployeeContribution.toFixed(2)),
          }
    );
    breakdown.push(
      eobiEmployerOverride === null
        ? { label: `EOBI employer contribution (${settings.eobiEmployerRatePercent}% of wage base ${settings.eobiWageBase}, prorated)`, value: Number(eobiEmployerContribution.toFixed(2)) }
        : {
            label: `EOBI employer contribution — tenant formula override effective ${eobiEmployerOverride.effectiveFrom} (built-in calculation: ${builtInEobiEmployerContribution.toFixed(2)})`,
            value: Number(eobiEmployerContribution.toFixed(2)),
          }
    );

    const ssApplies =
      settings.socialSecurityScheme !== "none" &&
      (settings.socialSecurityWageCeiling === null || grossPay <= settings.socialSecurityWageCeiling);
    const socialSecurityEmployerContribution = ssApplies ? grossPay * (settings.socialSecurityEmployerRatePercent / 100) : 0;
    breakdown.push({
      label: `Social security (${settings.socialSecurityScheme}) employer contribution`,
      value: Number(socialSecurityEmployerContribution.toFixed(2)),
    });

    // --- Loans / Salary Advances (Phase P3 — IT0045 equivalent) ---------
    // Every ACTIVE loan this employee has, read through
    // EmployeeLoansService (Core Employee's own table). Preview only —
    // `min(installmentAmount, outstandingBalance)` per loan — never
    // mutated here; only `finalizeRun()` writes the ledger row and
    // decrements the balance (see that service's own class doc comment
    // and 0112's header comment for why). A repayment reduces NET pay
    // only — it is recovering money already disbursed outside payroll,
    // never a tax-relevant event.
    const { loans } = this.requireCalculationCollaborators();
    const activeLoans = await loans.listActiveLoansWithinTransaction(client, employee.id);
    let loanDeductionTotal = 0;
    const loanDeductions: Array<{ loanId: string; amount: number }> = [];
    for (const loan of activeLoans) {
      // Final Settlement (Phase P4): the employee is leaving, so there
      // are no more installments to come — the FULL outstanding balance
      // is recovered now, not just this period's usual installment.
      // Every other run (regular, bonus, arrears) keeps the normal
      // `min(installment, outstanding)` preview.
      const amount = Number(
        (offCycleOptions?.isFinalSettlement ? loan.outstandingBalance : Math.min(loan.installmentAmount, loan.outstandingBalance)).toFixed(2)
      );
      if (amount <= 0) continue;
      loanDeductionTotal += amount;
      loanDeductions.push({ loanId: loan.id, amount });
      breakdown.push({
        label: offCycleOptions?.isFinalSettlement
          ? `${loan.loanType === "loan" ? "Loan" : "Salary advance"} FULL payoff at final settlement (outstanding balance ${loan.outstandingBalance})`
          : `${loan.loanType === "loan" ? "Loan" : "Salary advance"} repayment installment (outstanding balance ${loan.outstandingBalance})`,
        value: -amount,
      });
    }

    const netPay =
      grossPay - incomeTaxMonthly - eobiEmployeeContribution - recurringDeductionTotal - loanDeductionTotal - additionalDeductionTotal;
    breakdown.push({
      label:
        "Net pay (gross - income tax - EOBI employee contribution - recurring deductions - loan/advance repayments - additional deductions)",
      value: Number(netPay.toFixed(2)),
    });

    return {
      employeeId: employee.id,
      employeeNumber: employee.employee_number,
      bankAccountNumber: employee.bank_account_number,
      // The proration denominator actually used: calendar days, or
      // scheduled working days for a schedule-aware payslip (the
      // breakdown's "Proration basis" line says which).
      daysInPeriod: prorationDays,
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
      // Phase P3 — structured PREVIEWS `finalizeRun()` reads back to know
      // exactly which loan/additional-payment rows to commit against
      // (see 0112's own header comment for why this beats re-deriving it
      // from the free-text breakdown labels above).
      loanDeductions,
      consumedAdditionalPayments,
      // Phase P4 — empty for a regular run (offCycleOptions undefined);
      // populated for final_settlement only, see that option's own doc
      // comment above.
      consumedOffCyclePayments,
    };
  }

  /**
   * Phase P4 — Off-cycle runs, bonus/arrears/other (NOT `final_settlement`
   * — that goes through `calculateOnePayslip()` with its `offCycleOptions`
   * instead, see that method's own doc comment for why). Deliberately a
   * separate, self-contained method rather than another branch inside
   * `calculateOnePayslip()`: a bonus/arrears run pays exactly what's
   * queued against THIS run in `employee_offcycle_payments` (IT0267) and
   * nothing else — no compensation proration, no unpaid leave, no
   * overtime, no loan deduction (a bonus run is not the place to also
   * recover a loan installment — that is the regular run's job; applying
   * it here too would double-collect) and no EOBI/employer-social-
   * security (both are a flat MONTHLY wage-base contribution, already
   * collected by this employee's regular run for the identical month —
   * collecting it again here would double-count it). Building this as a
   * separate method keeps zero risk of regressing the already-tested
   * regular-run calculation path above.
   *
   * Tax: the one-off earning IS taxable income this period (added to the
   * employee's real year-to-date figure the same cumulative method
   * `calculateOnePayslip()` uses), but is NEVER projected into the
   * recurring year-end estimate (`recurringTaxableThisPeriod` is always
   * 0 here — nothing about a bonus recurs) and uses the NORMAL elapsed-
   * fraction true-up, not the full year-end true-up `final_settlement`
   * forces (an employee who got a bonus is still employed and will keep
   * accruing — there is no reason yet to finalize their whole year's tax).
   */
  private async calculateOffCyclePayslip(
    client: PoolClient,
    employee: EmployeeRow,
    payrollRunId: string,
    periodStart: string,
    periodEnd: string,
    taxSlabs: TaxSlabView[],
    formulas: ResolvedPayrollFormulas
  ): Promise<Record<string, unknown>> {
    const breakdown: PayrollCalculationStep[] = [];
    breakdown.push({ label: "Off-cycle period", value: `${periodStart} to ${periodEnd}` });

    const { offCyclePayments } = this.requireCalculationCollaborators();
    const pending = await offCyclePayments.listPendingForRunWithinTransaction(client, payrollRunId, employee.id);
    if (pending.length === 0) {
      throw new Error("No off-cycle payments are recorded against this run for this employee");
    }
    let earningsTaxable = 0;
    let earningsNonTaxable = 0;
    let deductionTotal = 0;
    const consumedOffCyclePayments: Array<{ offCyclePaymentId: string; amount: number }> = [];
    for (const payment of pending) {
      if (payment.paymentType === "earning") {
        if (payment.isTaxable) earningsTaxable += payment.amount;
        else earningsNonTaxable += payment.amount;
        breakdown.push({
          label: `${payment.label}${payment.isTaxable ? "" : " (non-taxable)"}`,
          value: Number(payment.amount.toFixed(2)),
        });
      } else {
        deductionTotal += payment.amount;
        breakdown.push({ label: `${payment.label} (deduction)`, value: -Number(payment.amount.toFixed(2)) });
      }
      consumedOffCyclePayments.push({ offCyclePaymentId: payment.id, amount: Number(payment.amount.toFixed(2)) });
    }
    const grossPay = earningsTaxable + earningsNonTaxable;
    const taxableGrossThisPeriod = earningsTaxable;
    breakdown.push({ label: "Gross pay", value: Number(grossPay.toFixed(2)) });

    // --- Year-to-date cumulative tax withholding, same method as
    // `calculateOnePayslip()` (Phase P1) — but `recurringTaxableThisPeriod`
    // is always 0: nothing paid by a bonus/arrears run recurs, so none
    // of it is ever projected into the year-end estimate, and the
    // normal elapsed-fraction true-up applies (never the full-year
    // true-up `final_settlement` forces — this employee is still
    // employed and will keep accruing through the rest of the tax year).
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
      label: `Tax year ${taxYear} (${taxYearStart} to ${taxYearEnd}) — YTD taxable income before this payment (finalized runs only)`,
      value: Number(priorYtdTaxable.toFixed(2)),
    });
    const totalDaysInTaxYear = inclusiveDayCount(taxYearStart, taxYearEnd);
    const daysElapsedInclusive = Math.min(totalDaysInTaxYear, inclusiveDayCount(taxYearStart, periodEnd));
    const estimatedAnnualTaxableIncome = priorYtdTaxable + taxableGrossThisPeriod;
    breakdown.push({
      label: "Estimated full tax-year taxable income (YTD + this off-cycle payment — nothing projected, it's one-off)",
      value: Number(estimatedAnnualTaxableIncome.toFixed(2)),
    });
    const totalAnnualTaxEstimate = taxFromSlabs(estimatedAnnualTaxableIncome, taxSlabs);
    const fractionElapsed = totalDaysInTaxYear > 0 ? daysElapsedInclusive / totalDaysInTaxYear : 1;
    const totalTaxDueToDate = totalAnnualTaxEstimate * fractionElapsed;
    breakdown.push({
      label: `Tax due to date (${daysElapsedInclusive}/${totalDaysInTaxYear} days elapsed this tax year)`,
      value: Number(totalTaxDueToDate.toFixed(2)),
    });
    breakdown.push({ label: "Already withheld this tax year (finalized runs only)", value: Number(priorYtdTaxWithheld.toFixed(2)) });

    const builtInIncomeTaxMonthly = Math.max(0, totalTaxDueToDate - priorYtdTaxWithheld);
    const incomeTaxOverride = formulas.evaluate("income_tax", {
      defaultAmount: builtInIncomeTaxMonthly,
      grossPay,
      taxableGrossThisPeriod,
      recurringTaxableThisPeriod: 0,
      overtimePay: 0,
      taxableAnnualIncome: estimatedAnnualTaxableIncome,
      priorYtdTaxableIncome: priorYtdTaxable,
      priorYtdTaxWithheld,
      slabAnnualTax: totalAnnualTaxEstimate,
      taxDueToDate: totalTaxDueToDate,
      bracketMinAnnualIncome:
        taxSlabs.find(
          (s) => estimatedAnnualTaxableIncome >= s.minAnnualIncome && (s.maxAnnualIncome === null || estimatedAnnualTaxableIncome <= s.maxAnnualIncome)
        )?.minAnnualIncome ?? taxSlabs[taxSlabs.length - 1].minAnnualIncome,
      bracketBaseTax: 0,
      bracketRatePercent: 0,
      daysInPeriod: inclusiveDayCount(periodStart, periodEnd),
      taxYearDaysElapsed: daysElapsedInclusive,
      taxYearTotalDays: totalDaysInTaxYear,
      taxYearFractionElapsed: fractionElapsed,
    });
    const incomeTaxMonthly = incomeTaxOverride === null ? builtInIncomeTaxMonthly : incomeTaxOverride.value;
    breakdown.push(
      incomeTaxOverride === null
        ? { label: "Income tax on this off-cycle payment", value: Number(incomeTaxMonthly.toFixed(2)) }
        : {
            label: `Income tax on this off-cycle payment — tenant formula override effective ${incomeTaxOverride.effectiveFrom} (built-in calculation: ${builtInIncomeTaxMonthly.toFixed(2)})`,
            value: Number(incomeTaxMonthly.toFixed(2)),
          }
    );

    // No EOBI/employer-social-security and no loan deduction — see this
    // method's own class doc comment for why both are deliberately
    // skipped on a bonus/arrears off-cycle run.
    breakdown.push({ label: "EOBI / social security — not applicable to a bonus/arrears off-cycle payment (already collected by the regular run this month)", value: 0 });

    const netPay = grossPay - incomeTaxMonthly - deductionTotal;
    breakdown.push({ label: "Net pay (gross - income tax - deductions)", value: Number(netPay.toFixed(2)) });

    return {
      employeeId: employee.id,
      employeeNumber: employee.employee_number,
      bankAccountNumber: employee.bank_account_number,
      daysInPeriod: inclusiveDayCount(periodStart, periodEnd),
      paidDays: 0,
      unpaidLeaveDays: 0,
      grossPay: Number(grossPay.toFixed(2)),
      taxableGrossThisPeriod: Number(taxableGrossThisPeriod.toFixed(2)),
      taxableAnnualIncome: Number(estimatedAnnualTaxableIncome.toFixed(2)),
      incomeTaxMonthly: Number(incomeTaxMonthly.toFixed(2)),
      eobiEmployeeContribution: 0,
      eobiEmployerContribution: 0,
      socialSecurityEmployerContribution: 0,
      netPay: Number(netPay.toFixed(2)),
      calculationBreakdown: breakdown,
      loanDeductions: [],
      consumedAdditionalPayments: [],
      consumedOffCyclePayments,
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

  /**
   * Integration gap audit item 5/10 — work-schedule-aware proration.
   *
   * An employee with an EXPLICIT work schedule assignment covering any
   * day of the period — an individual or temporary `shift_assignments`
   * row, or a matching `work_schedule_assignment_rules` rule — is prorated
   * over their scheduled WORKING days (the resolved weekly pattern, minus
   * mandatory holidays: exactly `WorkScheduleResolutionService.
   * isWorkingDay()`'s own predicate, the same one Leave's day count uses)
   * instead of calendar days. A Mon/Wed/Fri part-timer joining mid-month
   * is then paid for the share of their OWN scheduled days they were
   * employed for, not a share of calendar days that treats their rest
   * days as days they would have been paid to work.
   *
   * Everyone else — no assignment at all, or only the company's
   * `is_default` fallback shift — keeps the exact pre-existing flat
   * calendar-day proration, so no existing payslip changes unless the
   * employee actually has a schedule assigned to them. A full-period
   * employee with no unpaid leave is paid the identical full amount under
   * either basis (numerator == denominator); only partial periods and
   * unpaid leave differ.
   *
   * Every per-day decision goes through WorkScheduleResolutionService
   * (Section 20/35 of the Work Schedule architecture: "no module may
   * independently decide what a working day is"). The two cheap queries
   * up front are a PERFORMANCE short-circuit only, deciding whether the
   * per-day walk (≈6 queries per day inside resolve()) is worth doing at
   * all — they make no scheduling decision themselves: if the company has
   * no active assignment rules and this employee has no direct assignment
   * row overlapping the period, resolve() could only ever answer
   * "default"/"no schedule" for every day, so calendar proration applies
   * without walking. Without this, a 500-employee run would issue ~90k
   * resolution queries for tenants that never configured Work Schedule.
   *
   * Falls back to calendar days (with a breakdown note) if the assigned
   * schedule marks every day of the period as non-working — a zero
   * denominator would otherwise make proration undefined.
   */
  private async resolveProrationBasis(
    client: PoolClient,
    employeeId: string,
    periodStart: string,
    periodEnd: string,
    companyHasScheduleRules: boolean
  ): Promise<ProrationBasis> {
    if (!companyHasScheduleRules) {
      const direct = await client.query(
        `SELECT 1 FROM shift_assignments
         WHERE employee_id = $1 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $2)
         LIMIT 1`,
        [employeeId, periodStart, periodEnd]
      );
      if ((direct.rowCount ?? 0) === 0) return { mode: "calendar" };
    }

    const { workSchedule } = this.requireCalculationCollaborators();
    const workingDates: string[] = [];
    const scheduleNames = new Set<string>();
    let anyExplicit = false;
    for (let day = periodStart; day <= periodEnd; day = addOneDayIso(day)) {
      const resolved = await workSchedule.resolve(client, employeeId, day);
      if (resolved.hasSchedule && resolved.assignmentSource !== null && resolved.assignmentSource !== "default") {
        anyExplicit = true;
        if (resolved.scheduleName) scheduleNames.add(resolved.scheduleName);
      }
      if (resolved.isWorking && !resolved.isMandatoryHoliday) workingDates.push(day);
    }
    if (!anyExplicit) return { mode: "calendar" };
    if (workingDates.length === 0) {
      return { mode: "calendar", note: "assigned work schedule has no working days in this period" };
    }
    return { mode: "working_days", workingDates, scheduleNames: [...scheduleNames] };
  }

  /** See resolveProrationBasis(): whether ANY active rule-based schedule
   * assignment exists for the company — if so, any employee might match
   * one, so the cheap per-employee short-circuit can't be used. */
  private async companyHasActiveScheduleAssignmentRules(client: PoolClient, companyId: string): Promise<boolean> {
    const result = await client.query("SELECT 1 FROM work_schedule_assignment_rules WHERE company_id = $1 AND is_active LIMIT 1", [
      companyId,
    ]);
    return (result.rowCount ?? 0) > 0;
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

  /** The review numbers behind `PayrollRunView.payslipCount`/`totalGrossPay`/
   * `totalNetPay` — always computed fresh from `payslips`, never cached on
   * `payroll_runs` itself. Called after every mutation that leaves a run's
   * payslips unchanged (finalize/submit/decide); `calculateRun()` instead
   * sums its own freshly-inserted `payslipRows` in memory rather than
   * re-querying what it just wrote, and `listRuns()` batches this same
   * aggregate across every run in one query instead of N+1'ing it. */
  private async loadRunSummary(client: PoolClient, id: string): Promise<RunSummary> {
    const result = await client.query(
      `SELECT COUNT(*)::int AS payslip_count,
              COALESCE(SUM(gross_pay), 0) AS total_gross_pay,
              COALESCE(SUM(net_pay), 0) AS total_net_pay
       FROM payslips WHERE payroll_run_id = $1`,
      [id]
    );
    const row = result.rows[0];
    return {
      payslipCount: Number(row.payslip_count),
      totalGrossPay: Number(row.total_gross_pay),
      totalNetPay: Number(row.total_net_pay),
    };
  }

  /** The injected PayrollFormulaService, or the identical stateless
   * fallback for hand-constructed fixtures — see FALLBACK_FORMULA_SERVICE. */
  private formulaService(): PayrollFormulaService {
    return this.formulas ?? FALLBACK_FORMULA_SERVICE;
  }

  /** See the constructor's own comment: these are optional-typed only so
   * hand-constructed fixtures elsewhere keep compiling — a calculation
   * must never run without them (that would silently drop unpaid-leave
   * deductions/overtime pay/loan repayments/additional payments), so this
   * fails loudly instead. Phase P3 (2026-10-02) added `loans`/
   * `additionalPayments` to this same required set. */
  private requireCalculationCollaborators(): {
    leaveRequests: LeaveRequestsService;
    overtime: OvertimeService;
    workSchedule: WorkScheduleResolutionService;
    loans: EmployeeLoansService;
    additionalPayments: EmployeeAdditionalPaymentsService;
    offCyclePayments: EmployeeOffCyclePaymentsService;
  } {
    if (!this.leaveRequests || !this.overtime || !this.workSchedule || !this.loans || !this.additionalPayments || !this.offCyclePayments) {
      throw new Error(
        "PayrollService was constructed without LeaveRequestsService/OvertimeService/WorkScheduleResolutionService/EmployeeLoansService/EmployeeAdditionalPaymentsService/EmployeeOffCyclePaymentsService — payroll calculation requires all six"
      );
    }
    return {
      leaveRequests: this.leaveRequests,
      overtime: this.overtime,
      workSchedule: this.workSchedule,
      loans: this.loans,
      additionalPayments: this.additionalPayments,
      offCyclePayments: this.offCyclePayments,
    };
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
  }

  /* Data Scope (integration gap audit item 3/7). Originally left as flat
   * `.all` checks because `payroll_runs` had no sub-company dimension to
   * narrow by. Payroll Areas (0101_payroll_areas.sql) are that dimension:
   * a run may now carry a `payroll_area_id`, and calculate/submit/
   * finalize/disburse accept `<base>.scoped` as an alternative to
   * `<base>.all` — restricted to runs whose area resolves (through its
   * `payroll_area_scope_links`) inside the caller's own
   * data_scope_assignments (payroll-area-access.ts). The run stays the
   * atomic unit (calculate replaces all its payslips, finalize locks it,
   * one bank file per run), so narrowing happens per RUN, not per payslip.
   * Company-wide runs (`payroll_area_id IS NULL`, every pre-existing run)
   * remain `.all`-only. Settings/tax slabs (`requirePayrollCalculate()`),
   * approval and reversal deliberately stay `.all`-only — see
   * 0102_payroll_area_permissions_seed.sql's header comment. */

  /** Phase P2 permission split — the preparer's own COMPANY-WIDE work:
   * settings and tax slabs. `.all` only; run-level actions go through
   * `requireRunAction()` instead. */
  private async requirePayrollCalculate(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, CALCULATE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to calculate payroll");
    }
  }

  /** Run-level gate for calculate (create/calculate/submit), finalize
   * (locks a run's payslips) and disburse (the bank file — the point money
   * moves). Resolves the caller's access ONCE per request — unrestricted
   * for `<base>.all`, an explicit payroll-area id set for `<base>.scoped`
   * — and 403s if they hold neither. The per-run half is
   * `assertRunInScope()`, called once the run is loaded. */
  private async requireRunAction(claims: RequestClaims, permissionBase: string, forbiddenMessage: string): Promise<PayrollAreaAccess> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [permissionBase]);
    if (!access) throw new ForbiddenException(forbiddenMessage);
    return access;
  }

  private assertRunInScope(access: PayrollAreaAccess, run: { payroll_area_id?: string | null }): void {
    if (!isPayrollAreaInScope(access, run.payroll_area_id)) {
      throw new ForbiddenException(
        run.payroll_area_id
          ? "This payroll run's payroll area is outside your data scope"
          : "Only a caller with the .all permission can act on a company-wide payroll run"
      );
    }
  }

  private async requirePayrollApprove(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, APPROVE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to approve payroll runs");
    }
  }

  /**
   * Correction/Reversal (Phase P2, master engineering instruction Section
   * 36): reversing a `finalized` run — one that may already have real
   * money disbursed off of it — needs "elevated authorization", stricter
   * than any single lifecycle step. Rather than inventing a fifth
   * granular permission the fixed role catalog has no extra role to grant
   * on its own, reversal requires BOTH of the two most sensitive tiers
   * this same split created: `payroll.finalize.all` (the permission that
   * moved the run to `finalized` in the first place) AND
   * `payroll.disburse.all` (the permission that can generate the actual
   * bank file off of it). A caller holding only `payroll.calculate.all` —
   * able to prepare and submit a run, nothing more — cannot reverse one,
   * which is the elevation this requirement is asking for.
   */
  private async requirePayrollReverse(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    const [canFinalize, canDisburse] = await Promise.all([
      this.rbac.can(claims, FINALIZE_PERMISSION),
      this.rbac.can(claims, DISBURSE_PERMISSION),
    ]);
    if (!canFinalize || !canDisburse) {
      throw new ForbiddenException("Not permitted to reverse a finalized payroll run");
    }
  }

  /** Any one of the four payroll-staff permissions — used both to gate
   * the runs list/detail (`requireViewRuns`) and to decide, in
   * `listPayslips()`/`getPayslip()`, whether a caller sees every payslip
   * rather than only their own finalized one. */
  private async hasAnyPayrollStaffPermission(claims: RequestClaims): Promise<boolean> {
    const [canCalculate, canFinalize, canDisburse, canApprove] = await Promise.all([
      this.rbac.can(claims, CALCULATE_PERMISSION),
      this.rbac.can(claims, FINALIZE_PERMISSION),
      this.rbac.can(claims, DISBURSE_PERMISSION),
      this.rbac.can(claims, APPROVE_PERMISSION),
    ]);
    return canCalculate || canFinalize || canDisburse || canApprove;
  }

  /** Any `.all` payroll-staff permission sees every run (unchanged);
   * otherwise any `payroll.{calculate,finalize,disburse}.scoped` sees only
   * the runs of in-scope payroll areas. */
  private async requireViewRuns(claims: RequestClaims): Promise<PayrollAreaAccess> {
    await this.requireModule(claims);
    if (await this.hasAnyPayrollStaffPermission(claims)) return { unrestricted: true };
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, RUN_SCOPED_VIEW_BASES);
    if (!access) throw new ForbiddenException("Not permitted to view payroll runs");
    return access;
  }
}
