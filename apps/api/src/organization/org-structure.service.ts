import { ForbiddenException, Injectable } from "@nestjs/common";
import type { EmployeeView, OrgStructureNode, OrgStructureView, OrgUnitView, PositionView } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeesService } from "../employees/employees.service";
import { OrgUnitsService } from "./org-units.service";
import { PositionsService } from "./positions.service";

type DateWindow = { from: string | null; to: string | null };

const iso = (d: unknown): string | null => {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
};

/** "O 3A9F01C2": a type letter plus the first 8 characters of the id, the way a structure view shows an object id. */
function objectId(letter: "O" | "S" | "P", id: string): string {
  return `${letter} ${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/**
 * The "Staff assignments (structure)" read model: org units, the positions in them and the people holding those
 * positions, as one nested tree with validity dates and each unit's chief.
 *
 * It adds no new access rule. Units and positions come from the same data-scoped `list()` calls the other
 * organization screens use, and people come from `EmployeesService.list()`, so a caller who may not see employee
 * records gets the structure without holders (`peopleVisible: false`). Only the validity dates are read here
 * directly, from the effective-dated version tables, under the caller's own claims (RLS keeps it inside the tenant).
 */
@Injectable()
export class OrgStructureService {
  constructor(
    private readonly db: DatabaseService,
    private readonly orgUnits: OrgUnitsService,
    private readonly positions: PositionsService,
    private readonly employees: EmployeesService
  ) {}

  async getStructure(claims: RequestClaims): Promise<OrgStructureView> {
    if (!claims.company_id) throw new ForbiddenException();
    // Units decide whether the caller may use this screen at all (entitlement + org_unit.view); a failure here is the answer.
    const units = await this.orgUnits.list(claims);
    const positions = await this.positions.list(claims).catch(() => [] as PositionView[]);
    let peopleVisible = true;
    const people = await this.employees.list(claims).catch(() => {
      peopleVisible = false;
      return [] as EmployeeView[];
    });
    const personById = new Map(people.map((e) => [e.id, e]));

    const { unitWindows, positionWindows, incumbents } = await this.db.withClaims(claims, async (client) => {
      const unitRows = await client.query(
        `SELECT org_unit_id AS id, MIN(effective_from) AS from_date,
                CASE WHEN bool_or(effective_to IS NULL) THEN NULL ELSE MAX(effective_to) END AS to_date
           FROM org_unit_versions WHERE company_id = $1 GROUP BY org_unit_id`,
        [claims.company_id]
      );
      const positionRows = await client.query(
        `SELECT position_id AS id, MIN(effective_from) AS from_date,
                CASE WHEN bool_or(effective_to IS NULL) THEN NULL ELSE MAX(effective_to) END AS to_date
           FROM position_versions WHERE company_id = $1 GROUP BY position_id`,
        [claims.company_id]
      );
      const incumbentRows = await client.query(
        `SELECT position_id, employee_id, fte, effective_from, effective_to
           FROM position_incumbents WHERE company_id = $1 AND status = 'active' ORDER BY effective_from, created_at`,
        [claims.company_id]
      );
      const win = (rows: Array<{ id: string; from_date: unknown; to_date: unknown }>) =>
        new Map<string, DateWindow>(rows.map((r) => [r.id, { from: iso(r.from_date), to: iso(r.to_date) }]));
      return { unitWindows: win(unitRows.rows), positionWindows: win(positionRows.rows), incumbents: incumbentRows.rows };
    });

    const incumbentsByPosition = new Map<string, typeof incumbents>();
    for (const row of incumbents) {
      const list = incumbentsByPosition.get(row.position_id);
      if (list) list.push(row);
      else incumbentsByPosition.set(row.position_id, [row]);
    }
    const positionsByUnit = new Map<string, PositionView[]>();
    for (const p of positions) {
      const list = positionsByUnit.get(p.orgUnitId);
      if (list) list.push(p);
      else positionsByUnit.set(p.orgUnitId, [p]);
    }
    const unitIds = new Set(units.map((u) => u.id));
    const childrenByParent = new Map<string | null, OrgUnitView[]>();
    for (const u of units) {
      // A unit whose parent is outside the caller's data scope is shown as a root, so a scoped caller still sees their branch.
      const parent = u.parentId && unitIds.has(u.parentId) ? u.parentId : null;
      const list = childrenByParent.get(parent);
      if (list) list.push(u);
      else childrenByParent.set(parent, [u]);
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

    const holderNodes = (position: PositionView): OrgStructureNode[] => {
      if (!peopleVisible) return [];
      const nodes: OrgStructureNode[] = [];
      for (const row of incumbentsByPosition.get(position.id) ?? []) {
        const person = personById.get(row.employee_id);
        if (!person) continue;
        nodes.push({
          key: `holder:${position.id}:${person.id}`,
          kind: "holder",
          id: person.id,
          objectId: objectId("P", person.id),
          code: person.employeeNumber ?? null,
          name: `${person.firstName} ${person.lastName}`.trim(),
          relationshipText: "Holder",
          chiefName: null,
          validFrom: iso(row.effective_from),
          validTo: iso(row.effective_to),
          status: null,
          isChief: false,
          fte: row.fte === null || row.fte === undefined ? null : Number(row.fte),
          children: [],
        });
      }
      return nodes;
    };

    const chiefNameOf = (unit: OrgUnitView): string | null => {
      if (!unit.headPositionId || !peopleVisible) return null;
      const names = (incumbentsByPosition.get(unit.headPositionId) ?? [])
        .map((row) => personById.get(row.employee_id))
        .filter((p): p is EmployeeView => Boolean(p))
        .map((p) => `${p.firstName} ${p.lastName}`.trim());
      return names.length > 0 ? names.join(", ") : null;
    };

    const buildUnit = (unit: OrgUnitView, isRoot: boolean): OrgStructureNode => {
      const window = unitWindows.get(unit.id);
      const own = (positionsByUnit.get(unit.id) ?? [])
        .slice()
        // The chief position leads, the rest by title: the same order a structure view lists them in.
        .sort((a, b) => Number(b.id === unit.headPositionId) - Number(a.id === unit.headPositionId) || a.positionTitle.localeCompare(b.positionTitle))
        .map((position): OrgStructureNode => {
          const pw = positionWindows.get(position.id);
          const ended = position.status === "abolished";
          return {
            key: `position:${position.id}`,
            kind: "position",
            id: position.id,
            objectId: objectId("S", position.id),
            code: position.positionCode,
            name: position.positionTitle,
            relationshipText: "Incorporates",
            chiefName: null,
            validFrom: pw?.from ?? null,
            validTo: pw?.to ?? (ended ? iso(position.updatedAt) : null),
            status: position.status,
            isChief: position.id === unit.headPositionId,
            fte: null,
            children: holderNodes(position),
          };
        });
      const subUnits = (childrenByParent.get(unit.id) ?? []).slice().sort(byName).map((child) => buildUnit(child, false));
      return {
        key: `unit:${unit.id}`,
        kind: "unit",
        id: unit.id,
        objectId: objectId("O", unit.id),
        code: unit.code,
        name: unit.name,
        relationshipText: isRoot ? "" : "Is line supervisor of",
        chiefName: chiefNameOf(unit),
        validFrom: window?.from ?? null,
        validTo: window?.to ?? (unit.status === "archived" ? iso(unit.updatedAt) : null),
        status: unit.status,
        isChief: false,
        fte: null,
        children: [...own, ...subUnits],
      };
    };

    const roots = (childrenByParent.get(null) ?? []).slice().sort(byName).map((u) => buildUnit(u, true));
    return { asOf: new Date().toISOString().slice(0, 10), roots, peopleVisible };
  }
}
