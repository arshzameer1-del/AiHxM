import type { PoolClient } from "pg";
import type { RequestClaims } from "../database/tenant-context";
import { DomainEventsService } from "../domain-events/domain-events.service";
import { eventTypeMatches } from "../domain-events/payload-redaction";
import type {
  PayrollEmployeeCalculatedPayloadV1,
  PayrollEventType,
  PayrollPaymentStatusChangedPayloadV1,
  PayrollPostingStatusChangedPayloadV1,
  PayrollRunFinalizedPayloadV1,
  PayrollRunStateChangedPayloadV1,
} from "@aihxm/shared-types";
import { PAYROLL_EVENT_CATALOG } from "@aihxm/shared-types";

/**
 * PAY-27 - payroll domain events. Every publisher here runs on the SAME client as the state change it announces, so
 * the outbox row commits or rolls back with it (PLT-04). Payload shapes are versioned: a field is only ever added to a
 * version; a removal or a meaning change publishes a new schemaVersion alongside the old one. SEC-13 redacts any payload
 * key that looks like pay (gross, net pay, salary...), so events carry identifiers, states, counts and run-level
 * aggregates only - an individual's figures are read through the API by a subscriber who is allowed to see them.
 */
const events = new DomainEventsService();

const schemaVersion = (type: PayrollEventType) => PAYROLL_EVENT_CATALOG.find((e) => e.eventType === type)?.schemaVersion ?? 1;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function emit(
  client: PoolClient,
  claims: RequestClaims,
  companyId: string,
  eventType: PayrollEventType,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  aggregateVersion?: number
): Promise<void> {
  await events.publish(client, claims, {
    companyId,
    eventType,
    aggregateType,
    aggregateId,
    aggregateVersion,
    schemaVersion: schemaVersion(eventType),
    payload,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishRunStateChanged(client: PoolClient, claims: RequestClaims, run: any, from: string | null, action: string): Promise<void> {
  const payload: PayrollRunStateChangedPayloadV1 = {
    runId: run.id,
    runType: run.run_type,
    payrollAreaId: run.payroll_area_id ?? null,
    periodStart: day(run.period_start),
    periodEnd: day(run.period_end),
    from,
    to: run.status,
    action,
    calculationSequence: Number(run.calculation_sequence ?? 1),
  };
  await emit(client, claims, run.company_id, "payroll.run.state_changed", "payroll_run", run.id, payload as unknown as Record<string, unknown>, Number(run.calculation_sequence ?? 1));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishRunFinalized(client: PoolClient, claims: RequestClaims, run: any): Promise<void> {
  const totals = await client.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(net_pay), 0) AS payable,
            COALESCE(SUM(income_tax_monthly), 0) AS tax, COALESCE(SUM(employer_cost), 0) AS employer
       FROM payslips WHERE payroll_run_id = $1 AND status <> 'voided'`,
    [run.id]
  );
  const t = totals.rows[0];
  const payload: PayrollRunFinalizedPayloadV1 = {
    runId: run.id,
    runType: run.run_type,
    payrollAreaId: run.payroll_area_id ?? null,
    periodStart: day(run.period_start),
    periodEnd: day(run.period_end),
    currencyCode: run.currency_code ?? "PKR",
    payslipCount: Number(t.n),
    totalPayable: num(t.payable),
    totalIncomeTax: num(t.tax),
    totalEmployerCost: num(t.employer),
    finalizedAt: run.finalized_at ? new Date(run.finalized_at).toISOString() : null,
  };
  await emit(client, claims, run.company_id, "payroll.run.finalized", "payroll_run", run.id, payload as unknown as Record<string, unknown>, Number(run.calculation_sequence ?? 1));
}

/** One event per payslip, but only while an active subscription listens for it: a 10,000-employee run must not write 10,000 outbox rows nobody reads. */
export async function publishEmployeesCalculated(client: PoolClient, claims: RequestClaims, run: { id: string; company_id: string; calculation_sequence: number }): Promise<number> {
  const subs = await client.query("SELECT event_patterns FROM event_subscriptions WHERE company_id = $1 AND status = 'active'", [run.company_id]);
  const listening = subs.rows.some((s) => (s.event_patterns as string[]).some((p) => eventTypeMatches(p, "payroll.employee.calculated")));
  if (!listening) return 0;
  const slips = await client.query(
    `SELECT id, employee_id, employee_number, calculation_sequence
       FROM payslips WHERE payroll_run_id = $1 AND status <> 'voided' AND calculation_sequence = $2 ORDER BY employee_number`,
    [run.id, run.calculation_sequence]
  );
  for (const s of slips.rows) {
    const payload: PayrollEmployeeCalculatedPayloadV1 = {
      runId: run.id,
      payslipId: s.id,
      employeeId: s.employee_id,
      employeeNumber: s.employee_number,
      calculationSequence: Number(s.calculation_sequence),
    };
    await emit(client, claims, run.company_id, "payroll.employee.calculated", "payroll_run", run.id, payload as unknown as Record<string, unknown>, Number(s.calculation_sequence));
  }
  return slips.rowCount ?? 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishPaymentStatusChanged(client: PoolClient, claims: RequestClaims, batch: any, from: string | null): Promise<void> {
  const payload: PayrollPaymentStatusChangedPayloadV1 = {
    runId: batch.payroll_run_id,
    batchId: batch.id,
    batchReference: batch.batch_reference,
    from,
    to: batch.status,
    rowCount: Number(batch.row_count),
    totalPayable: num(batch.total_net_pay),
  };
  await emit(client, claims, batch.company_id, "payroll.payment.status_changed", "payroll_payment_batch", batch.id, payload as unknown as Record<string, unknown>);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishPostingStatusChanged(client: PoolClient, claims: RequestClaims, journal: any, from: string | null): Promise<void> {
  const payload: PayrollPostingStatusChangedPayloadV1 = {
    runId: journal.payroll_run_id,
    journalId: journal.id,
    journalNumber: journal.journal_number ?? null,
    journalKind: journal.journal_kind,
    from,
    to: journal.status,
    totalDebit: num(journal.total_debit),
    totalCredit: num(journal.total_credit),
  };
  await emit(client, claims, journal.company_id, "payroll.posting.status_changed", "payroll_journal", journal.id, payload as unknown as Record<string, unknown>);
}
