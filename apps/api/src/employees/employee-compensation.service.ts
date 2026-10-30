import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { FormulaExpressionEngine, type FormulaExpression } from "../payroll/formula-expression.engine";
import type {
  CompensationCalculationType,
  CompensationComponentRules,
  CompensationComponentType,
  CompensationComponentView,
  CompensationEligibility,
  CompensationPayFrequency,
  CompensationView,
  CreateCompensationComponentRequest,
  EmployeeCompensationView,
  SetCompensationRequest,
  SetEmployeeCompensationComponentsRequest,
  UpdateCompensationComponentRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";
const BASIC_SALARY_KEY = "basic_salary";

const COMPONENT_TYPES: CompensationComponentType[] = [
  "earning",
  "deduction",
  "employer_contribution",
  "reimbursement",
  "non_cash_benefit",
  "arrears",
  "retro",
  "shift_premium",
];
/** Types that never carry a taxable flag of their own: money taken back, paid by the employer on top, or repaid expenses. */
const NEVER_TAXABLE_TYPES = new Set<CompensationComponentType>(["deduction", "employer_contribution", "reimbursement", "non_cash_benefit"]);
/** Types that add to the employee's gross pay (and may be the basis of a percentage). */
const EARNING_LIKE_TYPES = new Set<CompensationComponentType>(["earning", "reimbursement", "arrears", "retro", "shift_premium"]);
const FORMULA_VARIABLES = new Set(["basic_salary", "gross_fixed_earnings", "units", "percentage", "amount"]);
const CALCULATION_TYPES: CompensationCalculationType[] = ["fixed", "percentage", "per_unit", "formula", "threshold"];

type ComponentRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The columns of a catalog row that the engine needs next to an employee's amount (aliased `component_*`). */
const COMPONENT_JOIN_COLUMNS = `cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable, cc.component_type,
       cc.calculation_type AS component_calculation_type`;

// The standard starter compensation-component catalog, lazily seeded per
// company the first time this service needs one and finds none — the
// same lazy-seed pattern PayrollService already used for tax slabs/payroll
// settings before this ownership move. Every component defaults to
// taxable=true: Payroll Enterprise Gap Analysis Phase P1 deliberately does
// NOT presume any allowance is tax-exempt without a real accountant
// confirming a specific exemption applies (see
// claude/statutory-payroll-rates-pakistan.md). A tenant's HR/Finance admin
// can flip is_taxable per component, or add their own.
const DEFAULT_COMPONENTS: Array<{ key: string; name: string; sortOrder: number }> = [
  { key: BASIC_SALARY_KEY, name: "Basic Salary", sortOrder: 0 },
  { key: "house_rent_allowance", name: "House Rent Allowance", sortOrder: 1 },
  { key: "medical_allowance", name: "Medical Allowance", sortOrder: 2 },
  { key: "conveyance_allowance", name: "Conveyance Allowance", sortOrder: 3 },
  { key: "utilities_allowance", name: "Utilities Allowance", sortOrder: 4 },
  { key: "other_allowance", name: "Other Allowance", sortOrder: 5 },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value === null || value === undefined) return null;
  return value?.toISOString ? value.toISOString() : value;
}

const MAX_COMPONENT_AMOUNT = 1_000_000_000;

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

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "component";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToComponent(row: any): CompensationComponentView {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.id,
    companyId: row.company_id,
    key: row.key,
    name: row.name,
    isTaxable: row.is_taxable,
    componentType: row.component_type as CompensationComponentType,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at) as string,
    categoryCatalogItemId: row.category_catalog_item_id ?? null,
    calculationType: (row.calculation_type ?? "fixed") as CompensationCalculationType,
    basisType: row.basis_type ?? "none",
    basisComponentId: row.basis_component_id ?? null,
    defaultPercentage: num(row.default_percentage),
    unitRate: num(row.unit_rate),
    unitLabel: row.unit_label ?? null,
    thresholdAmount: num(row.threshold_amount),
    formulaExpression: row.formula_expression ?? null,
    capAmount: num(row.cap_amount),
    floorAmount: num(row.floor_amount),
    roundingMode: row.rounding_mode ?? "none",
    roundingIncrement: Number(row.rounding_increment ?? 1),
    prorationMode: row.proration_mode ?? "prorated",
    eligibility: (row.eligibility ?? {}) as CompensationEligibility,
    countsTowardEobiBase: row.counts_toward_eobi_base ?? true,
    countsTowardGratuityBase: row.counts_toward_gratuity_base ?? false,
    countsTowardProvidentFundBase: row.counts_toward_provident_fund_base ?? false,
    glAccountCode: row.gl_account_code ?? null,
    payslipLabel: row.payslip_label ?? null,
    displayOrder: row.display_order ?? 0,
  };
}

/** Maps one `employee_compensation_components` row JOINed to its
 * `compensation_components` catalog row (columns aliased `component_*`
 * by every query below) into the flattened `CompensationView` shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCompensationRow(row: any): CompensationView {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    componentId: row.component_id,
    componentKey: row.component_key,
    componentName: row.component_name,
    isTaxable: row.component_is_taxable,
    componentType: row.component_type as CompensationComponentType,
    amount: Number(row.amount),
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: toIsoDateOrNull(row.effective_to),
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
    calculationType: (row.component_calculation_type ?? "fixed") as CompensationCalculationType,
    percentage: row.percentage === null || row.percentage === undefined ? null : Number(row.percentage),
    units: row.units === null || row.units === undefined ? null : Number(row.units),
    enteredAmount: row.entered_amount === null || row.entered_amount === undefined ? null : Number(row.entered_amount),
    payFrequency: (row.pay_frequency ?? "monthly") as CompensationPayFrequency,
    currencyCode: row.currency_code ?? "PKR",
    changeReasonCatalogItemId: row.change_reason_catalog_item_id ?? null,
    changeReasonNote: row.change_reason_note ?? null,
    salaryGradeId: row.salary_grade_id ?? null,
  };
}

/**
 * Core Employee master data — the SAP IT0008 (Basic Pay) / IT0014
 * (Recurring Payments/Deductions) equivalent. Moved here (2026-09-27,
 * kumail's own architecture correction) from PayrollService, where Payroll
 * Enterprise Gap Analysis Phase P1 had originally built it: recurring
 * compensation is a fact ABOUT an employee — maintained here the same way
 * every other Core Employee sub-entity (contacts, addresses, payment
 * accounts, cost allocations) is — not a Payroll-owned record. Payroll
 * only ever READS this data (a direct SQL join inside
 * `PayrollService.calculateOnePayslip()`, never through this service) to
 * calculate a run, exactly as it already reads `leave_requests` for unpaid
 * leave — cross-module reads go straight to SQL, cross-module WRITES go
 * through an explicit service call
 * (`setCompensationWithinTransaction()` below, called by
 * `HiringProcessService.complete()`).
 *
 * A later phase's IT0015-equivalent ("Additional Payments" — one-time,
 * non-recurring pay) and IT0267-equivalent ("Additional Off-Cycle
 * Payments" — one-time, tied to a specific off-cycle run) both belong here
 * too, for the same reason, when they're built — see
 * claude/payroll-enterprise-gap-analysis-and-roadmap.md.
 *
 * Nothing about the underlying data model changed in this move — same
 * `compensation_components`/`employee_compensation_components` tables
 * (migration 0092), same effective-dating via the shared
 * `EffectiveDatingEngine`, same component-based (not one flat
 * `monthlySalary` figure) shape. Only the module that OWNS writing to it,
 * and the permission it's gated by (`employee.manage.all`, like every
 * other Core Employee sub-entity, not `payroll.manage.all`), changed.
 */
@Injectable()
export class EmployeeCompensationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  /** Stateless numeric evaluator (same class payroll formula overrides use); not injected so existing constructions keep working. */
  private readonly formulaEngine = new FormulaExpressionEngine();

  // --- Compensation components (catalog) -----------------------------------

  async listCompensationComponents(claims: RequestClaims): Promise<CompensationComponentView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, (client) => this.loadOrSeedComponents(client, claims));
  }

  async createCompensationComponent(claims: RequestClaims, input: CreateCompensationComponentRequest): Promise<CompensationComponentView> {
    await this.requireManage(claims);
    const name = input.name.trim();
    if (!name) throw new BadRequestException("A component name is required");
    const key = (input.key?.trim() || slugify(name)).toLowerCase();
    const componentType: CompensationComponentType = input.componentType ?? "earning";
    if (!COMPONENT_TYPES.includes(componentType)) throw new BadRequestException(`Unknown component type "${componentType}"`);
    // A deduction, an employer contribution, a reimbursement or a non-cash benefit is never "taxable" in the
    // earnings sense - the flag has no meaning for it. Forced here regardless of what the caller sent, same
    // "the service enforces this, not just the UI" posture every other invariant in this file already takes.
    const isTaxable = NEVER_TAXABLE_TYPES.has(componentType) ? false : input.isTaxable ?? true;
    return this.db.withClaims(claims, async (client) => {
      await this.loadOrSeedComponents(client, claims);
      const existing = await client.query("SELECT 1 FROM compensation_components WHERE company_id = $1 AND key = $2", [
        claims.company_id,
        key,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException(`A compensation component with key "${key}" already exists`);
      }
      const rules = this.mergeRules(null, input);
      await this.validateRules(client, claims.company_id!, null, componentType, rules);
      const maxSort = await client.query("SELECT COALESCE(MAX(sort_order), -1) AS max FROM compensation_components WHERE company_id = $1", [
        claims.company_id,
      ]);
      const sortOrder = Number(maxSort.rows[0].max) + 1;
      const result = await client.query(
        `INSERT INTO compensation_components (company_id, key, name, is_taxable, component_type, sort_order,
           category_catalog_item_id, calculation_type, basis_type, basis_component_id, default_percentage, unit_rate, unit_label,
           threshold_amount, formula_expression, cap_amount, floor_amount, rounding_mode, rounding_increment, proration_mode,
           eligibility, counts_toward_eobi_base, counts_toward_gratuity_base, counts_toward_provident_fund_base,
           gl_account_code, payslip_label, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$27)
         RETURNING *`,
        [
          claims.company_id, key, name, isTaxable, componentType, sortOrder,
          ...this.ruleParams(rules, sortOrder),
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "compensation_component.create",
        target: result.rows[0].id,
        metadata: { key, name, componentType, calculationType: rules.calculationType },
      });
      return rowToComponent(result.rows[0]);
    });
  }

  async updateCompensationComponent(
    claims: RequestClaims,
    id: string,
    patch: UpdateCompensationComponentRequest
  ): Promise<CompensationComponentView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const existing = await client.query("SELECT * FROM compensation_components WHERE id = $1", [id]);
      if (existing.rowCount === 0) throw new NotFoundException("Compensation component not found");
      const current = existing.rows[0];
      // componentType itself is immutable after creation (same as `key`) - changing earning<->deduction underneath
      // amounts already set against it would silently flip what every existing effective-dated row means. A
      // component that is never taxable stays forced non-taxable regardless of what's patched, same as create().
      const isTaxable = NEVER_TAXABLE_TYPES.has(current.component_type) ? false : patch.isTaxable ?? current.is_taxable;
      const merged = this.mergeRules(rowToComponent(current), patch);
      if (merged.calculationType !== current.calculation_type) {
        const inUse = await client.query("SELECT 1 FROM employee_compensation_components WHERE component_id = $1 LIMIT 1", [id]);
        if ((inUse.rowCount ?? 0) > 0) {
          throw new BadRequestException("How this component is calculated cannot change once employees are paid with it; create a new component instead");
        }
      }
      await this.validateRules(client, claims.company_id!, id, current.component_type, merged);
      const result = await client.query(
        `UPDATE compensation_components
            SET name = $2, is_taxable = $3, is_active = $4, sort_order = $5,
                category_catalog_item_id = $6, calculation_type = $7, basis_type = $8, basis_component_id = $9, default_percentage = $10,
                unit_rate = $11, unit_label = $12, threshold_amount = $13, formula_expression = $14::jsonb, cap_amount = $15, floor_amount = $16,
                rounding_mode = $17, rounding_increment = $18, proration_mode = $19, eligibility = $20::jsonb,
                counts_toward_eobi_base = $21, counts_toward_gratuity_base = $22, counts_toward_provident_fund_base = $23,
                gl_account_code = $24, payslip_label = $25, display_order = $26
          WHERE id = $1 RETURNING *`,
        [
          id,
          patch.name?.trim() || current.name,
          isTaxable,
          patch.isActive ?? current.is_active,
          patch.sortOrder ?? current.sort_order,
          ...this.ruleParams(merged, current.display_order),
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "compensation_component.update",
        target: id,
        metadata: { calculationType: merged.calculationType },
      });
      return rowToComponent(result.rows[0]);
    });
  }

  /** A component's rules after applying a patch to what it already had (or the defaults, for a new one). */
  private mergeRules(current: CompensationComponentView | null, patch: CompensationComponentRules): Required<CompensationComponentRules> {
    const pick = <K extends keyof CompensationComponentRules>(key: K, fallback: NonNullable<CompensationComponentRules[K]> | null) =>
      (patch[key] !== undefined ? patch[key] : current ? (current as unknown as Record<string, unknown>)[key as string] : fallback) as Required<CompensationComponentRules>[K];
    return {
      categoryCatalogItemId: pick("categoryCatalogItemId", null),
      calculationType: pick("calculationType", "fixed"),
      basisType: pick("basisType", "none"),
      basisComponentId: pick("basisComponentId", null),
      defaultPercentage: pick("defaultPercentage", null),
      unitRate: pick("unitRate", null),
      unitLabel: pick("unitLabel", null),
      thresholdAmount: pick("thresholdAmount", null),
      formulaExpression: pick("formulaExpression", null),
      capAmount: pick("capAmount", null),
      floorAmount: pick("floorAmount", null),
      roundingMode: pick("roundingMode", "none"),
      roundingIncrement: pick("roundingIncrement", 1),
      prorationMode: pick("prorationMode", "prorated"),
      eligibility: pick("eligibility", {}),
      countsTowardEobiBase: pick("countsTowardEobiBase", true),
      countsTowardGratuityBase: pick("countsTowardGratuityBase", false),
      countsTowardProvidentFundBase: pick("countsTowardProvidentFundBase", false),
      glAccountCode: pick("glAccountCode", null),
      payslipLabel: pick("payslipLabel", null),
      displayOrder: pick("displayOrder", 0),
    };
  }

  /** Positional parameters ($7...$27) of the INSERT / ($6...$26) of the UPDATE, in column order. */
  private ruleParams(r: Required<CompensationComponentRules>, defaultDisplayOrder: number): unknown[] {
    return [
      r.categoryCatalogItemId,
      r.calculationType,
      r.basisType,
      r.basisComponentId,
      r.defaultPercentage,
      r.unitRate,
      r.unitLabel?.trim() || null,
      r.thresholdAmount,
      r.formulaExpression === null || r.formulaExpression === undefined ? null : JSON.stringify(r.formulaExpression),
      r.capAmount,
      r.floorAmount,
      r.roundingMode,
      r.roundingIncrement,
      r.prorationMode,
      JSON.stringify(r.eligibility ?? {}),
      r.countsTowardEobiBase,
      r.countsTowardGratuityBase,
      r.countsTowardProvidentFundBase,
      r.glAccountCode?.trim() || null,
      r.payslipLabel?.trim() || null,
      r.displayOrder ?? defaultDisplayOrder,
    ];
  }

  private async validateRules(
    client: PoolClient,
    companyId: string,
    selfId: string | null,
    componentType: CompensationComponentType,
    r: Required<CompensationComponentRules>
  ): Promise<void> {
    if (!CALCULATION_TYPES.includes(r.calculationType)) throw new BadRequestException(`Unknown calculation type "${r.calculationType}"`);
    if (!["none", "nearest", "up", "down"].includes(r.roundingMode)) throw new BadRequestException("Unknown rounding mode");
    if (!(r.roundingIncrement > 0)) throw new BadRequestException("The rounding increment must be greater than zero");
    if (r.capAmount !== null && r.floorAmount !== null && r.floorAmount > r.capAmount) throw new BadRequestException("The floor cannot be higher than the cap");
    if (r.calculationType !== "fixed" && !EARNING_LIKE_TYPES.has(componentType) && componentType !== "deduction" && componentType !== "employer_contribution") {
      throw new BadRequestException("A non-cash benefit can only be a fixed amount");
    }
    if (r.calculationType === "percentage") {
      if (r.defaultPercentage === null) throw new BadRequestException("A percentage component needs a default percentage");
      if (r.basisType === "none") throw new BadRequestException("A percentage component needs a basis (basic salary, another component or gross fixed earnings)");
    }
    if (r.calculationType === "threshold") {
      if (r.thresholdAmount === null) throw new BadRequestException("A threshold component needs a threshold amount");
      if (r.basisType === "none") throw new BadRequestException("A threshold component needs a basis to compare with the threshold");
    }
    if (r.calculationType === "formula") {
      if (r.formulaExpression === null) throw new BadRequestException("A formula component needs a formula");
      try {
        this.formulaEngine.validate(r.formulaExpression, FORMULA_VARIABLES);
      } catch (err) {
        throw new BadRequestException(`Formula is not valid: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (r.basisType === "component") {
      if (!r.basisComponentId) throw new BadRequestException("Choose the component the basis is taken from");
      if (r.basisComponentId === selfId) throw new BadRequestException("A component cannot be based on itself");
      const basis = await client.query("SELECT component_type, calculation_type, is_active FROM compensation_components WHERE id = $1 AND company_id = $2", [
        r.basisComponentId,
        companyId,
      ]);
      if (basis.rowCount === 0) throw new BadRequestException("The basis component does not exist");
      if (basis.rows[0].calculation_type !== "fixed" || !EARNING_LIKE_TYPES.has(basis.rows[0].component_type)) {
        throw new BadRequestException("The basis must be a fixed-amount earning (a derived component cannot be the basis of another)");
      }
    } else if (r.basisComponentId) {
      throw new BadRequestException("A basis component was given but the basis type is not 'component'");
    }
    const el = r.eligibility ?? {};
    if (el.minServiceMonths !== undefined && (!Number.isInteger(el.minServiceMonths) || el.minServiceMonths < 0)) {
      throw new BadRequestException("Minimum service must be a whole number of months");
    }
    if (el.employmentTypeCatalogItemIds !== undefined) {
      if (!Array.isArray(el.employmentTypeCatalogItemIds)) throw new BadRequestException("Employment types must be a list");
      if (el.employmentTypeCatalogItemIds.length > 0) {
        const found = await client.query(
          "SELECT count(*)::int AS n FROM hr_reference_catalog_items WHERE id = ANY($1::uuid[]) AND company_id = $2 AND catalog_type = 'employment_type'",
          [el.employmentTypeCatalogItemIds, companyId]
        );
        if (found.rows[0].n !== new Set(el.employmentTypeCatalogItemIds).size) throw new BadRequestException("An employment type in the eligibility rule does not exist");
      }
    }
    if (r.categoryCatalogItemId) {
      const cat = await client.query("SELECT 1 FROM hr_reference_catalog_items WHERE id = $1 AND company_id = $2 AND catalog_type = 'component_category'", [
        r.categoryCatalogItemId,
        companyId,
      ]);
      if (cat.rowCount === 0) throw new BadRequestException("The component category does not exist");
    }
  }

  // --- Compensation (per-employee amounts) ---------------------------------

  /**
   * Back-compat, single-component convenience — the Hiring Wizard's
   * Compensation card still calls this shape (`{employeeId, monthlySalary,
   * effectiveFrom}`); it sets ONLY the "Basic Salary" component (seeding
   * the standard catalog for the tenant first if needed) rather than
   * writing to the retired `employee_compensation` table. Anyone paying
   * more than Basic Salary uses `setCompensationComponents()`.
   */
  async setCompensation(claims: RequestClaims, input: SetCompensationRequest): Promise<CompensationView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.setCompensationWithinTransaction(client, claims, input));
  }

  /**
   * Split out of `setCompensation()` above for exactly the reason
   * `EmployeesService.createWithinTransaction()` exists: HiringProcessService's
   * `compensation` card calls this directly, inside the SAME transaction
   * that creates the new employee.
   */
  async setCompensationWithinTransaction(client: PoolClient, claims: RequestClaims, input: SetCompensationRequest): Promise<CompensationView> {
    const employee = await this.loadEmployee(client, input.employeeId);
    if (!employee) throw new NotFoundException("Employee not found");

    const components = await this.loadOrSeedComponents(client, claims);
    const basic = components.find((c) => c.key === BASIC_SALARY_KEY);
    if (!basic) throw new Error("Basic Salary component missing from catalog — this should never happen");

    const written = await this.applyEntries(client, claims, {
      employeeId: input.employeeId,
      effectiveFrom: input.effectiveFrom,
      entries: [{ componentId: basic.id, amount: input.monthlySalary }],
    });
    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "compensation.set",
      target: input.employeeId,
      metadata: { componentKey: BASIC_SALARY_KEY, amount: input.monthlySalary, effectiveFrom: input.effectiveFrom },
    });
    return written.get(basic.id)!;
  }

  /**
   * Sets one or more components' amounts for an employee as of the same
   * date in one call. A component left out of `input.components` is
   * untouched — bumping just Basic Salary doesn't require resubmitting
   * every allowance (each component is independently effective-dated).
   * A percentage / threshold / formula component that depends on what was
   * changed is re-resolved automatically from the same date, so "house rent
   * = 45% of basic" follows a raise without anyone re-typing it.
   */
  async setCompensationComponents(claims: RequestClaims, input: SetEmployeeCompensationComponentsRequest): Promise<EmployeeCompensationView> {
    await this.requireManage(claims);
    if (input.components.length === 0) throw new BadRequestException("At least one component amount is required");
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      await this.applyEntries(client, claims, {
        employeeId: input.employeeId,
        effectiveFrom: input.effectiveFrom,
        entries: input.components,
        payFrequency: input.payFrequency,
        currencyCode: input.currencyCode,
        changeReasonCatalogItemId: input.changeReasonCatalogItemId,
        changeReasonNote: input.changeReasonNote,
        salaryGradeId: input.salaryGradeId,
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "compensation.set_components",
        target: input.employeeId,
        metadata: {
          effectiveFrom: input.effectiveFrom,
          componentIds: input.components.map((c) => c.componentId),
          changeReasonCatalogItemId: input.changeReasonCatalogItemId ?? null,
        },
      });
      return this.loadCurrentCompensation(client, claims, input.employeeId);
    });
  }

  /** Validates, resolves and writes the given entries (fixed and per-unit first, so derived ones can read them), then cascades. */
  private async applyEntries(
    client: PoolClient,
    claims: RequestClaims,
    args: {
      employeeId: string;
      effectiveFrom: string;
      entries: Array<{ componentId: string; amount?: number; percentage?: number; units?: number }>;
      payFrequency?: CompensationPayFrequency;
      currencyCode?: string;
      changeReasonCatalogItemId?: string | null;
      changeReasonNote?: string | null;
      salaryGradeId?: string | null;
    }
  ): Promise<Map<string, CompensationView>> {
    const catalog = await this.loadOrSeedComponents(client, claims);
    const byId = new Map(catalog.map((c) => [c.id, c]));
    const payFrequency: CompensationPayFrequency = args.payFrequency ?? "monthly";
    if (!["monthly", "annual"].includes(payFrequency)) throw new BadRequestException("Pay frequency must be monthly or annual");
    const currencyCode = (args.currencyCode ?? "PKR").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw new BadRequestException("Currency must be a three-letter code");
    if (args.changeReasonCatalogItemId) {
      const reason = await client.query(
        "SELECT 1 FROM hr_reference_catalog_items WHERE id = $1 AND company_id = $2 AND catalog_type = 'lifecycle_reason:compensation_change'",
        [args.changeReasonCatalogItemId, claims.company_id]
      );
      if (reason.rowCount === 0) throw new BadRequestException("The compensation change reason does not exist");
    }

    await this.assertSaneEffectiveDate(client, args.employeeId, args.effectiveFrom);

    for (const entry of args.entries) {
      const def = byId.get(entry.componentId);
      if (!def) throw new BadRequestException(`Unknown compensation component: ${entry.componentId}`);
      if ((entry.amount ?? 0) > MAX_COMPONENT_AMOUNT) throw new BadRequestException(`The amount for "${def.name}" is too large. Check the figure.`);
      if (!def.isActive) throw new BadRequestException(`Compensation component "${def.name}" is not active`);
      if (def.componentType === "non_cash_benefit") {
        throw new BadRequestException(`"${def.name}" is a non-cash benefit; its tax treatment needs your accountant's rule before it can be paid through payroll`);
      }
      for (const [label, v] of [["amount", entry.amount], ["percentage", entry.percentage], ["units", entry.units]] as const) {
        if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new BadRequestException(`A component ${label} cannot be negative`);
      }
      if (payFrequency === "annual" && !["fixed", "threshold"].includes(def.calculationType)) {
        throw new BadRequestException(`"${def.name}" is ${def.calculationType.replace("_", "-")}; annual entry is only for fixed-amount components`);
      }
    }

    const common = {
      payFrequency,
      currencyCode,
      changeReasonCatalogItemId: args.changeReasonCatalogItemId ?? null,
      changeReasonNote: args.changeReasonNote?.trim() || null,
      salaryGradeId: args.salaryGradeId ?? null,
    };
    const ordered = [...args.entries].sort((a, b) => {
      const rank = (id: string) => (["fixed", "per_unit"].includes(byId.get(id)!.calculationType) ? 0 : 1);
      return rank(a.componentId) - rank(b.componentId);
    });
    const written = new Map<string, CompensationView>();
    for (const entry of ordered) {
      const def = byId.get(entry.componentId)!;
      const resolved = await this.resolveAmount(client, def, entry, args.employeeId, args.effectiveFrom, payFrequency, catalog);
      written.set(def.id, await this.writeRow(client, claims, args.employeeId, def.id, args.effectiveFrom, resolved, common));
    }
    await this.cascadeDependents(client, claims, args.employeeId, args.effectiveFrom, new Set(written.keys()), catalog, common, written);
    return written;
  }

  /** The monthly amount of a component for an employee, from what was typed and the component's rules. */
  private async resolveAmount(
    client: PoolClient,
    def: CompensationComponentView,
    entry: { amount?: number; percentage?: number; units?: number },
    employeeId: string,
    asOf: string,
    payFrequency: CompensationPayFrequency,
    catalog: CompensationComponentView[]
  ): Promise<{ monthly: number; entered: number | null; percentage: number | null; units: number | null }> {
    const need = <T,>(value: T | undefined | null, what: string): T => {
      if (value === undefined || value === null) throw new BadRequestException(`"${def.name}" needs ${what}`);
      return value;
    };
    const toMonthly = (typed: number) => (payFrequency === "annual" ? typed / 12 : typed);
    let monthly: number;
    let entered: number | null = entry.amount ?? null;
    let percentage: number | null = null;
    let units: number | null = null;
    switch (def.calculationType) {
      case "fixed":
        monthly = toMonthly(need(entry.amount, "an amount"));
        break;
      case "per_unit": {
        const rate = entry.amount ?? def.unitRate;
        units = need(entry.units, `the number of ${def.unitLabel ?? "units"}`);
        entered = need(rate, "a rate per unit");
        monthly = units * entered;
        break;
      }
      case "percentage": {
        percentage = entry.percentage ?? def.defaultPercentage;
        monthly = (need(percentage, "a percentage") / 100) * (await this.basisAmount(client, def, employeeId, asOf, catalog));
        entered = null;
        break;
      }
      case "threshold": {
        const basis = await this.basisAmount(client, def, employeeId, asOf, catalog);
        monthly = basis >= need(def.thresholdAmount, "a threshold") ? toMonthly(need(entry.amount, "an amount")) : 0;
        break;
      }
      case "formula": {
        percentage = entry.percentage ?? null;
        units = entry.units ?? null;
        const vars = {
          basic_salary: await this.componentAmountAsOf(client, employeeId, catalog.find((c) => c.key === BASIC_SALARY_KEY)?.id, asOf),
          gross_fixed_earnings: await this.grossFixedEarnings(client, employeeId, asOf, catalog),
          units: units ?? 0,
          percentage: percentage ?? 0,
          amount: entry.amount ?? 0,
        };
        try {
          monthly = this.formulaEngine.evaluate(need(def.formulaExpression as FormulaExpression | null, "a formula") as FormulaExpression, vars);
        } catch (err) {
          throw new BadRequestException(`Formula for "${def.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      default:
        throw new BadRequestException(`Unsupported calculation type "${def.calculationType}"`);
    }
    return { monthly: this.finishAmount(def, monthly), entered, percentage, units };
  }

  /** Cap, floor and rounding of a resolved monthly amount (a threshold that was not met stays zero). */
  private finishAmount(def: CompensationComponentView, monthly: number): number {
    let v = monthly;
    if (v === 0 && def.calculationType === "threshold") return 0;
    if (def.capAmount !== null) v = Math.min(v, def.capAmount);
    if (def.floorAmount !== null) v = Math.max(v, def.floorAmount);
    const inc = def.roundingIncrement;
    if (def.roundingMode === "nearest") v = Math.round(v / inc) * inc;
    else if (def.roundingMode === "up") v = Math.ceil(v / inc - 1e-9) * inc;
    else if (def.roundingMode === "down") v = Math.floor(v / inc + 1e-9) * inc;
    return Number(Math.max(0, v).toFixed(2));
  }

  private async basisAmount(client: PoolClient, def: CompensationComponentView, employeeId: string, asOf: string, catalog: CompensationComponentView[]): Promise<number> {
    if (def.basisType === "gross_fixed_earnings") return this.grossFixedEarnings(client, employeeId, asOf, catalog);
    const basisId = def.basisType === "basic_salary" ? catalog.find((c) => c.key === BASIC_SALARY_KEY)?.id : (def.basisComponentId ?? undefined);
    const amount = await this.componentAmountAsOf(client, employeeId, basisId, asOf);
    if (amount === null) {
      const name = def.basisType === "basic_salary" ? "Basic Salary" : (catalog.find((c) => c.id === basisId)?.name ?? "its basis component");
      throw new BadRequestException(`"${def.name}" is based on ${name}, which is not set for this employee on ${asOf}; set it first`);
    }
    return amount;
  }

  private async componentAmountAsOf(client: PoolClient, employeeId: string, componentId: string | undefined, asOf: string): Promise<number | null> {
    if (!componentId) return null;
    const r = await client.query(
      `SELECT amount FROM employee_compensation_components
        WHERE employee_id = $1 AND component_id = $2 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)
        ORDER BY effective_from DESC LIMIT 1`,
      [employeeId, componentId, asOf]
    );
    return r.rowCount === 0 ? null : Number(r.rows[0].amount);
  }

  private async grossFixedEarnings(client: PoolClient, employeeId: string, asOf: string, catalog: CompensationComponentView[]): Promise<number> {
    const ids = catalog.filter((c) => c.isActive && c.calculationType === "fixed" && EARNING_LIKE_TYPES.has(c.componentType)).map((c) => c.id);
    if (ids.length === 0) return 0;
    const r = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM employee_compensation_components
        WHERE employee_id = $1 AND component_id = ANY($2::uuid[]) AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)`,
      [employeeId, ids, asOf]
    );
    return Number(r.rows[0].total);
  }

  /** Re-resolves every derived component of the employee that reads something this call changed. */
  private async cascadeDependents(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    effectiveFrom: string,
    changed: Set<string>,
    catalog: CompensationComponentView[],
    common: { payFrequency: CompensationPayFrequency; currencyCode: string; changeReasonCatalogItemId: string | null; changeReasonNote: string | null; salaryGradeId: string | null },
    written: Map<string, CompensationView>
  ): Promise<void> {
    const basicId = catalog.find((c) => c.key === BASIC_SALARY_KEY)?.id;
    const fixedEarningChanged = [...changed].some((id) => {
      const c = catalog.find((x) => x.id === id);
      return !!c && c.calculationType === "fixed" && EARNING_LIKE_TYPES.has(c.componentType);
    });
    for (const dep of catalog) {
      if (!dep.isActive || changed.has(dep.id) || !["percentage", "threshold", "formula"].includes(dep.calculationType)) continue;
      const affected =
        dep.calculationType === "formula" ||
        (dep.basisType === "basic_salary" && basicId !== undefined && changed.has(basicId)) ||
        (dep.basisType === "component" && dep.basisComponentId !== null && changed.has(dep.basisComponentId)) ||
        (dep.basisType === "gross_fixed_earnings" && fixedEarningChanged);
      if (!affected) continue;
      const cur = await client.query(
        "SELECT * FROM employee_compensation_components WHERE employee_id = $1 AND component_id = $2 AND effective_to IS NULL",
        [employeeId, dep.id]
      );
      if (cur.rowCount === 0) continue; // the employee is not paid this component
      const row = cur.rows[0];
      const resolved = await this.resolveAmount(
        client,
        dep,
        { amount: row.entered_amount === null ? undefined : Number(row.entered_amount), percentage: row.percentage === null ? undefined : Number(row.percentage), units: row.units === null ? undefined : Number(row.units) },
        employeeId,
        effectiveFrom,
        row.pay_frequency,
        catalog
      );
      if (Number(row.amount) === resolved.monthly) continue;
      written.set(
        dep.id,
        await this.writeRow(client, claims, employeeId, dep.id, effectiveFrom, resolved, {
          ...common,
          payFrequency: row.pay_frequency,
          currencyCode: row.currency_code,
          changeReasonNote: common.changeReasonNote ?? `Recalculated: ${dep.basisType === "basic_salary" ? "basic salary" : "its basis"} changed`,
        })
      );
    }
  }

  private async writeRow(
    client: PoolClient,
    claims: RequestClaims,
    employeeId: string,
    componentId: string,
    effectiveFrom: string,
    resolved: { monthly: number; entered: number | null; percentage: number | null; units: number | null },
    common: { payFrequency: CompensationPayFrequency; currencyCode: string; changeReasonCatalogItemId: string | null; changeReasonNote: string | null; salaryGradeId: string | null }
  ): Promise<CompensationView> {
    const { row } = await this.effectiveDating.applyVersionedRow(client, {
      table: "employee_compensation_components",
      scope: { employee_id: employeeId, component_id: componentId },
      extraInsertColumns: { company_id: claims.company_id, created_by_user_account_id: claims.sub },
      data: {
        amount: resolved.monthly,
        percentage: resolved.percentage,
        units: resolved.units,
        entered_amount: resolved.entered ?? (resolved.percentage === null ? resolved.monthly : null),
        pay_frequency: common.payFrequency,
        currency_code: common.currencyCode,
        change_reason_catalog_item_id: common.changeReasonCatalogItemId,
        change_reason_note: common.changeReasonNote,
        salary_grade_id: common.salaryGradeId,
      },
      effectiveFrom,
    });
    const withComponent = await client.query(
      `SELECT ecc.*, ${COMPONENT_JOIN_COLUMNS}
       FROM employee_compensation_components ecc
       JOIN compensation_components cc ON cc.id = ecc.component_id
       WHERE ecc.id = $1`,
      [(row as { id: string }).id]
    );
    return rowToCompensationRow(withComponent.rows[0]);
  }

  /** The employee's current (as-of-today) compensation across every
   * active component they have an open row for. */
  async getCurrentCompensation(claims: RequestClaims, employeeId: string): Promise<EmployeeCompensationView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      return this.loadCurrentCompensation(client, claims, employeeId);
    });
  }

  private async loadCurrentCompensation(client: PoolClient, claims: RequestClaims, employeeId: string): Promise<EmployeeCompensationView> {
    await this.loadOrSeedComponents(client, claims);
    const result = await client.query(
      `SELECT ecc.*, ${COMPONENT_JOIN_COLUMNS}, cc.sort_order
       FROM employee_compensation_components ecc
       JOIN compensation_components cc ON cc.id = ecc.component_id
       WHERE ecc.employee_id = $1 AND ecc.effective_to IS NULL AND cc.is_active = true
       ORDER BY cc.sort_order ASC`,
      [employeeId]
    );
    const components = result.rows.map(rowToCompensationRow);
    const totalEarnings = components.filter((c) => c.componentType === "earning").reduce((sum, c) => sum + c.amount, 0);
    const totalDeductions = components.filter((c) => c.componentType === "deduction").reduce((sum, c) => sum + c.amount, 0);
    return {
      employeeId,
      asOfDate: toIsoDate(new Date()),
      components,
      totalEarnings: Number(totalEarnings.toFixed(2)),
      totalDeductions: Number(totalDeductions.toFixed(2)),
      totalMonthly: Number((totalEarnings - totalDeductions).toFixed(2)),
    };
  }

  /** Full effective-dated history across EVERY component (active or
   * retired) an employee has ever had, newest first — mirrors
   * `TaxSlabsForm`'s own history endpoint shape. */
  async getCompensationHistory(claims: RequestClaims, employeeId: string): Promise<CompensationView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, employeeId);
      if (!employee) throw new NotFoundException("Employee not found");
      const result = await client.query(
        `SELECT ecc.*, ${COMPONENT_JOIN_COLUMNS}
         FROM employee_compensation_components ecc
         JOIN compensation_components cc ON cc.id = ecc.component_id
         WHERE ecc.employee_id = $1
         ORDER BY ecc.effective_from DESC, cc.sort_order ASC`,
        [employeeId]
      );
      return result.rows.map(rowToCompensationRow);
    });
  }

  // --- Internals -------------------------------------------------------

  private async loadOrSeedComponents(client: PoolClient, claims: RequestClaims): Promise<CompensationComponentView[]> {
    const existing = await client.query("SELECT * FROM compensation_components WHERE company_id = $1 ORDER BY sort_order ASC", [
      claims.company_id,
    ]);
    if ((existing.rowCount ?? 0) > 0) return existing.rows.map(rowToComponent);
    const inserted: unknown[] = [];
    for (const component of DEFAULT_COMPONENTS) {
      const result = await client.query(
        `INSERT INTO compensation_components (company_id, key, name, is_taxable, sort_order)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (company_id, key) DO NOTHING RETURNING *`,
        [claims.company_id, component.key, component.name, component.sortOrder]
      );
      if ((result.rowCount ?? 0) > 0) inserted.push(result.rows[0]);
    }
    if (inserted.length > 0) return inserted.map(rowToComponent) as CompensationComponentView[];
    const retry = await client.query("SELECT * FROM compensation_components WHERE company_id = $1 ORDER BY sort_order ASC", [
      claims.company_id,
    ]);
    return retry.rows.map(rowToComponent);
  }

  /** A pay change cannot take effect after the person has left, or at an absurd date. */
  private async assertSaneEffectiveDate(client: PoolClient, employeeId: string, effectiveFrom: string): Promise<void> {
    const day = effectiveFrom.slice(0, 10);
    if (day < "1960-01-01") throw new BadRequestException("The effective date is too far in the past. Check the year.");
    if (day > "2500-12-31") throw new BadRequestException("The effective date is too far ahead. Check the year.");
    const row = await client.query("SELECT termination_date::text AS left_on FROM employees WHERE id = $1", [employeeId]);
    const leftOn: string | null = row.rows[0]?.left_on ?? null;
    if (leftOn && day > leftOn) throw new BadRequestException(`The employee left on ${leftOn}. A pay change cannot take effect after that date.`);
  }

  private async loadEmployee(client: PoolClient, employeeId: string): Promise<{ id: string } | null> {
    const result = await client.query("SELECT id FROM employees WHERE id = $1", [employeeId]);
    return result.rowCount === 0 ? null : (result.rows[0] as { id: string });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage employee compensation");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!canView && !canManage) {
      throw new ForbiddenException("Not permitted to view employee compensation");
    }
  }
}
