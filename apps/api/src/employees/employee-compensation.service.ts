import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import type {
  CompensationComponentView,
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
  return {
    id: row.id,
    companyId: row.company_id,
    key: row.key,
    name: row.name,
    isTaxable: row.is_taxable,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at) as string,
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
    amount: Number(row.amount),
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: toIsoDateOrNull(row.effective_to),
    createdByUserAccountId: row.created_by_user_account_id,
    createdAt: toIso(row.created_at) as string,
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
    return this.db.withClaims(claims, async (client) => {
      await this.loadOrSeedComponents(client, claims);
      const existing = await client.query("SELECT 1 FROM compensation_components WHERE company_id = $1 AND key = $2", [
        claims.company_id,
        key,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new BadRequestException(`A compensation component with key "${key}" already exists`);
      }
      const maxSort = await client.query("SELECT COALESCE(MAX(sort_order), -1) AS max FROM compensation_components WHERE company_id = $1", [
        claims.company_id,
      ]);
      const result = await client.query(
        `INSERT INTO compensation_components (company_id, key, name, is_taxable, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [claims.company_id, key, name, input.isTaxable ?? true, Number(maxSort.rows[0].max) + 1]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "compensation_component.create",
        target: result.rows[0].id,
        metadata: { key, name },
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
      const result = await client.query(
        `UPDATE compensation_components
         SET name = $2, is_taxable = $3, is_active = $4, sort_order = $5
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.name?.trim() || current.name,
          patch.isTaxable ?? current.is_taxable,
          patch.isActive ?? current.is_active,
          patch.sortOrder ?? current.sort_order,
        ]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "compensation_component.update", target: id });
      return rowToComponent(result.rows[0]);
    });
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

    const row = await this.applyOneComponent(client, claims, {
      employeeId: input.employeeId,
      componentId: basic.id,
      amount: input.monthlySalary,
      effectiveFrom: input.effectiveFrom,
    });
    await this.audit.record(client, claims, {
      companyId: claims.company_id ?? null,
      action: "compensation.set",
      target: input.employeeId,
      metadata: { componentKey: BASIC_SALARY_KEY, amount: input.monthlySalary, effectiveFrom: input.effectiveFrom },
    });
    return { ...row, componentKey: basic.key, componentName: basic.name, isTaxable: basic.isTaxable };
  }

  /**
   * Sets one or more components' amounts for an employee as of the same
   * date in one call. A component left out of `input.components` is
   * untouched — bumping just Basic Salary doesn't require resubmitting
   * every allowance (each component is independently effective-dated).
   */
  async setCompensationComponents(claims: RequestClaims, input: SetEmployeeCompensationComponentsRequest): Promise<EmployeeCompensationView> {
    await this.requireManage(claims);
    if (input.components.length === 0) throw new BadRequestException("At least one component amount is required");
    return this.db.withClaims(claims, async (client) => {
      const employee = await this.loadEmployee(client, input.employeeId);
      if (!employee) throw new NotFoundException("Employee not found");

      const catalog = await this.loadOrSeedComponents(client, claims);
      const byId = new Map(catalog.map((c) => [c.id, c]));
      for (const entry of input.components) {
        const component = byId.get(entry.componentId);
        if (!component) throw new BadRequestException(`Unknown compensation component: ${entry.componentId}`);
        if (!component.isActive) throw new BadRequestException(`Compensation component "${component.name}" is not active`);
        if (entry.amount < 0) throw new BadRequestException("A component amount cannot be negative");
      }

      for (const entry of input.components) {
        await this.applyOneComponent(client, claims, {
          employeeId: input.employeeId,
          componentId: entry.componentId,
          amount: entry.amount,
          effectiveFrom: input.effectiveFrom,
        });
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "compensation.set_components",
        target: input.employeeId,
        metadata: { effectiveFrom: input.effectiveFrom, componentIds: input.components.map((c) => c.componentId) },
      });
      return this.loadCurrentCompensation(client, claims, input.employeeId);
    });
  }

  private async applyOneComponent(
    client: PoolClient,
    claims: RequestClaims,
    input: { employeeId: string; componentId: string; amount: number; effectiveFrom: string }
  ): Promise<CompensationView> {
    const { row } = await this.effectiveDating.applyVersionedRow(client, {
      table: "employee_compensation_components",
      scope: { employee_id: input.employeeId, component_id: input.componentId },
      extraInsertColumns: { company_id: claims.company_id, created_by_user_account_id: claims.sub },
      data: { amount: input.amount },
      effectiveFrom: input.effectiveFrom,
    });
    const withComponent = await client.query(
      `SELECT ecc.*, cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable
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
      `SELECT ecc.*, cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable, cc.sort_order
       FROM employee_compensation_components ecc
       JOIN compensation_components cc ON cc.id = ecc.component_id
       WHERE ecc.employee_id = $1 AND ecc.effective_to IS NULL AND cc.is_active = true
       ORDER BY cc.sort_order ASC`,
      [employeeId]
    );
    const components = result.rows.map(rowToCompensationRow);
    return {
      employeeId,
      asOfDate: toIsoDate(new Date()),
      components,
      totalMonthly: Number(components.reduce((sum, c) => sum + c.amount, 0).toFixed(2)),
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
        `SELECT ecc.*, cc.key AS component_key, cc.name AS component_name, cc.is_taxable AS component_is_taxable
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
