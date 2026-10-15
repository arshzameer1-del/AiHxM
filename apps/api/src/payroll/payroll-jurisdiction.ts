import type { PoolClient } from "pg";

/**
 * PAY-28 - which statutory jurisdiction (province, for SESSI / PESSI / BESSI) an employee falls under. The nearest place
 * up the location tree that names one wins; when none does, the payroll area's jurisdiction is used. The answer is
 * recorded on the payslip's input snapshot so a later change never rewrites a payslip already produced.
 */
export type ResolvedJurisdiction = {
  code: string | null;
  source: "location" | "payroll_area" | "none";
  locationId: string | null;
  locationName: string | null;
};

export async function resolveStatutoryJurisdiction(client: PoolClient, employeeId: string): Promise<ResolvedJurisdiction> {
  const loc = await client.query<{ id: string; name: string; statutory_jurisdiction: string }>(
    `WITH RECURSIVE chain AS (
       SELECT l.id, l.parent_id, l.name, l.statutory_jurisdiction, 0 AS depth
         FROM locations l JOIN employees e ON e.location_id = l.id WHERE e.id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.name, p.statutory_jurisdiction, c.depth + 1
         FROM locations p JOIN chain c ON c.parent_id = p.id WHERE c.depth < 12
     )
     SELECT id, name, statutory_jurisdiction FROM chain WHERE statutory_jurisdiction IS NOT NULL ORDER BY depth LIMIT 1`,
    [employeeId]
  );
  if (loc.rows[0]) {
    return { code: loc.rows[0].statutory_jurisdiction, source: "location", locationId: loc.rows[0].id, locationName: loc.rows[0].name };
  }
  const area = await client.query<{ jurisdiction: string | null }>(
    `SELECT a.jurisdiction FROM employees e JOIN payroll_areas a ON a.id = e.payroll_area_id WHERE e.id = $1`,
    [employeeId]
  );
  const code = area.rows[0]?.jurisdiction ?? null;
  return code ? { code, source: "payroll_area", locationId: null, locationName: null } : { code: null, source: "none", locationId: null, locationName: null };
}
