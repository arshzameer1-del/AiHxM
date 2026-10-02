import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { PayrollFormulaContractView, PayrollFormulaKey } from "@aihxm/shared-types";
import { FormulaEvaluationError, FormulaExpression, FormulaExpressionEngine } from "./formula-expression.engine";

/**
 * The evaluation-context CONTRACT for each payroll formula key — exactly
 * which variables a tenant's configured expression may reference, and
 * what each one means. This is a stable, public contract (it is served
 * verbatim by `GET /payroll/formulas/contract` and enforced when an
 * override is saved), so variables may be ADDED here later but must
 * never be renamed or removed: a saved override that references one
 * would start failing at calculation time.
 *
 * The TypeScript types below are DERIVED from these objects, so each call
 * site in `PayrollService.calculateOnePayslip()` is compile-time checked
 * to supply every documented variable, and nothing else.
 *
 * Every variable is the exact value already in scope at that call site
 * (unrounded — the same figures the built-in calculation itself uses),
 * plus `defaultAmount`: what the built-in calculation produced, so an
 * override can be expressed relative to it (e.g. `max(defaultAmount, X)`).
 */
const INCOME_TAX_VARIABLES = {
  defaultAmount: "The built-in income tax for this period: max(0, taxDueToDate - priorYtdTaxWithheld).",
  grossPay: "Gross pay this period (after unpaid-leave deduction, including overtime).",
  taxableGrossThisPeriod: "Taxable portion of this period's gross pay (taxable components + overtime).",
  recurringTaxableThisPeriod: "taxableGrossThisPeriod minus overtimePay — the portion projected forward across the tax year.",
  overtimePay: "Approved overtime pay this period (one-off; counted this period, never projected forward).",
  taxableAnnualIncome:
    "Estimated full tax-year taxable income: priorYtdTaxableIncome + taxableGrossThisPeriod + projected remainder (the payslip's taxableAnnualIncome).",
  priorYtdTaxableIncome: "Taxable income on this employee's FINALIZED payslips earlier in the same tax year (1 Jul - 30 Jun).",
  priorYtdTaxWithheld: "Income tax already withheld on this employee's FINALIZED payslips earlier in the same tax year.",
  slabAnnualTax: "Tax on taxableAnnualIncome per the tax-slab set in force at the run's periodEnd.",
  taxDueToDate: "slabAnnualTax x taxYearFractionElapsed — total tax that should have been withheld by the end of this period.",
  bracketMinAnnualIncome: "Lower bound of the tax slab taxableAnnualIncome falls in.",
  bracketBaseTax: "Fixed base tax of that slab.",
  bracketRatePercent: "Marginal rate (%) of that slab, applied to income above bracketMinAnnualIncome.",
  daysInPeriod: "Calendar days in the payroll period.",
  taxYearDaysElapsed: "Days of the tax year elapsed through the period end (inclusive).",
  taxYearTotalDays: "Total days in the tax year.",
  taxYearFractionElapsed: "taxYearDaysElapsed / taxYearTotalDays.",
} as const;

const EOBI_VARIABLES = {
  defaultAmount: "The built-in contribution: wageBase x (ratePercent / 100) x paidDaysRatio.",
  wageBase: "EOBI wage base from the payroll settings in force at the run's periodEnd.",
  ratePercent: "This contribution's EOBI rate (%) from those same settings (employee or employer rate, per formula key).",
  paidDays: "Days actually paid this period (employment-window days minus unpaid-leave days).",
  employmentWindowDays: "Days of the period the employee was employed (calendar or scheduled working days, per proration basis).",
  paidDaysRatio: "paidDays / employmentWindowDays (0 when employmentWindowDays is 0).",
  grossPay: "Gross pay this period (after unpaid-leave deduction, including overtime).",
} as const;

// Note on what is deliberately NOT exposed: the top tax slab's
// maxAnnualIncome is null (uncapped), and the engine only deals in finite
// numbers, so `bracketMaxAnnualIncome` is omitted rather than exposed as a
// variable that would fail for top-bracket earners only.

const PAYROLL_FORMULA_CONTRACT = {
  income_tax: {
    description: "Income tax withheld this period (replaces the built-in year-to-date cumulative average-rate calculation).",
    variables: INCOME_TAX_VARIABLES,
  },
  eobi_employee: {
    description: "EOBI employee contribution (deducted from net pay).",
    variables: EOBI_VARIABLES,
  },
  eobi_employer: {
    description: "EOBI employer contribution.",
    variables: EOBI_VARIABLES,
  },
} as const satisfies Record<PayrollFormulaKey, { description: string; variables: Record<string, string> }>;

export const PAYROLL_FORMULA_KEYS = Object.keys(PAYROLL_FORMULA_CONTRACT) as PayrollFormulaKey[];

/** The exact context object a formula key's call site must supply. */
export type PayrollFormulaContext<K extends PayrollFormulaKey> = {
  [V in keyof (typeof PAYROLL_FORMULA_CONTRACT)[K]["variables"]]: number;
};

export function isPayrollFormulaKey(value: unknown): value is PayrollFormulaKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PAYROLL_FORMULA_CONTRACT, value);
}

export function allowedVariablesFor(key: PayrollFormulaKey): ReadonlySet<string> {
  return new Set(Object.keys(PAYROLL_FORMULA_CONTRACT[key].variables));
}

/** A configured override that applied, with enough provenance for the payslip breakdown. */
export type PayrollFormulaResult = {
  value: number;
  formulaId: string;
  effectiveFrom: string;
};

/** A configured override that exists but could not produce a usable amount. Surfaces as a per-employee calculation error — never a silent fallback to the built-in figure, which would hide a misconfigured formula. */
export class PayrollFormulaError extends Error {
  constructor(
    readonly formulaKey: PayrollFormulaKey,
    readonly formulaId: string,
    message: string
  ) {
    super(message);
    this.name = "PayrollFormulaError";
  }
}

type FormulaRow = { id: string; formula_key: PayrollFormulaKey; expression: unknown; effective_from: unknown };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoDate(value: any): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/**
 * Every override in force for one company on one date — resolved ONCE per
 * payroll run (as of its own periodEnd, exactly like
 * `loadSettingsAsOf()`/`loadTaxSlabsAsOf()`), then evaluated per employee
 * with no further queries.
 */
export class ResolvedPayrollFormulas {
  constructor(
    private readonly engine: FormulaExpressionEngine,
    private readonly byKey: ReadonlyMap<PayrollFormulaKey, FormulaRow>
  ) {}

  /** `null` = no override configured for this key on this date: the caller MUST use its built-in calculation. */
  evaluate<K extends PayrollFormulaKey>(key: K, context: PayrollFormulaContext<K>): PayrollFormulaResult | null {
    const row = this.byKey.get(key);
    if (!row) return null;
    const effectiveFrom = toIsoDate(row.effective_from);
    const label = `Payroll formula override "${key}" (effective from ${effectiveFrom})`;
    let value: number;
    try {
      // Re-validated against the contract here, not only at save time —
      // defense in depth for a row written by anything other than
      // PayrollFormulaOverridesService.
      this.engine.validate(row.expression, allowedVariablesFor(key));
      value = this.engine.evaluate(row.expression as FormulaExpression, context);
    } catch (err) {
      if (err instanceof FormulaEvaluationError) throw new PayrollFormulaError(key, row.id, `${label} failed: ${err.message}`);
      throw err;
    }
    // A payslip deduction/contribution can never be negative (that would
    // silently INCREASE net pay); the built-in calculations all clamp at
    // 0, and a formula wanting that behavior can say max(0, ...) itself.
    if (value < 0) {
      throw new PayrollFormulaError(key, row.id, `${label} evaluated to a negative amount (${value}); wrap it in max(0, ...) if that is intended`);
    }
    return { value, formulaId: row.id, effectiveFrom };
  }
}

/**
 * Resolves and evaluates tenant formula overrides for payroll
 * calculation. Deliberately has no RBAC/entitlement dependency: it is only
 * ever called from inside an already-authorized payroll calculation's own
 * transaction (`client`), the same way `loadTaxSlabsAsOf()` is. Managing
 * overrides (with permission checks) is PayrollFormulaOverridesService.
 */
@Injectable()
export class PayrollFormulaService {
  constructor(private readonly engine: FormulaExpressionEngine) {}

  /** Every override in force for `companyId` on `asOfDate` (inclusive on both ends of each row's range). */
  async resolveAsOf(client: PoolClient, companyId: string, asOfDate: string): Promise<ResolvedPayrollFormulas> {
    const result = await client.query<FormulaRow>(
      `SELECT id, formula_key, expression, effective_from FROM payroll_formulas
       WHERE company_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)
       ORDER BY effective_from DESC`,
      [companyId, asOfDate]
    );
    const byKey = new Map<PayrollFormulaKey, FormulaRow>();
    // ORDER BY effective_from DESC + first-wins: if overlapping rows ever
    // existed despite the service-level guard, the most recent generation
    // decides (the same tie-break loadSettingsAsOf() uses).
    for (const row of result.rows) if (!byKey.has(row.formula_key)) byKey.set(row.formula_key, row);
    return new ResolvedPayrollFormulas(this.engine, byKey);
  }

  /**
   * Single-key convenience: look up the override for `formulaKey` in force
   * on `asOfDate` and evaluate it against `context`. Returns `null` when
   * none is configured, telling the caller to fall back to its built-in
   * calculation. (`calculateRun()` uses `resolveAsOf()` once per run
   * instead, so a 500-employee run doesn't issue 1,500 lookups.)
   */
  async resolveAndEvaluate<K extends PayrollFormulaKey>(
    client: PoolClient,
    companyId: string,
    formulaKey: K,
    asOfDate: string,
    context: PayrollFormulaContext<K>
  ): Promise<PayrollFormulaResult | null> {
    const resolved = await this.resolveAsOf(client, companyId, asOfDate);
    return resolved.evaluate(formulaKey, context);
  }

  /** Save-time check: shape + only this key's documented variables. Throws FormulaEvaluationError. */
  validateExpression(formulaKey: PayrollFormulaKey, expression: unknown): void {
    this.engine.validate(expression, allowedVariablesFor(formulaKey));
  }

  contract(): PayrollFormulaContractView[] {
    return PAYROLL_FORMULA_KEYS.map((key) => ({
      formulaKey: key,
      description: PAYROLL_FORMULA_CONTRACT[key].description,
      variables: Object.entries(PAYROLL_FORMULA_CONTRACT[key].variables).map(([name, description]) => ({ name, description })),
    }));
  }
}
