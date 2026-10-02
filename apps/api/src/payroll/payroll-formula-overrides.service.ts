import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine, toIsoDate } from "../effective-dating/effective-dating.engine";
import { FormulaEvaluationError } from "./formula-expression.engine";
import { PayrollFormulaService, isPayrollFormulaKey } from "./payroll-formula.service";
import type {
  CreatePayrollFormulaRequest,
  EndDatePayrollFormulaRequest,
  PayrollFormulaContractView,
  PayrollFormulaKey,
  PayrollFormulaView,
  UpdatePayrollFormulaRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
// Deliberately the SAME permission that gates payroll_settings and
// tax_slabs (PayrollService.requirePayrollCalculate()): an override
// replaces exactly the figures those two tables parameterize, so whoever
// may change the EOBI rate or the tax brackets may change the formula
// that consumes them — and no one else. No new permission/seed migration.
const MANAGE_PERMISSION = "payroll.calculate.all";
const TABLE = "payroll_formulas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToFormula(row: any): PayrollFormulaView {
  return {
    id: row.id,
    companyId: row.company_id,
    formulaKey: row.formula_key,
    expression: row.expression,
    effectiveFrom: toIsoDate(row.effective_from),
    effectiveTo: row.effective_to === null || row.effective_to === undefined ? null : toIsoDate(row.effective_to),
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

function normalizeDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value.slice(0, 10)))) {
    throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
  }
  return value.slice(0, 10);
}

/**
 * Managing payroll formula overrides (0105_payroll_formulas.sql):
 * list / create / supersede / end-date. Layered like every tenant service
 * (entitlement -> RBAC -> validation -> write -> audit, RLS underneath),
 * mirroring PayrollService's settings/tax-slab endpoints.
 *
 * Effective dating goes through the shared EffectiveDatingEngine
 * (`applyVersionedRow`, scope = {company_id, formula_key}) — the same
 * single-row supersession payroll_settings uses — rather than hand-rolled
 * close-then-insert logic. On top of it, this service refuses edits that
 * would rewrite history out from under already-calculated runs:
 *  - create: only when no override is currently open for the key, and
 *    never starting on/before the end of an earlier closed generation.
 *  - update (supersede): only the open row; `effectiveFrom` must be on or
 *    after its own effective_from. Same day = edited in place (the
 *    engine's same-day collapse), later = closed the day before and a new
 *    generation inserted.
 *  - end-date: only the open row; never before its own effective_from.
 * Rows are never deleted (no DELETE grant): the history is what lets an
 * accountant reconstruct which formula produced a past payslip.
 */
@Injectable()
export class PayrollFormulaOverridesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine,
    private readonly formulas: PayrollFormulaService
  ) {}

  /** Every generation, oldest first per key; optionally one key only. */
  async list(claims: RequestClaims, filter: { formulaKey?: string } = {}): Promise<PayrollFormulaView[]> {
    await this.requireManage(claims);
    const formulaKey = filter.formulaKey === undefined ? undefined : this.requireKey(filter.formulaKey);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM payroll_formulas WHERE company_id = $1 AND ($2::text IS NULL OR formula_key = $2)
         ORDER BY formula_key ASC, effective_from ASC`,
        [claims.company_id, formulaKey ?? null]
      );
      return result.rows.map(rowToFormula);
    });
  }

  /** The stable per-key evaluation-context contract (which variables an expression may use). */
  async getContract(claims: RequestClaims): Promise<PayrollFormulaContractView[]> {
    await this.requireManage(claims);
    return this.formulas.contract();
  }

  async create(claims: RequestClaims, input: CreatePayrollFormulaRequest): Promise<PayrollFormulaView> {
    await this.requireManage(claims);
    const formulaKey = this.requireKey(input.formulaKey);
    this.validateExpression(formulaKey, input.expression);
    const effectiveFrom = normalizeDate(input.effectiveFrom, "effectiveFrom") ?? toIsoDate(new Date());

    return this.db.withClaims(claims, async (client) => {
      const scope = { company_id: claims.company_id!, formula_key: formulaKey };
      const open = await this.effectiveDating.getCurrentRow(client, { table: TABLE, scope });
      if (open) {
        throw new ConflictException(
          `An override for "${formulaKey}" is already active (id ${open.id as string}) — supersede it with PATCH, or end-date it first`
        );
      }
      const latestClosed = await client.query(
        "SELECT MAX(effective_to) AS last_end FROM payroll_formulas WHERE company_id = $1 AND formula_key = $2",
        [claims.company_id, formulaKey]
      );
      const lastEnd = latestClosed.rows[0].last_end;
      if (lastEnd !== null && effectiveFrom <= toIsoDate(lastEnd)) {
        throw new BadRequestException(
          `effectiveFrom must be after ${toIsoDate(lastEnd)}, the end of the previous "${formulaKey}" override — overlapping generations would rewrite history`
        );
      }
      const { row } = await this.applyVersion(client, scope, input.expression, effectiveFrom);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_formula.create",
        target: row.id as string,
        metadata: { formulaKey, effectiveFrom },
      });
      return rowToFormula(row);
    });
  }

  async update(claims: RequestClaims, id: string, input: UpdatePayrollFormulaRequest): Promise<PayrollFormulaView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadOpen(client, id, "superseded");
      const formulaKey = current.formula_key as PayrollFormulaKey;
      this.validateExpression(formulaKey, input.expression);
      const currentFrom = toIsoDate(current.effective_from);
      const effectiveFrom = normalizeDate(input.effectiveFrom, "effectiveFrom") ?? dateMaxIso(toIsoDate(new Date()), currentFrom);
      if (effectiveFrom < currentFrom) {
        throw new BadRequestException(`effectiveFrom must be on or after this override's own effectiveFrom (${currentFrom})`);
      }
      const { row, collapsed } = await this.applyVersion(
        client,
        { company_id: claims.company_id!, formula_key: formulaKey },
        input.expression,
        effectiveFrom
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_formula.supersede",
        target: row.id as string,
        metadata: { formulaKey, effectiveFrom, previousId: id, editedInPlace: collapsed },
      });
      return rowToFormula(row);
    });
  }

  async endDate(claims: RequestClaims, id: string, input: EndDatePayrollFormulaRequest): Promise<PayrollFormulaView> {
    await this.requireManage(claims);
    const effectiveTo = normalizeDate(input.effectiveTo, "effectiveTo");
    if (!effectiveTo) throw new BadRequestException("effectiveTo is required");
    return this.db.withClaims(claims, async (client) => {
      const current = await this.loadOpen(client, id, "end-dated");
      const currentFrom = toIsoDate(current.effective_from);
      if (effectiveTo < currentFrom) {
        throw new BadRequestException(`effectiveTo cannot be before this override's effectiveFrom (${currentFrom})`);
      }
      const result = await client.query(
        "UPDATE payroll_formulas SET effective_to = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [id, effectiveTo]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_formula.end_date",
        target: id,
        metadata: { formulaKey: current.formula_key, effectiveTo },
      });
      return rowToFormula(result.rows[0]);
    });
  }

  // --- Internals -------------------------------------------------------

  private async applyVersion(
    client: PoolClient,
    scope: { company_id: string; formula_key: PayrollFormulaKey },
    expression: unknown,
    effectiveFrom: string
  ): Promise<{ row: Record<string, unknown>; collapsed: boolean }> {
    try {
      return await this.effectiveDating.applyVersionedRow(client, {
        table: TABLE,
        scope,
        data: { expression: JSON.stringify(expression), updated_at: new Date() },
        effectiveFrom,
      });
    } catch (err) {
      // The partial unique index (one open row per key) — a concurrent create.
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException(`An override for "${scope.formula_key}" was created concurrently — reload and retry`);
      }
      throw err;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadOpen(client: PoolClient, id: string, verb: string): Promise<any> {
    const result = await client.query("SELECT * FROM payroll_formulas WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Payroll formula override not found");
    const row = result.rows[0];
    if (row.effective_to !== null) {
      throw new BadRequestException(`Only the currently-open override can be ${verb}; this one ended ${toIsoDate(row.effective_to)}`);
    }
    return row;
  }

  private requireKey(value: unknown): PayrollFormulaKey {
    if (!isPayrollFormulaKey(value)) {
      throw new BadRequestException(`formulaKey must be one of: income_tax, eobi_employee, eobi_employer`);
    }
    return value;
  }

  private validateExpression(formulaKey: PayrollFormulaKey, expression: unknown): void {
    try {
      this.formulas.validateExpression(formulaKey, expression);
    } catch (err) {
      if (err instanceof FormulaEvaluationError) throw new BadRequestException(`Invalid formula expression: ${err.message}`);
      throw err;
    }
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage payroll formulas");
    }
  }
}

function dateMaxIso(a: string, b: string): string {
  return a > b ? a : b;
}
