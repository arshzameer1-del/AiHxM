import type { PoolClient } from "pg";
import type { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";

/**
 * PAY-24 - the tenant-wide standard working hours live with working time (`company_work_time_defaults`), not with the
 * statutory payroll settings. An employee's own work profile still wins over this default (TLM-08).
 *
 * Reads fall back to `payroll_settings.standard_monthly_hours` for a tenant whose defaults were never written, so a
 * database restored from before the migration keeps behaving; writes through the old payroll-settings screen are
 * mirrored here by `writeCompanyWorkTimeDefault`.
 */

/** Used only when a tenant has neither a working-time default nor payroll settings (208 = 26 days x 8 hours). */
export const BUILT_IN_STANDARD_MONTHLY_HOURS = 208;

export type CompanyWorkTimeDefault = { standardMonthlyHours: number; standardWeeklyHours: number | null; effectiveFrom: string; effectiveTo: string | null };

/** The tenant's standard monthly hours on `date`, or null when neither the defaults nor the payroll settings say. */
export async function resolveCompanyMonthlyHours(client: PoolClient, companyId: string, date: string): Promise<number | null> {
  const d = await client.query<{ standard_monthly_hours: string }>(
    `SELECT standard_monthly_hours FROM company_work_time_defaults
      WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [companyId, date]
  );
  if (d.rowCount) return Number(d.rows[0].standard_monthly_hours);
  const s = await client.query<{ standard_monthly_hours: string }>(
    `SELECT standard_monthly_hours FROM payroll_settings
      WHERE company_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [companyId, date]
  );
  return s.rowCount ? Number(s.rows[0].standard_monthly_hours) : null;
}

export async function writeCompanyWorkTimeDefault(
  client: PoolClient,
  effectiveDating: EffectiveDatingEngine,
  companyId: string,
  values: { standardMonthlyHours: number; standardWeeklyHours?: number | null },
  effectiveFrom?: string
): Promise<void> {
  const current = await effectiveDating.getCurrentRow<{ standard_weekly_hours: string | null; effective_from: unknown }>(client, {
    table: "company_work_time_defaults",
    scope: { company_id: companyId },
  });
  const weekly = values.standardWeeklyHours !== undefined ? values.standardWeeklyHours : current?.standard_weekly_hours === null || current === null ? null : Number(current.standard_weekly_hours);
  await effectiveDating.applyVersionedRow(client, {
    table: "company_work_time_defaults",
    scope: { company_id: companyId },
    effectiveFrom,
    data: { standard_monthly_hours: values.standardMonthlyHours, standard_weekly_hours: weekly, updated_at: new Date() },
  });
}
