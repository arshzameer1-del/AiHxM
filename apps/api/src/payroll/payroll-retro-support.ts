import type { PoolClient } from "pg";

/**
 * PAY-12 - the SQL-only side of the arrears / retro ledger, shared by the places that move a run through its life
 * (finalise, reverse, cancel). Kept free of services so PayrollService and PayrollRunControlService can both use it
 * without importing the detection service (which itself depends on PayrollService).
 */

/** Finalising pays every retro line that was included in the run: they can never be included in a second run. */
export async function markRetroPaid(client: PoolClient, runId: string): Promise<number> {
  const r = await client.query(
    `UPDATE payroll_retro_results rr
        SET status = 'paid', paid_at = now(), included_payslip_id = pc.payslip_id, updated_at = now()
       FROM payslip_consumptions pc
      WHERE pc.payroll_run_id = $1 AND pc.source_type = 'retro_result' AND pc.source_id = rr.id
        AND rr.target_run_id = $1 AND rr.status = 'included'`,
    [runId]
  );
  // anything included but never consumed by a payslip (the run was not recalculated after it was included) goes back to the queue
  await client.query(
    `UPDATE payroll_retro_results SET status = 'detected', target_run_id = NULL, updated_at = now() WHERE target_run_id = $1 AND status = 'included'`,
    [runId]
  );
  return r.rowCount ?? 0;
}

/**
 * Gives a run's retro lines back: lines that were only included return to 'detected' (they can be included again),
 * lines already paid by a reversed run too - unless a newer live line already exists for the same payslip and
 * component, in which case the old one is superseded (the next detection recomputes the difference from scratch).
 */
export async function releaseRetroForRun(client: PoolClient, runId: string): Promise<number> {
  const superseded = await client.query(
    `UPDATE payroll_retro_results rr
        SET status = 'superseded', updated_at = now()
      WHERE rr.target_run_id = $1 AND rr.status IN ('included', 'paid')
        AND EXISTS (SELECT 1 FROM payroll_retro_results o
                     WHERE o.source_payslip_id = rr.source_payslip_id AND o.component_key = rr.component_key
                       AND o.id <> rr.id AND o.status IN ('detected', 'included'))`,
    [runId]
  );
  const released = await client.query(
    `UPDATE payroll_retro_results
        SET status = 'detected', target_run_id = NULL, included_payslip_id = NULL, paid_at = NULL, updated_at = now()
      WHERE target_run_id = $1 AND status IN ('included', 'paid')`,
    [runId]
  );
  return (superseded.rowCount ?? 0) + (released.rowCount ?? 0);
}
