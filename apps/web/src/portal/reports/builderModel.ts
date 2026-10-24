import type { BuilderAggregate, BuilderDatasetInfo, BuilderDefinition, BuilderFieldInfo, BuilderFilter, BuilderFilterOp } from "@aihxm/shared-types";

/** What the Builder form holds. It is turned into a BuilderDefinition only when the person runs or saves. */
export type BuilderForm = {
  dataset: string;
  mode: "list" | "summary";
  columns: string[];
  groups: { field: string; bucket: "" | "month" | "year" }[];
  measures: { aggregate: BuilderAggregate; field: string }[];
  filters: { field: string; op: BuilderFilterOp; value: string }[];
  sortBy: string;
  sortDir: "asc" | "desc";
  limit: string;
  chart: "auto" | "bar" | "line" | "donut" | "none";
};

export const EMPTY_FORM: BuilderForm = { dataset: "", mode: "summary", columns: [], groups: [], measures: [{ aggregate: "count", field: "" }], filters: [], sortBy: "", sortDir: "desc", limit: "", chart: "auto" };

export const OPS_BY_TYPE: Record<string, { op: BuilderFilterOp; label: string }[]> = {
  text: [
    { op: "eq", label: "is" },
    { op: "neq", label: "is not" },
    { op: "contains", label: "contains" },
    { op: "in", label: "is one of" },
    { op: "isNull", label: "is empty" },
    { op: "notNull", label: "is not empty" },
  ],
  number: [
    { op: "eq", label: "equals" },
    { op: "neq", label: "does not equal" },
    { op: "gt", label: "is more than" },
    { op: "gte", label: "is at least" },
    { op: "lt", label: "is less than" },
    { op: "lte", label: "is at most" },
    { op: "isNull", label: "is empty" },
    { op: "notNull", label: "is not empty" },
  ],
  date: [
    { op: "eq", label: "is on" },
    { op: "gte", label: "is on or after" },
    { op: "lte", label: "is on or before" },
    { op: "gt", label: "is after" },
    { op: "lt", label: "is before" },
    { op: "isNull", label: "is empty" },
    { op: "notNull", label: "is not empty" },
  ],
};

export const AGGREGATE_LABEL: Record<BuilderAggregate, string> = { count: "Count", sum: "Total", avg: "Average", min: "Smallest", max: "Largest" };

/** Aggregates a field supports: numbers can be added and averaged, dates have a smallest and largest, anything can be counted. */
export function aggregatesFor(field: BuilderFieldInfo | undefined): BuilderAggregate[] {
  if (!field) return ["count"];
  if (field.type === "number" && field.measure) return ["count", "sum", "avg", "min", "max"];
  if (field.type === "number" || field.type === "date") return ["count", "min", "max"];
  return ["count"];
}

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** The form as the definition the server validates. Empty rows are dropped; the server remains the judge of validity. */
export function toDefinition(form: BuilderForm, dataset: BuilderDatasetInfo | undefined): BuilderDefinition {
  const def: BuilderDefinition = { dataset: form.dataset };
  if (form.mode === "list") def.columns = form.columns;
  else {
    def.groupBy = form.groups.filter((g) => g.field).map((g) => (g.bucket ? `${g.field}@${g.bucket}` : g.field));
    def.measures = form.measures.filter((m) => m.aggregate === "count" || m.field).map((m) => ({ aggregate: m.aggregate, field: m.field || null }));
  }
  const filters: BuilderFilter[] = [];
  for (const f of form.filters) {
    if (!f.field) continue;
    const info = dataset?.fields.find((x) => x.key === f.field);
    if (f.op === "isNull" || f.op === "notNull") {
      filters.push({ field: f.field, op: f.op });
      continue;
    }
    if (f.value.trim() === "") continue;
    if (f.op === "in") filters.push({ field: f.field, op: f.op, value: info?.type === "number" ? splitList(f.value).map(Number) : splitList(f.value) });
    else filters.push({ field: f.field, op: f.op, value: info?.type === "number" ? Number(f.value) : f.value.trim() });
  }
  if (filters.length) def.filters = filters;
  if (form.sortBy) def.sort = { by: form.sortBy, direction: form.sortDir };
  const limit = Number(form.limit);
  if (form.limit && Number.isInteger(limit) && limit > 0) def.limit = limit;
  if (form.chart !== "auto") def.chart = form.chart;
  return def;
}

/** The form that produced a definition, so a saved report can be edited. */
export function fromDefinition(def: BuilderDefinition): BuilderForm {
  const listMode = !!def.columns?.length && !def.groupBy?.length && !def.measures?.length;
  return {
    dataset: def.dataset,
    mode: listMode ? "list" : "summary",
    columns: def.columns ?? [],
    groups: (def.groupBy ?? []).map((g) => {
      const [field, bucket] = g.split("@");
      return { field: field ?? "", bucket: (bucket as "month" | "year" | undefined) ?? "" };
    }),
    measures: def.measures?.length ? def.measures.map((m) => ({ aggregate: m.aggregate, field: m.field ?? "" })) : [{ aggregate: "count", field: "" }],
    filters: (def.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: Array.isArray(f.value) ? f.value.join(", ") : f.value === undefined ? "" : String(f.value) })),
    sortBy: def.sort?.by ?? "",
    sortDir: def.sort?.direction ?? "desc",
    limit: def.limit ? String(def.limit) : "",
    chart: def.chart ?? "auto",
  };
}

/** The result columns a form will produce, as { key, label }: the Sort control lists these. Mirrors the server's naming. */
export function outputColumns(form: BuilderForm, dataset: BuilderDatasetInfo | undefined): { key: string; label: string }[] {
  if (!dataset) return [];
  const field = (k: string) => dataset.fields.find((f) => f.key === k);
  if (form.mode === "list") return form.columns.flatMap((k) => (field(k) ? [{ key: k, label: field(k)!.label }] : []));
  const out: { key: string; label: string }[] = [];
  for (const g of form.groups) {
    const f = field(g.field);
    if (f) out.push({ key: g.bucket ? `${f.key}_${g.bucket}` : f.key, label: g.bucket ? `${f.label} (by ${g.bucket})` : f.label });
  }
  for (const m of form.measures) {
    const f = m.field ? field(m.field) : undefined;
    if (m.aggregate !== "count" && !f) continue;
    out.push({ key: `${m.aggregate}_${f?.key ?? "rows"}`, label: m.aggregate === "count" ? (f ? `Count of ${f.label}` : "Number of records") : `${AGGREGATE_LABEL[m.aggregate]} ${f?.label ?? ""}`.trim() });
  }
  return out;
}

/** A sentence a person can read back before running: "Count of records, grouped by department, where status is Approved." */
export function describeForm(form: BuilderForm, dataset: BuilderDatasetInfo | undefined): string {
  if (!dataset) return "";
  const cols = outputColumns(form, dataset);
  const what = form.mode === "list" ? (cols.length ? `${cols.map((c) => c.label.toLowerCase()).join(", ")}` : "choose the columns") : cols.filter((c) => !form.groups.some((g) => (g.bucket ? `${g.field}_${g.bucket}` : g.field) === c.key)).map((c) => c.label.toLowerCase()).join(", ");
  const by = form.mode === "summary" && form.groups.some((g) => g.field) ? `, grouped by ${form.groups.filter((g) => g.field).map((g) => dataset.fields.find((f) => f.key === g.field)?.label.toLowerCase() ?? g.field).join(" and ")}` : "";
  const n = form.filters.filter((f) => f.field).length;
  return `${dataset.label}: ${what}${by}${n ? `, with ${n} filter${n === 1 ? "" : "s"}` : ""}.`;
}
