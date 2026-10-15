import type { OrgStructureNode } from "@aihxm/shared-types";

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

/** 2024-05-01 -> 01.05.2024; no end date reads "Unlimited", no start date reads an empty cell. */
export function formatValidFrom(iso: string | null): string {
  return iso ? toDisplay(iso) : "";
}
export function formatValidTo(iso: string | null): string {
  return iso ? toDisplay(iso) : "Unlimited";
}
function toDisplay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
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
