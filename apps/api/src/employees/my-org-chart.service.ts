import { Injectable, NotFoundException } from "@nestjs/common";
import type { MyOrgChart, MyOrgChartNode, MyOrgChartPerson } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";

const MAX_DEPTH = 8;
const MAX_NODES = 500;
const MAX_PEERS = 200;

type Row = { id: string; employee_number: string; first_name: string; last_name: string; designation: string | null; department: string | null; manager_id: string | null; org_unit_id: string | null; position_id: string | null };

const toPerson = (r: Row): MyOrgChartPerson => ({
  id: r.id,
  employeeNumber: r.employee_number,
  fullName: `${r.first_name} ${r.last_name}`.trim(),
  designation: r.designation,
  department: r.department,
});

const COLUMNS = "id, employee_number, first_name, last_name, designation, department, manager_id, org_unit_id, position_id";

/**
 * The caller's own place in the organization (manager chain, peers, reports), for the Employee Self Service "My Org
 * Chart" tile. Only public fields leave this service. The caller needs `employee.view.self` (every Employee and Line
 * Manager has it) and their login must be linked to an employee record; they never get a way to ask about someone else's
 * position, so this does not widen what an Employee can read.
 */
@Injectable()
export class MyOrgChartService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService
  ) {}

  async get(claims: RequestClaims): Promise<MyOrgChart> {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "employee.view.self", { ownerId: claims.sub }))) throw new NotFoundException();

    return this.db.withClaims(claims, async (client) => {
      const meRows = await client.query<Row>(`SELECT ${COLUMNS} FROM employees WHERE user_account_id = $1 AND employment_status <> 'terminated'`, [claims.sub]);
      const me = meRows.rows[0];
      if (!me) throw new NotFoundException("Your login is not linked to an employee record yet.");

      // Manager chain, bottom-up, guarded against a loop in the data.
      const chain: Row[] = [];
      const seen = new Set<string>([me.id]);
      let next = me.manager_id;
      while (next && chain.length < MAX_DEPTH && !seen.has(next)) {
        const r = await client.query<Row>(`SELECT ${COLUMNS} FROM employees WHERE id = $1 AND employment_status <> 'terminated'`, [next]);
        const mgr = r.rows[0];
        if (!mgr) break;
        seen.add(mgr.id);
        chain.push(mgr);
        next = mgr.manager_id;
      }
      chain.reverse();

      // Peers: same manager, or (for the top of a line) the other top people in the same department.
      const peerRows = me.manager_id
        ? await client.query<Row>(
            `SELECT ${COLUMNS} FROM employees WHERE manager_id = $1 AND id <> $2 AND employment_status <> 'terminated' ORDER BY first_name, last_name LIMIT ${MAX_PEERS}`,
            [me.manager_id, me.id]
          )
        : await client.query<Row>(
            `SELECT ${COLUMNS} FROM employees WHERE manager_id IS NULL AND id <> $1 AND employment_status <> 'terminated'
               AND department IS NOT DISTINCT FROM $2 AND $2::text IS NOT NULL ORDER BY first_name, last_name LIMIT ${MAX_PEERS}`,
            [me.id, me.department]
          );

      // Downline, level by level, across every department.
      const nodeById = new Map<string, MyOrgChartNode>();
      const top: MyOrgChartNode[] = [];
      const departments = new Set<string>();
      if (me.department) departments.add(me.department);
      let level: string[] = [me.id];
      let count = 0;
      let truncated = false;
      for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && !truncated; depth++) {
        const res = await client.query<Row>(
          `SELECT ${COLUMNS} FROM employees WHERE manager_id = ANY($1::uuid[]) AND employment_status <> 'terminated' ORDER BY first_name, last_name`,
          [level]
        );
        const added: string[] = [];
        for (const r of res.rows) {
          if (nodeById.has(r.id) || r.id === me.id) continue;
          if (count >= MAX_NODES) {
            truncated = true;
            break;
          }
          count++;
          const node: MyOrgChartNode = { ...toPerson(r), directReports: [] };
          nodeById.set(r.id, node);
          if (r.department) departments.add(r.department);
          const parent = r.manager_id === me.id ? null : nodeById.get(r.manager_id as string);
          (parent ? parent.directReports : top).push(node);
          added.push(r.id);
        }
        level = added;
      }

      // Units the person heads (their position is the unit's head position), even when nobody there reports to them.
      if (me.position_id) {
        const heads = await client.query<{ name: string }>(
          "SELECT name FROM org_units WHERE head_position_id = $1 AND status = 'active' ORDER BY name",
          [me.position_id]
        );
        for (const h of heads.rows) departments.add(h.name);
      }

      return {
        me: toPerson(me),
        managerChain: chain.map(toPerson),
        peers: peerRows.rows.map(toPerson),
        downline: top,
        departments: [...departments].sort((a, b) => a.localeCompare(b)),
        truncated,
      };
    });
  }
}
