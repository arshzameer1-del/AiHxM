import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { releaseRetroForRun } from "./payroll-retro-support";
import type { ComponentLine, PayslipInputSnapshot } from "./payroll-components";

/** What the engine returns for one employee, beyond the payslip's own columns. */
export type EngineDetail = {
  components: ComponentLine[];
  inputSnapshot: PayslipInputSnapshot;
  consumedLeave: Array<{ leaveRequestId: string; days: number }>;
  consumedAdditionalPayments?: Array<{ additionalPaymentId: string; amount: number }>;
  consumedOffCyclePayments?: Array<{ offCyclePaymentId: string; amount: number }>;
  consumedOvertime?: Array<{ overtimeId: string; amount: number }>;
  loanDeductions?: Array<{ loanId: string; amount: number }>;
  consumedRetro?: Array<{ retroResultId: string; amount: number }>;
};

export type InsertedPayslip = { payslipId: string; employeeId: string; detail: EngineDetail };

/** Stable JSON (sorted keys) so equal snapshots always hash equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * PAY-05 / PAY-21 - writes the structured result of a calculation next to the payslips it produced: one row per
 * component, one input snapshot per payslip, and the typed links to every input the payslip used.
 */
export async function persistPayslipDetail(
  client: PoolClient,
  run: { id: string; company_id: string },
  items: InsertedPayslip[],
  sequence: number
): Promise<void> {
  if (items.length === 0) return;
  const componentRows: unknown[] = [];
  const snapshotRows: unknown[] = [];
  const linkRows: unknown[] = [];
  for (const item of items) {
    item.detail.components.forEach((c, i) => {
      componentRows.push({
        payslip_id: item.payslipId,
        employee_id: item.employeeId,
        line_no: i + 1,
        component_key: c.key,
        component_id: c.componentId ?? null,
        label: c.label,
        category: c.category,
        affects: c.affects,
        amount: c.amount,
        is_taxable: c.isTaxable ?? false,
        quantity: c.quantity ?? null,
        unit: c.unit ?? null,
        rate: c.rate ?? null,
        basis_amount: c.basisAmount ?? null,
        source_type: c.sourceType,
        source_id: c.sourceId ?? null,
        trace: c.trace ?? {},
      });
    });
    snapshotRows.push({
      payslip_id: item.payslipId,
      employee_id: item.employeeId,
      content_hash: createHash("sha256").update(stable(item.detail.inputSnapshot)).digest("hex"),
      snapshot: item.detail.inputSnapshot,
    });
    const link = (source_type: string, source_id: string, amount: number, quantity?: number, unit?: string) =>
      linkRows.push({ payslip_id: item.payslipId, employee_id: item.employeeId, source_type, source_id, amount, quantity: quantity ?? null, unit: unit ?? null });
    for (const c of item.detail.consumedAdditionalPayments ?? []) link("additional_payment", c.additionalPaymentId, c.amount);
    for (const c of item.detail.consumedOffCyclePayments ?? []) link("off_cycle_payment", c.offCyclePaymentId, c.amount);
    for (const c of item.detail.consumedOvertime ?? []) link("overtime", c.overtimeId, c.amount);
    for (const c of item.detail.loanDeductions ?? []) link("loan_installment", c.loanId, c.amount);
    for (const c of item.detail.consumedRetro ?? []) link("retro_result", c.retroResultId, c.amount);
    for (const c of item.detail.consumedLeave) link("unpaid_leave", c.leaveRequestId, 0, c.days, "days");
  }

  await client.query(
    `INSERT INTO payroll_component_results (company_id, payroll_run_id, payslip_id, employee_id, calculation_sequence, line_no, component_key, component_id,
                                            label, category, affects, amount, is_taxable, quantity, unit, rate, basis_amount, source_type, source_id, trace)
     SELECT $1, $2, x.payslip_id, x.employee_id, $3, x.line_no, x.component_key, x.component_id, x.label, x.category, x.affects, x.amount,
            x.is_taxable, x.quantity, x.unit, x.rate, x.basis_amount, x.source_type, x.source_id, x.trace
       FROM jsonb_to_recordset($4::jsonb) AS x(payslip_id uuid, employee_id uuid, line_no int, component_key text, component_id uuid, label text, category text,
                                               affects text, amount numeric, is_taxable boolean, quantity numeric, unit text, rate numeric, basis_amount numeric,
                                               source_type text, source_id uuid, trace jsonb)`,
    [run.company_id, run.id, sequence, JSON.stringify(componentRows)]
  );
  await client.query(
    `INSERT INTO payroll_input_snapshots (company_id, payroll_run_id, payslip_id, employee_id, calculation_sequence, content_hash, snapshot)
     SELECT $1, $2, x.payslip_id, x.employee_id, $3, x.content_hash, x.snapshot
       FROM jsonb_to_recordset($4::jsonb) AS x(payslip_id uuid, employee_id uuid, content_hash text, snapshot jsonb)`,
    [run.company_id, run.id, sequence, JSON.stringify(snapshotRows)]
  );
  if (linkRows.length > 0) {
    await client.query(
      `INSERT INTO payslip_consumptions (company_id, payroll_run_id, payslip_id, employee_id, source_type, source_id, amount, quantity, unit)
       SELECT $1, $2, x.payslip_id, x.employee_id, x.source_type, x.source_id, x.amount, x.quantity, x.unit
         FROM jsonb_to_recordset($3::jsonb) AS x(payslip_id uuid, employee_id uuid, source_type text, source_id uuid, amount numeric, quantity numeric, unit text)
       ON CONFLICT (payslip_id, source_type, source_id) DO NOTHING`,
      [run.company_id, run.id, JSON.stringify(linkRows)]
    );
  }
  await client.query("UPDATE payslips SET calculation_sequence = $2 WHERE payroll_run_id = $1", [run.id, sequence]);
}

export type ConsumptionLinks = {
  additionalPaymentIds: Array<{ id: string; amount: number }>;
  offCyclePaymentIds: Array<{ id: string; amount: number }>;
  overtimeIds: Array<{ id: string; amount: number }>;
  loans: Array<{ id: string; amount: number }>;
};

/** The typed inputs each payslip of a run used, by payslip id. A payslip without links predates 0144 (its jsonb arrays are the record). */
export async function loadConsumptionLinks(client: PoolClient, runId: string): Promise<Map<string, ConsumptionLinks>> {
  const r = await client.query<{ payslip_id: string; source_type: string; source_id: string; amount: string }>(
    "SELECT payslip_id, source_type, source_id, amount FROM payslip_consumptions WHERE payroll_run_id = $1 AND status = 'previewed' ORDER BY created_at, id",
    [runId]
  );
  const out = new Map<string, ConsumptionLinks>();
  for (const row of r.rows) {
    const entry = out.get(row.payslip_id) ?? { additionalPaymentIds: [], offCyclePaymentIds: [], overtimeIds: [], loans: [] };
    const item = { id: row.source_id, amount: Number(row.amount) };
    if (row.source_type === "additional_payment") entry.additionalPaymentIds.push(item);
    else if (row.source_type === "off_cycle_payment") entry.offCyclePaymentIds.push(item);
    else if (row.source_type === "overtime") entry.overtimeIds.push(item);
    else if (row.source_type === "loan_installment") entry.loans.push(item);
    out.set(row.payslip_id, entry);
  }
  return out;
}

/** Finalising settles every link and locks the payslips for good. Order matters: links first, then the lock. */
export async function settlePayslips(client: PoolClient, runId: string): Promise<void> {
  await client.query("UPDATE payslip_consumptions SET status = 'consumed', consumed_at = now() WHERE payroll_run_id = $1 AND status = 'previewed'", [runId]);
  await client.query("UPDATE payslips SET status = 'final', is_immutable = true, updated_at = now() WHERE payroll_run_id = $1", [runId]);
}

/** A reversal voids the payslips (they stay on record) and gives every consumed input back. */
export async function voidPayslips(client: PoolClient, runId: string): Promise<void> {
  await client.query("UPDATE payslips SET status = 'voided' WHERE payroll_run_id = $1 AND is_immutable", [runId]);
  await client.query("UPDATE payslip_consumptions SET status = 'released', released_at = now() WHERE payroll_run_id = $1 AND status <> 'released'", [runId]);
  // PAY-12 - arrears paid by the reversed run become payable again
  await releaseRetroForRun(client, runId);
}

/**
 * PAY-05 - rebuilds the year-to-date accumulations of every employee of a run from the settled payslips of the
 * run's tax year (1 July - 30 June, labelled by its ending year). Safe to call any number of times: it recomputes,
 * it never adds, so a finalise, a reversal or a retry can never leave a drifted total.
 */
export async function refreshYtd(client: PoolClient, run: { id: string; company_id: string }, taxYearLabel: number): Promise<void> {
  const start = `${taxYearLabel - 1}-07-01`;
  const end = `${taxYearLabel}-06-30`;
  // zero first, so an employee whose only payslip in the year was just reversed is not left with the old total
  await client.query(
    `UPDATE payroll_ytd SET gross_pay = 0, taxable_gross = 0, income_tax = 0, eobi_employee = 0, eobi_employer = 0, social_security_employer = 0,
            net_pay = 0, employer_cost = 0, payslip_count = 0, updated_at = now()
      WHERE company_id = $1 AND tax_year = $2 AND employee_id IN (SELECT employee_id FROM payslips WHERE payroll_run_id = $3)`,
    [run.company_id, String(taxYearLabel), run.id]
  );
  await client.query(
    `INSERT INTO payroll_ytd (company_id, employee_id, tax_year, gross_pay, taxable_gross, income_tax, eobi_employee, eobi_employer,
                              social_security_employer, net_pay, employer_cost, payslip_count, last_period_end, last_run_id, updated_at)
     SELECT p.company_id, p.employee_id, $2, SUM(p.gross_pay), SUM(p.taxable_gross_this_period), SUM(p.income_tax_monthly),
            SUM(p.eobi_employee_contribution), SUM(p.eobi_employer_contribution), SUM(p.social_security_employer_contribution),
            SUM(p.net_pay), SUM(p.employer_cost), COUNT(*)::int, MAX(r.period_end),
            (ARRAY_AGG(r.id ORDER BY r.period_end DESC, r.finalized_at DESC NULLS LAST))[1], now()
       FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id
      WHERE p.company_id = $1 AND r.is_simulation = false
        AND r.status IN ('finalized', 'accounting', 'payment_released', 'reconciled', 'closed', 'reopened')
        AND p.status <> 'voided' AND r.period_end >= $4 AND r.period_end <= $5
        AND p.employee_id IN (SELECT employee_id FROM payslips WHERE payroll_run_id = $3)
      GROUP BY p.company_id, p.employee_id
     ON CONFLICT (company_id, employee_id, tax_year) DO UPDATE SET
       gross_pay = EXCLUDED.gross_pay, taxable_gross = EXCLUDED.taxable_gross, income_tax = EXCLUDED.income_tax,
       eobi_employee = EXCLUDED.eobi_employee, eobi_employer = EXCLUDED.eobi_employer,
       social_security_employer = EXCLUDED.social_security_employer, net_pay = EXCLUDED.net_pay, employer_cost = EXCLUDED.employer_cost,
       payslip_count = EXCLUDED.payslip_count, last_period_end = EXCLUDED.last_period_end, last_run_id = EXCLUDED.last_run_id, updated_at = now()`,
    [run.company_id, String(taxYearLabel), run.id, start, end]
  );
}
