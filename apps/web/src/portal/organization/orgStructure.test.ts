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
  assert.equal(formatValidFrom("2024-05-01"), "01.05.2024");
  assert.equal(formatValidTo(null), "Unlimited");
  assert.equal(formatValidTo("2025-01-31"), "31.01.2025");
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
