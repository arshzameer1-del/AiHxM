import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModuleKey } from "@aihxm/shared-types";
import { buildEssTileGroups } from "./essTiles";

const ALL = ["employee", "leave", "payroll", "performance", "expense", "learning"] as ModuleKey[];
const flat = (m: ModuleKey[]) => buildEssTileGroups(m).flatMap((g) => g.tiles);

test("no tile title appears twice and no two tiles share a link", () => {
  const tiles = flat(ALL);
  const titles = tiles.map((t) => t.title);
  assert.equal(new Set(titles).size, titles.length);
  const links = tiles.filter((t) => t.to).map((t) => t.to as string);
  const repeated = links.filter((l, i) => links.indexOf(l) !== i);
  assert.deepEqual(repeated, []);
});

test("the SAP duplicates are merged away", () => {
  const titles = flat(ALL).map((t) => t.title);
  for (const merged of ["My Profile Enhance", "My Leave Requests Enhance", "My Benefits Enrollment", "My Time Statements", "My Team Calendar"]) {
    assert.ok(!titles.includes(merged), merged);
  }
});

test("tiles without a feature are Coming soon and have no link", () => {
  const soon = flat(ALL).filter((t) => t.comingSoon);
  const names = soon.map((t) => t.title);
  for (const n of ["Employee Lookup", "My Benefits", "My Forms"]) assert.ok(names.includes(n), n);
  for (const t of soon) assert.equal(t.to, undefined);
});

test("tiles of a module the company has not enabled are left out", () => {
  const titles = flat(["employee"] as ModuleKey[]).map((t) => t.title);
  assert.ok(titles.includes("My Profile"));
  assert.ok(!titles.includes("My Paystubs"));
  assert.ok(!titles.includes("My Leave Requests"));
});
