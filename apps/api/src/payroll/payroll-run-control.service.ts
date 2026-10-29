import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { releaseRetroForRun } from "./payroll-retro-support";
import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { currentCorrelationId } from "../common/request-context";
import { isPayrollAreaInScope, resolvePayrollAreaAccess, type PayrollAreaAccess } from "./payroll-area-access";
import { selectRunPopulation } from "./payroll-population";
import { rowToRunView } from "./payroll-run-view";
import { publishRunFinalized, publishRunStateChanged } from "./payroll-events";
import type {
  PayrollCalculationProgressView,
  PayrollExceptionView,
  PayrollOverridableField,
  PayrollOverrideView,
  PayrollReversalView,
  PayrollRunEventView,
  PayrollRunReopenView,
  PayrollRunStatus,
  PayrollRunValidationView,
  PayrollRunVarianceView,
  PayrollVarianceFlag,
  PayrollVarianceRowView,
  PayrollRunPopulationView,
  PayrollValidationFinding,
  SetPayrollOverrideRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
/** A person is flagged for review when their pay or tax moved by more than this against the previous finalised run. */
export const VARIANCE_NET_PERCENT = 20;
export const VARIANCE_TAX_PERCENT = 50;
/** ...and by at least this many rupees, so a small base does not raise noise. */
const VARIANCE_MIN_AMOUNT = 1000;

const CALCULATE_BASE = "payroll.calculate";
const FINALIZE_BASE = "payroll.finalize";
const DISBURSE_BASE = "payroll.disburse";

/**
 * PAY-01 - the one definition of a payroll run's legal moves in application code. The database holds an
 * identical copy (`app.payroll_run_transition_allowed`, migration 0142) behind a trigger, so nothing -
 * including manual SQL - can skip a step; `payroll-run-control.step9.spec.ts` compares the two.
 */
export const PAYROLL_RUN_TRANSITIONS: Record<PayrollRunStatus, PayrollRunStatus[]> = {
  draft: ["pre_validated", "calculating", "calculated", "cancelled"],
  pre_validated: ["draft", "calculating", "calculated", "cancelled"],
  calculating: ["calculated", "draft", "cancelled"],
  calculated: ["calculating", "validated", "pending_approval", "cancelled"],
  validated: ["calculating", "calculated", "pending_approval", "cancelled"],
  pending_approval: ["approved", "calculated"],
  approved: ["finalized", "calculated", "cancelled"],
  finalized: ["accounting", "payment_released", "reconciled", "closed", "reversed"],
  accounting: ["payment_released", "reconciled", "closed", "reversed"],
  payment_released: ["accounting", "reconciled", "closed", "reversed"],
  reconciled: ["closed", "reversed"],
  closed: ["reopened"],
  reopened: ["accounting", "payment_released", "reconciled", "closed", "reversed"],
  reversed: [],
  cancelled: [],
};

export function canTransitionPayrollRun(from: PayrollRunStatus, to: PayrollRunStatus): boolean {
  return from === to || PAYROLL_RUN_TRANSITIONS[from]?.includes(to) === true;
}

/** Statuses from which a finalised run may still be reversed (a closed run must be reopened first). */
export const REVERSIBLE_STATUSES: PayrollRunStatus[] = ["finalized", "accounting", "payment_released", "reconciled", "reopened"];
export const POST_FINAL_STATUS_LIST: PayrollRunStatus[] = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened"];

/** Bumped whenever the gross-to-net engine changes in a way that could alter a result. */
export const PAYROLL_ENGINE_VERSION = "payroll-engine/9";

const OVERRIDE_COLUMNS: Record<PayrollOverridableField, { column: string; employeeBorne: boolean; componentKey: string; label: string; category: string; affects: string; source: string }> = {
  incomeTaxMonthly: { column: "income_tax_monthly", employeeBorne: true, componentKey: "income_tax", label: "Income tax", category: "tax", affects: "net", source: "tax" },
  eobiEmployeeContribution: { column: "eobi_employee_contribution", employeeBorne: true, componentKey: "eobi_employee", label: "EOBI employee contribution", category: "statutory_deduction", affects: "net", source: "statutory" },
  eobiEmployerContribution: { column: "eobi_employer_contribution", employeeBorne: false, componentKey: "eobi_employer", label: "EOBI employer contribution", category: "employer_contribution", affects: "employer_cost", source: "statutory" },
  socialSecurityEmployerContribution: { column: "social_security_employer_contribution", employeeBorne: false, componentKey: "social_security_employer", label: "Social security employer contribution", category: "employer_contribution", affects: "employer_cost", source: "statutory" },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function iso(v: any): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEvent(r: any): PayrollRunEventView {
  return {
    id: r.id,
    payrollRunId: r.payroll_run_id,
    fromStatus: r.from_status ?? null,
    toStatus: r.to_status,
    action: r.action,
    actorUserAccountId: r.actor_user_account_id ?? null,
    reason: r.reason ?? null,
    correlationId: r.correlation_id ?? null,
    metadata: r.metadata ?? {},
    createdAt: iso(r.created_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToOverride(r: any): PayrollOverrideView {
  const field = (Object.keys(OVERRIDE_COLUMNS) as PayrollOverridableField[]).find((k) => k === r.field) ?? (r.field as PayrollOverridableField);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id,
    payrollRunId: r.payroll_run_id,
    payslipId: r.payslip_id ?? null,
    employeeId: r.employee_id,
    field,
    oldValue: num(r.old_value),
    newValue: Number(r.new_value),
    reason: r.reason,
    status: r.status,
    overriddenBy: r.overridden_by,
    approvedBy: r.approved_by ?? null,
    approvedAt: iso(r.approved_at),
    reappliedCount: Number(r.reapplied_count),
    createdAt: iso(r.created_at) as string,
    withdrawnAt: iso(r.withdrawn_at),
  };
}

export type RunTransitionOptions = {
  action: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Extra payroll_runs columns to set in the same UPDATE (column name -> value). Whitelisted below. */
  set?: Record<string, unknown>;
};

const SETTABLE_RUN_COLUMNS = new Set([
  "finalized_at",
  "reversed_at",
  "reversed_by_user_account_id",
  "reversal_reason",
  "cancelled_at",
  "cancelled_by_user_account_id",
  "cancel_reason",
  "closed_at",
  "closed_by_user_account_id",
  "workflow_instance_id",
]);

/**
 * Gap Register Step 9A (PAY-01, PAY-19, PAY-23): every status change of a payroll run goes through
 * `transition()` - validated against the matrix, written to the append-only `payroll_run_events` log and
 * audited - plus the controlled actions that sit around it (pre-validation, validation, close, reopen,
 * cancel, manual overrides).
 */
@Injectable()
export class PayrollRunControlService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly businessPolicy?: HrBusinessPolicyService
  ) {}

  // ------------------------------------------------------------------ transitions

  /**
   * Moves a run to `to`, or - when `to` equals its current status - just records the action (a recalculation
   * is `calculated -> calculated`). Locks the run row so concurrent actions serialise.
   */
  async transition(client: PoolClient, claims: RequestClaims, runId: string, to: PayrollRunStatus, opts: RunTransitionOptions) {
    const locked = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
    if (locked.rowCount === 0) throw new NotFoundException("Payroll run not found");
    const from = locked.rows[0].status as PayrollRunStatus;
    if (!canTransitionPayrollRun(from, to)) {
      throw new BadRequestException(`A payroll run cannot move from ${from} to ${to}`);
    }
    let row = locked.rows[0];
    if (from !== to || opts.set) {
      const sets: string[] = ["status = $2", "updated_at = now()"];
      const values: unknown[] = [runId, to];
      for (const [col, val] of Object.entries(opts.set ?? {})) {
        if (!SETTABLE_RUN_COLUMNS.has(col)) throw new Error(`payroll_runs.${col} cannot be set through transition()`);
        values.push(val);
        sets.push(`${col} = $${values.length}`);
      }
      const updated = await client.query(`UPDATE payroll_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      row = updated.rows[0];
    }
    await client.query(
      `INSERT INTO payroll_run_events (company_id, payroll_run_id, from_status, to_status, action, actor_user_account_id, reason, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [row.company_id, runId, from, to, opts.action, claims.sub ?? null, opts.reason ?? null, currentCorrelationId(), JSON.stringify(opts.metadata ?? {})]
    );
    // PAY-27 - announce the change through the outbox, in this same transaction
    if (from !== to) await publishRunStateChanged(client, claims, row, from, opts.action);
    if (to === "finalized" && from !== "finalized") await publishRunFinalized(client, claims, row);
    return row;
  }

  async listEvents(claims: RequestClaims, runId: string): Promise<PayrollRunEventView[]> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM payroll_run_events WHERE payroll_run_id = $1 ORDER BY created_at, id", [runId]);
      return r.rows.map(rowToEvent);
    });
  }


  // ------------------------------------------------------------------ PAY-04 population

  /**
   * Records who a calculation covered and why - one set per calculation, so the population of an earlier
   * calculation stays reproducible after the employee master moves on.
   */
  async recordPopulation(
    client: PoolClient,
    run: { id: string; company_id: string; payroll_area_id?: string | null; target_employee_id?: string | null; off_cycle_reason?: string | null },
    employees: Array<{ id: string; employee_number: string; date_of_joining: unknown; termination_date: unknown; bank_account_number: string | null }>,
    outcome: Map<string, { status: "calculated" | "failed" | "excluded"; reason?: string }>,
    sequence: number
  ): Promise<void> {
    if (employees.length === 0) return;
    const inclusion = run.target_employee_id
      ? run.off_cycle_reason === "final_settlement" ? "final_settlement" : "target_employee"
      : run.payroll_area_id ? "area_member" : "company_wide";
    const master = await client.query<Record<string, unknown>>(
      `SELECT id, employment_status, payroll_area_id, org_unit_id, position_id, location_id, employee_subgroup_id, manager_id
         FROM employees WHERE id = ANY($1::uuid[])`,
      [employees.map((e) => e.id)]
    );
    const byId = new Map(master.rows.map((m) => [m.id as string, m]));
    const day = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10));
    await client.query(
      `INSERT INTO payroll_run_population (company_id, payroll_run_id, employee_id, calculation_sequence, inclusion_reason, status, exclusion_reason, snapshot)
       SELECT $1, $2, x.employee_id, $3, $4, x.status, x.reason, x.snapshot
         FROM jsonb_to_recordset($5::jsonb) AS x(employee_id uuid, status text, reason text, snapshot jsonb)
       ON CONFLICT (payroll_run_id, employee_id, calculation_sequence) DO UPDATE
         SET status = EXCLUDED.status, exclusion_reason = EXCLUDED.exclusion_reason, snapshot = EXCLUDED.snapshot`,
      [
        run.company_id,
        run.id,
        sequence,
        inclusion,
        JSON.stringify(
          employees.map((e) => {
            const m = byId.get(e.id) ?? {};
            const o = outcome.get(e.id) ?? { status: "calculated" as const };
            return {
              employee_id: e.id,
              status: o.status,
              reason: o.reason ?? null,
              snapshot: {
                employeeNumber: e.employee_number,
                dateOfJoining: day(e.date_of_joining),
                terminationDate: day(e.termination_date),
                employmentStatus: m.employment_status ?? null,
                payrollAreaId: m.payroll_area_id ?? null,
                orgUnitId: m.org_unit_id ?? null,
                positionId: m.position_id ?? null,
                locationId: m.location_id ?? null,
                employeeSubgroupId: m.employee_subgroup_id ?? null,
                managerId: m.manager_id ?? null,
                hasPaymentAccount: e.bank_account_number !== null,
              },
            };
          })
        ),
      ]
    );
  }

  async listPopulation(claims: RequestClaims, runId: string, calculationSequence?: number): Promise<PayrollRunPopulationView[]> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT p.*, e.employee_number FROM payroll_run_population p JOIN employees e ON e.id = p.employee_id
          WHERE p.payroll_run_id = $1
            AND p.calculation_sequence = COALESCE($2::int, (SELECT MAX(calculation_sequence) FROM payroll_run_population WHERE payroll_run_id = $1))
          ORDER BY e.employee_number`,
        [runId, calculationSequence ?? null]
      );
      return r.rows.map((row) => ({
        id: row.id,
        payrollRunId: row.payroll_run_id,
        employeeId: row.employee_id,
        employeeNumber: row.employee_number,
        calculationSequence: row.calculation_sequence,
        inclusionReason: row.inclusion_reason,
        status: row.status,
        exclusionReason: row.exclusion_reason,
        snapshot: row.snapshot ?? {},
        createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
      }));
    });
  }

  /** First entry of a run's timeline. */
  async recordCreated(client: PoolClient, claims: RequestClaims, run: { id: string; company_id: string; status: string }, metadata: Record<string, unknown> = {}): Promise<void> {
    await client.query(
      `INSERT INTO payroll_run_events (company_id, payroll_run_id, from_status, to_status, action, actor_user_account_id, correlation_id, metadata)
       VALUES ($1, $2, NULL, $3, 'create', $4, $5, $6::jsonb)`,
      [run.company_id, run.id, run.status, claims.sub ?? null, currentCorrelationId(), JSON.stringify(metadata)]
    );
  }

  /**
   * PAY-02 / PAY-05: freezes the settings, tax slabs and formulas a calculation reads. A run can always show
   * exactly which rule versions produced its numbers, and a later rate change can never alter them.
   */
  async captureRuleSnapshot(
    client: PoolClient,
    run: { id: string; company_id: string },
    asOfDate: string,
    settings: Record<string, unknown>,
    taxSlabs: Array<Record<string, unknown> & { id?: string }>
  ): Promise<{ id: string; sequence: number }> {
    const row = await client.query<{ id: string }>(
      "SELECT id FROM payroll_settings WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY effective_from DESC LIMIT 1",
      [run.company_id, asOfDate]
    );
    const formulas = await this.loadRuleFormulaRows(client, run.company_id, asOfDate);
    const seq = await client.query<{ n: number }>("SELECT COALESCE(max(calculation_sequence), 0)::int + 1 AS n FROM payroll_rule_snapshots WHERE payroll_run_id = $1", [run.id]);
    const sequence = seq.rows[0].n;
    const hash = this.ruleContentHash(settings, taxSlabs, formulas);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO payroll_rule_snapshots (company_id, payroll_run_id, calculation_sequence, as_of_date, engine_version, settings_row_id, tax_slab_ids, formula_ids, settings, tax_slabs, formulas, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::uuid[], $9::jsonb, $10::jsonb, $11::jsonb, $12) RETURNING id`,
      [
        run.company_id,
        run.id,
        sequence,
        asOfDate,
        PAYROLL_ENGINE_VERSION,
        row.rows[0]?.id ?? null,
        taxSlabs.map((t) => t.id).filter(Boolean),
        formulas.map((f) => f.id),
        JSON.stringify(settings),
        JSON.stringify(taxSlabs),
        JSON.stringify(formulas),
        hash,
      ]
    );
    return { id: ins.rows[0].id, sequence };
  }

  async getRuleSnapshot(claims: RequestClaims, runId: string): Promise<import("@aihxm/shared-types").PayrollRuleSnapshotView | null> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        "SELECT * FROM payroll_rule_snapshots WHERE payroll_run_id = $1 ORDER BY calculation_sequence DESC LIMIT 1",
        [runId]
      );
      if (r.rowCount === 0) return null;
      const x = r.rows[0];
      return {
        id: x.id,
        payrollRunId: x.payroll_run_id,
        calculationSequence: x.calculation_sequence,
        asOfDate: iso(x.as_of_date)!.slice(0, 10),
        engineVersion: x.engine_version,
        contentHash: x.content_hash,
        settingsRowId: x.settings_row_id ?? null,
        taxSlabIds: x.tax_slab_ids ?? [],
        formulaIds: x.formula_ids ?? [],
        settings: x.settings,
        taxSlabs: x.tax_slabs,
        formulas: x.formulas,
        createdAt: iso(x.created_at) as string,
      };
    });
  }

  // ------------------------------------------------------------------ totals

  /** Recomputes the run's stored totals and counters from its payslips (the single place they are written). */
  async refreshRunTotals(client: PoolClient, runId: string, counters?: { population?: number; failed?: number; warnings?: number }): Promise<void> {
    await client.query(
      `UPDATE payroll_runs r SET
         total_gross = s.gross, total_net = s.net, total_income_tax = s.tax,
         total_employee_deductions = s.gross - s.net - s.tax,
         total_employer_contributions = s.employer, total_employer_cost = s.gross + s.employer,
         calculated_count = s.n,
         population_count = COALESCE($2::int, r.population_count),
         failed_count = COALESCE($3::int, r.failed_count),
         warning_count = COALESCE($4::int, r.warning_count)
       FROM (
         SELECT COALESCE(sum(gross_pay), 0) AS gross, COALESCE(sum(net_pay), 0) AS net, COALESCE(sum(income_tax_monthly), 0) AS tax,
                COALESCE(sum(eobi_employer_contribution + social_security_employer_contribution), 0) AS employer, count(*)::int AS n
           FROM payslips WHERE payroll_run_id = $1
       ) s
       WHERE r.id = $1`,
      [runId, counters?.population ?? null, counters?.failed ?? null, counters?.warnings ?? null]
    );
  }

  private async loadRuleFormulaRows(client: PoolClient, companyId: string, asOfDate: string): Promise<Array<Record<string, any>>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await client.query(
      `SELECT id, formula_key, expression, effective_from, effective_to FROM payroll_formulas
        WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY formula_key`,
      [companyId, asOfDate]
    );
    return r.rows;
  }

  private ruleContentHash(settings: Record<string, unknown>, taxSlabs: unknown[], formulas: Array<Record<string, any>>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
    return createHash("sha256")
      .update(JSON.stringify({ settings, taxSlabs, formulas: formulas.map((f) => [f.formula_key, f.expression, f.effective_from]) }))
      .digest("hex");
  }

  /**
   * PAY-06 - a partial recalculation (one employee, one partition) is only legitimate when it would read exactly the
   * rules the run was calculated with. Throws when the settings, tax slabs or formulas in force at the period end no
   * longer hash to the run's stored rule snapshot.
   */
  async assertRulesUnchanged(
    client: PoolClient,
    run: { id: string; company_id: string; rule_snapshot_id?: string | null },
    asOfDate: string,
    settings: Record<string, unknown>,
    taxSlabs: unknown[]
  ): Promise<void> {
    if (!run.rule_snapshot_id) return;
    const snap = await client.query<{ content_hash: string }>("SELECT content_hash FROM payroll_rule_snapshots WHERE id = $1", [run.rule_snapshot_id]);
    if (snap.rowCount === 0) return;
    const formulas = await this.loadRuleFormulaRows(client, run.company_id, asOfDate);
    if (this.ruleContentHash(settings, taxSlabs, formulas) !== snap.rows[0].content_hash) {
      throw new ConflictException("Payroll rules (settings, tax slabs or formulas) have changed since this run was calculated. Recalculate the whole run so every payslip uses the same rules.");
    }
  }

  // ------------------------------------------------------------------ exceptions (PAY-06)

  async supersedeOpenExceptions(client: PoolClient, runId: string): Promise<void> {
    await client.query(
      "UPDATE payroll_exceptions SET status = 'superseded', updated_at = now() WHERE payroll_run_id = $1 AND status = 'open'",
      [runId]
    );
  }

  /** Writes (or refreshes) the open exception of one employee in one calculation. */
  async recordException(
    client: PoolClient,
    run: { id: string; company_id: string },
    input: { employeeId: string | null; sequence: number; message: string; exceptionClass?: string; partitionId?: string | null; detail?: Record<string, unknown> }
  ): Promise<void> {
    const params = [
      run.company_id,
      run.id,
      input.partitionId ?? null,
      input.employeeId,
      input.sequence,
      input.exceptionClass ?? "calculation",
      input.message.slice(0, 2000),
      JSON.stringify(input.detail ?? {}),
      currentCorrelationId(),
    ];
    if (input.employeeId) {
      await client.query(
        `INSERT INTO payroll_exceptions (company_id, payroll_run_id, payroll_partition_id, employee_id, calculation_sequence, exception_class, message, detail, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (payroll_run_id, employee_id, calculation_sequence) WHERE status = 'open' AND employee_id IS NOT NULL
         DO UPDATE SET message = EXCLUDED.message, detail = EXCLUDED.detail, exception_class = EXCLUDED.exception_class, updated_at = now()`,
        params
      );
    } else {
      await client.query(
        `INSERT INTO payroll_exceptions (company_id, payroll_run_id, payroll_partition_id, employee_id, calculation_sequence, exception_class, message, detail, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        params
      );
    }
  }

  async countOpenExceptions(client: PoolClient, runId: string, sequence: number): Promise<number> {
    const r = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM payroll_exceptions WHERE payroll_run_id = $1 AND calculation_sequence = $2 AND status = 'open'",
      [runId, sequence]
    );
    return r.rows[0].n;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exceptionView(r: any): PayrollExceptionView {
    return {
      id: r.id,
      payrollRunId: r.payroll_run_id,
      payrollPartitionId: r.payroll_partition_id ?? null,
      employeeId: r.employee_id ?? null,
      employeeNumber: r.employee_number ?? null,
      employeeName: r.employee_name ?? null,
      calculationSequence: r.calculation_sequence,
      exceptionClass: r.exception_class,
      severity: r.severity,
      message: r.message,
      detail: r.detail ?? {},
      status: r.status,
      retryCount: r.retry_count,
      lastRetryAt: iso(r.last_retry_at),
      resolution: r.resolution ?? null,
      resolutionNote: r.resolution_note ?? null,
      resolvedBy: r.resolved_by ?? null,
      resolvedAt: iso(r.resolved_at),
      correlationId: r.correlation_id ?? null,
      createdAt: iso(r.created_at) as string,
    };
  }

  async listExceptions(claims: RequestClaims, runId: string, status?: string): Promise<PayrollExceptionView[]> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT x.*, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS employee_name
           FROM payroll_exceptions x LEFT JOIN employees e ON e.id = x.employee_id
          WHERE x.payroll_run_id = $1 AND ($2::text IS NULL OR x.status = $2)
          ORDER BY x.created_at DESC, x.id`,
        [runId, status ?? null]
      );
      return r.rows.map((row) => this.exceptionView(row));
    });
  }

  /**
   * Knowingly leaves an employee out of this run (e.g. data is being fixed and they will be paid off-cycle). The
   * population record shows them as excluded with the reason, so the omission is explained rather than silent.
   */
  async waiveException(claims: RequestClaims, runId: string, exceptionId: string, note: string): Promise<PayrollExceptionView> {
    const access = await this.requireRunAction(claims, CALCULATE_BASE, "Not permitted to resolve payroll exceptions");
    const trimmed = (note ?? "").trim();
    if (trimmed.length < 5) throw new BadRequestException("Say why this employee is being left out of the run (at least 5 characters)");
    return this.db.withClaims(claims, async (client) => {
      const run = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
      if (run.rowCount === 0) throw new NotFoundException("Payroll run not found");
      this.assertInScope(access, run.rows[0]);
      if (!["calculated", "validated"].includes(run.rows[0].status)) {
        throw new BadRequestException(`Exceptions can only be resolved while a run is calculated or validated (this one is ${run.rows[0].status})`);
      }
      const ex = await client.query("SELECT * FROM payroll_exceptions WHERE id = $1 AND payroll_run_id = $2 FOR UPDATE", [exceptionId, runId]);
      if (ex.rowCount === 0) throw new NotFoundException("Exception not found");
      if (ex.rows[0].status !== "open") throw new BadRequestException(`This exception is already ${ex.rows[0].status}`);
      await client.query(
        `UPDATE payroll_exceptions SET status = 'waived', resolution = 'waived', resolution_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1`,
        [exceptionId, trimmed, claims.sub]
      );
      if (ex.rows[0].employee_id) {
        await client.query(
          `UPDATE payroll_run_population SET status = 'excluded', exclusion_reason = $4
            WHERE payroll_run_id = $1 AND employee_id = $2 AND calculation_sequence = $3`,
          [runId, ex.rows[0].employee_id, ex.rows[0].calculation_sequence, `Left out of this run: ${trimmed}`]
        );
      }
      await this.refreshRunTotals(client, runId, { failed: await this.countOpenExceptions(client, runId, run.rows[0].calculation_sequence) });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_exception.waive",
        target: exceptionId,
        metadata: { payrollRunId: runId, employeeId: ex.rows[0].employee_id, note: trimmed },
      });
      const out = await client.query(
        `SELECT x.*, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS employee_name
           FROM payroll_exceptions x LEFT JOIN employees e ON e.id = x.employee_id WHERE x.id = $1`,
        [exceptionId]
      );
      return this.exceptionView(out.rows[0]);
    });
  }

  /** Where a (possibly background) calculation stands: run status, job, partitions, open exceptions. */
  async getCalculationProgress(claims: RequestClaims, runId: string): Promise<PayrollCalculationProgressView> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      const parts = await client.query(
        `SELECT partition_no, state, employee_count, calculated_count, failed_count, attempts, last_error
           FROM payroll_run_partitions WHERE payroll_run_id = $1 AND calculation_sequence = $2 ORDER BY partition_no`,
        [runId, run.calculation_sequence]
      );
      const job = run.calculation_job_id
        ? await client.query("SELECT status, progress_percent, progress_note, attempts, max_attempts, last_error FROM background_jobs WHERE id = $1", [run.calculation_job_id])
        : null;
      const open = await this.countOpenExceptions(client, runId, run.calculation_sequence);
      const total = Number(run.partition_count);
      return {
        payrollRunId: runId,
        status: run.status,
        calculationMode: run.calculation_mode,
        calculationSequence: run.calculation_sequence,
        jobId: run.calculation_job_id ?? null,
        jobStatus: job?.rows[0]?.status ?? null,
        progressPercent: job?.rows[0]?.progress_percent ?? (run.status === "calculating" ? 0 : 100),
        progressNote: job?.rows[0]?.progress_note ?? null,
        attempts: job?.rows[0]?.attempts ?? 0,
        maxAttempts: job?.rows[0]?.max_attempts ?? 0,
        lastError: run.calculation_error ?? job?.rows[0]?.last_error ?? null,
        populationCount: Number(run.population_count),
        calculatedCount: Number(run.calculated_count),
        failedCount: Number(run.failed_count),
        openExceptionCount: open,
        partitionCount: total,
        partitionsCompleted: Number(run.partitions_completed),
        startedAt: iso(run.calculation_started_at),
        partitions: parts.rows.map((p) => ({
          partitionNo: p.partition_no,
          state: p.state,
          employeeCount: p.employee_count,
          calculatedCount: p.calculated_count,
          failedCount: p.failed_count,
          attempts: p.attempts,
          lastError: p.last_error ?? null,
        })),
      };
    });
  }

  // ------------------------------------------------------------------ policy

  async policy(client: PoolClient, companyId: string): Promise<{ requireValidationBeforeApproval: boolean; requirePeriodForRun: boolean; blockFinalizeBeforePeriodStart: boolean }> {
    const rules = this.businessPolicy ? await this.businessPolicy.resolveEffectivePolicy(client, companyId, "payroll", {}) : null;
    return {
      requireValidationBeforeApproval: rules?.requireValidationBeforeApproval === true,
      requirePeriodForRun: rules?.requirePeriodForRun === true,
      blockFinalizeBeforePeriodStart: rules?.blockFinalizeBeforePeriodStart === true,
    };
  }

  // ------------------------------------------------------------------ pre-validation / validation

  /** Draft -> pre_validated when the master data a calculation needs is in place. */
  async preValidate(claims: RequestClaims, runId: string): Promise<PayrollRunValidationView> {
    const access = await this.requireRunAction(claims, CALCULATE_BASE, "Not permitted to calculate payroll");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertInScope(access, run);
      if (!["draft", "pre_validated"].includes(run.status)) {
        throw new BadRequestException(`Payroll run is ${run.status}; pre-validation applies to a draft run`);
      }
      const findings = await this.preValidationFindings(client, run);
      const errors = findings.filter((f) => f.severity === "error").length;
      const warnings = findings.filter((f) => f.severity === "warning").length;
      const passed = errors === 0;
      const updated = await this.transition(client, claims, runId, passed ? "pre_validated" : "draft", {
        action: passed ? "pre_validate" : "pre_validate_failed",
        metadata: { errors, warnings, findings: findings.slice(0, 200) },
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.pre_validate",
        target: runId,
        metadata: { passed, errors, warnings },
      });
      return { run: await this.view(client, updated), stage: "pre_validation", passed, errorCount: errors, warningCount: warnings, findings };
    });
  }

  /** Calculated -> validated when the results are fit to be approved. */
  async validate(claims: RequestClaims, runId: string): Promise<PayrollRunValidationView> {
    const access = await this.requireRunAction(claims, CALCULATE_BASE, "Not permitted to calculate payroll");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertInScope(access, run);
      if (!["calculated", "validated"].includes(run.status)) {
        throw new BadRequestException(`Payroll run is ${run.status}; validation applies to a calculated run`);
      }
      const findings = await this.validationFindings(client, run);
      const errors = findings.filter((f) => f.severity === "error").length;
      const warnings = findings.filter((f) => f.severity === "warning").length;
      const passed = errors === 0;
      const updated = await this.transition(client, claims, runId, passed ? "validated" : "calculated", {
        action: passed ? "validate" : "validate_failed",
        metadata: { errors, warnings, findings: findings.slice(0, 200) },
      });
      await client.query("UPDATE payroll_runs SET warning_count = $2 WHERE id = $1", [runId, warnings]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_run.validate",
        target: runId,
        metadata: { passed, errors, warnings },
      });
      return { run: await this.view(client, { ...updated, warning_count: warnings }), stage: "validation", passed, errorCount: errors, warningCount: warnings, findings };
    });
  }

  private async preValidationFindings(client: PoolClient, run: Record<string, any>): Promise<PayrollValidationFinding[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const findings: PayrollValidationFinding[] = [];
    const periodStart = iso(run.period_start)!.slice(0, 10);
    const periodEnd = iso(run.period_end)!.slice(0, 10);
    const people = await selectRunPopulation(client, run as Parameters<typeof selectRunPopulation>[1]);
    if (people.length === 0) {
      findings.push({ severity: "error", code: "EMPTY_POPULATION", message: run.selection ? "No employee falls into this run's period, payroll area and selection" : "No employee falls into this run's period and payroll area" });
      return findings;
    }
    const ids = people.map((p) => p.id);

    const noComp = await client.query<{ id: string }>(
      `SELECT e.id FROM employees e
        WHERE e.id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM employee_compensation_components ecc JOIN compensation_components cc ON cc.id = ecc.component_id
             WHERE ecc.employee_id = e.id AND cc.is_active = true
               AND ecc.effective_from <= $3::date AND (ecc.effective_to IS NULL OR ecc.effective_to >= $2::date))`,
      [ids, periodStart, periodEnd]
    );
    const byId = new Map(people.map((p) => [p.id, p]));
    for (const r of noComp.rows) {
      findings.push({ severity: "error", code: "NO_COMPENSATION", message: "No compensation record covers this employee for the period", employeeId: r.id, employeeNumber: byId.get(r.id)?.employee_number });
    }
    for (const p of people) {
      if (!p.bank_account_number) {
        findings.push({ severity: "warning", code: "NO_PAYMENT_ACCOUNT", message: "No active primary payment account; the employee cannot be paid by bank file", employeeId: p.id, employeeNumber: p.employee_number });
      }
    }

    if (run.run_type === "regular" && !run.is_simulation) {
      const overlap = await client.query(
        `SELECT period_start, period_end FROM payroll_runs
          WHERE company_id = $1 AND id <> $2 AND run_type = 'regular' AND is_simulation = false AND status NOT IN ('reversed', 'cancelled')
            AND COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND daterange(period_start, period_end, '[]') && daterange($4::date, $5::date, '[]')
            AND NOT ($6::boolean AND selection IS NOT NULL AND period_start = $4::date AND period_end = $5::date)`,
        [run.company_id, run.id, run.payroll_area_id ?? null, periodStart, periodEnd, run.selection != null]
      );
      for (const o of overlap.rows) {
        findings.push({ severity: "error", code: "PERIOD_OVERLAP", message: `Another active run covers ${iso(o.period_start)!.slice(0, 10)} to ${iso(o.period_end)!.slice(0, 10)} for the same payroll area` });
      }
    }

    const unpriced = await client.query<{ employee_id: string; work_date: unknown }>(
      `SELECT employee_id, work_date FROM overtime_records
        WHERE employee_id = ANY($1::uuid[]) AND status = 'approved' AND payout_mode = 'pay' AND consumed_payroll_run_id IS NULL
          AND amount IS NULL AND work_date BETWEEN $2::date AND $3::date`,
      [ids, periodStart, periodEnd]
    );
    for (const r of unpriced.rows) {
      findings.push({ severity: "error", code: "OVERTIME_UNPRICED", message: `Approved overtime on ${iso(r.work_date)!.slice(0, 10)} has no snapshotted amount`, employeeId: r.employee_id, employeeNumber: byId.get(r.employee_id)?.employee_number });
    }

    // R3 - when the tenant deducts pay for absence, HR must see who is affected BEFORE the run (and can correct an attendance result first).
    if (run.run_type === "regular") {
      const mode = await client.query<{ absence_deduction_mode: string; late_marks_per_absence: number | null }>(
        `SELECT absence_deduction_mode, late_marks_per_absence FROM payroll_settings
          WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
          ORDER BY effective_from DESC LIMIT 1`,
        [run.company_id, periodEnd]
      );
      if (mode.rows[0]?.absence_deduction_mode === "absent_days") {
        const lateN = mode.rows[0].late_marks_per_absence;
        const rows = await client.query<{ employee_id: string; absent: string; half: string; late: string }>(
          `SELECT employee_id,
                  COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
                  COUNT(*) FILTER (WHERE status = 'half_day')::int AS half,
                  COUNT(*) FILTER (WHERE status IN ('late','late_and_early'))::int AS late
             FROM attendance_daily_results
            WHERE employee_id = ANY($1::uuid[]) AND work_date BETWEEN $2::date AND $3::date
            GROUP BY employee_id`,
          [ids, periodStart, periodEnd]
        );
        let affected = 0;
        for (const r of rows.rows) {
          const days = Number(r.absent) + Number(r.half) * 0.5 + (lateN ? Math.floor(Number(r.late) / lateN) : 0);
          if (days <= 0) continue;
          affected++;
          findings.push({
            severity: "warning",
            code: "ABSENCE_DEDUCTION",
            message: `${days} day(s) will be deducted for attendance (${r.absent} absent, ${r.half} half-day, ${r.late} late mark(s)). Correct the attendance first if any of these days is wrong`,
            employeeId: r.employee_id,
            employeeNumber: byId.get(r.employee_id)?.employee_number,
          });
        }
        findings.push({ severity: "info", code: "ABSENCE_DEDUCTION_ON", message: `Attendance deduction is on: ${affected} employee(s) have days to be deducted in this period` });
        const last = await client.query<{ d: unknown }>("SELECT MAX(work_date) AS d FROM attendance_daily_results WHERE company_id = $1", [run.company_id]);
        const lastDay = iso(last.rows[0]?.d)?.slice(0, 10) ?? null;
        const needed = new Date(`${periodEnd}T00:00:00Z`);
        needed.setUTCDate(needed.getUTCDate() - 1);
        if (!lastDay || lastDay < needed.toISOString().slice(0, 10)) {
          findings.push({ severity: "warning", code: "ATTENDANCE_NOT_EVALUATED", message: `Attendance has been processed only up to ${lastDay ?? "(never)"}; days after that are not checked for absence, so nothing is deducted for them` });
        }
      }
    }

    if (run.run_type === "regular" && !run.is_simulation) {
      const month = Number(periodStart.slice(5, 7));
      const taxYearStart = `${Number(periodStart.slice(0, 4)) - (month >= 7 ? 0 : 1)}-07-01`;
      // An earlier month of this tax year still open: its pay is not in the year-to-date yet, so this month's tax would be worked out on too little.
      const open = await client.query(
        `SELECT period_start, period_end, status FROM payroll_runs
          WHERE company_id = $1 AND id <> $2 AND run_type = 'regular' AND is_simulation = false
            AND status NOT IN ('finalized','accounting','payment_released','reconciled','closed','reopened','reversed','cancelled')
            AND COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND period_end < $4::date AND period_end >= $5::date
          ORDER BY period_end`,
        [run.company_id, run.id, run.payroll_area_id ?? null, periodStart, taxYearStart]
      );
      for (const o of open.rows) {
        findings.push({ severity: "warning", code: "EARLIER_RUN_NOT_FINAL", message: `The run for ${iso(o.period_start)!.slice(0, 10)} to ${iso(o.period_end)!.slice(0, 10)} is still ${o.status}; finalise or cancel it first so this month's tax uses the year-to-date correctly` });
      }
      // Tax year runs July to June. After July, with no finalised month in the tax year, tax is estimated from this month alone.
      if (periodStart > taxYearStart) {
        const history = await client.query(
          `SELECT 1 FROM payroll_runs
            WHERE company_id = $1 AND id <> $2 AND run_type = 'regular' AND is_simulation = false
              AND status IN ('finalized','accounting','payment_released','reconciled','closed','reopened')
              AND COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
              AND period_end >= $4::date AND period_end < $5::date LIMIT 1`,
          [run.company_id, run.id, run.payroll_area_id ?? null, taxYearStart, periodStart]
        );
        if (history.rowCount === 0) {
          findings.push({ severity: "warning", code: "NO_TAX_YEAR_HISTORY", message: `No finalised payroll exists for the earlier months of this tax year (from ${taxYearStart}). Tax is estimated from this month alone unless each employee's earlier income and tax are entered in their tax profile` });
        }
      }
    }

    findings.push({ severity: "info", code: "POPULATION", message: `${people.length} employee(s) fall into this run` });
    return findings;
  }

  private async validationFindings(client: PoolClient, run: Record<string, any>): Promise<PayrollValidationFinding[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const findings: PayrollValidationFinding[] = [];
    const slips = await client.query(
      `SELECT employee_id, employee_number, gross_pay, net_pay, income_tax_monthly FROM payslips WHERE payroll_run_id = $1`,
      [run.id]
    );
    if (slips.rowCount === 0) {
      findings.push({ severity: "error", code: "NO_PAYSLIPS", message: "The run has no payslips; calculate it first" });
      return findings;
    }
    for (const s of slips.rows) {
      if (Number(s.net_pay) < 0) {
        findings.push({ severity: "error", code: "NEGATIVE_NET_PAY", message: `Net pay is negative (${Number(s.net_pay).toFixed(2)})`, employeeId: s.employee_id, employeeNumber: s.employee_number });
      }
      if (Number(s.gross_pay) === 0) {
        findings.push({ severity: "warning", code: "ZERO_GROSS", message: "Gross pay is zero", employeeId: s.employee_id, employeeNumber: s.employee_number });
      }
      if (Number(s.income_tax_monthly) > Number(s.gross_pay)) {
        findings.push({ severity: "error", code: "TAX_EXCEEDS_GROSS", message: "Income tax is higher than gross pay", employeeId: s.employee_id, employeeNumber: s.employee_number });
      }
    }
    if (Number(run.failed_count) > 0) {
      findings.push({ severity: "warning", code: "CALCULATION_FAILURES", message: `${run.failed_count} employee(s) could not be calculated and will not be paid by this run` });
    }
    const overrides = await client.query("SELECT count(*)::int AS n FROM payroll_overrides WHERE payroll_run_id = $1 AND status = 'applied'", [run.id]);
    if (overrides.rows[0].n > 0) {
      findings.push({ severity: "warning", code: "OVERRIDES_APPLIED", message: `${overrides.rows[0].n} value(s) were overridden manually; the approver sees them listed` });
    }
    // Variance against the previous finalised regular run of the same area: the total, then each person who moved a lot.
    const prev = await this.previousFinalRun(client, run);
    const net = slips.rows.reduce((a, s) => a + Number(s.net_pay), 0);
    if (prev) {
      const v = await this.buildVariance(client, run, prev);
      if (v.totals.previousNetPay && v.totals.previousNetPay > 0 && v.totals.netChangePercent !== null) {
        const delta = v.totals.netChangePercent;
        findings.push({ severity: "info", code: "NET_VARIANCE", message: `Total net pay is ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% against the previous finalised run` });
      }
      for (const r of v.rows) {
        const who = { employeeId: r.employeeId, employeeNumber: r.employeeNumber };
        if (r.flags.includes("missing_from_run")) {
          findings.push({ severity: "warning", code: "MISSING_FROM_RUN", message: `${r.employeeName} was paid ${money(r.previousNetPay)} in the previous run but has no payslip in this one (left, on hold, or left out by mistake?)`, ...who });
        }
        if (r.flags.includes("net_change")) {
          findings.push({ severity: "warning", code: "NET_PAY_CHANGE", message: `${r.employeeName}: net pay ${signedPercent(r.netChangePercent)} (${money(r.previousNetPay)} to ${money(r.netPay)})${reasonText(r)}`, ...who });
        }
        if (r.flags.includes("tax_change")) {
          findings.push({ severity: "warning", code: "TAX_CHANGE", message: `${r.employeeName}: income tax moved from ${money(r.previousIncomeTax)} to ${money(r.incomeTax)}`, ...who });
        }
      }
      if (v.totals.newCount > 0) {
        findings.push({ severity: "info", code: "NEW_IN_RUN", message: `${v.totals.newCount} employee(s) are paid for the first time in this run` });
      }
    } else if (net > 0) {
      findings.push({ severity: "info", code: "NO_PREVIOUS_RUN", message: "There is no earlier finalised run to compare with" });
    }
    return findings;
  }

  /** The latest finalised regular run of the same payroll area that ended before this one began. */
  private async previousFinalRun(client: PoolClient, run: Record<string, any>): Promise<{ id: string; period_start: unknown; period_end: unknown } | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const prev = await client.query(
      `SELECT id, period_start, period_end FROM payroll_runs
        WHERE company_id = $1 AND id <> $2 AND run_type = 'regular' AND is_simulation = false
          AND status IN ('finalized','accounting','payment_released','reconciled','closed','reopened')
          AND COALESCE(payroll_area_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND period_end < $4::date
        ORDER BY period_end DESC LIMIT 1`,
      [run.company_id, run.id, run.payroll_area_id ?? null, iso(run.period_start)!.slice(0, 10)]
    );
    return prev.rows[0] ?? null;
  }

  private async buildVariance(client: PoolClient, run: Record<string, any>, prev: { id: string; period_start: unknown; period_end: unknown } | null): Promise<PayrollRunVarianceView> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await client.query(
      `SELECT COALESCE(c.employee_id, p.employee_id) AS employee_id,
              COALESCE(c.employee_number, p.employee_number) AS employee_number,
              concat_ws(' ', e.first_name, e.last_name) AS employee_name,
              c.gross_pay AS gross, p.gross_pay AS prev_gross,
              c.income_tax_monthly AS tax, p.income_tax_monthly AS prev_tax,
              c.net_pay AS net, p.net_pay AS prev_net
         FROM (SELECT * FROM payslips WHERE payroll_run_id = $1) c
         FULL OUTER JOIN (SELECT * FROM payslips WHERE payroll_run_id = $2::uuid) p ON p.employee_id = c.employee_id
         JOIN employees e ON e.id = COALESCE(c.employee_id, p.employee_id)`,
      [run.id, prev?.id ?? null]
    );
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const rows: PayrollVarianceRowView[] = r.rows.map((x) => {
      const netPay = num(x.net);
      const previousNetPay = num(x.prev_net);
      const incomeTax = num(x.tax);
      const previousIncomeTax = num(x.prev_tax);
      const netChange = Math.round(((netPay ?? 0) - (previousNetPay ?? 0)) * 100) / 100;
      const netChangePercent = previousNetPay !== null && previousNetPay > 0 && netPay !== null ? Math.round((netChange / previousNetPay) * 1000) / 10 : null;
      const flags: PayrollVarianceFlag[] = [];
      if (prev) {
        if (netPay === null) flags.push("missing_from_run");
        else if (previousNetPay === null) flags.push("new_in_run");
        else {
          if (netChangePercent !== null && Math.abs(netChangePercent) > VARIANCE_NET_PERCENT && Math.abs(netChange) >= VARIANCE_MIN_AMOUNT) flags.push("net_change");
          const taxChange = (incomeTax ?? 0) - (previousIncomeTax ?? 0);
          const taxBase = Math.max(previousIncomeTax ?? 0, 1);
          if (Math.abs(taxChange) >= VARIANCE_MIN_AMOUNT && (Math.abs(taxChange) / taxBase) * 100 > VARIANCE_TAX_PERCENT) flags.push("tax_change");
        }
      }
      return {
        employeeId: x.employee_id,
        employeeNumber: x.employee_number,
        employeeName: String(x.employee_name ?? "").trim(),
        grossPay: num(x.gross),
        previousGrossPay: num(x.prev_gross),
        incomeTax,
        previousIncomeTax,
        netPay,
        previousNetPay,
        netChange,
        netChangePercent,
        flags,
      };
    });
    // the biggest movers first; people with no change last
    rows.sort((a, b) => Math.abs(b.netChange) - Math.abs(a.netChange) || a.employeeNumber.localeCompare(b.employeeNumber));
    const currentRows = rows.filter((x) => x.netPay !== null);
    const previousRows = rows.filter((x) => x.previousNetPay !== null);
    const netPay = currentRows.reduce((a, x) => a + (x.netPay ?? 0), 0);
    const previousNetPay = prev ? previousRows.reduce((a, x) => a + (x.previousNetPay ?? 0), 0) : null;
    return {
      payrollRunId: run.id,
      previousRun: prev ? { id: prev.id, periodStart: iso(prev.period_start)!.slice(0, 10), periodEnd: iso(prev.period_end)!.slice(0, 10) } : null,
      netPayThresholdPercent: VARIANCE_NET_PERCENT,
      taxThresholdPercent: VARIANCE_TAX_PERCENT,
      totals: {
        netPay: Math.round(netPay * 100) / 100,
        previousNetPay: previousNetPay === null ? null : Math.round(previousNetPay * 100) / 100,
        netChangePercent: previousNetPay && previousNetPay > 0 ? Math.round(((netPay - previousNetPay) / previousNetPay) * 1000) / 10 : null,
        headcount: currentRows.length,
        previousHeadcount: prev ? previousRows.length : null,
        newCount: rows.filter((x) => x.flags.includes("new_in_run")).length,
        missingCount: rows.filter((x) => x.flags.includes("missing_from_run")).length,
        flaggedCount: rows.filter((x) => x.flags.length > 0).length,
      },
      rows,
    };
  }

  /** The run compared with the previous finalised run, person by person (read only). */
  async getVariance(claims: RequestClaims, runId: string): Promise<PayrollRunVarianceView> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      return this.buildVariance(client, run, await this.previousFinalRun(client, run));
    });
  }

  // ------------------------------------------------------------------ close / reopen / cancel

  async close(claims: RequestClaims, runId: string, note?: string): Promise<PayrollRunValidationView["run"]> {
    const access = await this.requireRunAction(claims, FINALIZE_BASE, "Not permitted to close payroll runs");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertInScope(access, run);
      if (!["finalized", "accounting", "payment_released", "reconciled", "reopened"].includes(run.status)) {
        throw new BadRequestException(`Payroll run is ${run.status}; only a finalised run can be closed`);
      }
      const updated = await this.transition(client, claims, runId, "closed", {
        action: "close",
        reason: note ?? null,
        set: { closed_at: new Date(), closed_by_user_account_id: claims.sub },
      });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.close", target: runId, metadata: { note } });
      return this.view(client, updated);
    });
  }

  /** Highly restricted: needs payroll.reopen.all, a reason, and leaves a record besides the audit entry. */
  async reopen(claims: RequestClaims, runId: string, reason: string): Promise<PayrollRunValidationView["run"]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "payroll.reopen.all"))) throw new ForbiddenException("Not permitted to reopen payroll runs");
    const why = reason?.trim();
    if (!why || why.length < 5) throw new BadRequestException("A reason (at least 5 characters) is required to reopen a payroll run");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      if (run.status !== "closed") throw new BadRequestException(`Payroll run is ${run.status}; only a closed run can be reopened`);
      if (run.payroll_period_id) {
        const period = await client.query<{ status: string; label: string }>("SELECT status, label FROM payroll_periods WHERE id = $1", [run.payroll_period_id]);
        if (period.rows[0]?.status === "closed") {
          throw new BadRequestException(`Payroll period ${period.rows[0].label} is closed; reopen the period first`);
        }
      }
      const updated = await this.transition(client, claims, runId, "reopened", { action: "reopen", reason: why });
      await client.query(
        `INSERT INTO payroll_run_reopens (company_id, payroll_run_id, from_status, reason, requested_by, authorized_by, correlation_id)
         VALUES ($1, $2, 'closed', $3, $4, $4, $5)`,
        [run.company_id, runId, why, claims.sub, currentCorrelationId()]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.reopen", target: runId, metadata: { reason: why } });
      return this.view(client, updated);
    });
  }

  async cancel(claims: RequestClaims, runId: string, reason: string): Promise<PayrollRunValidationView["run"]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "payroll.cancel.all"))) throw new ForbiddenException("Not permitted to cancel payroll runs");
    const why = reason?.trim();
    if (!why || why.length < 5) throw new BadRequestException("A reason (at least 5 characters) is required to cancel a payroll run");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      if (!canTransitionPayrollRun(run.status, "cancelled")) {
        throw new BadRequestException(
          run.status === "pending_approval"
            ? "This run is awaiting approval; have it rejected first, then cancel it"
            : `Payroll run is ${run.status}; only a run that has not been finalised can be cancelled`
        );
      }
      const updated = await this.transition(client, claims, runId, "cancelled", {
        action: "cancel",
        reason: why,
        set: { cancelled_at: new Date(), cancelled_by_user_account_id: claims.sub, cancel_reason: why },
      });
      await releaseRetroForRun(client, runId);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_run.cancel", target: runId, metadata: { reason: why } });
      return this.view(client, updated);
    });
  }

  // ------------------------------------------------------------------ reversal record

  /** Called by PayrollService.reverseRun() inside its transaction. */
  async recordReversal(
    client: PoolClient,
    claims: RequestClaims,
    run: { id: string; company_id: string },
    correctiveRunId: string,
    reason: string,
    impact: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO payroll_reversals (company_id, payroll_run_id, corrective_run_id, reason, requested_by, authorized_by, impact, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6::jsonb, $7)
       ON CONFLICT (payroll_run_id) DO NOTHING`,
      [run.company_id, run.id, correctiveRunId, reason, claims.sub, JSON.stringify(impact), currentCorrelationId()]
    );
  }

  async getReversal(claims: RequestClaims, runId: string): Promise<PayrollReversalView | null> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM payroll_reversals WHERE payroll_run_id = $1", [runId]);
      if (r.rowCount === 0) return null;
      const x = r.rows[0];
      return {
        id: x.id,
        payrollRunId: x.payroll_run_id,
        correctiveRunId: x.corrective_run_id ?? null,
        reason: x.reason,
        requestedBy: x.requested_by ?? null,
        authorizedBy: x.authorized_by ?? null,
        authorizationPermission: x.authorization_permission,
        impact: x.impact ?? {},
        createdAt: iso(x.created_at) as string,
      };
    });
  }

  async listReopens(claims: RequestClaims, runId: string): Promise<PayrollRunReopenView[]> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM payroll_run_reopens WHERE payroll_run_id = $1 ORDER BY created_at", [runId]);
      return r.rows.map((x) => ({
        id: x.id,
        payrollRunId: x.payroll_run_id,
        fromStatus: x.from_status,
        reason: x.reason,
        requestedBy: x.requested_by ?? null,
        authorizedBy: x.authorized_by ?? null,
        createdAt: iso(x.created_at) as string,
      }));
    });
  }

  // ------------------------------------------------------------------ PAY-23 overrides

  async listOverrides(claims: RequestClaims, runId: string): Promise<PayrollOverrideView[]> {
    await this.requireView(claims, runId);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM payroll_overrides WHERE payroll_run_id = $1 ORDER BY created_at, id", [runId]);
      return r.rows.map(rowToOverride);
    });
  }

  async applyOverride(claims: RequestClaims, runId: string, input: SetPayrollOverrideRequest): Promise<PayrollOverrideView> {
    const access = await this.requireRunAction(claims, CALCULATE_BASE, "Not permitted to calculate payroll");
    if (!(await this.rbac.can(claims, "payroll.override.all"))) throw new ForbiddenException("Not permitted to override payroll values");
    const spec = OVERRIDE_COLUMNS[input.field];
    if (!spec) throw new BadRequestException("That value cannot be overridden");
    const reason = input.reason?.trim();
    if (!reason || reason.length < 5) throw new BadRequestException("A reason (at least 5 characters) is required for an override");
    if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0) {
      throw new BadRequestException("The override value must be a number that is zero or more");
    }
    const value = Number(input.value.toFixed(2));
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertInScope(access, run);
      if (!["calculated", "validated"].includes(run.status)) {
        throw new BadRequestException(`Payroll run is ${run.status}; values can only be overridden while it is calculated and not yet submitted`);
      }
      const slip = await client.query(`SELECT * FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2 FOR UPDATE`, [runId, input.employeeId]);
      if (slip.rowCount === 0) throw new NotFoundException("This employee has no payslip in the run");
      const current = Number(slip.rows[0][spec.column]);
      // A second override of the same field replaces the first; the original calculated value stays the "old" value.
      const prior = await client.query(
        "UPDATE payroll_overrides SET status = 'withdrawn', withdrawn_at = now() WHERE payroll_run_id = $1 AND employee_id = $2 AND field = $3 AND status = 'applied' RETURNING old_value",
        [runId, input.employeeId, input.field]
      );
      const oldValue = prior.rowCount ? Number(prior.rows[0].old_value) : current;
      await this.writeOverrideValue(client, slip.rows[0], input.field, value, oldValue, reason);
      const ins = await client.query(
        `INSERT INTO payroll_overrides (company_id, payroll_run_id, payslip_id, employee_id, field, old_value, new_value, reason, overridden_by, correlation_id)
         VALUES ($1, $2, $3, $4, $5, to_jsonb($6::numeric), to_jsonb($7::numeric), $8, $9, $10) RETURNING *`,
        [run.company_id, runId, slip.rows[0].id, input.employeeId, input.field, oldValue, value, reason, claims.sub, currentCorrelationId()]
      );
      await this.syncPayslipStatus(client, slip.rows[0].id);
      await this.refreshRunTotals(client, runId);
      await this.transition(client, claims, runId, run.status, {
        action: "override",
        reason,
        metadata: { employeeId: input.employeeId, field: input.field, from: current, to: value },
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_override.apply",
        target: ins.rows[0].id,
        metadata: { runId, employeeId: input.employeeId, field: input.field, from: current, to: value, reason },
      });
      return rowToOverride(ins.rows[0]);
    });
  }

  async withdrawOverride(claims: RequestClaims, runId: string, overrideId: string): Promise<PayrollOverrideView> {
    const access = await this.requireRunAction(claims, CALCULATE_BASE, "Not permitted to calculate payroll");
    if (!(await this.rbac.can(claims, "payroll.override.all"))) throw new ForbiddenException("Not permitted to override payroll values");
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadRun(client, runId);
      this.assertInScope(access, run);
      if (!["calculated", "validated"].includes(run.status)) {
        throw new BadRequestException(`Payroll run is ${run.status}; an override can only be withdrawn while the run is calculated and not yet submitted`);
      }
      const ov = await client.query("SELECT * FROM payroll_overrides WHERE id = $1 AND payroll_run_id = $2 FOR UPDATE", [overrideId, runId]);
      if (ov.rowCount === 0) throw new NotFoundException("Override not found");
      if (ov.rows[0].status !== "applied") throw new BadRequestException("This override is already withdrawn");
      const slip = await client.query("SELECT * FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2 FOR UPDATE", [runId, ov.rows[0].employee_id]);
      if (slip.rowCount) {
        await this.writeOverrideValue(client, slip.rows[0], ov.rows[0].field, Number(ov.rows[0].old_value), Number(ov.rows[0].new_value), "override withdrawn");
      }
      const done = await client.query("UPDATE payroll_overrides SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1 RETURNING *", [overrideId]);
      if (slip.rowCount) await this.syncPayslipStatus(client, slip.rows[0].id);
      await this.refreshRunTotals(client, runId);
      await this.transition(client, claims, runId, run.status, { action: "override_withdrawn", metadata: { overrideId } });
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_override.withdraw", target: overrideId, metadata: { runId } });
      return rowToOverride(done.rows[0]);
    });
  }

  /**
   * After a recalculation replaced the run's payslips, put every active override back on the new rows so a
   * manual decision survives a rerun (and is still visible to the approver). An override whose employee no
   * longer has a payslip is withdrawn with a note.
   */
  async reapplyOverrides(client: PoolClient, claims: RequestClaims, runId: string): Promise<{ reapplied: number; dropped: number }> {
    const active = await client.query("SELECT * FROM payroll_overrides WHERE payroll_run_id = $1 AND status = 'applied' ORDER BY created_at FOR UPDATE", [runId]);
    let reapplied = 0;
    let dropped = 0;
    for (const ov of active.rows) {
      const slip = await client.query("SELECT * FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2 FOR UPDATE", [runId, ov.employee_id]);
      if (slip.rowCount === 0) {
        await client.query("UPDATE payroll_overrides SET status = 'withdrawn', withdrawn_at = now(), payslip_id = NULL WHERE id = $1", [ov.id]);
        dropped++;
        continue;
      }
      const calculated = Number(slip.rows[0][OVERRIDE_COLUMNS[ov.field as PayrollOverridableField].column]);
      await this.writeOverrideValue(client, slip.rows[0], ov.field, Number(ov.new_value), calculated, ov.reason);
      await client.query(
        "UPDATE payroll_overrides SET payslip_id = $2, old_value = to_jsonb($3::numeric), reapplied_count = reapplied_count + 1, approved_by = NULL, approved_at = NULL WHERE id = $1",
        [ov.id, slip.rows[0].id, calculated]
      );
      await this.syncPayslipStatus(client, slip.rows[0].id);
      reapplied++;
    }
    if (reapplied + dropped > 0) {
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_override.reapply",
        target: runId,
        metadata: { reapplied, dropped },
      });
    }
    return { reapplied, dropped };
  }

  /** The workflow approval of the run also approves the overrides it contains. */
  async approveOverrides(client: PoolClient, runId: string, approverUserId: string): Promise<number> {
    const r = await client.query(
      "UPDATE payroll_overrides SET approved_by = $2, approved_at = now() WHERE payroll_run_id = $1 AND status = 'applied' AND approved_by IS NULL",
      [runId, approverUserId]
    );
    return r.rowCount ?? 0;
  }

  /** Sets one overridden column on a payslip, adjusts net pay by the employee-borne difference and annotates the trace. */
  private async writeOverrideValue(
    client: PoolClient,
    slip: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    field: PayrollOverridableField,
    newValue: number,
    previousCalculated: number,
    reason: string
  ): Promise<void> {
    const spec = OVERRIDE_COLUMNS[field];
    const current = Number(slip[spec.column]);
    const netNow = Number(slip.net_pay);
    const net = spec.employeeBorne ? Number((netNow + current - newValue).toFixed(2)) : netNow;
    const breakdown = Array.isArray(slip.calculation_breakdown) ? [...slip.calculation_breakdown] : [];
    for (let i = breakdown.length - 1; i >= 0; i--) {
      if (typeof breakdown[i]?.label === "string" && breakdown[i].label.startsWith("Net pay")) {
        breakdown[i] = { ...breakdown[i], value: net };
        break;
      }
    }
    breakdown.push({
      label: `Manual override of ${field}: calculated ${previousCalculated.toFixed(2)}, set to ${newValue.toFixed(2)} - ${reason}`,
      value: newValue,
    });
    const employerCost = spec.employeeBorne ? Number(slip.employer_cost) : Number((Number(slip.employer_cost) + newValue - current).toFixed(2));
    await client.query(`UPDATE payslips SET ${spec.column} = $2, net_pay = $3, employer_cost = $5, calculation_breakdown = $4::jsonb, updated_at = now() WHERE id = $1`, [
      slip.id,
      newValue,
      net,
      JSON.stringify(breakdown),
      employerCost,
    ]);
    // PAY-05 - the structured line follows the figure, flagged as overridden (and cleared again on a withdrawal)
    const restoring = reason === "override withdrawn";
    const signed = spec.affects === "employer_cost" ? newValue : -newValue;
    const updated = await client.query(
      `UPDATE payroll_component_results
          SET amount = $3, is_overridden = $4,
              trace = CASE WHEN $4 THEN trace || jsonb_build_object('override', jsonb_build_object('calculated', $5::numeric, 'reason', $6::text))
                           ELSE trace - 'override' END
        WHERE payslip_id = $1 AND component_key = $2`,
      [slip.id, spec.componentKey, signed, !restoring, previousCalculated, reason]
    );
    if (updated.rowCount === 0 && newValue !== 0) {
      await client.query(
        `INSERT INTO payroll_component_results (company_id, payroll_run_id, payslip_id, employee_id, calculation_sequence, line_no, component_key, label, category, affects, amount, source_type, trace, is_overridden)
         SELECT $1, $2, $3, $4, $5, COALESCE(MAX(line_no), 0) + 1, $6, $7, $8, $9, $10, $11, $12::jsonb, true FROM payroll_component_results WHERE payslip_id = $3`,
        [slip.company_id, slip.payroll_run_id, slip.id, slip.employee_id, slip.calculation_sequence ?? 1, spec.componentKey, spec.label, spec.category, spec.affects, signed, spec.source, JSON.stringify({ override: { calculated: previousCalculated, reason } })]
      );
    }
  }

  /** A payslip is 'overridden' while any override is applied to it, otherwise 'calculated'. */
  private async syncPayslipStatus(client: PoolClient, payslipId: string): Promise<void> {
    await client.query(
      `UPDATE payslips SET status = CASE WHEN EXISTS (SELECT 1 FROM payroll_overrides o WHERE o.payslip_id = $1 AND o.status = 'applied') THEN 'overridden' ELSE 'calculated' END
        WHERE id = $1 AND NOT is_immutable`,
      [payslipId]
    );
  }

  // ------------------------------------------------------------------ helpers

  async loadRun(client: PoolClient, id: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await client.query("SELECT * FROM payroll_runs WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Payroll run not found");
    return r.rows[0];
  }

  /** Minimal run view for control endpoints (the full PayrollRunView mapper lives in PayrollService). */
  private async view(client: PoolClient, row: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const summary = await client.query(
      `SELECT COUNT(*)::int AS payslip_count, COALESCE(SUM(gross_pay), 0) AS g, COALESCE(SUM(net_pay), 0) AS n FROM payslips WHERE payroll_run_id = $1`,
      [row.id]
    );
    return rowToRunView(row, { payslipCount: summary.rows[0].payslip_count, totalGrossPay: Number(summary.rows[0].g), totalNetPay: Number(summary.rows[0].n) });
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireRunAction(claims: RequestClaims, base: string, message: string): Promise<PayrollAreaAccess> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [base]);
    if (!access) throw new ForbiddenException(message);
    return access;
  }

  private assertInScope(access: PayrollAreaAccess, run: { payroll_area_id?: string | null }): void {
    if (!isPayrollAreaInScope(access, run.payroll_area_id)) {
      throw new ForbiddenException(
        run.payroll_area_id ? "This payroll run's payroll area is outside your data scope" : "Only a caller with the .all permission can act on a company-wide payroll run"
      );
    }
  }

  /** Anyone who can see runs at all (any payroll staff permission, or approve) may read their history. */
  private async requireView(claims: RequestClaims, runId: string): Promise<void> {
    await this.requireModule(claims);
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, [CALCULATE_BASE, FINALIZE_BASE, DISBURSE_BASE]);
    const approver = await this.rbac.can(claims, "payroll.approve.all");
    if (!access && !approver) throw new ForbiddenException("Not permitted to view payroll runs");
    if (access && !access.unrestricted) {
      const run = await this.db.withClaims(claims, (c) => this.loadRun(c, runId));
      if (!isPayrollAreaInScope(access, run.payroll_area_id)) throw new NotFoundException("Payroll run not found");
    }
  }
}


function money(v: number | null): string {
  return v === null ? "-" : `Rs ${Math.round(v).toLocaleString("en-US")}`;
}

function signedPercent(v: number | null): string {
  return v === null ? "changed" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** Says whether the move came from gross pay, tax, or the other deductions. */
function reasonText(r: PayrollVarianceRowView): string {
  if (r.grossPay === null || r.previousGrossPay === null) return "";
  const gross = r.grossPay - r.previousGrossPay;
  const tax = (r.incomeTax ?? 0) - (r.previousIncomeTax ?? 0);
  const parts: string[] = [];
  if (Math.abs(gross) >= 1) parts.push(`gross ${gross >= 0 ? "+" : "-"}${money(Math.abs(gross))}`);
  if (Math.abs(tax) >= 1) parts.push(`tax ${tax >= 0 ? "+" : "-"}${money(Math.abs(tax))}`);
  return parts.length ? `; ${parts.join(", ")}` : "";
}
