import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { currentCorrelationId } from "../common/request-context";
import { PayrollService } from "./payroll.service";
import { toIsoDate } from "../effective-dating/effective-dating.engine";
import type {
  DetectPayrollRetroRequest,
  DetectPayrollRetroResponse,
  IncludePayrollRetroRequest,
  PayrollRetroResultView,
  PayrollRetroSourceEvent,
  PayrollRetroStatus,
} from "@aihxm/shared-types";

const DEFAULT_LOOKBACK_MONTHS = 12;
const MAX_LOOKBACK_MONTHS = 36;
/** One detection recalculates every (employee, paid period) pair it covers - bound it so a request cannot run for minutes. */
const MAX_PAIRS_PER_DETECTION = 3000;
const EPSILON = 0.005;
const UNPAID_LEAVE_KEY = "unpaid_leave_deduction";
/** Runs whose payslips are final: only these can have been "paid" and so be corrected retroactively. */
const PAID_RUN_STATUSES = ["finalized", "accounting", "payment_released", "reconciled", "closed", "reopened"];

type SourcePair = { payslip_id: string; employee_id: string; run_id: string; period_start: string | Date; period_end: string | Date; taxable_gross: string; gross: string };

const round2 = (n: number) => Number(n.toFixed(2));

/**
 * PAY-12 - arrears / retro. Detects differences between what a finalised period paid and what the same period
 * would pay today (a compensation change back-dated into it, unpaid leave decided after it), keeps them as a
 * reviewable ledger, and lets HR include the ones they want in a later run, where they become arrears lines.
 *
 * Scope: the lines that come from the employee's compensation components and from unpaid-leave deduction.
 * Late overtime, additional payments and loan changes are one-off inputs with their own pending queues and are not
 * re-priced here. The taxable flag of an unpaid-leave difference follows the source payslip (taxable when it had any
 * taxable pay), the same simplification the engine itself uses for the deduction.
 */
@Injectable()
export class PayrollRetroService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly payroll: PayrollService
  ) {}

  // ------------------------------------------------------------------ detect

  async detect(claims: RequestClaims, targetRunId: string, dto: DetectPayrollRetroRequest): Promise<DetectPayrollRetroResponse> {
    const access = await this.payroll.requireCalculateAccess(claims);
    const lookback = Math.min(Math.max(Math.trunc(dto.lookbackMonths ?? DEFAULT_LOOKBACK_MONTHS), 1), MAX_LOOKBACK_MONTHS);
    return this.db.withClaims(claims, async (client) => {
      const target = await this.loadTarget(client, targetRunId);
      this.payroll.assertCalculateScope(access, target);
      this.assertTargetOpen(target);

      const params: unknown[] = [claims.company_id, target.period_start, lookback, target.payroll_area_id ?? null];
      let employeeFilter = "";
      if (dto.employeeIds && dto.employeeIds.length > 0) {
        params.push(dto.employeeIds);
        employeeFilter = ` AND p.employee_id = ANY($${params.length}::uuid[])`;
      }
      const pairs = await client.query<SourcePair>(
        `SELECT p.id AS payslip_id, p.employee_id, r.id AS run_id, r.period_start, r.period_end,
                p.taxable_gross_this_period AS taxable_gross, p.gross_pay AS gross
           FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id
          WHERE p.company_id = $1 AND r.run_type = 'regular' AND r.is_simulation = false
            AND r.status = ANY('{${PAID_RUN_STATUSES.join(",")}}'::text[]) AND p.status <> 'voided'
            AND r.period_end < $2 AND r.period_end >= ($2::date - make_interval(months => $3))
            AND r.payroll_area_id IS NOT DISTINCT FROM $4::uuid${employeeFilter}
          ORDER BY r.period_end, p.employee_id`,
        params
      );
      if (pairs.rowCount! > MAX_PAIRS_PER_DETECTION) {
        throw new BadRequestException(
          `This would recalculate ${pairs.rowCount} paid payslips (limit ${MAX_PAIRS_PER_DETECTION}); narrow it with employeeIds or a shorter lookback`
        );
      }

      const runCache = new Map<string, Record<string, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
      const touched: string[] = [];
      let created = 0;
      let unchanged = 0;
      let superseded = 0;
      const failures: Array<{ employeeId: string; periodEnd: string; message: string }> = [];

      for (const pair of pairs.rows) {
        let sourceRun = runCache.get(pair.run_id);
        if (!sourceRun) {
          sourceRun = (await client.query("SELECT * FROM payroll_runs WHERE id = $1", [pair.run_id])).rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          runCache.set(pair.run_id, sourceRun);
        }
        const recalculated = await this.payroll.recalculateForRetro(client, claims, sourceRun as Record<string, any>, pair.employee_id);
        if (!Array.isArray(recalculated)) {
          failures.push({ employeeId: pair.employee_id, periodEnd: toIsoDate(pair.period_end), message: recalculated.error });
          continue;
        }
        const newTotals = sumByKey(recalculated.filter(isRetroLine).map((l) => ({ key: l.key, label: l.label, amount: l.amount, taxable: !!l.isTaxable })));
        const stored = await client.query<{ component_key: string; label: string; amount: string; is_taxable: boolean; source_type: string }>(
          `SELECT component_key, label, amount, is_taxable, source_type FROM payroll_component_results
            WHERE payslip_id = $1 AND affects IN ('gross', 'net') AND (source_type = 'compensation' OR component_key = $2)
            ORDER BY line_no`,
          [pair.payslip_id, UNPAID_LEAVE_KEY]
        );
        const oldTotals = sumByKey(stored.rows.map((l) => ({ key: l.component_key, label: l.label, amount: Number(l.amount), taxable: l.is_taxable })));
        const paidBefore = await client.query<{ component_key: string; paid: string }>(
          `SELECT component_key, COALESCE(SUM(delta), 0) AS paid FROM payroll_retro_results
            WHERE source_payslip_id = $1 AND status = 'paid' GROUP BY component_key`,
          [pair.payslip_id]
        );
        const paidByKey = new Map(paidBefore.rows.map((r) => [r.component_key, Number(r.paid)]));
        const payslipTaxable = Number(pair.taxable_gross) > 0;

        for (const key of new Set([...newTotals.keys(), ...oldTotals.keys()])) {
          const now = newTotals.get(key);
          const was = oldTotals.get(key);
          const alreadyCorrected = paidByKey.get(key) ?? 0;
          const originalAmount = round2((was?.amount ?? 0) + alreadyCorrected);
          const recalculatedAmount = round2(now?.amount ?? 0);
          const delta = round2(recalculatedAmount - originalAmount);
          const live = await client.query(
            "SELECT id, status, delta, recalculated_amount FROM payroll_retro_results WHERE source_payslip_id = $1 AND component_key = $2 AND status IN ('detected', 'included') FOR UPDATE",
            [pair.payslip_id, key]
          );
          const existing = live.rows[0];
          // a difference HR already dismissed stays dismissed until it changes again
          if (!existing) {
            const dismissed = await client.query(
              "SELECT 1 FROM payroll_retro_results WHERE source_payslip_id = $1 AND component_key = $2 AND status = 'dismissed' AND delta = $3 LIMIT 1",
              [pair.payslip_id, key, delta]
            );
            if ((dismissed.rowCount ?? 0) > 0) {
              unchanged++;
              continue;
            }
          }
          if (Math.abs(delta) < EPSILON) {
            if (existing) {
              await client.query("UPDATE payroll_retro_results SET status = 'superseded', updated_at = now() WHERE id = $1", [existing.id]);
              superseded++;
            } else unchanged++;
            continue;
          }
          const isLeave = key === UNPAID_LEAVE_KEY;
          const taxable = isLeave ? payslipTaxable : !!(now?.taxable ?? was?.taxable);
          const label = now?.label ?? was?.label ?? key;
          const detail = { sourcePeriodEnd: toIsoDate(pair.period_end), alreadyCorrected, storedAmount: was?.amount ?? 0 };
          if (existing) {
            if (Math.abs(Number(existing.delta) - delta) < EPSILON) {
              unchanged++;
              continue;
            }
            await client.query(
              `UPDATE payroll_retro_results SET original_amount = $2, recalculated_amount = $3, delta = $4, is_taxable = $5, detail = $6::jsonb, updated_at = now() WHERE id = $1`,
              [existing.id, originalAmount, recalculatedAmount, delta, taxable, JSON.stringify(detail)]
            );
            touched.push(existing.id);
            continue;
          }
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO payroll_retro_results (company_id, employee_id, source_run_id, source_payslip_id, source_event_type, affected_period_start, affected_period_end,
                                                component_key, component_label, original_amount, recalculated_amount, delta, is_taxable, detail, detected_by, correlation_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16) RETURNING id`,
            [
              claims.company_id, pair.employee_id, pair.run_id, pair.payslip_id, (isLeave ? "leave_change" : "compensation_change") satisfies PayrollRetroSourceEvent,
              pair.period_start, pair.period_end, key, label, originalAmount, recalculatedAmount, delta, taxable, JSON.stringify(detail), claims.sub, currentCorrelationId(),
            ]
          );
          touched.push(inserted.rows[0].id);
          created++;
        }
      }

      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_retro.detect",
        target: targetRunId,
        metadata: { pairs: pairs.rowCount, detected: created, superseded, unchanged, failures: failures.length, lookbackMonths: lookback },
      });
      const results = await this.listWithin(client, { ids: touched });
      return { detected: created, unchanged, superseded, results, ...(failures.length > 0 ? { failures } : {}) };
    });
  }

  // ------------------------------------------------------------------ list / include / dismiss

  async list(claims: RequestClaims, runId: string, status?: PayrollRetroStatus): Promise<PayrollRetroResultView[]> {
    const access = await this.payroll.requireCalculateAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const run = await this.loadTarget(client, runId);
      this.payroll.assertCalculateScope(access, run);
      return this.listWithin(client, { targetRunId: runId, areaId: run.payroll_area_id ?? null, status });
    });
  }

  /** Include detected differences in a run: omitted ids = every detected line of the run's area. */
  async include(claims: RequestClaims, runId: string, dto: IncludePayrollRetroRequest): Promise<PayrollRetroResultView[]> {
    const access = await this.payroll.requireCalculateAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const target = await this.loadTarget(client, runId);
      this.payroll.assertCalculateScope(access, target);
      this.assertTargetOpen(target);
      const candidates = await client.query<{ id: string; employee_id: string; source_period_end: string | Date }>(
        `SELECT rr.id, rr.employee_id, rr.affected_period_end AS source_period_end
           FROM payroll_retro_results rr JOIN payroll_runs sr ON sr.id = rr.source_run_id
          WHERE rr.status = 'detected' AND sr.payroll_area_id IS NOT DISTINCT FROM $2::uuid
            AND ($1::uuid[] IS NULL OR rr.id = ANY($1::uuid[])) FOR UPDATE OF rr`,
        [dto.retroResultIds && dto.retroResultIds.length > 0 ? dto.retroResultIds : null, target.payroll_area_id ?? null]
      );
      if (dto.retroResultIds && dto.retroResultIds.length > 0 && candidates.rowCount !== new Set(dto.retroResultIds).size) {
        throw new BadRequestException("Some of the selected lines are not in 'detected' state or belong to another payroll area");
      }
      const later = candidates.rows.filter((c) => toIsoDate(c.source_period_end) >= toIsoDate(target.period_start));
      if (later.length > 0) throw new BadRequestException("Arrears can only be included in a run for a period after the one they correct");
      if (candidates.rowCount === 0) return [];
      const ids = candidates.rows.map((c) => c.id);
      await client.query("UPDATE payroll_retro_results SET status = 'included', target_run_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])", [ids, runId]);
      await this.markStale(client, target);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_retro.include",
        target: runId,
        metadata: { count: ids.length, ids },
      });
      return this.listWithin(client, { ids });
    });
  }

  /** Takes included lines back out of a run (before it is finalised). */
  async exclude(claims: RequestClaims, runId: string, dto: IncludePayrollRetroRequest): Promise<PayrollRetroResultView[]> {
    const access = await this.payroll.requireCalculateAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const target = await this.loadTarget(client, runId);
      this.payroll.assertCalculateScope(access, target);
      this.assertTargetOpen(target);
      const released = await client.query<{ id: string }>(
        `UPDATE payroll_retro_results SET status = 'detected', target_run_id = NULL, updated_at = now()
          WHERE target_run_id = $1 AND status = 'included' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) RETURNING id`,
        [runId, dto.retroResultIds && dto.retroResultIds.length > 0 ? dto.retroResultIds : null]
      );
      if (released.rowCount! > 0) await this.markStale(client, target);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "payroll_retro.exclude",
        target: runId,
        metadata: { count: released.rowCount },
      });
      return this.listWithin(client, { ids: released.rows.map((r) => r.id) });
    });
  }

  async dismiss(claims: RequestClaims, retroId: string, reason: string): Promise<PayrollRetroResultView> {
    const access = await this.payroll.requireCalculateAccess(claims);
    const why = reason?.trim();
    if (!why || why.length < 5) throw new BadRequestException("A reason (at least 5 characters) is required to dismiss a difference");
    return this.db.withClaims(claims, async (client) => {
      const found = await client.query(
        `SELECT rr.*, sr.payroll_area_id FROM payroll_retro_results rr JOIN payroll_runs sr ON sr.id = rr.source_run_id WHERE rr.id = $1 FOR UPDATE OF rr`,
        [retroId]
      );
      if (found.rowCount === 0) throw new NotFoundException("Retro difference not found");
      this.payroll.assertCalculateScope(access, { payroll_area_id: found.rows[0].payroll_area_id });
      if (found.rows[0].status !== "detected") throw new BadRequestException(`Only a detected difference can be dismissed (this one is ${found.rows[0].status}); take it out of its run first`);
      await client.query(
        "UPDATE payroll_retro_results SET status = 'dismissed', dismissed_by = $2, dismissed_reason = $3, updated_at = now() WHERE id = $1",
        [retroId, claims.sub, why]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_retro.dismiss", target: retroId, metadata: { reason: why } });
      return (await this.listWithin(client, { ids: [retroId] }))[0];
    });
  }

  // ------------------------------------------------------------------ helpers

  private async loadTarget(client: PoolClient, runId: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
    if (r.rowCount === 0) throw new NotFoundException("Payroll run not found");
    return r.rows[0];
  }

  private assertTargetOpen(run: Record<string, any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (run.run_type !== "regular" || run.is_simulation) {
      throw new BadRequestException("Arrears are paid in a real regular run (not a simulation or an off-cycle run)");
    }
    if (!["draft", "pre_validated", "calculated", "validated"].includes(run.status)) {
      throw new ForbiddenException(`Arrears can only be changed while the run is being prepared (this one is ${run.status})`);
    }
  }

  /** A calculated run that gains or loses arrears lines no longer matches its inputs: leave a trace so it is recalculated. */
  private async markStale(client: PoolClient, run: Record<string, any>): Promise<void> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (["calculated", "validated"].includes(run.status)) {
      await client.query(
        `INSERT INTO payroll_run_events (company_id, payroll_run_id, from_status, to_status, action, actor_user_account_id, reason, correlation_id)
         VALUES ($1,$2,$3,$3,'retro_changed',NULL,'Arrears were included or removed - recalculate the run so its payslips match',$4)`,
        [run.company_id, run.id, run.status, currentCorrelationId()]
      );
    }
  }

  private async listWithin(
    client: PoolClient,
    filter: { ids?: string[]; targetRunId?: string; areaId?: string | null; status?: PayrollRetroStatus }
  ): Promise<PayrollRetroResultView[]> {
    if (filter.ids && filter.ids.length === 0) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (v: unknown) => (params.push(v), `$${params.length}`);
    if (filter.ids) where.push(`rr.id = ANY(${push(filter.ids)}::uuid[])`);
    if (filter.targetRunId) {
      // everything this run can include (same area, detected) plus what it already includes / paid
      where.push(`(rr.target_run_id = ${push(filter.targetRunId)} OR (rr.status = 'detected' AND sr.payroll_area_id IS NOT DISTINCT FROM ${push(filter.areaId ?? null)}::uuid))`);
    }
    if (filter.status) where.push(`rr.status = ${push(filter.status)}`);
    const rows = await client.query(
      `SELECT rr.*, e.employee_number, e.first_name, e.last_name
         FROM payroll_retro_results rr JOIN payroll_runs sr ON sr.id = rr.source_run_id JOIN employees e ON e.id = rr.employee_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY e.employee_number, rr.affected_period_start, rr.component_key`,
      params
    );
    return rows.rows.map(rowToView);
  }
}

type KeyTotal = { label: string; amount: number; taxable: boolean };

function isRetroLine(l: { key: string; sourceType: string; affects: string }): boolean {
  return (l.sourceType === "compensation" || l.key === UNPAID_LEAVE_KEY) && (l.affects === "gross" || l.affects === "net");
}

function sumByKey(lines: Array<{ key: string; label: string; amount: number; taxable: boolean }>): Map<string, KeyTotal> {
  const out = new Map<string, KeyTotal>();
  for (const l of lines) {
    const entry = out.get(l.key);
    if (entry) {
      entry.amount += l.amount;
      entry.taxable = entry.taxable || l.taxable;
    } else out.set(l.key, { label: l.label, amount: l.amount, taxable: l.taxable });
  }
  return out;
}

function rowToView(r: Record<string, any>): PayrollRetroResultView { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeNumber: r.employee_number ?? null,
    employeeName: r.first_name ? `${r.first_name} ${r.last_name}`.trim() : null,
    sourceRunId: r.source_run_id,
    sourcePayslipId: r.source_payslip_id,
    sourceEventType: r.source_event_type,
    sourceEventId: r.source_event_id ?? null,
    affectedPeriodStart: toIsoDate(r.affected_period_start),
    affectedPeriodEnd: toIsoDate(r.affected_period_end),
    componentKey: r.component_key,
    componentLabel: r.component_label,
    originalAmount: Number(r.original_amount),
    recalculatedAmount: Number(r.recalculated_amount),
    delta: Number(r.delta),
    isTaxable: r.is_taxable,
    status: r.status,
    targetRunId: r.target_run_id ?? null,
    includedPayslipId: r.included_payslip_id ?? null,
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    dismissedReason: r.dismissed_reason ?? null,
    detail: r.detail ?? {},
    createdAt: new Date(r.created_at).toISOString(),
  };
}
