import type { OrgStructureNode } from "@aihxm/shared-types";
import { formatDay } from "../shared/dates";

/** Pure helpers behind the Staff assignments (structure) tree-table. */

export type StructureFilter = {
  /** ISO date the structure is viewed on: rows that are not valid on it are hidden. */
  keyDate: string;
  showEnded: boolean;
  showPositions: boolean;
  showPeople: boolean;
  query: string;
};

export type StructureRow = { node: OrgStructureNode; depth: number; hasChildren: boolean; isOpen: boolean };

/** 2024-05-01 -> 1 May 2024; no end date reads "Unlimited", no start date reads an empty cell. */
export function formatValidFrom(iso: string | null): string {
  return iso ? toDisplay(iso) : "";
}
export function formatValidTo(iso: string | null): string {
  return iso ? toDisplay(iso) : "Unlimited";
}
function toDisplay(iso: string): string {
  return formatDay(iso);
}

export function isValidOn(node: OrgStructureNode, keyDate: string): boolean {
  if (node.validFrom && node.validFrom > keyDate) return false;
  if (node.validTo && node.validTo < keyDate) return false;
  return true;
}

export function matchesQuery(node: OrgStructureNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [node.name, node.code ?? "", node.objectId, node.chiefName ?? "", node.relationshipText].some((v) => v.toLowerCase().includes(q));
}

/** The tree after the filters: hidden kinds and rows not valid on the key date are cut with everything below them; with a query only matches and the rows leading to them stay. */
export function filterStructure(roots: OrgStructureNode[], f: StructureFilter): OrgStructureNode[] {
  const walk = (node: OrgStructureNode): OrgStructureNode | null => {
    if (node.kind === "position" && !f.showPositions) return null;
    if (node.kind === "holder" && (!f.showPositions || !f.showPeople)) return null;
    if (!f.showEnded && !isValidOn(node, f.keyDate)) return null;
    const children = node.children.map(walk).filter((c): c is OrgStructureNode => c !== null);
    if (f.query.trim() && !matchesQuery(node, f.query) && children.length === 0) return null;
    return { ...node, children };
  };
  return roots.map(walk).filter((n): n is OrgStructureNode => n !== null);
}

export function flattenStructure(roots: OrgStructureNode[], expanded: ReadonlySet<string>, forceOpen: boolean): StructureRow[] {
  const rows: StructureRow[] = [];
  const visit = (node: OrgStructureNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const isOpen = hasChildren && (forceOpen || expanded.has(node.key));
    rows.push({ node, depth, hasChildren, isOpen });
    if (isOpen) node.children.forEach((c) => visit(c, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));
  return rows;
}

/** Keys of every row that has children (for "Expand all"). */
export function parentKeys(roots: OrgStructureNode[]): string[] {
  const keys: string[] = [];
  const visit = (n: OrgStructureNode) => {
    if (n.children.length > 0) keys.push(n.key);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return keys;
}

/** Keys of the units only (the "units level"): opening them shows positions and sub-units. */
export function unitKeys(roots: OrgStructureNode[]): string[] {
  const keys: string[] = [];
  const visit = (n: OrgStructureNode) => {
    if (n.kind === "unit" && n.children.length > 0) keys.push(n.key);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return keys;
}

export function countStructure(roots: OrgStructureNode[]): { units: number; positions: number; holders: number } {
  const c = { units: 0, positions: 0, holders: 0 };
  const visit = (n: OrgStructureNode) => {
    if (n.kind === "unit") c.units += 1;
    else if (n.kind === "position") c.positions += 1;
    else c.holders += 1;
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return c;
}

/** Where a row opens: the unit, position or employee page. */
export function detailPath(node: OrgStructureNode): string {
  if (node.kind === "unit") return `/app/organization/units/${node.id}`;
  if (node.kind === "position") return `/app/organization/positions/${node.id}`;
  return `/app/employees/${node.id}`;
}

/** Every unit in the tree, flattened with its depth: the choices of a "Move to" list. */
export function unitChoices(roots: OrgStructureNode[]): Array<{ id: string; name: string; depth: number }> {
  const out: Array<{ id: string; name: string; depth: number }> = [];
  const visit = (n: OrgStructureNode, depth: number) => {
    if (n.kind !== "unit") return;
    out.push({ id: n.id, name: n.name, depth });
    n.children.forEach((c) => visit(c, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));
  return out;
}

/** The ids of a unit and every unit below it: none of them can become that unit's new parent. */
export function unitSubtreeIds(roots: OrgStructureNode[], unitId: string): Set<string> {
  const ids = new Set<string>();
  const collect = (n: OrgStructureNode) => {
    if (n.kind === "unit") ids.add(n.id);
    n.children.forEach(collect);
  };
  const find = (n: OrgStructureNode): boolean => {
    if (n.kind === "unit" && n.id === unitId) {
      collect(n);
      return true;
    }
    return n.children.some(find);
  };
  roots.some(find);
  return ids;
}

export type StructureAction = "create-unit" | "create-position" | "edit" | "move" | "archive" | "activate" | "set-chief" | "assign" | "unassign";

/**
 * What the toolbar offers for the selected row. Mirrors what the server allows (`org_unit.manage.all`, position and
 * assignment management are HR's); the server still decides.
 */
export function availableActions(node: OrgStructureNode | null, canManage: boolean): StructureAction[] {
  if (!canManage) return [];
  if (!node) return ["create-unit"];
  if (node.kind === "unit") {
    return ["create-unit", "create-position", "edit", "move", node.status === "archived" ? "activate" : "archive"];
  }
  if (node.kind === "position") {
    const actions: StructureAction[] = ["move"];
    if (!node.isChief) actions.push("set-chief");
    if (node.status === "vacant") actions.push("assign");
    return actions;
  }
  return ["unassign"];
}

/** Whether dropping `dragged` on the unit `target` is a real move (not onto itself, its own parent, or its own subtree). */
export function canDropOn(roots: OrgStructureNode[], dragged: OrgStructureNode, target: OrgStructureNode): boolean {
  if (target.kind !== "unit") return false;
  if (dragged.kind === "unit") {
    if (dragged.id === target.id || dragged.parentId === target.id) return false;
    return !unitSubtreeIds(roots, dragged.id).has(target.id);
  }
  if (dragged.kind === "position") return dragged.orgUnitId !== target.id;
  return false;
}
