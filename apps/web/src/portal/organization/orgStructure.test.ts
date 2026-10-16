import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { OrgStructureNode } from "@aihxm/shared-types";
import { countStructure, detailPath, filterStructure, flattenStructure, formatValidFrom, formatValidTo, isValidOn, parentKeys, unitKeys, type StructureFilter } from "./orgStructure";

const node = (over: Partial<OrgStructureNode> & Pick<OrgStructureNode, "key" | "kind" | "name">): OrgStructureNode => ({
  id: over.key.split(":").pop()!,
  objectId: "O 00000000",
  code: null,
  relationshipText: "",
  chiefName: null,
  validFrom: "2024-05-01",
  validTo: null,
  status: null,
  isChief: false,
  fte: null,
  children: [],
  ...over,
});

const tree: OrgStructureNode[] = [
  node({
    key: "unit:ams",
    kind: "unit",
    name: "Marine Services",
    code: "AMS",
    children: [
      node({
        key: "unit:pres",
        kind: "unit",
        name: "President Office",
        relationshipText: "Is line supervisor of",
        chiefName: "Ahmed Aziz",
        children: [
          node({ key: "position:p1", kind: "position", name: "President", isChief: true, children: [node({ key: "holder:p1:e1", kind: "holder", name: "Ahmed Aziz", code: "EMP-0001" })] }),
          node({ key: "position:p2", kind: "position", name: "Financial Advisor", validTo: "2025-01-31" }),
          node({ key: "unit:shared", kind: "unit", name: "Shared Services", validFrom: "2027-01-01" }),
        ],
      }),
    ],
  }),
];

const base: StructureFilter = { keyDate: "2026-10-15", showEnded: false, showPositions: true, showPeople: true, query: "" };
const names = (rows: ReturnType<typeof flattenStructure>) => rows.map((r) => `${"-".repeat(r.depth)}${r.node.name}`);

test("dates read dd.mm.yyyy and an open end reads Unlimited", () => {
  assert.equal(formatValidFrom("2024-05-01"), "1 May 2024");
  assert.equal(formatValidTo(null), "Unlimited");
  assert.equal(formatValidTo("2025-01-31"), "31 Jan 2025");
  assert.equal(formatValidFrom(null), "");
});

test("validity is checked against the key date, both ends inclusive", () => {
  const n = node({ key: "position:x", kind: "position", name: "X", validFrom: "2026-01-01", validTo: "2026-12-31" });
  assert.equal(isValidOn(n, "2026-01-01"), true);
  assert.equal(isValidOn(n, "2026-12-31"), true);
  assert.equal(isValidOn(n, "2025-12-31"), false);
  assert.equal(isValidOn(n, "2027-01-01"), false);
});

test("rows that are not valid on the key date are hidden unless ended rows are shown", () => {
  const hidden = filterStructure(tree, base);
  assert.deepEqual(names(flattenStructure(hidden, new Set(parentKeys(hidden)), false)), ["Marine Services", "-President Office", "--President", "---Ahmed Aziz"]);
  const all = filterStructure(tree, { ...base, showEnded: true });
  assert.equal(countStructure(all).positions, 2);
  assert.equal(countStructure(all).units, 3);
});

test("positions and people can be switched off; people never show without positions", () => {
  const noPeople = filterStructure(tree, { ...base, showPeople: false });
  assert.deepEqual(countStructure(noPeople), { units: 2, positions: 1, holders: 0 });
  const unitsOnly = filterStructure(tree, { ...base, showPositions: false });
  assert.deepEqual(countStructure(unitsOnly), { units: 2, positions: 0, holders: 0 });
});

test("collapsed rows hide their children; expand lists follow the tree", () => {
  const t = filterStructure(tree, base);
  assert.deepEqual(names(flattenStructure(t, new Set(), false)), ["Marine Services"]);
  assert.deepEqual(names(flattenStructure(t, new Set(["unit:ams"]), false)), ["Marine Services", "-President Office"]);
  assert.deepEqual(unitKeys(t), ["unit:ams", "unit:pres"]);
  assert.deepEqual(parentKeys(t), ["unit:ams", "unit:pres", "position:p1"]);
});

test("a search keeps matches and the rows that lead to them, opened", () => {
  const t = filterStructure(tree, { ...base, query: "ahmed" });
  assert.deepEqual(names(flattenStructure(t, new Set(), true)), ["Marine Services", "-President Office", "--President", "---Ahmed Aziz"]);
  assert.deepEqual(names(flattenStructure(filterStructure(tree, { ...base, query: "EMP-0001" }), new Set(), true)).slice(-1), ["---Ahmed Aziz"]);
  assert.deepEqual(filterStructure(tree, { ...base, query: "no such thing" }), []);
});

test("each row opens its own page", () => {
  assert.equal(detailPath(tree[0]), "/app/organization/units/ams");
  assert.equal(detailPath(tree[0].children[0].children[0]), "/app/organization/positions/p1");
  assert.equal(detailPath(tree[0].children[0].children[0].children[0]), "/app/employees/e1");
});

import { availableActions, canDropOn, unitChoices, unitSubtreeIds } from "./orgStructure";

const n = (over: Partial<OrgStructureNode> & Pick<OrgStructureNode, "key" | "kind" | "id">): OrgStructureNode => ({
  objectId: "O 00000000", code: null, name: over.id, relationshipText: "", chiefName: null, validFrom: null, validTo: null, status: null, isChief: false, fte: null, children: [], ...over,
});
const actionTree = (): OrgStructureNode[] => [
  n({ key: "unit:a", kind: "unit", id: "a", parentId: null, status: "active", children: [
    n({ key: "position:p1", kind: "position", id: "p1", orgUnitId: "a", status: "vacant" }),
    n({ key: "unit:b", kind: "unit", id: "b", parentId: "a", status: "active", children: [n({ key: "unit:c", kind: "unit", id: "c", parentId: "b", status: "active" })] }),
  ] }),
  n({ key: "unit:d", kind: "unit", id: "d", parentId: null, status: "archived" }),
];

test("unitChoices lists units only, with depth", () => {
  assert.deepEqual(unitChoices(actionTree()).map((u) => `${u.depth}:${u.id}`), ["0:a", "1:b", "2:c", "0:d"]);
});

test("unitSubtreeIds is the unit and everything below it", () => {
  assert.deepEqual([...unitSubtreeIds(actionTree(), "b")].sort(), ["b", "c"]);
  assert.deepEqual([...unitSubtreeIds(actionTree(), "zzz")], []);
});

test("availableActions follows the selected row and the role", () => {
  const t = actionTree();
  const a = t[0], p1 = a.children[0], d = t[1];
  assert.deepEqual(availableActions(null, false), []);
  assert.deepEqual(availableActions(a, false), []);
  assert.deepEqual(availableActions(null, true), ["create-unit"]);
  assert.deepEqual(availableActions(a, true), ["create-unit", "create-position", "edit", "move", "archive"]);
  assert.deepEqual(availableActions(d, true), ["create-unit", "create-position", "edit", "move", "activate"]);
  assert.deepEqual(availableActions(p1, true), ["move", "set-chief", "assign"]);
  assert.deepEqual(availableActions({ ...p1, isChief: true, status: "filled" }, true), ["move"]);
  assert.deepEqual(availableActions(n({ key: "holder:p1:e", kind: "holder", id: "e" }), true), ["unassign"]);
});

test("canDropOn refuses itself, its own parent, its own subtree and non-units", () => {
  const t = actionTree();
  const [a] = t;
  const b = a.children[1], c = b.children[0], p1 = a.children[0], d = t[1];
  assert.equal(canDropOn(t, b, b), false);
  assert.equal(canDropOn(t, b, a), false); // already its parent
  assert.equal(canDropOn(t, a, c), false); // into its own subtree
  assert.equal(canDropOn(t, b, d), true);
  assert.equal(canDropOn(t, c, a), true);
  assert.equal(canDropOn(t, p1, a), false); // already there
  assert.equal(canDropOn(t, p1, b), true);
  assert.equal(canDropOn(t, p1, p1), false);
});
