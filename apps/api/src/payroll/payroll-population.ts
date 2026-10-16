import type { PoolClient } from "pg";

export type PopulationEmployeeRow = {
  id: string;
  company_id: string;
  user_account_id: string | null;
  employee_number: string;
  bank_account_number: string | null;
  date_of_joining: unknown;
  termination_date: unknown;
};

const BANK_ACCOUNT_SQL = `COALESCE((SELECT pa.account_number FROM employee_payment_accounts pa
                               WHERE pa.employee_id = employees.id AND pa.is_primary AND pa.status = 'active'
                                 AND pa.account_number IS NOT NULL LIMIT 1), bank_account_number) AS bank_account_number`;

/** What a run's stored selection narrows the population to; null for a dimension that was not chosen (no narrowing). */
export function storedSelectionFilters(selection: unknown): { employeeIds: string[] | null; payrollAreaIds: string[] | null; groupMemberIds: string[] | null } {
  const raw = selection && typeof selection === "object" ? (selection as Record<string, unknown>) : {};
  const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : null);
  // Groups chosen but empty today: the run covers nobody (an empty array matches no employee), never everybody.
  const groupsChosen = ids(raw.employeeGroupIds) !== null;
  const members = Array.isArray(raw.groupMemberIds) ? raw.groupMemberIds.filter((x): x is string => typeof x === "string") : [];
  return { employeeIds: ids(raw.employeeIds), payrollAreaIds: ids(raw.payrollAreaIds), groupMemberIds: groupsChosen ? members : null };
}

/**
 * PAY-04 - the employees a run covers. One definition shared by the calculation, pre-validation and the
 * population snapshot, so what is validated is exactly what is calculated.
 *  - a targeted run (final settlement, single-employee bonus/arrears) covers that employee whatever their status;
 *  - every other run covers employees employed at any time in the period, within the run's payroll area, and
 *    narrowed by the run's selection (chosen employees, payroll areas, employee groups) when it has one.
 */
export async function selectRunPopulation(
  client: PoolClient,
  run: { company_id: string; period_start: unknown; period_end: unknown; payroll_area_id?: string | null; target_employee_id?: string | null; selection?: unknown }
): Promise<PopulationEmployeeRow[]> {
  const iso = (v: unknown) => (typeof v === "string" ? v : (v as Date).toISOString().slice(0, 10));
  if (run.target_employee_id) {
    const r = await client.query<PopulationEmployeeRow>(
      `SELECT id, company_id, user_account_id, employee_number, ${BANK_ACCOUNT_SQL}, date_of_joining, termination_date
         FROM employees WHERE id = $1 AND company_id = $2`,
      [run.target_employee_id, run.company_id]
    );
    return r.rows;
  }
  const sel = storedSelectionFilters(run.selection);
  const r = await client.query<PopulationEmployeeRow>(
    `SELECT id, company_id, user_account_id, employee_number, ${BANK_ACCOUNT_SQL}, date_of_joining, termination_date
       FROM employees
      WHERE date_of_joining <= $2
        AND (termination_date IS NULL OR termination_date >= $1)
        AND ($3::uuid IS NULL OR payroll_area_id = $3)
        AND company_id = $4
        AND ($5::uuid[] IS NULL OR id = ANY($5::uuid[]))
        AND ($6::uuid[] IS NULL OR payroll_area_id = ANY($6::uuid[]))
        AND ($7::uuid[] IS NULL OR id = ANY($7::uuid[]))
      ORDER BY employee_number, id`,
    [iso(run.period_start), iso(run.period_end), run.payroll_area_id ?? null, run.company_id, sel.employeeIds, sel.payrollAreaIds, sel.groupMemberIds]
  );
  return r.rows;
}

/** The same employee rows as selectRunPopulation(), for a known list of ids (a partition, a single retry). */
export async function selectEmployeesByIds(client: PoolClient, companyId: string, ids: string[]): Promise<PopulationEmployeeRow[]> {
  if (ids.length === 0) return [];
  const r = await client.query<PopulationEmployeeRow>(
    `SELECT id, company_id, user_account_id, employee_number, ${BANK_ACCOUNT_SQL}, date_of_joining, termination_date
       FROM employees WHERE id = ANY($1::uuid[]) AND company_id = $2 ORDER BY employee_number, id`,
    [ids, companyId]
  );
  return r.rows;
}
