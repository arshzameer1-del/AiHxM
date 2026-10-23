import assert from "node:assert/strict";
import { test } from "node:test";
import { appliedFilterChips, describeSeries, formatCell, formatKpiDelta, formatKpiValue } from "./reportFormat";

test("KPI values keep their unit and never turn a missing value into zero", () => {
  assert.equal(formatKpiValue({ value: 1234, unit: "count" }), "1,234");
  assert.equal(formatKpiValue({ value: 12.54, unit: "percent" }), "12.5%");
  assert.equal(formatKpiValue({ value: 1, unit: "days" }), "1 day");
  assert.equal(formatKpiValue({ value: 3.5, unit: "hours" }), "3.5 h");
  assert.equal(formatKpiValue({ value: null, unit: "count" }), "—");
  assert.equal(formatKpiValue({ value: Number.NaN, unit: "percent" }), "—");
});

test("deltas are signed and absent when the report gives none", () => {
  assert.equal(formatKpiDelta({ delta: 2, unit: "count" }), "+2");
  assert.equal(formatKpiDelta({ delta: -1.5, unit: "percent" }), "−1.5 pts");
  assert.equal(formatKpiDelta({ delta: 0, unit: "days" }), "0 d");
  assert.equal(formatKpiDelta({ delta: null, unit: "count" }), null);
  assert.equal(formatKpiDelta({ unit: "count" }), null);
});

test("table cells follow the column type", () => {
  assert.equal(formatCell(1500, "number"), "1,500");
  assert.equal(formatCell(40, "percent"), "40%");
  assert.equal(formatCell("2026-09-01", "date"), "1 Sep 2026");
  assert.equal(formatCell(null, "text"), "—");
  assert.equal(formatCell("", "number"), "—");
  assert.equal(formatCell("Karachi", "text"), "Karachi");
});

test("applied filters become labelled chips and skip empty ones", () => {
  const chips = appliedFilterChips({ dateFrom: "2026-09-01", dateTo: "2026-09-30", department: "d1", location: "" }, (_k, v) => (v === "d1" ? "Finance" : v));
  assert.deepEqual(chips.map((c) => c.text), ["From: 1 Sep 2026", "To: 30 Sep 2026", "Department: Finance"]);
});

test("chart summary names the highest and lowest points", () => {
  const rows = [{ m: "Jan", v: 5 }, { m: "Feb", v: 9 }, { m: "Mar", v: 2 }];
  assert.equal(describeSeries("Hires", "people", rows, "m", "v"), "Hires. 3 points, measured in people. Highest Feb: 9. Lowest Mar: 2.");
  assert.equal(describeSeries("Hires", "people", [], "m", "v"), "Hires. No data for the selected filters.");
});
