import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCatalogEntry, ReportCatalogResponse } from "@aihxm/shared-types";
import { filterCatalog, matchesQuery } from "./reportCatalogView";

const entry = (over: Partial<ReportCatalogEntry>): ReportCatalogEntry => ({
  id: "B04", version: 1, title: "Attrition by tenure", description: "Leavers by length of service", categoryKey: "B", categoryLabel: "Workforce movement",
  tags: ["turnover"], sourceModule: "employee", status: "available", statusReason: null, sensitivity: "standard", visualizations: ["bar"], filters: [],
  canExport: true, scope: "tenant", favorite: false, lastViewedAt: null, ...over,
});

const catalog = (entries: ReportCatalogEntry[], extra: Partial<ReportCatalogResponse> = {}): ReportCatalogResponse => ({
  generatedAt: "2026-10-23T00:00:00Z", catalogTotal: entries.length,
  counts: { visible: entries.length, available: 0, planned: 0, blocked: 0, unavailable: 0 }, categories: [], entries, recent: [], favorites: [], ...extra,
});

test("search needs every word and matches code, title, tag and description", () => {
  const e = entry({});
  assert.equal(matchesQuery(e, "b04"), true);
  assert.equal(matchesQuery(e, "attrition tenure"), true);
  assert.equal(matchesQuery(e, "turnover"), true);
  assert.equal(matchesQuery(e, "length service"), true);
  assert.equal(matchesQuery(e, "attrition payroll"), false);
  assert.equal(matchesQuery(e, "   "), true);
});

test("status and category filters combine", () => {
  const list = [entry({ id: "A01", categoryKey: "A" }), entry({ id: "B01", status: "blocked" }), entry({ id: "B02" })];
  const c = catalog(list);
  assert.deepEqual(filterCatalog(c, { query: "", category: "B", status: "available", only: "all" }).map((e) => e.id), ["B02"]);
  assert.deepEqual(filterCatalog(c, { query: "", category: "all", status: "all", only: "all" }).map((e) => e.id), ["A01", "B01", "B02"]);
});

test("recent keeps the server order and favorites only shows starred reports", () => {
  const list = [entry({ id: "A01", favorite: true }), entry({ id: "A02" }), entry({ id: "A03" })];
  const c = catalog(list, { recent: ["A03", "A01"] });
  assert.deepEqual(filterCatalog(c, { query: "", category: "all", status: "all", only: "recent" }).map((e) => e.id), ["A03", "A01"]);
  assert.deepEqual(filterCatalog(c, { query: "", category: "all", status: "all", only: "favorites" }).map((e) => e.id), ["A01"]);
});
