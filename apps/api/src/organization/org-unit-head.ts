import type { PoolClient } from "pg";

/**
 * The head of a department: whoever holds the unit's head position (`org_units.head_position_id`, 0080). The head is every
 * employee's default direct manager inside that unit. A unit without a head, or whose head is the person themself (or the
 * seat being filled), falls back to the parent unit's head, so nobody ends up without a default manager except the top head.
 * HR can still set a different direct manager through the person's relationships; this is only the default.
 */
export type UnitHead = { employeeId: string; name: string; orgUnitId: string; orgUnitName: string; inherited: boolean };

export async function resolveUnitHead(
  client: PoolClient,
  companyId: string,
  orgUnitId: string,
  opts: { excludeEmployeeId?: string | null; excludePositionId?: string | null } = {}
): Promise<UnitHead | null> {
  let unitId: string | null = orgUnitId;
  for (let hops = 0; unitId && hops < 25; hops++) {
    const unit: { rows: { id: string; name: string; head_position_id: string | null; parent_id: string | null }[] } = await client.query(
      "SELECT id, name, head_position_id, parent_id FROM org_units WHERE id = $1 AND company_id = $2",
      [unitId, companyId]
    );
    const u = unit.rows[0];
    if (!u) return null;
    if (u.head_position_id && u.head_position_id !== (opts.excludePositionId ?? null)) {
      const occupant = await client.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT e.id, e.first_name, e.last_name
           FROM employee_org_assignments a JOIN employees e ON e.id = a.employee_id
          WHERE a.position_id = $1 AND a.company_id = $2 AND a.status = 'active' AND e.employment_status <> 'terminated'
            AND ($3::uuid IS NULL OR e.id <> $3)
          ORDER BY (a.assignment_type = 'primary') DESC, a.created_at LIMIT 1`,
        [u.head_position_id, companyId, opts.excludeEmployeeId ?? null]
      );
      const head = occupant.rows[0];
      if (head) {
        return { employeeId: head.id, name: `${head.first_name} ${head.last_name}`.trim(), orgUnitId: u.id, orgUnitName: u.name, inherited: u.id !== orgUnitId };
      }
    }
    unitId = u.parent_id;
  }
  return null;
}
