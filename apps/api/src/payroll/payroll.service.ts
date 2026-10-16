import { publishEmployeesCalculated, publishPaymentStatusChanged } from "./payroll-events";
import { payslipsHiddenFromSelf } from "./payroll-payslip-publication";
import { sensitive } from "../crypto/sensitive-fields";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { currentCorrelationId } from "../common/request-context";
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
import { rowToRunView, ZERO_RUN_SUMMARY, type RunSummary } from "./payroll-run-view";
import { selectEmployeesByIds, selectRunPopulation } from "./payroll-population";
import { resolvePeriodForRun } from "./payroll-periods.service";
import { ComponentLedger, type ComponentLine, type PayslipInputSnapshot } from "./payroll-components";
import { markRetroPaid } from "./payroll-retro-support";
import { computeAnnualTax, loadEmployeeTaxContext, taxProfileTrace } from "./payroll-tax-profile";
import { payrollRunHooks } from "./payroll-run-hooks";
import { loadConsumptionLinks, persistPayslipDetail, refreshYtd, settlePayslips, voidPayslips, type EngineDetail, type InsertedPayslip } from "./payroll-payslip-detail";
import { PayrollRunControlService, POST_FINAL_STATUS_LIST, PAYROLL_ENGINE_VERSION, REVERSIBLE_STATUSES } from "./payroll-run-control.service";
import { PayrollFormulaService, type ResolvedPayrollFormulas } from "./payroll-formula.service";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";
import { renderBankFile, rowToBankFormat, rowToPaymentBatch } from "./payroll-payments-support";
import { resolveStatutoryJurisdiction } from "./payroll-jurisdiction";
import { writeCompanyWorkTimeDefault } from "../leave/work-time-defaults";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../employees/employee-offcycle-payments.service";
import type {
  CalculatePayrollRunResponse,
  CreatePayrollRunRequest,
  DecideLeaveRequestRequest,
  DisbursementFieldKey,
  GenerateDisbursementFileResponse,
  OffCycleReason,
  PayrollCalculationError,
  PayrollCalculationStep,
  PayrollCostCenterBreakdownView,
  PayrollDisbursementSettingsView,
  PayrollPaymentBatchView,
  PayrollRunType,
  PayrollRunView,
  RetryPayrollExceptionResponse,
  StartPayrollCalculationResponse,
  PayrollSettingsView,
  PayslipView,
  PayslipDetailView,
  PayslipConsumptionView,
  PayrollYtdView,
  ReversePayrollRunRequest,
  SetTaxSlabsRequest,
  TaxSlabSetView,
  TaxSlabView,
  UpdatePayrollDisbursementSettingsRequest,
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

// Payroll Enterprise Gap Analysis Phase P5 (0114_payroll_disbursement_
// settings_and_payment_batches.sql) — every column `generateDisbursementFile()`
// can emit, and the backward-compatible default (unchanged from before this
// phase). See `DisbursementFieldKey`'s own doc comment in shared-types for why
// this is a tenant-configurable column set rather than one hardcoded bank's
// real file spec.
const DISBURSEMENT_FIELD_KEYS: DisbursementFieldKey[] = [
  "employeeNumber",
  "employeeName",
  "cnic",
  "paymentMethod",
  "bankName",
  "accountTitle",
  "accountNumber",
  "iban",
  "branchCode",
  "bankAccountNumber",
  "netPay",
];

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

/** background_jobs.job_type of an asynchronous payroll calculation (PAY-06). */
export const PAYROLL_CALCULATION_JOB = "payroll_calculation";
/** Above this many employees a run must be calculated in the background rather than inside one request. */
const SYNC_CALCULATION_MAX_EMPLOYEES = Number(process.env.PAYROLL_SYNC_MAX_EMPLOYEES ?? 2000);
/** Component types whose "taxable" flag is meaningless: they are never taxable pay. */
const NEVER_TAXABLE_COMPONENT_TYPES = new Set(["deduction", "employer_contribution", "reimbursement", "non_cash_benefit"]);
const DUPLICATE_PAYMENT_MESSAGE = "Already has a payslip in another active payroll run for this exact period (moved between payroll areas?)";
function partitionSize(): number {
  const n = Number(process.env.PAYROLL_PARTITION_SIZE ?? 250);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 250;
}

type CalculationFailure = { employeeId: string; exceptionClass: "calculation" | "duplicate_payment"; message: string };

type CalculationContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: Record<string, any>;
  runType: PayrollRunType;
  offCycleReason: OffCycleReason | null;
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
  settings: PayrollSettingsView;
  taxSlabs: TaxSlabView[];
  formulas: ResolvedPayrollFormulas;
  companyHasScheduleRules: boolean;
  employees: EmployeeRow[];
  alreadyPaidIds: Set<string>;
};

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
function rowToDisbursementSettings(row: any): PayrollDisbursementSettingsView {
  return {
    companyId: row.company_id,
    columns: row.columns as DisbursementFieldKey[],
    requireReleaseApproval: !!row.require_release_approval,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRun(row: any, summary: RunSummary = ZERO_RUN_SUMMARY): PayrollRunView {
  return rowToRunView(row, summary);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPayslip(row: any): PayslipView {
  return {
    id: row.id,
    companyId: row.company_id,
    payrollRunId: row.payroll_run_id,
    // UI Re-skin Phase 4 — Part 2 category 5 ("Payslip / Payroll Self-
    // Service") needs a pay period/date on each payslip; both call sites
    // of this function (`listPayslips`/`getPayslip`) already JOIN
    // `payroll_runs` for `run_status`/`run_payroll_area_id`, so this is
    // two extra, non-sensitive columns off a join that was already
    // there — not a new permission or a new query.
    payrollRunPeriodStart: row.run_period_start,
    payrollRunPeriodEnd: row.run_period_end,
    payrollRunType: row.run_type ?? "regular",
    payrollRunFinalizedAt: row.run_finalized_at ? new Date(row.run_finalized_at).toISOString() : null,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    // SEC-02: the payslip snapshot is stored encrypted (legacy plaintext passes through).
    bankAccountNumber: sensitive.decrypt(row.company_id, row.bank_account_number),
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
    consumedOvertime: row.consumed_overtime ?? [],
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
    private readonly offCyclePayments?: EmployeeOffCyclePaymentsService,
    // Gap Register Step 9A (PAY-01/02/19/23) - state machine, events, overrides.
    // Optional for the same hand-constructed-fixture reason as the rest; `control()`
    // falls back to an identical instance built from the same collaborators.
    private readonly runControl?: PayrollRunControlService,
    // PAY-06 - background calculation. Optional for the same hand-constructed-fixture reason as the rest.
    private readonly jobs?: BackgroundJobsService
  ) {
    this.workflow?.adapters?.register({
      objectKey: WORKFLOW_OBJECT_KEY,
      label: "Payroll run",
      legacyDecide: (c, id, dto) => this.decideApproval(c, id, dto),
    });
  }

  private fallbackControl?: PayrollRunControlService;
  /** The run state machine / event log / overrides (PAY-01, PAY-19, PAY-23). */
  control(): PayrollRunControlService {
    if (this.runControl) return this.runControl;
    this.fallbackControl ??= new PayrollRunControlService(this.db, this.rbac, this.entitlements, this.audit);
    return this.fallbackControl;
  }

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
      // PAY-24: the standard hours belong with working time; the old field stays in step so nothing reading it breaks.
      if (patch.standardMonthlyHours !== undefined) {
        await writeCompanyWorkTimeDefault(client, this.effectiveDating, claims.company_id!, { standardMonthlyHours: patch.standardMonthlyHours });
      }
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
    const payrollPeriodId = input.payrollPeriodId ?? null;
    if (!payrollPeriodId && (!input.periodStart || !input.periodEnd)) {
      throw new BadRequestException("periodStart and periodEnd are required unless the run is created for a payroll period");
    }
    if (input.periodStart && input.periodEnd && new Date(input.periodEnd) < new Date(input.periodStart)) {
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
    // PAY-02: a simulation is a throw-away calculation - it never blocks a period, never reaches approval.
    const isSimulation = input.isSimulation === true;
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > 200) throw new BadRequestException("idempotencyKey is too long (200 characters at most)");
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
      // PAY-03 - a run created for a payroll period takes the period's dates; a tenant policy can make that mandatory.
      if (!payrollPeriodId && runType === "regular" && !isSimulation && (await this.control().policy(client, claims.company_id!)).requirePeriodForRun) {
        throw new BadRequestException("This company requires a regular payroll run to be created for a payroll period (payrollPeriodId)");
      }
      if (payrollPeriodId) {
        const period = await resolvePeriodForRun(client, claims.company_id!, payrollPeriodId, {
          runType: runType === "regular" ? "regular" : "off_cycle",
          payrollAreaId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        });
        input = { ...input, periodStart: period.periodStart, periodEnd: period.periodEnd };
      }
      const periodStartIso = input.periodStart!;
      const periodEndIso = input.periodEnd!;
      const fingerprint = {
        periodStart: periodStartIso,
        periodEnd: periodEndIso,
        payrollAreaId,
        runType,
        offCycleReason,
        targetEmployeeId,
        isSimulation,
        payrollPeriodId,
      };
      if (idempotencyKey) {
        const prior = await client.query("SELECT * FROM payroll_runs WHERE company_id = $1 AND idempotency_key = $2", [claims.company_id, idempotencyKey]);
        if (prior.rowCount) return this.replayIdempotentRun(client, prior.rows[0], fingerprint);
      }
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
          if (targetTerminationDate < periodStartIso || targetTerminationDate > periodEndIso) {
            throw new BadRequestException(
              `This run's period must cover the employee's termination date (${targetTerminationDate})`
            );
          }
          // One non-reversed final_settlement run per employee, ever —
          // also enforced by `payroll_runs_one_final_settlement_per_employee`
          // (0113), this pre-check just turns that constraint violation
          // into a clean 400.
          if (!isSimulation) {
            const existingSettlement = await client.query(
              "SELECT 1 FROM payroll_runs WHERE target_employee_id = $1 AND off_cycle_reason = 'final_settlement' AND status NOT IN ('reversed', 'cancelled') AND is_simulation = false",
              [targetEmployeeId]
            );
            if (existingSettlement.rowCount! > 0) {
              throw new BadRequestException("A final settlement run already exists for this employee");
            }
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
      // (see this method's own comment above). PAY-02: cancelled runs and
      // simulations never count either (0142 widened the index the same way).
      if (runType === "regular") {
        if (payrollAreaId) {
          const area = await client.query("SELECT is_active FROM payroll_areas WHERE id = $1", [payrollAreaId]);
          if (area.rowCount === 0) throw new NotFoundException("Payroll area not found");
          if (!area.rows[0].is_active) throw new BadRequestException("Cannot create a payroll run for an inactive payroll area");
        }
      }
      if (runType === "regular" && !isSimulation) {
        const existing = await client.query<{ payroll_area_id: string | null }>(
          "SELECT payroll_area_id FROM payroll_runs WHERE company_id = $1 AND period_start = $2 AND period_end = $3 AND status NOT IN ('reversed', 'cancelled') AND run_type = 'regular' AND is_simulation = false",
          [claims.company_id, periodStartIso, periodEndIso]
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
        // LIVE-12: two regular runs for the same people may not cover overlapping (not just identical) periods.
        const overlapping = await client.query<{ period_start: unknown; period_end: unknown }>(
          `SELECT period_start, period_end FROM payroll_runs
            WHERE company_id = $1 AND period_start <= $3 AND period_end >= $2
              AND status NOT IN ('reversed', 'cancelled') AND run_type = 'regular' AND is_simulation = false
              AND (payroll_area_id IS NOT DISTINCT FROM $4 OR payroll_area_id IS NULL OR $4::uuid IS NULL)
            LIMIT 1`,
          [claims.company_id, periodStartIso, periodEndIso, payrollAreaId]
        );
        if ((overlapping.rowCount ?? 0) > 0) {
          throw new BadRequestException(
            `This period overlaps an existing regular payroll run (${toIsoDateOrNull(overlapping.rows[0].period_start)} to ${toIsoDateOrNull(overlapping.rows[0].period_end)}); the same employees would be paid twice. Cancel or reverse that run first, or choose a period that does not overlap it.`
          );
        }
      }
      const currency = await client.query<{ currency: string | null }>("SELECT currency FROM companies WHERE id = $1", [claims.company_id]);
      let result;
      try {
        result = await client.query(
          `INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, payroll_area_id, run_type, off_cycle_reason, target_employee_id,
                                     is_simulation, idempotency_key, currency_code, correlation_id, payroll_period_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
          [
            claims.company_id,
            periodStartIso,
            periodEndIso,
            claims.sub,
            payrollAreaId,
            runType,
            offCycleReason,
            targetEmployeeId,
            isSimulation,
            idempotencyKey,
            currency.rows[0]?.currency ?? "PKR",
            currentCorrelationId(),
            payrollPeriodId,
          ]
        );
      } catch (err) {
        // A concurrent request with the same idempotency key won the race: hand back its run.
        if (idempotencyKey && (err as { code?: string }).code === "23505") {
          const prior = await client.query("SELECT * FROM payroll_runs WHERE company_id = $1 AND idempotency_key = $2", [claims.company_id, idempotencyKey]);
          if (prior.rowCount) return this.replayIdempotentRun(client, prior.rows[0], fingerprint);
        }
        throw err;
      }
      await this.control().recordCreated(client, claims, result.rows[0], { ...fingerprint, idempotencyKey: idempotencyKey ?? undefined });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.create",
        target: result.rows[0].id,
        metadata: {
          payrollAreaId: payrollAreaId ?? undefined,
          runType,
          offCycleReason: offCycleReason ?? undefined,
          targetEmployeeId: targetEmployeeId ?? undefined,
          isSimulation: isSimulation || undefined,
          idempotencyKey: idempotencyKey ?? undefined,
          payrollPeriodId: payrollPeriodId ?? undefined,
        },
      });
      return rowToRun(result.rows[0]);
    });
  }

  /** Same idempotency key + same request = the run already created; same key + a different request = conflict. */
  private async replayIdempotentRun(
    client: PoolClient,
    existing: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    fingerprint: Record<string, unknown>
  ): Promise<PayrollRunView> {
    const same =
      toIsoDate(existing.period_start) === fingerprint.periodStart &&
      toIsoDate(existing.period_end) === fingerprint.periodEnd &&
      (existing.payroll_area_id ?? null) === fingerprint.payrollAreaId &&
      existing.run_type === fingerprint.runType &&
      (existing.off_cycle_reason ?? null) === fingerprint.offCycleReason &&
      (existing.target_employee_id ?? null) === fingerprint.targetEmployeeId &&
      existing.is_simulation === fingerprint.isSimulation &&
      (existing.payroll_period_id ?? null) === (fingerprint.payrollPeriodId ?? null);
    if (!same) throw new ConflictException("This idempotency key was already used for a different payroll run request");
    return rowToRun(existing, await this.loadRunSummary(client, existing.id));
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
      this.assertRunCalculable(run);
      const approvalInvalidated = run.status === "approved";

      // Compensation is Core Employee master data now (moved 2026-09-27,
      // kumail's own architecture correction — see
      // EmployeeCompensationService's own doc comment) — this service only
      // reads it (the direct SQL join inside calculateOnePayslip() below),
      // never seeds or writes it. A tenant with no compensation catalog
      // yet simply has every employee collect a "No compensation record
      // covers this employee for this period" error below, the same as
      // any other genuinely-missing-data case this loop already handles.
      const ctx = await this.buildCalculationContext(client, claims, run, true);
      if (ctx.employees.length > SYNC_CALCULATION_MAX_EMPLOYEES) {
        throw new BadRequestException(
          `This run covers ${ctx.employees.length} employees; calculate it in the background instead (limit for an immediate calculation is ${SYNC_CALCULATION_MAX_EMPLOYEES}).`
        );
      }

      // PAY-06 - one employee failing never stops the others: each is calculated inside its own savepoint.
      const failures: CalculationFailure[] = [];
      const payslipRows: Array<Record<string, unknown>> = [];
      for (const employee of ctx.employees) {
        if (ctx.alreadyPaidIds.has(employee.id)) {
          failures.push({ employeeId: employee.id, exceptionClass: "duplicate_payment", message: DUPLICATE_PAYMENT_MESSAGE });
          continue;
        }
        const outcome = await this.isolated(client, () => this.calculateEmployeeRow(client, ctx, employee));
        if (outcome.ok) payslipRows.push(outcome.value);
        else failures.push({ employeeId: employee.id, exceptionClass: "calculation", message: outcome.message });
      }
      const errors: PayrollCalculationError[] = failures.map((f) => ({ employeeId: f.employeeId, message: f.message }));

      await client.query("DELETE FROM payslips WHERE payroll_run_id = $1", [id]);
      const insertedPayslips: InsertedPayslip[] = [];
      for (const row of payslipRows) insertedPayslips.push(await this.insertPayslipRow(client, claims, id, row));

      // PAY-02 - freeze the rules this calculation read, then record the (audited) move.
      const snapshot = await this.control().captureRuleSnapshot(client, run, ctx.periodEnd, ctx.settings as unknown as Record<string, unknown>, ctx.taxSlabs as unknown as Array<Record<string, unknown> & { id?: string }>);
      await this.control().transition(client, claims, id, "calculated", {
        action: "calculate",
        metadata: {
          payslipCount: payslipRows.length,
          errorCount: errors.length,
          calculationSequence: snapshot.sequence,
          ruleSnapshotId: snapshot.id,
          approvalInvalidated: approvalInvalidated || undefined,
        },
      });
      await client.query(
        "UPDATE payroll_runs SET rule_snapshot_id = $2, calculation_sequence = $3, calculated_at = now(), warning_count = 0, calculation_mode = 'sync' WHERE id = $1",
        [id, snapshot.id, snapshot.sequence]
      );
      // PAY-05 / PAY-21 - the structured result, input snapshot and typed input links of every payslip just written.
      await persistPayslipDetail(client, run, insertedPayslips, snapshot.sequence);
      // PAY-27 - one event per calculated payslip (only while a subscription listens)
      await publishEmployeesCalculated(client, claims, { id, company_id: run.company_id, calculation_sequence: snapshot.sequence });
      // PAY-06 - the error queue: earlier open exceptions belonged to the previous calculation.
      await this.control().supersedeOpenExceptions(client, id);
      for (const f of failures) {
        await this.control().recordException(client, run, { employeeId: f.employeeId, sequence: snapshot.sequence, message: f.message, exceptionClass: f.exceptionClass });
      }
      // PAY-04 - who this calculation covered, and why (one set per calculation).
      const outcome = new Map<string, { status: "calculated" | "failed" | "excluded"; reason?: string }>();
      for (const row of payslipRows) outcome.set(row.employeeId as string, { status: "calculated" });
      for (const e of errors) outcome.set(e.employeeId, { status: "failed", reason: e.message });
      await this.control().recordPopulation(client, run, ctx.employees, outcome, snapshot.sequence);
      // PAY-23 - a manual override survives a rerun (and loses its earlier approval).
      await this.control().reapplyOverrides(client, claims, id);
      await this.control().refreshRunTotals(client, id, { population: ctx.employees.length, failed: errors.length });
      const updated = await client.query("SELECT * FROM payroll_runs WHERE id = $1", [id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.calculate",
        target: id,
        metadata: { payslipCount: payslipRows.length, errorCount: errors.length, calculationSequence: snapshot.sequence },
      });

      const summary: RunSummary = await this.loadRunSummary(client, id);
      return { run: rowToRun(updated.rows[0], summary), payslipCount: payslipRows.length, errors };
    });
  }

  // ------------------------------------------------------------------ calculation building blocks (PAY-06)

  /** The statuses a run may be (re)calculated from; one guard shared by the immediate and background paths. */
  private assertRunCalculable(run: { status: string }): void {
    if (POST_FINAL_STATUS_LIST.includes(run.status as never)) {
      throw new BadRequestException("Cannot recalculate a finalized payroll run");
    }
    if (run.status === "pending_approval") {
      throw new BadRequestException("This payroll run is awaiting approval; have it rejected before recalculating it");
    }
    if (run.status === "reversed" || run.status === "cancelled") {
      throw new BadRequestException(`Payroll run is ${run.status} and cannot be calculated`);
    }
    if (run.status === "calculating") {
      throw new BadRequestException("This payroll run is already being calculated in the background");
    }
  }

  /**
   * Everything a calculation reads that is the same for every employee of the run: rules as of the period end,
   * the population (when asked) and the double-pay guards. Phase P1: settings/tax slabs are resolved AS OF the
   * run's own `periodEnd`, not "whatever is current today" — a run recalculated after a later rate change still
   * uses the rates that were actually in force during its own period.
   */
  private async buildCalculationContext(client: PoolClient, claims: RequestClaims, run: Record<string, any>, withPopulation: boolean): Promise<CalculationContext> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const periodStart = toIsoDate(run.period_start);
    const periodEnd = toIsoDate(run.period_end);
    const daysInPeriod = inclusiveDayCount(periodStart, periodEnd);
    const settings = await this.loadSettingsAsOf(client, claims, periodEnd);
    const taxSlabs = await this.loadTaxSlabsAsOf(client, claims, periodEnd);
    // Payroll Formula Engine: tenant overrides in force at periodEnd — the same as-of rule as settings/tax slabs
    // above, resolved once per run. Empty (the default for every tenant) = built-in math only.
    const formulas = await this.formulaService().resolveAsOf(client, claims.company_id!, periodEnd);
    // Once per run, not per employee — see resolveProrationBasis().
    const companyHasScheduleRules = await this.companyHasActiveScheduleAssignmentRules(client, claims.company_id!);

    // Phase P4 — employee selection branches on run_type/target_employee_id:
    //  - A TARGETED run (final_settlement always; bonus/arrears/other optionally) selects exactly that one
    //    employee, regardless of termination status — a final settlement run's whole point is paying someone the
    //    normal active-population filter would exclude.
    //  - Every other case uses the same active-population filter as always.
    const runType = (run.run_type ?? "regular") as PayrollRunType;
    const offCycleReason = (run.off_cycle_reason ?? null) as OffCycleReason | null;
    const targetEmployeeId: string | null = run.target_employee_id ?? null;
    const employees = withPopulation ? await selectRunPopulation(client, run as never) : [];

    // Final Settlement's own double-pay guard: `calculateOnePayslip()` computes this employee's full regular pay
    // for the window — if a REGULAR run already has a non-reversed payslip for this exact employee overlapping
    // this settlement's period, that salary was already paid once; final_settlement would pay it a second time on
    // top of gratuity/leave-encashment/loan-payoff. Reverse that regular run (or correct the settlement's own
    // period so it doesn't overlap) before calculating.
    if (withPopulation && offCycleReason === "final_settlement") {
      const overlapping = await client.query(
        `SELECT 1 FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE p.employee_id = $1 AND pr.company_id = $2 AND pr.run_type = 'regular' AND pr.status NOT IN ('reversed', 'cancelled')
           AND pr.is_simulation = false AND pr.period_start <= $4 AND pr.period_end >= $3`,
        [targetEmployeeId, claims.company_id, periodStart, periodEnd]
      );
      if ((overlapping.rowCount ?? 0) > 0) {
        throw new BadRequestException(
          "This employee already has a regular-run payslip overlapping this settlement's period — reverse that run first, or choose a final settlement period that doesn't overlap it, to avoid paying their final salary twice"
        );
      }
    }

    // Payroll Areas double-pay guard: an employee who moved between areas after one area's run for this exact
    // period was calculated must not be paid again by another area's run. Only other REGULAR runs count; an
    // off-cycle run is explicitly allowed to pay someone who already has a regular-run payslip for the period.
    const alreadyPaid =
      withPopulation && runType === "regular"
        ? await client.query<{ employee_id: string }>(
            `SELECT DISTINCT p.employee_id
             FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
             WHERE pr.company_id = $1 AND pr.id <> $2 AND pr.status NOT IN ('reversed', 'cancelled') AND pr.run_type = 'regular'
               AND pr.is_simulation = false AND pr.period_start = $3 AND pr.period_end = $4`,
            [claims.company_id, run.id, periodStart, periodEnd]
          )
        : { rows: [] as { employee_id: string }[] };

    return {
      run,
      runType,
      offCycleReason,
      periodStart,
      periodEnd,
      daysInPeriod,
      settings,
      taxSlabs,
      formulas,
      companyHasScheduleRules,
      employees,
      alreadyPaidIds: new Set(alreadyPaid.rows.map((r) => r.employee_id)),
    };
  }

  /** One employee's payslip row, by the same dispatch the run has always used. Throws on bad data. */
  private async calculateEmployeeRow(client: PoolClient, ctx: CalculationContext, employee: EmployeeRow): Promise<Record<string, unknown>> {
    if (ctx.runType === "off_cycle" && ctx.offCycleReason !== "final_settlement") {
      // Bonus / arrears / other: a lean, self-contained calculation — no compensation proration, no unpaid
      // leave, no loan deduction. It pays exactly what's queued against THIS run in `employee_offcycle_payments`
      // (IT0267), nothing else. See the method's own doc comment.
      return this.calculateOffCyclePayslip(client, employee, ctx.run.id, ctx.periodStart, ctx.periodEnd, ctx.taxSlabs, ctx.formulas);
    }
    // Regular run, OR a final_settlement off-cycle run: both go through the full, tested engine.
    // `offCycleOptions` is undefined for a regular run and set for final_settlement (forces the tax true-up and
    // full loan payoff, and additionally consumes this run's own IT0267 lines).
    return this.calculateOnePayslip(
      client,
      employee,
      ctx.periodStart,
      ctx.periodEnd,
      ctx.daysInPeriod,
      ctx.settings,
      ctx.taxSlabs,
      ctx.companyHasScheduleRules,
      ctx.formulas,
      ctx.offCycleReason === "final_settlement" ? { isFinalSettlement: true, offCycleRunId: ctx.run.id } : undefined,
      { runId: ctx.run.is_simulation ? undefined : ctx.run.id, currencyCode: ctx.run.currency_code ?? undefined }
    );
  }

  /**
   * PAY-06 - runs `fn` inside a savepoint so a failure (even a failed SQL statement, which would otherwise poison
   * the whole transaction) undoes only that employee's work and reports the message instead of throwing.
   */
  private async isolated<T>(client: PoolClient, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    await client.query("SAVEPOINT payroll_employee");
    try {
      const value = await fn();
      await client.query("RELEASE SAVEPOINT payroll_employee");
      return { ok: true, value };
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT payroll_employee");
      await client.query("RELEASE SAVEPOINT payroll_employee");
      return { ok: false, message: err instanceof Error ? err.message : "Calculation failed" };
    }
  }

  /**
   * PAY-12 - what an employee's pay for an ALREADY PAID run would be if it were calculated today with the rules of
   * that period: the retro detector compares these lines with what was actually paid. Nothing is written - the
   * calculation runs as a simulation (no run id, so it consumes nothing) inside a savepoint that is always undone.
   */
  async recalculateForRetro(client: PoolClient, claims: RequestClaims, sourceRun: Record<string, any>, employeeId: string): Promise<ComponentLine[] | { error: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.requireCalculationCollaborators();
    const ctx = await this.buildCalculationContext(client, claims, { ...sourceRun, is_simulation: true }, false);
    const [employee] = await selectEmployeesByIds(client, sourceRun.company_id, [employeeId]);
    if (!employee) return { error: "Employee not found" };
    await client.query("SAVEPOINT payroll_retro_probe");
    try {
      const row = await this.calculateEmployeeRow(client, ctx, employee);
      return (row.components ?? []) as ComponentLine[];
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Calculation failed" };
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT payroll_retro_probe");
      await client.query("RELEASE SAVEPOINT payroll_retro_probe");
    }
  }

  /** Retro (PAY-12) entry points: the same permission and payroll-area scope as calculating a run. */
  requireCalculateAccess(claims: RequestClaims): Promise<PayrollAreaAccess> {
    return this.requireRunAction(claims, CALCULATE_PERMISSION_BASE, "Not permitted to calculate payroll");
  }

  assertCalculateScope(access: PayrollAreaAccess, run: { payroll_area_id?: string | null }): void {
    this.assertRunInScope(access, run);
  }

  /** Writes one calculated row to `payslips` and returns what persistPayslipDetail() needs for it. */
  private async insertPayslipRow(client: PoolClient, claims: RequestClaims, runId: string, row: Record<string, unknown>): Promise<InsertedPayslip> {
    const insertedRow = await client.query<{ id: string }>(
      `INSERT INTO payslips (
         company_id, payroll_run_id, employee_id, employee_number, bank_account_number,
         days_in_period, paid_days, unpaid_leave_days, gross_pay, taxable_gross_this_period,
         taxable_annual_income, income_tax_monthly, eobi_employee_contribution, eobi_employer_contribution,
         social_security_employer_contribution, net_pay, calculation_breakdown,
         loan_deductions, consumed_additional_payments, consumed_offcycle_payments, consumed_overtime, employer_cost,
         arrears_amount, retro_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23,$24::jsonb)
       RETURNING id`,
      [
        claims.company_id,
        runId,
        row.employeeId,
        row.employeeNumber,
        sensitive.encrypt(claims.company_id!, row.bankAccountNumber as string | null),
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
        JSON.stringify(row.consumedOvertime ?? []),
        row.employerCost ?? 0,
        row.arrearsAmount ?? 0,
        JSON.stringify(row.retroDetail ?? []),
      ]
    );
    return {
      payslipId: insertedRow.rows[0].id,
      employeeId: row.employeeId as string,
      detail: {
        components: row.components as EngineDetail["components"],
        inputSnapshot: row.inputSnapshot as EngineDetail["inputSnapshot"],
        consumedLeave: (row.consumedLeave ?? []) as EngineDetail["consumedLeave"],
        consumedAdditionalPayments: row.consumedAdditionalPayments as EngineDetail["consumedAdditionalPayments"],
        consumedOffCyclePayments: row.consumedOffCyclePayments as EngineDetail["consumedOffCyclePayments"],
        consumedOvertime: row.consumedOvertime as EngineDetail["consumedOvertime"],
        loanDeductions: row.loanDeductions as EngineDetail["loanDeductions"],
        consumedRetro: (row.consumedRetro ?? []) as EngineDetail["consumedRetro"],
      },
    };
  }

  // ------------------------------------------------------------------ background calculation (PAY-06)

  /**
   * Queues the run's calculation as a background job and returns at once with the run in `calculating`. The
   * population is cut into partitions, each committed on its own, so a large run is resumable and a failing
   * employee lands in the exception queue instead of stopping the run.
   */
  async calculateRunAsync(claims: RequestClaims, id: string): Promise<StartPayrollCalculationResponse> {
    const access = await this.requireRunAction(claims, CALCULATE_PERMISSION_BASE, "Not permitted to calculate payroll");
    this.requireCalculationCollaborators();
    if (!this.jobs) throw new Error("PayrollService was constructed without BackgroundJobsService - background calculation is unavailable");
    const jobs = this.jobs;
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, id);
      this.assertRunInScope(access, run);
      this.assertRunCalculable(run);
      const approvalInvalidated = run.status === "approved";
      if (approvalInvalidated) {
        await this.control().transition(client, claims, id, "calculated", { action: "approval_invalidated", reason: "Recalculation requested" });
      }
      const next = await client.query<{ n: number }>("SELECT COALESCE(max(calculation_sequence), 0)::int + 1 AS n FROM payroll_rule_snapshots WHERE payroll_run_id = $1", [id]);
      const sequence = next.rows[0].n;
      const job = await jobs.enqueue(client, claims, {
        companyId: claims.company_id!,
        jobType: PAYROLL_CALCULATION_JOB,
        payload: {
          runId: id,
          sequence,
          approvalInvalidated,
          claims: { sub: claims.sub, company_id: claims.company_id ?? null, is_platform_admin: claims.is_platform_admin === true },
        },
        idempotencyKey: `payroll-calc:${id}:${sequence}`,
        maxAttempts: 3,
      });
      await this.control().transition(client, claims, id, "calculating", {
        action: "calculate_start",
        metadata: { jobId: job.id, calculationSequence: sequence, mode: "async" },
      });
      const updated = await client.query(
        `UPDATE payroll_runs SET calculation_mode = 'async', calculation_job_id = $2, calculation_started_at = now(), calculation_error = NULL,
                partition_count = 0, partitions_completed = 0 WHERE id = $1 RETURNING *`,
        [id, job.id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.calculate_async",
        target: id,
        metadata: { jobId: job.id, calculationSequence: sequence },
      });
      const summary: RunSummary = await this.loadRunSummary(client, id);
      return { run: rowToRun(updated.rows[0], summary), jobId: job.id };
    });
  }

  /**
   * The body of a `payroll_calculation` job (called by PayrollCalculationWorker). Three phases, each its own
   * transaction: start (snapshot rules, cut partitions), one transaction per partition, finish. Every phase is
   * safe to run again after a crash: the work already committed is detected and skipped.
   */
  async runCalculationJob(
    payload: { runId: string; sequence: number; approvalInvalidated?: boolean; claims: { sub: string; company_id: string | null; is_platform_admin: boolean } },
    report: (percent: number, note: string) => Promise<void>
  ): Promise<{ payslipCount: number; failedCount: number } | null> {
    this.requireCalculationCollaborators();
    const claims: RequestClaims = { sub: payload.claims.sub, company_id: payload.claims.company_id, is_platform_admin: payload.claims.is_platform_admin };
    const runId = payload.runId;

    const started = await this.db.withClaims(claims, (c) => this.startAsyncCalculation(c, claims, runId, payload.sequence));
    if (!started) return null;
    await report(5, "Population cut into partitions");

    const pending = await this.db.withClaims(claims, async (c) => {
      const r = await c.query<{ id: string; partition_no: number }>(
        `SELECT id, partition_no FROM payroll_run_partitions
          WHERE payroll_run_id = $1 AND calculation_sequence = $2 AND state <> 'completed' ORDER BY partition_no`,
        [runId, started.sequence]
      );
      return r.rows;
    });
    let done = started.partitionCount - pending.length;
    for (const part of pending) {
      try {
        await this.db.withClaims(claims, (c) => this.processPartition(c, claims, runId, part.id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.db.withClaims(claims, (c) =>
          c.query("UPDATE payroll_run_partitions SET state = 'failed', last_error = left($2, 2000), updated_at = now() WHERE id = $1", [part.id, message])
        );
        throw err;
      }
      done++;
      await report(5 + (90 * done) / Math.max(started.partitionCount, 1), `Partition ${done} of ${started.partitionCount} calculated`);
    }

    const result = await this.db.withClaims(claims, (c) => this.finishAsyncCalculation(c, claims, runId, payload.approvalInvalidated === true));
    await report(100, "Calculation finished");
    return result;
  }

  private async startAsyncCalculation(
    client: PoolClient,
    claims: RequestClaims,
    runId: string,
    sequence: number
  ): Promise<{ sequence: number; partitionCount: number } | null> {
    const locked = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
    if (locked.rowCount === 0) return null;
    const run = locked.rows[0];
    if (run.status !== "calculating") return null; // a stale job: the run was cancelled or already finished
    const existing = await client.query("SELECT 1 FROM payroll_rule_snapshots WHERE payroll_run_id = $1 AND calculation_sequence = $2", [runId, sequence]);
    if ((existing.rowCount ?? 0) > 0) {
      return { sequence, partitionCount: Number(run.partition_count) }; // resuming after a crash: start already committed
    }
    const ctx = await this.buildCalculationContext(client, claims, run, true);
    const snapshot = await this.control().captureRuleSnapshot(client, run, ctx.periodEnd, ctx.settings as unknown as Record<string, unknown>, ctx.taxSlabs as unknown as Array<Record<string, unknown> & { id?: string }>);
    await client.query("DELETE FROM payslips WHERE payroll_run_id = $1", [runId]);
    await this.control().supersedeOpenExceptions(client, runId);

    const payable: string[] = [];
    let duplicates = 0;
    for (const e of ctx.employees) {
      if (ctx.alreadyPaidIds.has(e.id)) {
        duplicates++;
        await this.control().recordException(client, run, { employeeId: e.id, sequence: snapshot.sequence, message: DUPLICATE_PAYMENT_MESSAGE, exceptionClass: "duplicate_payment" });
      } else {
        payable.push(e.id);
      }
    }
    const size = partitionSize();
    let partitionCount = 0;
    for (let i = 0; i < payable.length; i += size) {
      const ids = payable.slice(i, i + size);
      await client.query(
        `INSERT INTO payroll_run_partitions (company_id, payroll_run_id, calculation_sequence, partition_no, employee_ids, employee_count)
         VALUES ($1, $2, $3, $4, $5::uuid[], $6)`,
        [run.company_id, runId, snapshot.sequence, partitionCount + 1, ids, ids.length]
      );
      partitionCount++;
    }
    await client.query(
      `UPDATE payroll_runs SET rule_snapshot_id = $2, calculation_sequence = $3, partition_count = $4, partitions_completed = 0,
              population_count = $5, failed_count = $6, calculated_count = 0 WHERE id = $1`,
      [runId, snapshot.id, snapshot.sequence, partitionCount, ctx.employees.length, duplicates]
    );
    return { sequence: snapshot.sequence, partitionCount };
  }

  private async processPartition(client: PoolClient, claims: RequestClaims, runId: string, partitionId: string): Promise<void> {
    const runRow = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
    const run = runRow.rows[0];
    if (!run || run.status !== "calculating") return;
    const partRow = await client.query("SELECT * FROM payroll_run_partitions WHERE id = $1 FOR UPDATE", [partitionId]);
    const part = partRow.rows[0];
    if (!part || part.state === "completed") return;
    await client.query("UPDATE payroll_run_partitions SET state = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1", [partitionId]);

    const ctx = await this.buildCalculationContext(client, claims, run, false);
    // The rules read here must be the rules snapshotted when the run started; otherwise stop rather than mix versions.
    await this.control().assertRulesUnchanged(client, run, ctx.periodEnd, ctx.settings as unknown as Record<string, unknown>, ctx.taxSlabs);
    const employees = await selectEmployeesByIds(client, run.company_id, part.employee_ids);
    const sequence = Number(run.calculation_sequence);
    let calculated = 0;
    let failed = 0;
    for (const employee of employees) {
      const outcome = await this.isolated(client, async () => {
        const row = await this.calculateEmployeeRow(client, ctx, employee);
        const inserted = await this.insertPayslipRow(client, claims, runId, row);
        await persistPayslipDetail(client, run, [inserted], sequence);
      });
      if (outcome.ok) {
        calculated++;
      } else {
        failed++;
        await this.control().recordException(client, run, { employeeId: employee.id, sequence, message: outcome.message, partitionId });
      }
    }
    await client.query(
      `UPDATE payroll_run_partitions SET state = 'completed', calculated_count = $2, failed_count = $3, last_error = NULL,
              checkpoint = jsonb_build_object('processed', $4::int), completed_at = now(), updated_at = now() WHERE id = $1`,
      [partitionId, calculated, failed, employees.length]
    );
    await client.query("UPDATE payroll_runs SET partitions_completed = partitions_completed + 1 WHERE id = $1", [runId]);
  }

  private async finishAsyncCalculation(
    client: PoolClient,
    claims: RequestClaims,
    runId: string,
    approvalInvalidated: boolean
  ): Promise<{ payslipCount: number; failedCount: number } | null> {
    const locked = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
    const run = locked.rows[0];
    if (!run || run.status !== "calculating") return null;
    const sequence = Number(run.calculation_sequence);
    const unfinished = await client.query(
      "SELECT count(*)::int AS n FROM payroll_run_partitions WHERE payroll_run_id = $1 AND calculation_sequence = $2 AND state <> 'completed'",
      [runId, sequence]
    );
    if (unfinished.rows[0].n > 0) throw new Error(`${unfinished.rows[0].n} partition(s) of this payroll run are not calculated yet`);

    const ids = await client.query<{ employee_id: string }>(
      `SELECT unnest(employee_ids) AS employee_id FROM payroll_run_partitions WHERE payroll_run_id = $1 AND calculation_sequence = $2
       UNION
       SELECT employee_id FROM payroll_exceptions WHERE payroll_run_id = $1 AND calculation_sequence = $2 AND employee_id IS NOT NULL`,
      [runId, sequence]
    );
    const employees = await selectEmployeesByIds(client, run.company_id, ids.rows.map((r) => r.employee_id));
    const paid = await client.query<{ employee_id: string }>("SELECT employee_id FROM payslips WHERE payroll_run_id = $1", [runId]);
    const open = await client.query<{ employee_id: string; message: string }>(
      "SELECT employee_id, message FROM payroll_exceptions WHERE payroll_run_id = $1 AND calculation_sequence = $2 AND status = 'open' AND employee_id IS NOT NULL",
      [runId, sequence]
    );
    const outcome = new Map<string, { status: "calculated" | "failed" | "excluded"; reason?: string }>();
    for (const p of paid.rows) outcome.set(p.employee_id, { status: "calculated" });
    for (const e of open.rows) outcome.set(e.employee_id, { status: "failed", reason: e.message });

    await this.control().transition(client, claims, runId, "calculated", {
      action: "calculate",
      metadata: {
        payslipCount: paid.rowCount ?? 0,
        errorCount: open.rowCount ?? 0,
        calculationSequence: sequence,
        ruleSnapshotId: run.rule_snapshot_id,
        mode: "async",
        approvalInvalidated: approvalInvalidated || undefined,
      },
    });
    await client.query("UPDATE payroll_runs SET calculated_at = now(), warning_count = 0, calculation_error = NULL WHERE id = $1", [runId]);
    await this.control().recordPopulation(client, run, employees, outcome, sequence);
    await this.control().reapplyOverrides(client, claims, runId);
    await this.control().refreshRunTotals(client, runId, { population: employees.length, failed: open.rowCount ?? 0 });
    await publishEmployeesCalculated(client, claims, { id: runId, company_id: run.company_id, calculation_sequence: sequence });
    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "payroll_run.calculate",
      target: runId,
      metadata: { payslipCount: paid.rowCount ?? 0, errorCount: open.rowCount ?? 0, calculationSequence: sequence, mode: "async" },
    });
    return { payslipCount: paid.rowCount ?? 0, failedCount: open.rowCount ?? 0 };
  }

  /** Called by the worker once a job has used all its attempts: the run goes back to draft with the reason shown. */
  async failCalculationJob(payload: { runId: string; claims: { sub: string; company_id: string | null; is_platform_admin: boolean } }, message: string): Promise<void> {
    const claims: RequestClaims = { sub: payload.claims.sub, company_id: payload.claims.company_id, is_platform_admin: payload.claims.is_platform_admin };
    await this.db.withClaims(claims, async (client) => {
      const locked = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [payload.runId]);
      const run = locked.rows[0];
      if (!run || run.status !== "calculating") return;
      await this.control().transition(client, claims, payload.runId, "draft", { action: "calculate_failed", reason: message.slice(0, 500) });
      await client.query("UPDATE payroll_runs SET calculation_error = left($2, 2000) WHERE id = $1", [payload.runId, message]);
      await this.control().recordException(client, run, {
        employeeId: null,
        sequence: Number(run.calculation_sequence),
        message,
        exceptionClass: /rules .* have changed/i.test(message) ? "rule_change" : "system",
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.calculate_failed",
        target: payload.runId,
        metadata: { message: message.slice(0, 500) },
      });
    });
  }

  /**
   * PAY-06 - retries one employee of a calculated run without recalculating everyone else. Allowed only while the
   * rules in force still hash to the run's snapshot, so a retried payslip can never mix rule versions.
   */
  async retryException(claims: RequestClaims, runId: string, exceptionId: string): Promise<RetryPayrollExceptionResponse> {
    const access = await this.requireRunAction(claims, CALCULATE_PERMISSION_BASE, "Not permitted to calculate payroll");
    this.requireCalculationCollaborators();
    return this.db.withClaims(claims, async (client) => {
      const locked = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
      if (locked.rowCount === 0) throw new NotFoundException("Payroll run not found");
      const run = locked.rows[0];
      this.assertRunInScope(access, run);
      if (!["calculated", "validated"].includes(run.status)) {
        throw new BadRequestException(`An employee can only be retried while the run is calculated or validated (this one is ${run.status})`);
      }
      const ex = await client.query("SELECT * FROM payroll_exceptions WHERE id = $1 AND payroll_run_id = $2 FOR UPDATE", [exceptionId, runId]);
      if (ex.rowCount === 0) throw new NotFoundException("Exception not found");
      const exception = ex.rows[0];
      if (exception.status !== "open") throw new BadRequestException(`This exception is already ${exception.status}`);
      if (!exception.employee_id) throw new BadRequestException("This exception is about the whole run, not one employee; recalculate the run");
      const sequence = Number(run.calculation_sequence);
      if (Number(exception.calculation_sequence) !== sequence) {
        throw new BadRequestException("The run has been recalculated since this exception was raised");
      }

      const ctx = await this.buildCalculationContext(client, claims, run, true);
      await this.control().assertRulesUnchanged(client, run, ctx.periodEnd, ctx.settings as unknown as Record<string, unknown>, ctx.taxSlabs);
      const [employee] = await selectEmployeesByIds(client, run.company_id, [exception.employee_id]);
      let message: string | null = null;
      if (!employee) {
        message = "Employee not found";
      } else if (ctx.alreadyPaidIds.has(employee.id)) {
        message = DUPLICATE_PAYMENT_MESSAGE;
      }
      let resolved = false;
      if (!message) {
        const outcome = await this.isolated(client, async () => {
          await client.query("DELETE FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2", [runId, employee.id]);
          const row = await this.calculateEmployeeRow(client, ctx, employee);
          const inserted = await this.insertPayslipRow(client, claims, runId, row);
          await persistPayslipDetail(client, run, [inserted], sequence);
        });
        if (outcome.ok) resolved = true;
        else message = outcome.message;
      }

      if (resolved) {
        await client.query(
          `UPDATE payroll_exceptions SET status = 'resolved', resolution = 'retried', resolved_by = $2, resolved_at = now(),
                  retry_count = retry_count + 1, last_retry_at = now(), updated_at = now() WHERE id = $1`,
          [exceptionId, claims.sub]
        );
        await client.query(
          `UPDATE payroll_run_population SET status = 'calculated', exclusion_reason = NULL
            WHERE payroll_run_id = $1 AND employee_id = $2 AND calculation_sequence = $3`,
          [runId, exception.employee_id, sequence]
        );
        if (run.status === "validated") {
          await this.control().transition(client, claims, runId, "calculated", { action: "retry_employee", reason: "A payslip was added after validation" });
        }
        await this.control().reapplyOverrides(client, claims, runId);
      } else {
        await client.query(
          `UPDATE payroll_exceptions SET message = left($2, 2000), retry_count = retry_count + 1, last_retry_at = now(), updated_at = now() WHERE id = $1`,
          [exceptionId, message]
        );
      }
      await this.control().refreshRunTotals(client, runId, { failed: await this.control().countOpenExceptions(client, runId, sequence) });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_exception.retry",
        target: exceptionId,
        metadata: { payrollRunId: runId, employeeId: exception.employee_id, resolved, message: resolved ? undefined : message },
      });
      const out = await client.query(
        `SELECT x.*, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS employee_name
           FROM payroll_exceptions x LEFT JOIN employees e ON e.id = x.employee_id WHERE x.id = $1`,
        [exceptionId]
      );
      const view = this.control().exceptionView(out.rows[0]);
      return { resolved, message: resolved ? "Payslip calculated" : (message ?? "Calculation failed"), exception: view };
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
      if (run.is_simulation) {
        throw new BadRequestException("A simulation run cannot be approved or finalized; create a real run for this period");
      }
      if (POST_FINAL_STATUS_LIST.includes(run.status)) {
        throw new BadRequestException("This payroll run is already finalized");
      }
      if (run.status !== "approved") {
        throw new BadRequestException(
          run.status === "pending_approval"
            ? "This payroll run is still awaiting approval"
            : "This payroll run must be calculated, submitted for approval, and approved before it can be finalized"
        );
      }
      // LIVE-12: with the payroll policy switched on, payslips cannot be locked for a period that has not started.
      const periodStartDay = toIsoDateOrNull(run.period_start);
      if (periodStartDay && periodStartDay > new Date().toISOString().slice(0, 10) && (await this.control().policy(client, claims.company_id!)).blockFinalizeBeforePeriodStart) {
        throw new BadRequestException(`This payroll run cannot be finalized yet: its period starts on ${periodStartDay}`);
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
      const { loans, additionalPayments, offCyclePayments, overtime } = this.requireCalculationCollaborators();
      const payslipsToCommit = await client.query(
        "SELECT id, loan_deductions, consumed_additional_payments, consumed_offcycle_payments, consumed_overtime FROM payslips WHERE payroll_run_id = $1",
        [id]
      );
      // PAY-05 - the typed links are the record of what each payslip used; a payslip calculated before they existed
      // (no links at all) still commits from its jsonb arrays.
      const links = await loadConsumptionLinks(client, id);
      for (const payslip of payslipsToCommit.rows) {
        const own = links.get(payslip.id);
        if (own) {
          payslip.loan_deductions = own.loans.map((l) => ({ loanId: l.id, amount: l.amount }));
          payslip.consumed_additional_payments = own.additionalPaymentIds.map((a) => ({ additionalPaymentId: a.id, amount: a.amount }));
          payslip.consumed_offcycle_payments = own.offCyclePaymentIds.map((a) => ({ offCyclePaymentId: a.id, amount: a.amount }));
          payslip.consumed_overtime = own.overtimeIds.map((a) => ({ overtimeId: a.id, amount: a.amount }));
        }
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
        // TLM-07 - an overtime claim is paid by exactly one finalised run
        const consumedOvertime = (payslip.consumed_overtime ?? []) as Array<{ overtimeId: string; amount: number }>;
        for (const entry of consumedOvertime) {
          await overtime.markPaidWithinTransaction(client, entry.overtimeId, id);
        }
      }

      await markRetroPaid(client, id);
      await this.control().refreshRunTotals(client, id);
      await settlePayslips(client, id);
      const finalizedRow = await this.control().transition(client, claims, id, "finalized", {
        action: "finalize",
        set: { finalized_at: new Date() },
        metadata: { payslipCount: payslipsToCommit.rowCount },
      });
      await refreshYtd(client, run, taxYearLabelFor(toIsoDate(run.period_end)));
      await payrollRunHooks.finalized(client, claims, finalizedRow);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.finalize", target: id });
      return rowToRun(finalizedRow, await this.loadRunSummary(client, id));
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
    if (run.is_simulation) {
      throw new BadRequestException("A simulation run cannot be submitted for approval; create a real run for this period");
    }
    if (run.status !== "calculated" && run.status !== "validated") {
      throw new BadRequestException(`Payroll run is ${run.status}, must be freshly calculated before it can be submitted for approval`);
    }
    if (run.status !== "validated") {
      const policy = await this.db.withClaims(claims, (client) => this.control().policy(client, claims.company_id!));
      if (policy.requireValidationBeforeApproval) {
        throw new BadRequestException("Your payroll policy requires the run to pass validation before it is submitted for approval");
      }
    }

    const instance = await this.workflow.submitForApproval(claims, {
      templateKey: WORKFLOW_TEMPLATE_KEY,
      objectKey: WORKFLOW_OBJECT_KEY,
      recordId: id,
      record: { periodStart: toIsoDate(run.period_start), periodEnd: toIsoDate(run.period_end) },
    });

    return this.db.withClaims(claims, async (client) => {
      const submitted = await this.control().transition(client, claims, id, "pending_approval", {
        action: "submit",
        set: { workflow_instance_id: instance.id },
        metadata: { workflowInstanceId: instance.id },
      });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.submit", target: id });
      return rowToRun(submitted, await this.loadRunSummary(client, id));
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
      const decided = await this.control().transition(client, claims, id, newStatus, {
        action: decidedInstance.status === "approved" ? "approve" : decidedInstance.status === "rejected" ? "reject" : "decide_step",
        reason: dto.comment ?? null,
        metadata: { decision: dto.decision },
      });
      if (newStatus === "approved") await this.control().approveOverrides(client, id, claims.sub!);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.decide",
        target: id,
        metadata: { decision: dto.decision },
      });
      return rowToRun(decided, await this.loadRunSummary(client, id));
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
        `SELECT p.*, e.user_account_id AS employee_user_account_id, pr.status AS run_status, pr.payroll_area_id AS run_payroll_area_id, pr.period_start AS run_period_start, pr.period_end AS run_period_end, pr.run_type AS run_type, pr.finalized_at AS run_finalized_at
         FROM payslips p
         JOIN employees e ON e.id = p.employee_id
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE ($1::uuid IS NULL OR p.payroll_run_id = $1)
           AND ($2::uuid IS NULL OR p.employee_id = $2)
         ORDER BY p.created_at DESC, p.employee_number, p.id`,
        [filter.payrollRunId ?? null, filter.employeeId ?? null]
      );
      // Payroll Areas: a `payroll.*.scoped` holder also sees every payslip
      // of in-scope runs (reviewing the numbers they calculate/finalize).
      const scoped = hasAll ? null : await resolvePayrollAreaAccess(this.db, this.rbac, claims, RUN_SCOPED_VIEW_BASES);
      let visible = hasAll
        ? result.rows
        : result.rows.filter(
            (row) =>
              (scoped !== null && isPayrollAreaInScope(scoped, row.run_payroll_area_id)) ||
              (row.employee_user_account_id === claims.sub && POST_FINAL_STATUS_LIST.includes(row.run_status))
          );
      if (!hasAll) {
        // PAY-20 - an employee's own payslip may need publishing first; payroll staff are never affected
        const selfOnly = visible.filter((row) => !(scoped !== null && isPayrollAreaInScope(scoped, row.run_payroll_area_id)));
        const hidden = await payslipsHiddenFromSelf(client, selfOnly.map((row) => row.id));
        if (hidden.size) visible = visible.filter((row) => !hidden.has(row.id));
      }
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
        `SELECT p.*, e.user_account_id AS employee_user_account_id, pr.status AS run_status, pr.payroll_area_id AS run_payroll_area_id, pr.period_start AS run_period_start, pr.period_end AS run_period_end, pr.run_type AS run_type, pr.finalized_at AS run_finalized_at
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
      if (!hasSelf || !POST_FINAL_STATUS_LIST.includes(row.run_status)) {
        throw new NotFoundException("Payslip not found");
      }
      if ((await payslipsHiddenFromSelf(client, [row.id])).size) throw new NotFoundException("Payslip not found");
      return rowToPayslip(row);
    });
  }

  /**
   * PAY-05 - the structured result behind a payslip. Anyone who may see the payslip sees its component lines;
   * the input snapshot and the consumption links are for payroll staff only (they carry organisation and
   * compensation detail an employee's own view does not need).
   */
  async getPayslipDetail(claims: RequestClaims, id: string): Promise<PayslipDetailView> {
    await this.getPayslip(claims, id); // same visibility rules as the payslip itself
    const staff = (await this.hasAnyPayrollStaffPermission(claims)) || !!(await resolvePayrollAreaAccess(this.db, this.rbac, claims, RUN_SCOPED_VIEW_BASES));
    return this.db.withClaims(claims, async (client) => {
      const slip = await client.query("SELECT * FROM payslips WHERE id = $1", [id]);
      const lines = await client.query("SELECT * FROM payroll_component_results WHERE payslip_id = $1 ORDER BY line_no", [id]);
      let consumptions: PayslipConsumptionView[] | null = null;
      let snapshot: Record<string, unknown> | null = null;
      let hash: string | null = null;
      if (staff) {
        const links = await client.query("SELECT * FROM payslip_consumptions WHERE payslip_id = $1 ORDER BY created_at, id", [id]);
        consumptions = links.rows.map((l) => ({
          sourceType: l.source_type,
          sourceId: l.source_id,
          amount: Number(l.amount),
          quantity: l.quantity === null ? null : Number(l.quantity),
          unit: l.unit ?? null,
          status: l.status,
        }));
        const snap = await client.query("SELECT snapshot, content_hash FROM payroll_input_snapshots WHERE payslip_id = $1", [id]);
        snapshot = snap.rows[0]?.snapshot ?? null;
        hash = snap.rows[0]?.content_hash ?? null;
      }
      const row = slip.rows[0];
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return {
        payslipId: row.id,
        payrollRunId: row.payroll_run_id,
        employeeId: row.employee_id,
        status: row.status,
        isImmutable: row.is_immutable,
        calculationSequence: row.calculation_sequence,
        employerCost: Number(row.employer_cost),
        components: lines.rows.map((l) => ({
          lineNo: l.line_no,
          key: l.component_key,
          label: l.label,
          category: l.category,
          affects: l.affects,
          amount: Number(l.amount),
          isTaxable: l.is_taxable,
          quantity: num(l.quantity),
          unit: l.unit ?? null,
          rate: num(l.rate),
          basisAmount: num(l.basis_amount),
          sourceType: l.source_type,
          sourceId: l.source_id ?? null,
          isOverridden: l.is_overridden,
          trace: l.trace ?? {},
        })),
        consumptions,
        inputSnapshot: snapshot,
        inputSnapshotHash: hash,
      };
    });
  }

  /**
   * PAY-05 - year-to-date accumulations. Payroll staff may read any employee's; an employee only their own
   * (the same self-view permission the payslip itself uses).
   */
  async getYtd(claims: RequestClaims, employeeId: string, taxYear?: number): Promise<PayrollYtdView[]> {
    await this.requireModule(claims);
    const staff = (await this.hasAnyPayrollStaffPermission(claims)) || !!(await resolvePayrollAreaAccess(this.db, this.rbac, claims, RUN_SCOPED_VIEW_BASES));
    return this.db.withClaims(claims, async (client) => {
      if (!staff) {
        const owner = await client.query<{ user_account_id: string | null }>("SELECT user_account_id FROM employees WHERE id = $1", [employeeId]);
        if (owner.rowCount === 0 || !(await this.rbac.can(claims, SELF_VIEW_PERMISSION, { ownerId: owner.rows[0].user_account_id }))) {
          throw new NotFoundException("Employee not found");
        }
      }
      const r = await client.query(
        "SELECT * FROM payroll_ytd WHERE employee_id = $1 AND ($2::text IS NULL OR tax_year = $2) ORDER BY tax_year DESC",
        [employeeId, taxYear === undefined ? null : String(taxYear)]
      );
      return r.rows.map((y) => ({
        employeeId: y.employee_id,
        taxYear: y.tax_year,
        grossPay: Number(y.gross_pay),
        taxableGross: Number(y.taxable_gross),
        incomeTax: Number(y.income_tax),
        eobiEmployee: Number(y.eobi_employee),
        eobiEmployer: Number(y.eobi_employer),
        socialSecurityEmployer: Number(y.social_security_employer),
        netPay: Number(y.net_pay),
        employerCost: Number(y.employer_cost),
        payslipCount: y.payslip_count,
        lastPeriodEnd: y.last_period_end ? toIsoDate(y.last_period_end) : null,
      }));
    });
  }

  /**
   * The bank disbursement file — Section 5's own external-interface rule
   * ("references employee_number, never the internal UUID"), generated via
   * the same `ImportExportService.toCsv()` utility the Conversions WRICEF
   * pillar built. Only a finalized run's numbers are real enough to hand to
   * a bank.
   *
   * Payroll Enterprise Gap Analysis Phase P5 — two changes from the original
   * generic 3-column version:
   *
   * 1. **Real bank details, tenant-configurable columns.** Rows are now
   *    built by `buildDisbursementRows()`, which joins each employee's
   *    ACTIVE PRIMARY `employee_payment_accounts` row (Core Employee's own
   *    Payment/Bank card, 0086) rather than reading the long-stale flat
   *    `employees.bank_account_number` column this endpoint read before
   *    this phase. Which of the available `DISBURSEMENT_FIELD_KEYS` actually
   *    get written, and in what order, comes from
   *    `payroll_disbursement_settings` (tenant-configurable — see that
   *    table's own migration comment for why this is a swappable adapter,
   *    not a hardcoded specific bank's real spec) — defaulting to the exact
   *    3 columns this endpoint always produced, so an existing tenant's file
   *    is unchanged until they explicitly reconfigure it. An employee with
   *    no usable bank_transfer account on file is EXCLUDED from the file
   *    (never silently given a blank account number) and reported back.
   * 2. **Duplicate-payment protection.** Every row written to the file is
   *    tracked in `payroll_payment_batches`. If this run already has a
   *    non-voided batch, generating ANOTHER one requires the caller to pass
   *    `confirmRegenerate: true` — otherwise this throws, telling HR exactly
   *    when/by whom/how many rows the existing one covers, so a stray
   *    second click (or a second person downloading the same file) can
   *    never silently hand someone a second bank file for money that may
   *    already have moved. `previewDisbursementFile()` lets the frontend
   *    show this (and the excluded list) BEFORE committing to a new batch.
   */
  async generateDisbursementFile(
    claims: RequestClaims,
    runId: string,
    confirmRegenerate = false,
    formatId?: string
  ): Promise<GenerateDisbursementFileResponse> {
    const access = await this.requireRunAction(claims, DISBURSE_PERMISSION_BASE, "Not permitted to generate payroll disbursement files");
    const { csv, batch, excluded, event } = await this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertRunInScope(access, run);
      if (run.status === "closed") {
        throw new BadRequestException("This payroll run is closed; reopen it before generating payment files");
      }
      if (!REVERSIBLE_STATUSES.includes(run.status)) {
        throw new BadRequestException("Cannot disburse a payroll run that is not finalized yet");
      }

      const priorCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM payroll_payment_batches WHERE payroll_run_id = $1",
        [runId]
      );
      const existingActive = await client.query(
        `SELECT * FROM payroll_payment_batches
          WHERE payroll_run_id = $1 AND status IN ('generated', 'approved', 'released', 'acknowledged')
          ORDER BY generated_at DESC LIMIT 1`,
        [runId]
      );
      if ((existingActive.rowCount ?? 0) > 0 && !confirmRegenerate) {
        const prev = existingActive.rows[0];
        throw new BadRequestException(
          `This run's disbursement file was already generated on ${toIso(prev.generated_at)} (batch ${prev.batch_reference}, ` +
            `${prev.row_count} payment(s), total ${Number(prev.total_net_pay).toFixed(2)}). ` +
            `Pass confirmRegenerate to generate another one anyway — only do this if the previous file was never actually sent to the bank, or was rejected.`
        );
      }

      // PAY-16: a file that was generated (or approved) but never released is replaced by the new one. Money that was
      // already released to the bank stays where it is - those payments are left out of the new file, never repeated.
      const superseded = await client.query<{ id: string; batch_reference: string }>(
        `SELECT id, batch_reference FROM payroll_payment_batches
          WHERE payroll_run_id = $1 AND status IN ('generated', 'approved') FOR UPDATE`,
        [runId]
      );
      const { rows, entries, excluded: baseExcluded } = await this.buildDisbursementRows(client, runId);
      const lockedPayslips = await client.query<{ payslip_id: string; status: string; batch_reference: string }>(
        `SELECT i.payslip_id, i.status, b.batch_reference
           FROM payroll_payment_items i JOIN payroll_payment_batches b ON b.id = i.batch_id
          WHERE i.payroll_run_id = $1 AND i.status IN ('released', 'acknowledged')`,
        [runId]
      );
      const locked = new Map(lockedPayslips.rows.map((r) => [r.payslip_id, r]));
      const excluded = [...baseExcluded];
      const keptRows: typeof rows = [];
      const keptEntries: typeof entries = [];
      entries.forEach((entry, i) => {
        const lock = locked.get(entry.payslipId);
        if (lock) {
          excluded.push({ employeeNumber: entry.employeeNumber, employeeName: entry.employeeName, reason: `Already ${lock.status === "acknowledged" ? "paid" : "released"} in payment batch ${lock.batch_reference}` });
        } else {
          keptRows.push(rows[i]);
          keptEntries.push(entry);
        }
      });
      if (keptEntries.length === 0 && locked.size > 0) {
        throw new BadRequestException("Every payment in this run has already been released to the bank; there is nothing left to put in a new file");
      }
      const totalNetPay = Number(keptEntries.reduce((a, e) => a + e.amount, 0).toFixed(2));

      for (const old of superseded.rows) {
        await client.query(
          `UPDATE payroll_payment_batches
              SET status = 'voided', voided_reason = $2, voided_at = now(), voided_by_user_account_id = $3
            WHERE id = $1 RETURNING *`,
          [old.id, "Replaced by a newer payment file before release", claims.sub]
        ).then((r) => publishPaymentStatusChanged(client, claims, r.rows[0], "generated"));
        await client.query("UPDATE payroll_payment_items SET status = 'voided', updated_at = now() WHERE batch_id = $1 AND status = 'generated'", [old.id]);
      }

      const settings = await this.loadOrSeedDisbursementSettings(client, claims);
      const format = await this.resolveBankFormat(client, claims.company_id!, formatId, settings.columns);
      const batchReference = `PB-${runId.slice(0, 8).toUpperCase()}-${(priorCount.rows[0].n as number) + 1}`;

      const inserted = await client.query(
        `INSERT INTO payroll_payment_batches
           (company_id, payroll_run_id, batch_reference, row_count, excluded_count, total_net_pay, generated_by_user_account_id, format_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, runId, batchReference, keptRows.length, excluded.length, totalNetPay, claims.sub, format.id]
      );
      await this.insertPaymentItems(client, claims.company_id!, inserted.rows[0].id, runId, keptEntries);
      await publishPaymentStatusChanged(client, claims, inserted.rows[0], null);

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.disburse",
        target: runId,
        metadata: { batchReference, rowCount: keptRows.length, excludedCount: excluded.length, confirmRegenerate, formatId: format.id, supersededBatches: superseded.rows.map((b) => b.batch_reference) },
      });

      return {
        csv: renderBankFile(format, keptRows),
        batch: rowToPaymentBatch(inserted.rows[0]),
        excluded,
        event: {
          payrollRunId: run.id as string,
          companyId: run.company_id as string,
          periodStart: toIsoDate(run.period_start),
          periodEnd: toIsoDate(run.period_end),
          totalEmployees: keptRows.length,
          totalNetPay,
        },
      };
    });

    // Integration gap audit item 9 — see finalizeRun()'s own comment on
    // the fire-and-forget, enqueue-after-commit pattern. "Disbursed" here
    // means exactly what this endpoint does: the bank disbursement file
    // was generated (the point money moves), so the acting user is part of
    // the payload. Re-generating the file for the same run emits the event
    // again — every generation is a real, separately audited action (see
    // the audit record above, and the new `payroll_payment_batches` row),
    // and a subscriber can de-duplicate on `payrollRunId` if it only cares
    // about the first.
    this.webhooks
      ?.enqueue(event.companyId, "payroll_run.disbursed", {
        ...event,
        disbursedByUserAccountId: claims.sub,
        disbursedAt: new Date().toISOString(),
      })
      .catch(() => undefined);

    return { csv, batch, excluded };
  }

  /** The tenant's chosen payment-file layout: the named format, else its default, else the older column setting. */
  async resolveBankFormat(
    client: PoolClient,
    companyId: string,
    formatId: string | undefined,
    fallbackColumns: DisbursementFieldKey[]
  ): Promise<{ id: string | null; delimiter: string; includeHeader: boolean; columns: DisbursementFieldKey[]; headerLabels: Record<string, string> }> {
    if (formatId) {
      const r = await client.query("SELECT * FROM bank_file_formats WHERE id = $1 AND company_id = $2", [formatId, companyId]);
      if (r.rowCount === 0) throw new BadRequestException("The payment file format does not exist");
      if (!r.rows[0].is_active) throw new BadRequestException(`The payment file format "${r.rows[0].name}" is not active`);
      const f = rowToBankFormat(r.rows[0]);
      return { id: f.id, delimiter: f.delimiter, includeHeader: f.includeHeader, columns: f.columns, headerLabels: f.headerLabels };
    }
    const d = await client.query("SELECT * FROM bank_file_formats WHERE company_id = $1 AND is_default AND is_active", [companyId]);
    if (d.rowCount) {
      const f = rowToBankFormat(d.rows[0]);
      return { id: f.id, delimiter: f.delimiter, includeHeader: f.includeHeader, columns: f.columns, headerLabels: f.headerLabels };
    }
    return { id: null, delimiter: "comma", includeHeader: true, columns: fallbackColumns, headerLabels: {} };
  }

  /** One item per payslip in the file, with the account as it is now (encrypted; only the last four digits in clear). */
  async insertPaymentItems(
    client: PoolClient,
    companyId: string,
    batchId: string,
    runId: string,
    entries: Array<{ payslipId: string; employeeId: string; employeeNumber: string; amount: number; paymentMethod: string; bankName: string; accountTitle: string; accountNumber: string; iban: string; branchCode: string }>
  ): Promise<void> {
    for (const e of entries) {
      try {
        await client.query(
          `INSERT INTO payroll_payment_items
             (company_id, batch_id, payroll_run_id, payslip_id, employee_id, employee_number, amount, payment_method,
              bank_name, account_title, account_number_enc, iban_enc, account_last4, branch_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            companyId, batchId, runId, e.payslipId, e.employeeId, e.employeeNumber, e.amount, e.paymentMethod,
            e.bankName || null, e.accountTitle || null, sensitive.encrypt(companyId, e.accountNumber || null), sensitive.encrypt(companyId, e.iban || null),
            e.accountNumber ? e.accountNumber.slice(-4) : null, e.branchCode || null,
          ]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new BadRequestException(`${e.employeeNumber} already has a live payment for this payslip; the same salary cannot be paid twice`);
        }
        throw err;
      }
    }
  }

  /** Read-only — builds the exact same rows `generateDisbursementFile()`
   * would, and reports the existing batch (if any), WITHOUT writing a new
   * `payroll_payment_batches` row. The frontend calls this first so HR sees
   * the excluded-employee list and any "already generated" warning and can
   * make an informed choice before triggering the real (batch-writing)
   * download. Safe to call any number of times. */
  async previewDisbursementFile(
    claims: RequestClaims,
    runId: string
  ): Promise<{
    rowCount: number;
    excludedCount: number;
    excluded: Array<{ employeeNumber: string; employeeName: string; reason: string }>;
    totalNetPay: number;
    existingBatch: PayrollPaymentBatchView | null;
  }> {
    const access = await this.requireRunAction(claims, DISBURSE_PERMISSION_BASE, "Not permitted to preview payroll disbursement files");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertRunInScope(access, run);
      if (run.status === "closed") {
        throw new BadRequestException("This payroll run is closed; reopen it before generating payment files");
      }
      if (!REVERSIBLE_STATUSES.includes(run.status)) {
        throw new BadRequestException("Cannot disburse a payroll run that is not finalized yet");
      }
      const built = await this.buildDisbursementRows(client, runId);
      const lockedRows = await client.query<{ payslip_id: string; status: string; batch_reference: string }>(
        `SELECT i.payslip_id, i.status, b.batch_reference
           FROM payroll_payment_items i JOIN payroll_payment_batches b ON b.id = i.batch_id
          WHERE i.payroll_run_id = $1 AND i.status IN ('released', 'acknowledged')`,
        [runId]
      );
      const lockedIds = new Map(lockedRows.rows.map((r) => [r.payslip_id, r]));
      const excluded = [...built.excluded];
      let rows = built.rows;
      let totalNetPay = built.totalNetPay;
      if (lockedIds.size > 0) {
        rows = [];
        totalNetPay = 0;
        built.entries.forEach((entry, i) => {
          const lock = lockedIds.get(entry.payslipId);
          if (lock) excluded.push({ employeeNumber: entry.employeeNumber, employeeName: entry.employeeName, reason: `Already ${lock.status === "acknowledged" ? "paid" : "released"} in payment batch ${lock.batch_reference}` });
          else {
            rows.push(built.rows[i]);
            totalNetPay += entry.amount;
          }
        });
        totalNetPay = Number(totalNetPay.toFixed(2));
      }
      const existing = await client.query(
        `SELECT * FROM payroll_payment_batches WHERE payroll_run_id = $1 AND status IN ('generated', 'approved', 'released', 'acknowledged')
          ORDER BY generated_at DESC LIMIT 1`,
        [runId]
      );
      return {
        rowCount: rows.length,
        excludedCount: excluded.length,
        excluded,
        totalNetPay,
        existingBatch: (existing.rowCount ?? 0) > 0 ? rowToPaymentBatch(existing.rows[0]) : null,
      };
    });
  }

  /** Full generation history for one run — every `payroll_payment_batches`
   * row, newest first. Same view access as the run itself (`requireViewRuns`),
   * since seeing "has this already been paid" is a read, not a disburse
   * action. */
  async listPaymentBatches(claims: RequestClaims, runId: string): Promise<PayrollPaymentBatchView[]> {
    const access = await this.requireViewRuns(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      if (!isPayrollAreaInScope(access, run.payroll_area_id)) throw new NotFoundException("Payroll run not found");
      const result = await client.query(
        "SELECT * FROM payroll_payment_batches WHERE payroll_run_id = $1 ORDER BY generated_at DESC",
        [runId]
      );
      return result.rows.map(rowToPaymentBatch);
    });
  }

  /** An explicit, reasoned, audited way to mark a batch void (e.g. "bank
   * rejected the file, reissuing") — Section 19's "rejected-payment
   * handling; reissue/retry controls". Deliberately never a delete: the
   * point of this ledger is a history nothing erases. Voiding does NOT
   * retroactively allow `generateDisbursementFile()` to skip its
   * confirm-to-regenerate guard — that guard only ever looks at the single
   * MOST RECENT batch, so if the most recent one is now voided, the next
   * generation proceeds without needing `confirmRegenerate` (there is no
   * longer an active, un-voided batch to collide with); if an OLDER batch
   * is voided while a newer one is still active, the guard is unaffected,
   * which is correct — the newer one is still the thing that may have
   * already been sent to the bank. */
  async voidPaymentBatch(claims: RequestClaims, id: string, reason: string): Promise<PayrollPaymentBatchView> {
    const access = await this.requireRunAction(claims, DISBURSE_PERMISSION_BASE, "Not permitted to void a payment batch");
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException("A reason is required to void a payment batch");
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM payroll_payment_batches WHERE id = $1", [id]);
      if (existing.rowCount === 0) throw new NotFoundException("Payment batch not found");
      const batchRow = existing.rows[0];
      const run = await this.loadRun(client, batchRow.payroll_run_id);
      this.assertRunInScope(access, run);
      if (batchRow.status === "voided") throw new BadRequestException("This batch is already voided");
      const paid = await client.query("SELECT 1 FROM payroll_payment_items WHERE batch_id = $1 AND status = 'acknowledged' LIMIT 1", [id]);
      if (paid.rowCount) throw new BadRequestException("The bank has already acknowledged payments in this batch; they cannot be voided");
      const result = await client.query(
        `UPDATE payroll_payment_batches
         SET status = 'voided', voided_reason = $2, voided_at = now(), voided_by_user_account_id = $3
         WHERE id = $1 RETURNING *`,
        [id, trimmed, claims.sub]
      );
      await client.query("UPDATE payroll_payment_items SET status = 'voided', updated_at = now() WHERE batch_id = $1 AND status IN ('generated', 'released')", [id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_payment_batch.void",
        target: id,
        metadata: { reason: trimmed },
      });
      await publishPaymentStatusChanged(client, claims, result.rows[0], batchRow.status);
      return rowToPaymentBatch(result.rows[0]);
    });
  }

  /** The tenant-configurable disbursement column set — see
   * `payroll_disbursement_settings`'s own migration comment for why this
   * exists instead of a hardcoded bank format. Company-wide only (no
   * Payroll Areas scoping — this is a format preference, not a run-level
   * action), gated by the same `.all` disburse permission as actually
   * generating the file. */
  async getDisbursementSettings(claims: RequestClaims): Promise<PayrollDisbursementSettingsView> {
    await this.requirePayrollDisburseAll(claims);
    return this.db.withClaims(claims, (client) => this.loadOrSeedDisbursementSettings(client, claims));
  }

  async updateDisbursementSettings(
    claims: RequestClaims,
    patch: UpdatePayrollDisbursementSettingsRequest
  ): Promise<PayrollDisbursementSettingsView> {
    await this.requirePayrollDisburseAll(claims);
    if (patch.columns === undefined && patch.requireReleaseApproval === undefined) {
      throw new BadRequestException("Nothing to change: give columns or requireReleaseApproval");
    }
    if (patch.columns !== undefined) {
      if (!Array.isArray(patch.columns) || patch.columns.length === 0) {
        throw new BadRequestException("columns must be a non-empty array");
      }
      const unknown = patch.columns.filter((c) => !DISBURSEMENT_FIELD_KEYS.includes(c));
      if (unknown.length > 0) {
        throw new BadRequestException(`Unknown disbursement column(s): ${unknown.join(", ")}`);
      }
    }
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadOrSeedDisbursementSettings(client, claims);
      const result = await client.query(
        `UPDATE payroll_disbursement_settings SET columns = $2, require_release_approval = $3, updated_at = now() WHERE company_id = $1 RETURNING *`,
        [claims.company_id, JSON.stringify(patch.columns ?? current.columns), patch.requireReleaseApproval ?? current.requireReleaseApproval]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_disbursement_settings.update",
        target: claims.company_id ?? "",
        metadata: { columns: patch.columns ?? null, requireReleaseApproval: patch.requireReleaseApproval ?? null },
      });
      return rowToDisbursementSettings(result.rows[0]);
    });
  }

  /**
   * Section 20 (Accounting & Costing Administration): "cost-center
   * mapping; ... organization-based costing; employee allocation; split
   * allocation where supported" — wired into Payroll via a READ-ONLY report
   * over the EXISTING `employee_cost_allocations` table (Core Employee
   * Phase 8, 0086), not a new costing table or a GL/journal engine (that
   * stays Phase P6). Uses each employee's CURRENT active allocation(s), not
   * a historical snapshot pinned to the run's own period — a deliberate
   * simplification matching this phase's own "doesn't require a full
   * GL/journal engine to deliver real value" scope; an employee whose cost
   * allocation changed AFTER this run was finalized will show under their
   * NEW allocation here, not the one in force when they were actually paid.
   * An employee with no active allocation at all falls into the
   * `costCenterId: null` "Unallocated" bucket; one split across several
   * cost centers contributes a proportional share (by
   * `allocation_percentage`) of their gross/net pay to each. Same view
   * access as the run itself.
   */
  async getCostCenterBreakdown(claims: RequestClaims, runId: string): Promise<PayrollCostCenterBreakdownView> {
    const access = await this.requireViewRuns(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      if (!isPayrollAreaInScope(access, run.payroll_area_id)) throw new NotFoundException("Payroll run not found");

      const result = await client.query(
        `SELECT p.employee_id, p.gross_pay, p.net_pay,
                ca.cost_center_id, ca.allocation_percentage,
                cc.code AS cost_center_code, cc.name AS cost_center_name
         FROM payslips p
         LEFT JOIN employee_cost_allocations ca ON ca.employee_id = p.employee_id AND ca.status = 'active'
         LEFT JOIN cost_centers cc ON cc.id = ca.cost_center_id
         WHERE p.payroll_run_id = $1`,
        [runId]
      );

      // Group by employee FIRST so an employee with no active allocation
      // (the LEFT JOIN produces one row with every ca.*/cc.* column null)
      // is bucketed as "Unallocated" exactly once, rather than once per
      // joined row.
      type EmpAgg = {
        grossPay: number;
        netPay: number;
        allocations: Array<{ costCenterId: string | null; code: string | null; name: string | null; pct: number }>;
      };
      const byEmployee = new Map<string, EmpAgg>();
      for (const row of result.rows) {
        if (!byEmployee.has(row.employee_id)) {
          byEmployee.set(row.employee_id, { grossPay: Number(row.gross_pay), netPay: Number(row.net_pay), allocations: [] });
        }
        byEmployee.get(row.employee_id)!.allocations.push({
          costCenterId: row.cost_center_id ?? null,
          code: row.cost_center_code ?? null,
          name: row.cost_center_name ?? null,
          pct: row.cost_center_id ? Number(row.allocation_percentage) : 100,
        });
      }

      const buckets = new Map<string, { costCenterId: string | null; costCenterCode: string | null; costCenterName: string; employeeCount: number; totalGrossPay: number; totalNetPay: number }>();
      for (const emp of byEmployee.values()) {
        for (const alloc of emp.allocations) {
          const key = alloc.costCenterId ?? "__unallocated__";
          if (!buckets.has(key)) {
            buckets.set(key, {
              costCenterId: alloc.costCenterId,
              costCenterCode: alloc.code,
              costCenterName: alloc.costCenterId ? alloc.name ?? "Unnamed cost center" : "Unallocated",
              employeeCount: 0,
              totalGrossPay: 0,
              totalNetPay: 0,
            });
          }
          const bucket = buckets.get(key)!;
          const share = alloc.pct / 100;
          // Counts "how many employees have cost landing in this cost
          // center" — an employee split across 2 cost centers counts once
          // in EACH, which is correct for this bucket's own headcount, not
          // a company-wide headcount total.
          bucket.employeeCount += 1;
          bucket.totalGrossPay = Number((bucket.totalGrossPay + emp.grossPay * share).toFixed(2));
          bucket.totalNetPay = Number((bucket.totalNetPay + emp.netPay * share).toFixed(2));
        }
      }

      return {
        payrollRunId: runId,
        rows: Array.from(buckets.values()).sort((a, b) => b.totalNetPay - a.totalNetPay),
      };
    });
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
      if (run.status === "closed") {
        throw new BadRequestException("This payroll run is closed; reopen it (payroll.reopen.all) before reversing it");
      }
      if (!REVERSIBLE_STATUSES.includes(run.status)) {
        throw new BadRequestException(`Payroll run is ${run.status}, only a finalized run can be reversed`);
      }

      await this.control().transition(client, claims, id, "reversed", {
        action: "reverse",
        reason,
        set: { reversed_at: new Date(), reversed_by_user_account_id: claims.sub, reversal_reason: reason },
      });

      // PAY-19 - the money side of a reversal: a bank file generated for this run no longer stands.
      const voided = await client.query(
        `UPDATE payroll_payment_batches
            SET status = 'voided', voided_reason = $2, voided_at = now(), voided_by_user_account_id = $3
          WHERE payroll_run_id = $1 AND status IN ('generated', 'approved', 'released') RETURNING *`,
        [id, `Payroll run reversed: ${reason}`, claims.sub]
      );
      for (const b of voided.rows) await publishPaymentStatusChanged(client, claims, b, null);
      await client.query(
        "UPDATE payroll_payment_items SET status = 'voided', updated_at = now() WHERE payroll_run_id = $1 AND status IN ('generated', 'released')",
        [id]
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
        `INSERT INTO payroll_runs (company_id, period_start, period_end, created_by_user_account_id, payroll_area_id, run_type, off_cycle_reason, target_employee_id, payroll_period_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          run.company_id,
          run.period_start,
          run.period_end,
          claims.sub,
          run.payroll_area_id ?? null,
          run.run_type ?? "regular",
          run.off_cycle_reason ?? null,
          run.target_employee_id ?? null,
          run.payroll_period_id ?? null,
        ]
      );
      const correctiveRunId = corrective.rows[0].id as string;

      // TLM-07 - overtime is the one thing a reversal gives back: the reversed run's payslips are
      // void and the corrective run for the same period must pay those claims again.
      const releasedOvertime = this.overtime ? await this.overtime.releaseForRunWithinTransaction(client, id) : 0;
      // PAY-05 - the payslips stay on record but are void, their input links are given back and the YTD is rebuilt without them
      await voidPayslips(client, id);
      await refreshYtd(client, run, taxYearLabelFor(toIsoDate(run.period_end)));
      await payrollRunHooks.reversed(client, claims, run);

      const result = await client.query(
        `UPDATE payroll_runs SET corrective_run_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, correctiveRunId]
      );

      const impact = {
        payslipCount: (await this.loadRunSummary(client, id)).payslipCount,
        releasedOvertimeClaims: releasedOvertime,
        voidedPaymentBatches: voided.rows.map((r) => r.id),
        journals: [] as string[],
      };
      await this.control().recordReversal(client, claims, run, correctiveRunId, reason, impact);
      await this.control().recordCreated(client, claims, { id: correctiveRunId, company_id: run.company_id, status: "draft" }, { reversalOf: id });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.reverse",
        target: id,
        metadata: { reason, correctiveRunId, releasedOvertimeClaims: releasedOvertime, voidedPaymentBatches: voided.rowCount ?? 0 },
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
    offCycleOptions?: { isFinalSettlement: boolean; offCycleRunId: string },
    // PAY-07 / PAY-12: the run this payslip is for (retro results targeted at it are paid here) and the currency it
    // pays in. Both omitted when a historical payslip is recalculated only to be compared (retro detection).
    runContext?: { runId?: string; currencyCode?: string }
  ): Promise<Record<string, unknown>> {
    const breakdown: PayrollCalculationStep[] = [];
    // PAY-05 - the structured twin of `breakdown`: one signed line per component, and what the payslip was built from.
    const ledger = new ComponentLedger();
    const snapshotCompensation: PayslipInputSnapshot["compensation"] = [];
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
      `SELECT ecc.*, cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable, cc.component_type,
              cc.calculation_type, cc.proration_mode, cc.payslip_label, cc.eligibility,
              cc.counts_toward_eobi_base, cc.counts_toward_gratuity_base, cc.counts_toward_provident_fund_base
       FROM employee_compensation_components ecc
       JOIN compensation_components cc ON cc.id = ecc.component_id
       WHERE ecc.employee_id = $1 AND cc.is_active = true
         AND ecc.effective_from <= $3 AND (ecc.effective_to IS NULL OR ecc.effective_to >= $2)
       ORDER BY cc.display_order ASC, cc.sort_order ASC, ecc.effective_from ASC`,
      [employee.id, windowStart, windowEnd]
    );
    if (componentSegments.rowCount === 0) {
      throw new Error("No compensation record covers this employee for this period");
    }

    let grossFromSegments = 0;
    let taxableGrossFromSegments = 0;
    // Only plain 'earning' components are the unpaid-leave base; a reimbursement or a premium is not reduced by leave.
    let earningGrossFromSegments = 0;
    let earningTaxableFromSegments = 0;
    // PAY-07 - what the component flags say counts toward each statutory / benefit base (exposed to formulas and the snapshot).
    let eobiEligibleEarnings = 0;
    let gratuityBase = 0;
    let providentFundBase = 0;
    // Phase P3, Section 1 - a 'deduction'-type component (a recurring Benefits-style deduction: health-insurance
    // premium, society membership fee, ...) is never part of gross/taxable gross and never part of the unpaid-leave
    // rate base below (a society fee is owed regardless of attendance) - see 0112's own header comment. It reduces
    // NET pay only, alongside loan repayments/additional deductions further down.
    let recurringDeductionTotal = 0;
    // PAY-07 - an employer-paid recurring cost (e.g. an insurance premium the company pays on top): never touches
    // the employee's pay, adds to the employer cost.
    let recurringEmployerCost = 0;
    const latestAmountByComponent = new Map<string, number>();
    const runCurrency = runContext?.currencyCode ?? null;
    const eligibilityFacts = await this.loadEligibilityFacts(client, employee.id);
    // A component with proration 'none' is paid in full for any employment in the period: only its latest segment counts.
    const lastSegmentOfUnprorated = new Map<string, string>();
    for (const seg of componentSegments.rows) {
      if (seg.proration_mode === "none") lastSegmentOfUnprorated.set(seg.component_id, seg.id);
    }
    for (const seg of componentSegments.rows) {
      const segStart = dateMax(windowStart, toIsoDate(seg.effective_from));
      const segEnd = dateMin(windowEnd, seg.effective_to ? toIsoDate(seg.effective_to) : windowEnd);
      if (segEnd < segStart) continue;
      if (runCurrency && seg.currency_code && seg.currency_code !== runCurrency) {
        throw new Error(`"${seg.component_name}" is set in ${seg.currency_code} but this run pays in ${runCurrency}; multi-currency payroll is not supported`);
      }
      const notEligible = this.ineligibilityReason(seg.eligibility, eligibilityFacts, windowEnd);
      if (notEligible) {
        breakdown.push({ label: `${seg.component_name} — not paid: ${notEligible}`, value: 0 });
        continue;
      }
      if (seg.proration_mode === "none" && lastSegmentOfUnprorated.get(seg.component_id) !== seg.id) continue;
      const segDays = countDays(segStart, segEnd);
      const amount = Number(seg.amount);
      const unprorated = seg.proration_mode === "none";
      const proratedAmount = unprorated ? amount : (amount * segDays) / prorationDays;
      const label = seg.payslip_label || seg.component_name;
      const type = seg.component_type as string;
      snapshotCompensation.push({
        segmentId: seg.id,
        componentKey: seg.component_key,
        componentType: type,
        monthlyAmount: amount,
        from: segStart,
        to: segEnd,
        days: segDays,
        taxable: !!seg.component_is_taxable,
      });
      const trace = {
        from: segStart,
        to: segEnd,
        prorationDays,
        componentType: type,
        calculationType: seg.calculation_type,
        prorated: !unprorated,
        percentage: seg.percentage === null ? undefined : Number(seg.percentage),
        units: seg.units === null ? undefined : Number(seg.units),
      };
      if (type === "deduction") {
        ledger.add({
          key: seg.component_key, label, category: "employee_deduction", affects: "net", amount: -proratedAmount, isTaxable: false,
          quantity: segDays, unit: dayUnit, rate: amount, basisAmount: amount, sourceType: "compensation", sourceId: seg.id, componentId: seg.component_id, trace,
        });
        recurringDeductionTotal += proratedAmount;
        breakdown.push({
          label: `${seg.component_name} — ${segStart} to ${segEnd} (${segDays} ${dayUnit}) @ ${amount}/mo (recurring deduction, reduces net pay only)`,
          value: -Number(proratedAmount.toFixed(2)),
        });
        continue;
      }
      if (type === "employer_contribution") {
        ledger.add({
          key: seg.component_key, label, category: "employer_contribution", affects: "employer_cost", amount: proratedAmount, isTaxable: false,
          quantity: segDays, unit: dayUnit, rate: amount, basisAmount: amount, sourceType: "compensation", sourceId: seg.id, componentId: seg.component_id, trace,
        });
        recurringEmployerCost += proratedAmount;
        breakdown.push({
          label: `${seg.component_name} — ${segStart} to ${segEnd} (${segDays} ${dayUnit}) @ ${amount}/mo (employer cost only; not part of the employee's pay)`,
          value: Number(proratedAmount.toFixed(2)),
        });
        continue;
      }
      const taxable = !!seg.component_is_taxable && !NEVER_TAXABLE_COMPONENT_TYPES.has(type);
      ledger.add({
        key: seg.component_key, label, category: "earning", affects: "gross", amount: proratedAmount, isTaxable: taxable,
        quantity: segDays, unit: dayUnit, rate: amount, basisAmount: amount, sourceType: "compensation", sourceId: seg.id, componentId: seg.component_id, trace,
      });
      grossFromSegments += proratedAmount;
      if (taxable) taxableGrossFromSegments += proratedAmount;
      if (type === "earning") {
        earningGrossFromSegments += proratedAmount;
        if (taxable) earningTaxableFromSegments += proratedAmount;
        latestAmountByComponent.set(seg.component_id, amount);
      }
      if (seg.counts_toward_eobi_base) eobiEligibleEarnings += proratedAmount;
      if (seg.counts_toward_gratuity_base) gratuityBase += proratedAmount;
      if (seg.counts_toward_provident_fund_base) providentFundBase += proratedAmount;
      breakdown.push({
        label: `${seg.component_name} — ${segStart} to ${segEnd} (${segDays} ${dayUnit}) @ ${amount}/mo${taxable ? "" : " (non-taxable)"}${unprorated ? " (paid in full, not prorated)" : ""}`,
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
      ledger.add({
        key: "unpaid_leave_deduction",
        label: "Unpaid leave deduction",
        category: "adjustment",
        affects: "gross",
        amount: -unpaidDeduction,
        quantity: unpaidLeaveDays,
        unit: dayUnit,
        rate: latestTotalMonthlyRate,
        basisAmount: latestTotalMonthlyRate,
        sourceType: "leave",
        trace: { prorationDays, monthlyRate: latestTotalMonthlyRate },
      });
    }
    const taxableShare = earningGrossFromSegments > 0 ? earningTaxableFromSegments / earningGrossFromSegments : 0;
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
    const consumedOvertime: Array<{ overtimeId: string; amount: number }> = [];
    for (const claim of overtimeClaims) {
      overtimePay += claim.amount as number;
      overtimeMinutes += claim.overtimeMinutes;
      consumedOvertime.push({ overtimeId: claim.id, amount: Number((claim.amount as number).toFixed(2)) });
      ledger.add({
        key: "overtime",
        label: `Overtime ${claim.workDate}`,
        category: "earning",
        affects: "gross",
        amount: claim.amount as number,
        isTaxable: true,
        quantity: claim.overtimeMinutes,
        unit: "minutes",
        rate: claim.hourlyRate ?? undefined,
        sourceType: "overtime",
        sourceId: claim.id,
        trace: { workDate: claim.workDate, dayType: claim.dayType, rateMultiplier: claim.rateMultiplier, amountSnapshottedAtApproval: true },
      });
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
      ledger.add({
        key: payment.paymentType === "earning" ? "additional_earning" : "additional_deduction",
        label: payment.label,
        category: payment.paymentType === "earning" ? "earning" : "employee_deduction",
        affects: payment.paymentType === "earning" ? "gross" : "net",
        amount: payment.paymentType === "earning" ? payment.amount : -payment.amount,
        isTaxable: payment.paymentType === "earning" && payment.isTaxable,
        sourceType: "additional_payment",
        sourceId: payment.id,
        trace: { effectiveDate: payment.effectiveDate },
      });
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
        ledger.add({
          key: payment.paymentType === "earning" ? "offcycle_earning" : "offcycle_deduction",
          label: payment.label,
          category: payment.paymentType === "earning" ? "earning" : "employee_deduction",
          affects: payment.paymentType === "earning" ? "gross" : "net",
          amount: payment.paymentType === "earning" ? payment.amount : -payment.amount,
          isTaxable: payment.paymentType === "earning" && payment.isTaxable,
          sourceType: "off_cycle_payment",
          sourceId: payment.id,
          trace: { finalSettlement: true },
        });
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

    // --- Arrears / retro (PAY-12) ----------------------------------------
    // Differences in already-paid history that HR included in THIS run (compensation changed or unpaid leave
    // decided after the period was paid). Like any one-time earning they are taxed this period and never projected
    // forward; a negative result is a recovery of an overpayment.
    let arrearsTotal = 0;
    let arrearsTaxable = 0;
    const consumedRetro: Array<{ retroResultId: string; amount: number }> = [];
    const retroDetail: Array<Record<string, unknown>> = [];
    if (runContext?.runId && !offCycleOptions) {
      const retro = await client.query(
        `SELECT * FROM payroll_retro_results WHERE target_run_id = $1 AND employee_id = $2 AND status = 'included' ORDER BY affected_period_start, component_key`,
        [runContext.runId, employee.id]
      );
      for (const r of retro.rows) {
        const delta = Number(r.delta);
        const label = `Arrears: ${r.component_label} (${toIsoDate(r.affected_period_start)} to ${toIsoDate(r.affected_period_end)})`;
        ledger.add({
          key: `arrears_${r.component_key}`,
          label,
          category: delta >= 0 ? "earning" : "adjustment",
          affects: "gross",
          amount: delta,
          isTaxable: !!r.is_taxable,
          sourceType: "retro",
          sourceId: r.id,
          trace: { sourceRunId: r.source_run_id, originalAmount: Number(r.original_amount), recalculatedAmount: Number(r.recalculated_amount), sourceEvent: r.source_event_type },
        });
        arrearsTotal += delta;
        if (r.is_taxable) arrearsTaxable += delta;
        consumedRetro.push({ retroResultId: r.id, amount: Number(delta.toFixed(2)) });
        retroDetail.push({ retroResultId: r.id, componentKey: r.component_key, label, delta, isTaxable: !!r.is_taxable, sourceRunId: r.source_run_id });
        breakdown.push({ label, value: Number(delta.toFixed(2)) });
      }
    }

    const paidDays = Math.max(0, employmentWindowDays - unpaidLeaveDays);
    const grossPay = Math.max(0, Math.max(0, grossFromSegments - unpaidDeduction) + overtimePay + additionalEarningsTotal + arrearsTotal);
    const taxableGrossThisPeriod = Math.max(0, Math.max(0, taxableGrossFromSegments - taxableUnpaidDeduction) + overtimePay + additionalEarningsTaxable + arrearsTaxable);
    breakdown.push({ label: "Gross pay", value: Number(grossPay.toFixed(2)) });
    breakdown.push({ label: "Of which taxable this period", value: Number(taxableGrossThisPeriod.toFixed(2)) });

    // --- Year-to-date cumulative tax withholding (Phase P1) -------------
    const taxYear = taxYearLabelFor(periodEnd);
    const { start: taxYearStart, end: taxYearEnd } = taxYearBounds(taxYear);
    const ytdResult = await client.query(
      `SELECT COALESCE(SUM(p.taxable_gross_this_period), 0) AS taxable, COALESCE(SUM(p.income_tax_monthly), 0) AS tax
       FROM payslips p
       JOIN payroll_runs pr ON pr.id = p.payroll_run_id
       WHERE p.employee_id = $1 AND pr.status IN ('finalized','accounting','payment_released','reconciled','closed','reopened') AND pr.is_simulation = false AND pr.period_end >= $2 AND pr.period_end < $3`,
      [employee.id, taxYearStart, periodStart]
    );
    // PAY-09/PAY-10 - an employee tax profile (published slabs, exemptions, credits, previous employer) replaces the
    // company-wide slabs for that employee; without one nothing here changes.
    const taxContext = await loadEmployeeTaxContext(client, employee.id, periodStart, periodEnd, taxYear);
    const priorYtdTaxable = Number(ytdResult.rows[0].taxable) + (taxContext?.previousEmployerIncome ?? 0);
    const priorYtdTaxWithheld = Number(ytdResult.rows[0].tax) + (taxContext?.previousEmployerTax ?? 0);
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
    const recurringTaxableThisPeriod = Math.max(0, taxableGrossThisPeriod - overtimePay - additionalEarningsTaxable - arrearsTaxable);
    const dailyTaxableRate = daysInPeriod > 0 ? recurringTaxableThisPeriod / daysInPeriod : 0;
    const projectedRemainingIncome = dailyTaxableRate * daysRemaining;
    const estimatedAnnualTaxableIncome = priorYtdTaxable + taxableGrossThisPeriod + projectedRemainingIncome;
    breakdown.push({
      label: offCycleOptions?.isFinalSettlement
        ? "Final tax-year taxable income from this employer (YTD + this settlement, no projection — final true-up)"
        : "Estimated full tax-year taxable income (YTD + this period + projected remainder)",
      value: Number(estimatedAnnualTaxableIncome.toFixed(2)),
    });

    const profileTax = taxContext ? computeAnnualTax(taxContext, estimatedAnnualTaxableIncome, taxFromSlabs) : null;
    const slabsInUse = taxContext ? taxContext.slabs : taxSlabs;
    const incomeForSlabs = profileTax ? profileTax.taxableForSlabs : estimatedAnnualTaxableIncome;
    const totalAnnualTaxEstimate = profileTax ? profileTax.annualTax : taxFromSlabs(estimatedAnnualTaxableIncome, taxSlabs);
    const fractionElapsed = offCycleOptions?.isFinalSettlement ? 1 : totalDaysInTaxYear > 0 ? daysElapsedInclusive / totalDaysInTaxYear : 1;
    const totalTaxDueToDate = totalAnnualTaxEstimate * fractionElapsed;
    const bracket =
      slabsInUse.find(
        (s) => incomeForSlabs >= s.minAnnualIncome && (s.maxAnnualIncome === null || incomeForSlabs <= s.maxAnnualIncome)
      ) ?? slabsInUse[slabsInUse.length - 1];
    if (taxContext && profileTax) {
      breakdown.push({
        label: `Tax profile "${taxContext.profileName}" (tax year ${taxContext.taxYearLabel}): taxable income after exemptions ${incomeForSlabs.toFixed(2)}, surcharge ${profileTax.surcharge.toFixed(2)}`,
        value: Number(profileTax.annualTax.toFixed(2)),
      });
    }
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
    ledger.add({
      key: "income_tax",
      label: "Income tax",
      category: "tax",
      affects: "net",
      amount: -incomeTaxMonthly,
      basisAmount: taxableGrossThisPeriod,
      sourceType: "tax",
      trace: {
        taxYear,
        estimatedAnnualTaxableIncome,
        priorYtdTaxable,
        priorYtdTaxWithheld,
        slabAnnualTax: totalAnnualTaxEstimate,
        taxDueToDate: totalTaxDueToDate,
        bracket: { min: bracket.minAnnualIncome, max: bracket.maxAnnualIncome, ratePercent: bracket.ratePercent, baseTax: bracket.baseTax },
        taxYearDaysElapsed: daysElapsedInclusive,
        taxYearTotalDays: totalDaysInTaxYear,
        finalSettlementTrueUp: !!offCycleOptions?.isFinalSettlement,
        formulaOverride: incomeTaxOverride === null ? null : { effectiveFrom: incomeTaxOverride.effectiveFrom, builtInAmount: Number(builtInIncomeTaxMonthly.toFixed(2)) },
        ...(taxContext && profileTax ? { taxProfile: taxProfileTrace(taxContext, profileTax) } : {}),
      },
    });
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
      eobiEligibleEarnings,
    });
    const eobiEmployerOverride = formulas.evaluate("eobi_employer", {
      defaultAmount: builtInEobiEmployerContribution,
      wageBase: settings.eobiWageBase,
      ratePercent: settings.eobiEmployerRatePercent,
      paidDays,
      employmentWindowDays,
      paidDaysRatio,
      grossPay,
      eobiEligibleEarnings,
    });
    const eobiEmployeeContribution = eobiEmployeeOverride === null ? builtInEobiEmployeeContribution : eobiEmployeeOverride.value;
    const eobiEmployerContribution = eobiEmployerOverride === null ? builtInEobiEmployerContribution : eobiEmployerOverride.value;
    ledger.add({
      key: "eobi_employee",
      label: "EOBI employee contribution",
      category: "statutory_deduction",
      affects: "net",
      amount: -eobiEmployeeContribution,
      basisAmount: settings.eobiWageBase,
      rate: settings.eobiEmployeeRatePercent,
      sourceType: "statutory",
      trace: { wageBase: settings.eobiWageBase, ratePercent: settings.eobiEmployeeRatePercent, paidDaysRatio, formulaOverride: eobiEmployeeOverride === null ? null : { effectiveFrom: eobiEmployeeOverride.effectiveFrom, builtInAmount: Number(builtInEobiEmployeeContribution.toFixed(2)) } },
    });
    ledger.add({
      key: "eobi_employer",
      label: "EOBI employer contribution",
      category: "employer_contribution",
      affects: "employer_cost",
      amount: eobiEmployerContribution,
      basisAmount: settings.eobiWageBase,
      rate: settings.eobiEmployerRatePercent,
      sourceType: "statutory",
      trace: { wageBase: settings.eobiWageBase, ratePercent: settings.eobiEmployerRatePercent, paidDaysRatio, formulaOverride: eobiEmployerOverride === null ? null : { effectiveFrom: eobiEmployerOverride.effectiveFrom, builtInAmount: Number(builtInEobiEmployerContribution.toFixed(2)) } },
    });
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
    if (socialSecurityEmployerContribution > 0 || settings.socialSecurityScheme !== "none") {
      ledger.add({
        key: "social_security_employer",
        label: `Social security (${settings.socialSecurityScheme}) employer contribution`,
        category: "employer_contribution",
        affects: "employer_cost",
        amount: socialSecurityEmployerContribution,
        basisAmount: grossPay,
        rate: settings.socialSecurityEmployerRatePercent,
        sourceType: "statutory",
        trace: { scheme: settings.socialSecurityScheme, wageCeiling: settings.socialSecurityWageCeiling, applies: ssApplies },
      });
    }
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
    const jurisdiction = await resolveStatutoryJurisdiction(client, employee.id);
    const { loans } = this.requireCalculationCollaborators();
    const loanPreviews = await loans.previewDeductionsWithinTransaction(client, employee.id, periodEnd, { fullPayoff: !!offCycleOptions?.isFinalSettlement });
    let loanDeductionTotal = 0;
    const loanDeductions: Array<{ loanId: string; amount: number }> = [];
    for (const { loan, amount, basis, dueInstallments } of loanPreviews) {
      // PAY-13: the amount is what the approved repayment schedule says is due up to the period end (a loan with no
      // schedule keeps `min(installment, outstanding)`). A final settlement, or an early settlement the employer
      // requested, recovers the FULL outstanding balance instead.
      loanDeductionTotal += amount;
      loanDeductions.push({ loanId: loan.id, amount });
      const kindLabel = loan.loanType === "loan" ? "Loan" : "Salary advance";
      ledger.add({
        key: loan.loanType === "loan" ? "loan_repayment" : "advance_repayment",
        label: `${kindLabel} repayment`,
        category: "recovery",
        affects: "net",
        amount: -amount,
        sourceType: "loan",
        sourceId: loan.id,
        trace: {
          outstandingBalance: loan.outstandingBalance,
          installmentAmount: loan.installmentAmount,
          fullPayoff: basis === "final_settlement" || basis === "early_settlement",
          basis,
          dueInstallments,
        },
      });
      breakdown.push({
        label:
          basis === "final_settlement"
            ? `${kindLabel} FULL payoff at final settlement (outstanding balance ${loan.outstandingBalance})`
            : basis === "early_settlement"
              ? `${kindLabel} early settlement of the full balance (outstanding balance ${loan.outstandingBalance})`
              : basis === "schedule"
                ? `${kindLabel} repayment installment per schedule, ${dueInstallments} due (outstanding balance ${loan.outstandingBalance})`
                : `${kindLabel} repayment installment (outstanding balance ${loan.outstandingBalance})`,
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
      consumedOvertime,
      // PAY-05 / PAY-21
      employerCost: Number((grossPay + eobiEmployerContribution + socialSecurityEmployerContribution + recurringEmployerCost).toFixed(2)),
      arrearsAmount: Number(arrearsTotal.toFixed(2)),
      retroDetail,
      consumedRetro,
      components: ledger.finish(Number(grossPay.toFixed(2)), Number(netPay.toFixed(2))),
      inputSnapshot: {
        period: { start: periodStart, end: periodEnd, daysInPeriod },
        employment: { dateOfJoining, terminationDate, windowStart, windowEnd, windowDays: employmentWindowDays },
        organisation: await this.loadOrganisationFacts(client, employee.id),
        workingDays: {
          mode: basis.mode,
          prorationDays,
          unit: dayUnit,
          scheduleNames: basis.mode === "calendar" ? undefined : basis.scheduleNames,
          note: basis.mode === "calendar" ? (basis.note ?? null) : null,
        },
        compensation: snapshotCompensation,
        leave: {
          unpaidDays: Number(unpaidLeaveDays.toFixed(2)),
          segments: unpaidLeave.segments.map((seg) => ({ startDate: seg.startDate, endDate: seg.endDate, days: seg.days, leaveRequestId: seg.leaveRequestId })),
        },
        overtime: { claimCount: overtimeClaims.length, minutes: overtimeMinutes, total: Number(overtimePay.toFixed(2)), claimIds: overtimeClaims.map((c) => c.id) },
        adjustments: {
          additionalPaymentIds: consumedAdditionalPayments.map((c) => c.additionalPaymentId),
          offCyclePaymentIds: consumedOffCyclePayments.map((c) => c.offCyclePaymentId),
          loanIds: loanDeductions.map((l) => l.loanId),
          retroResultIds: consumedRetro.map((c) => c.retroResultId),
        },
        jurisdiction: { code: jurisdiction.code, source: jurisdiction.source, locationId: jurisdiction.locationId },
        bases: { eobiEligibleEarnings: Number(eobiEligibleEarnings.toFixed(2)), gratuityBase: Number(gratuityBase.toFixed(2)), providentFundBase: Number(providentFundBase.toFixed(2)) },
        tax: { taxYear, taxYearStart, taxYearEnd, priorYtdTaxable, priorYtdTaxWithheld, isFinalSettlement: !!offCycleOptions?.isFinalSettlement, profile: taxContext ? { employeeTaxProfileId: taxContext.employeeTaxProfileId, profileId: taxContext.profileId, code: taxContext.profileCode, filerStatus: taxContext.filerStatus, taxResidency: taxContext.taxResidency, provincialScheme: taxContext.provincialScheme } : null },
      } satisfies PayslipInputSnapshot,
      // PAY-21 - unpaid leave actually deducted, as consumption links (a leave request can span runs, so these are informational)
      consumedLeave: unpaidLeave.segments
        .filter((seg) => seg.leaveRequestId)
        .map((seg) => ({ leaveRequestId: seg.leaveRequestId as string, days: seg.days })),
    };
  }

  /** What eligibility rules of a pay component look at, for one employee. */
  private async loadEligibilityFacts(client: PoolClient, employeeId: string): Promise<{ dateOfJoining: string; employmentTypeCatalogItemId: string | null }> {
    const r = await client.query("SELECT date_of_joining, employment_type_catalog_item_id FROM employees WHERE id = $1", [employeeId]);
    const row = r.rows[0] ?? {};
    return { dateOfJoining: row.date_of_joining ? toIsoDate(row.date_of_joining) : "1900-01-01", employmentTypeCatalogItemId: row.employment_type_catalog_item_id ?? null };
  }

  /** null when the employee qualifies for the component; otherwise the (human) reason they do not. */
  private ineligibilityReason(
    eligibility: { minServiceMonths?: number; employmentTypeCatalogItemIds?: string[] } | null,
    facts: { dateOfJoining: string; employmentTypeCatalogItemId: string | null },
    asOf: string
  ): string | null {
    if (!eligibility) return null;
    if (typeof eligibility.minServiceMonths === "number" && eligibility.minServiceMonths > 0) {
      const [jy, jm, jd] = facts.dateOfJoining.split("-").map(Number);
      const [ay, am, ad] = asOf.split("-").map(Number);
      const months = (ay - jy) * 12 + (am - jm) - (ad < jd ? 1 : 0);
      if (months < eligibility.minServiceMonths) return `needs ${eligibility.minServiceMonths} month(s) of service, has ${Math.max(0, months)}`;
    }
    const types = eligibility.employmentTypeCatalogItemIds;
    if (Array.isArray(types) && types.length > 0 && (!facts.employmentTypeCatalogItemId || !types.includes(facts.employmentTypeCatalogItemId))) {
      return "employment type is not eligible";
    }
    return null;
  }

  /** Organisation facts a payslip was calculated under (ids only; the names live in their own masters). */
  private async loadOrganisationFacts(client: PoolClient, employeeId: string): Promise<Record<string, unknown>> {
    const emp = await client.query(
      `SELECT payroll_area_id, org_unit_id, position_id, location_id, employee_subgroup_id, employment_status FROM employees WHERE id = $1`,
      [employeeId]
    );
    const alloc = await client.query<{ cost_center_id: string; allocation_percentage: string }>(
      `SELECT cost_center_id, allocation_percentage FROM employee_cost_allocations WHERE employee_id = $1 AND status = 'active'`,
      [employeeId]
    );
    const e = emp.rows[0] ?? {};
    return {
      payrollAreaId: e.payroll_area_id ?? null,
      orgUnitId: e.org_unit_id ?? null,
      positionId: e.position_id ?? null,
      locationId: e.location_id ?? null,
      employeeSubgroupId: e.employee_subgroup_id ?? null,
      employmentStatus: e.employment_status ?? null,
      costCenters: alloc.rows.map((a) => ({ costCenterId: a.cost_center_id, percentage: Number(a.allocation_percentage) })),
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
    const ledger = new ComponentLedger();
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
      ledger.add({
        key: payment.paymentType === "earning" ? "offcycle_earning" : "offcycle_deduction",
        label: payment.label,
        category: payment.paymentType === "earning" ? "earning" : "employee_deduction",
        affects: payment.paymentType === "earning" ? "gross" : "net",
        amount: payment.paymentType === "earning" ? payment.amount : -payment.amount,
        isTaxable: payment.paymentType === "earning" && payment.isTaxable,
        sourceType: "off_cycle_payment",
        sourceId: payment.id,
      });
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
       WHERE p.employee_id = $1 AND pr.status IN ('finalized','accounting','payment_released','reconciled','closed','reopened') AND pr.is_simulation = false AND pr.period_end >= $2 AND pr.period_end < $3`,
      [employee.id, taxYearStart, periodStart]
    );
    const taxContext = await loadEmployeeTaxContext(client, employee.id, periodStart, periodEnd, taxYear);
    const priorYtdTaxable = Number(ytdResult.rows[0].taxable) + (taxContext?.previousEmployerIncome ?? 0);
    const priorYtdTaxWithheld = Number(ytdResult.rows[0].tax) + (taxContext?.previousEmployerTax ?? 0);
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
    const profileTax = taxContext ? computeAnnualTax(taxContext, estimatedAnnualTaxableIncome, taxFromSlabs) : null;
    const totalAnnualTaxEstimate = profileTax ? profileTax.annualTax : taxFromSlabs(estimatedAnnualTaxableIncome, taxSlabs);
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
    ledger.add({
      key: "income_tax",
      label: "Income tax on this off-cycle payment",
      category: "tax",
      affects: "net",
      amount: -incomeTaxMonthly,
      basisAmount: taxableGrossThisPeriod,
      sourceType: "tax",
      trace: {
        taxYear,
        estimatedAnnualTaxableIncome,
        priorYtdTaxable,
        priorYtdTaxWithheld,
        slabAnnualTax: totalAnnualTaxEstimate,
        taxDueToDate: totalTaxDueToDate,
        taxYearDaysElapsed: daysElapsedInclusive,
        taxYearTotalDays: totalDaysInTaxYear,
        formulaOverride: incomeTaxOverride === null ? null : { effectiveFrom: incomeTaxOverride.effectiveFrom, builtInAmount: Number(builtInIncomeTaxMonthly.toFixed(2)) },
        ...(taxContext && profileTax ? { taxProfile: taxProfileTrace(taxContext, profileTax) } : {}),
      },
    });
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
      consumedOvertime: [],
      employerCost: Number(grossPay.toFixed(2)),
      components: ledger.finish(Number(grossPay.toFixed(2)), Number(netPay.toFixed(2))),
      inputSnapshot: {
        period: { start: periodStart, end: periodEnd, daysInPeriod: inclusiveDayCount(periodStart, periodEnd) },
        employment: {
          dateOfJoining: toIsoDate(employee.date_of_joining),
          terminationDate: toIsoDateOrNull(employee.termination_date),
          windowStart: periodStart,
          windowEnd: periodEnd,
          windowDays: 0,
        },
        organisation: await this.loadOrganisationFacts(client, employee.id),
        workingDays: { mode: "calendar", prorationDays: 0, unit: "days", note: "off-cycle payment: nothing is prorated" },
        compensation: [],
        leave: { unpaidDays: 0, segments: [] },
        overtime: { claimCount: 0, minutes: 0, total: 0, claimIds: [] },
        adjustments: { additionalPaymentIds: [], offCyclePaymentIds: consumedOffCyclePayments.map((c) => c.offCyclePaymentId), loanIds: [] },
        tax: { taxYear, taxYearStart, taxYearEnd, priorYtdTaxable, priorYtdTaxWithheld, isFinalSettlement: false },
      } satisfies PayslipInputSnapshot,
      consumedLeave: [],
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
      `SELECT * FROM tax_slabs WHERE company_id = $1 AND status = 'published' AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)
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

  /** Phase P5 — company-wide only (no Payroll Areas scoping; this is a
   * format PREFERENCE, not a run-level action), gated by the same `.all`
   * tier that can actually generate/disburse the file. */
  private async requirePayrollDisburseAll(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, DISBURSE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to configure payroll disbursement settings");
    }
  }

  /** Lazily seeds `payroll_disbursement_settings` the first time a tenant
   * has none — same lazy-seed-with-retry-on-race pattern as
   * `loadOrSeedSettings()`, just over a plain table instead of the
   * EffectiveDatingEngine (this isn't a calculation input that needs
   * pinning to a run's period — see that table's own migration comment). */
  private async loadOrSeedDisbursementSettings(client: PoolClient, claims: RequestClaims): Promise<PayrollDisbursementSettingsView> {
    const existing = await client.query("SELECT * FROM payroll_disbursement_settings WHERE company_id = $1", [claims.company_id]);
    if ((existing.rowCount ?? 0) > 0) return rowToDisbursementSettings(existing.rows[0]);
    const inserted = await client.query(
      "INSERT INTO payroll_disbursement_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING RETURNING *",
      [claims.company_id]
    );
    if ((inserted.rowCount ?? 0) > 0) return rowToDisbursementSettings(inserted.rows[0]);
    const retry = await client.query("SELECT * FROM payroll_disbursement_settings WHERE company_id = $1", [claims.company_id]);
    return rowToDisbursementSettings(retry.rows[0]);
  }

  /**
   * Shared row-builder for `generateDisbursementFile()` AND
   * `previewDisbursementFile()` — exactly one definition of "who's
   * payable and what their bank details are" so the two can never drift.
   * Joins each employee's ACTIVE PRIMARY `employee_payment_accounts` row
   * (0086); falls back to the legacy flat `employees.bank_account_number`
   * column ONLY when no payment-account row exists at all, so a tenant who
   * hasn't touched the newer Payment/Bank card yet keeps getting a file
   * (with whatever they'd set the old way) rather than suddenly losing
   * every row. An employee is EXCLUDED (never given a blank/wrong account
   * number) when: they have no bank details at all; their payment method
   * is `cash`/`cheque` (not bank_transfer — simply not a bank-file row);
   * or they're nominally `bank_transfer` but have no account number on
   * file either way.
   */
  async buildDisbursementRows(
    client: PoolClient,
    runId: string,
    onlyPayslipIds?: string[]
  ): Promise<{
    rows: Array<Record<DisbursementFieldKey, string>>;
    /** Parallel to `rows`: what each payment item records. */
    entries: Array<{ payslipId: string; employeeId: string; employeeNumber: string; employeeName: string; amount: number; paymentMethod: string; bankName: string; accountTitle: string; accountNumber: string; iban: string; branchCode: string }>;
    excluded: Array<{ employeeNumber: string; employeeName: string; reason: string }>;
    totalNetPay: number;
  }> {
    const result = await client.query(
      `SELECT p.id AS payslip_id, p.employee_id, p.company_id, p.employee_number, p.net_pay, p.bank_account_number AS legacy_bank_account_number,
              e.first_name, e.last_name, e.cnic,
              pa.payment_method, pa.bank_name, pa.account_title, pa.account_number, pa.iban, pa.branch_code
       FROM payslips p
       JOIN employees e ON e.id = p.employee_id
       LEFT JOIN employee_payment_accounts pa
         ON pa.employee_id = p.employee_id AND pa.is_primary = true AND pa.status = 'active'
       WHERE p.payroll_run_id = $1 AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
       ORDER BY p.employee_number`,
      [runId, onlyPayslipIds ?? null]
    );

    const rows: Array<Record<DisbursementFieldKey, string>> = [];
    const entries: Array<{ payslipId: string; employeeId: string; employeeNumber: string; employeeName: string; amount: number; paymentMethod: string; bankName: string; accountTitle: string; accountNumber: string; iban: string; branchCode: string }> = [];
    const excluded: Array<{ employeeNumber: string; employeeName: string; reason: string }> = [];
    let totalNetPay = 0;

    for (const r of result.rows) {
      const employeeName = `${r.first_name} ${r.last_name}`.trim();
      // SEC-02: stored encrypted; the bank file is the one place the real values are needed.
      const plainAccountNumber = sensitive.decrypt(r.company_id, r.account_number);
      const plainLegacyAccount = sensitive.decrypt(r.company_id, r.legacy_bank_account_number);
      const plainCnic = sensitive.decrypt(r.company_id, r.cnic);
      const plainIban = sensitive.decrypt(r.company_id, r.iban);
      const resolvedAccountNumber: string | null = plainAccountNumber ?? plainLegacyAccount ?? null;
      const effectivePaymentMethod: string | null = r.payment_method ?? (plainLegacyAccount ? "bank_transfer" : null);

      if (!effectivePaymentMethod) {
        excluded.push({ employeeNumber: r.employee_number, employeeName, reason: "No payment account on file" });
        continue;
      }
      if (effectivePaymentMethod !== "bank_transfer") {
        excluded.push({
          employeeNumber: r.employee_number,
          employeeName,
          reason: `Paid by ${effectivePaymentMethod}, not bank transfer — not included in the bank file`,
        });
        continue;
      }
      if (!resolvedAccountNumber) {
        excluded.push({ employeeNumber: r.employee_number, employeeName, reason: "Bank transfer on file but missing an account number" });
        continue;
      }

      const netPay = Number(r.net_pay).toFixed(2);
      totalNetPay += Number(netPay);
      rows.push({
        employeeNumber: r.employee_number,
        employeeName,
        cnic: plainCnic ?? "",
        paymentMethod: effectivePaymentMethod,
        bankName: r.bank_name ?? "",
        accountTitle: r.account_title ?? "",
        accountNumber: resolvedAccountNumber,
        iban: plainIban ?? "",
        branchCode: r.branch_code ?? "",
        bankAccountNumber: resolvedAccountNumber,
        netPay,
      });
      entries.push({
        payslipId: r.payslip_id,
        employeeId: r.employee_id,
        employeeNumber: r.employee_number,
        employeeName,
        amount: Number(netPay),
        paymentMethod: effectivePaymentMethod,
        bankName: r.bank_name ?? "",
        accountTitle: r.account_title ?? "",
        accountNumber: resolvedAccountNumber,
        iban: plainIban ?? "",
        branchCode: r.branch_code ?? "",
      });
    }

    return { rows, entries, excluded, totalNetPay: Number(totalNetPay.toFixed(2)) };
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
