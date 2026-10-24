import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BuilderDatasetInfo } from "@aihxm/shared-types";
import { EMPTY_FORM, aggregatesFor, describeForm, fromDefinition, outputColumns, toDefinition } from "./builderModel";

const ds: BuilderDatasetInfo = {
  key: "payslips",
  label: "Payslips",
  description: "",
  sensitivity: "sensitive",
  scope: "tenant",
  fields: [
    { key: "department", label: "Department", type: "text", groupable: true, measure: false },
    { key: "period", label: "Payroll month", type: "text", groupable: true, measure: false },
    { key: "net_pay", label: "Net pay (PKR)", type: "number", groupable: false, measure: true },
    { key: "joined", label: "Joining date", type: "date", groupable: true, measure: false },
  ],
};

test("a summary form becomes a grouped definition and drops empty rows", () => {
  const def = toDefinition(
    {
      ...EMPTY_FORM,
      dataset: "payslips",
      groups: [{ field: "department", bucket: "" }, { field: "", bucket: "" }, { field: "joined", bucket: "month" }],
      measures: [{ aggregate: "sum", field: "net_pay" }, { aggregate: "sum", field: "" }, { aggregate: "count", field: "" }],
      filters: [
        { field: "department", op: "in", value: "Finance, Sales" },
        { field: "net_pay", op: "gte", value: "50000" },
        { field: "period", op: "eq", value: "" },
        { field: "joined", op: "notNull", value: "" },
      ],
      sortBy: "sum_net_pay",
      sortDir: "desc",
      limit: "25",
    },
    ds,
  );
  assert.deepEqual(def.groupBy, ["department", "joined@month"]);
  assert.deepEqual(def.measures, [{ aggregate: "sum", field: "net_pay" }, { aggregate: "count", field: null }]);
  assert.deepEqual(def.filters, [
    { field: "department", op: "in", value: ["Finance", "Sales"] },
    { field: "net_pay", op: "gte", value: 50000 },
    { field: "joined", op: "notNull" },
  ]);
  assert.deepEqual(def.sort, { by: "sum_net_pay", direction: "desc" });
  assert.equal(def.limit, 25);
});

test("a list form keeps only its columns", () => {
  const def = toDefinition({ ...EMPTY_FORM, dataset: "payslips", mode: "list", columns: ["department", "net_pay"] }, ds);
  assert.deepEqual(def, { dataset: "payslips", columns: ["department", "net_pay"] });
});

test("a definition round-trips through the form", () => {
  const def = toDefinition({ ...EMPTY_FORM, dataset: "payslips", groups: [{ field: "joined", bucket: "year" }], measures: [{ aggregate: "avg", field: "net_pay" }], chart: "line" }, ds);
  assert.deepEqual(toDefinition(fromDefinition(def), ds), def);
});

test("output columns use the same names the server gives them", () => {
  const cols = outputColumns({ ...EMPTY_FORM, dataset: "payslips", groups: [{ field: "joined", bucket: "month" }], measures: [{ aggregate: "count", field: "" }, { aggregate: "sum", field: "net_pay" }] }, ds);
  assert.deepEqual(cols.map((c) => c.key), ["joined_month", "count_rows", "sum_net_pay"]);
});

test("only numbers that are measures can be added up", () => {
  assert.deepEqual(aggregatesFor(ds.fields[2]), ["count", "sum", "avg", "min", "max"]);
  assert.deepEqual(aggregatesFor(ds.fields[3]), ["count", "min", "max"]);
  assert.deepEqual(aggregatesFor(ds.fields[0]), ["count"]);
});

test("the form reads back as a sentence", () => {
  const s = describeForm({ ...EMPTY_FORM, dataset: "payslips", groups: [{ field: "department", bucket: "" }], filters: [{ field: "period", op: "eq", value: "2026-09" }] }, ds);
  assert.match(s, /Payslips/);
  assert.match(s, /grouped by department/);
  assert.match(s, /1 filter/);
});
