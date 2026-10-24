import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { BuilderDefinition, BuilderFilter, BuilderFilterOp, BuilderMeasure, ReportColumn, ReportScope } from "@aihxm/shared-types";
import type { PayrollAreaAccess } from "../../payroll/payroll-area-access";
import { Params, employeeConditions } from "../engine/sql";
import { DATASET_BY_KEY, type DatasetDef, type FieldDef } from "./datasets";

export const MAX_COLUMNS = 20;
export const MAX_GROUPS = 3;
export const MAX_MEASURES = 6;
export const MAX_FILTERS = 20;
export const MAX_IN_VALUES = 50;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUCKETS = ["month", "year"] as const;
type Bucket = (typeof BUCKETS)[number];

const OPS_BY_TYPE: Record<string, readonly BuilderFilterOp[]> = {
  text: ["eq", "neq", "contains", "in", "isNull", "notNull"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "isNull", "notNull"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "notNull"],
  boolean: ["eq"],
};

const bad = (m: string): never => {
  throw new BadRequestException(m);
};

export type GroupSpec = { field: FieldDef; bucket: Bucket | null; key: string; label: string };

export type Compiled = {
  sql: string;
  params: unknown[];
  columns: ReportColumn[];
  mode: "list" | "aggregate";
  groups: GroupSpec[];
  measures: Array<{ key: string; label: string; aggregate: BuilderMeasure["aggregate"]; field: FieldDef | null }>;
};

/** Parses "field" or "field@month" into the field and its bucket. */
function parseGroup(ds: DatasetDef, raw: unknown): GroupSpec {
  if (typeof raw !== "string" || raw.length > 60) return bad("A group is not valid");
  const [fieldKey, bucketRaw] = raw.split("@");
  const field = ds.fields.find((x) => x.key === fieldKey);
  if (!field || !KEY_RE.test(fieldKey ?? "")) return bad(`"${String(fieldKey).slice(0, 40)}" is not a field of ${ds.label}`);
  if (!field.groupable) return bad(`${field.label} cannot be used to group rows`);
  let bucket: Bucket | null = null;
  if (bucketRaw !== undefined) {
    if (!field.buckets || !(BUCKETS as readonly string[]).includes(bucketRaw)) return bad(`${field.label} cannot be grouped by "${bucketRaw.slice(0, 20)}"`);
    bucket = bucketRaw as Bucket;
  }
  return { field, bucket, key: bucket ? `${field.key}_${bucket}` : field.key, label: bucket ? `${field.label} (by ${bucket})` : field.label };
}

/**
 * Checks the shape of a stored or submitted definition against the dataset allowlist and returns a clean copy. Anything
 * unknown is rejected, never ignored: a definition that passes here can only name fields this file knows. Pure.
 */
export function validateDefinition(raw: unknown): BuilderDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("The report definition is not valid");
  const d = raw as Record<string, unknown>;
  const allowed = new Set(["dataset", "columns", "groupBy", "measures", "filters", "sort", "limit", "chart"]);
  for (const k of Object.keys(d)) if (!allowed.has(k)) bad(`Unknown report setting "${k.slice(0, 30)}"`);
  const ds = typeof d.dataset === "string" ? DATASET_BY_KEY.get(d.dataset) : undefined;
  if (!ds) return bad("Choose what the report is about");

  const out: BuilderDefinition = { dataset: ds.key };
  const fieldOf = (k: unknown): FieldDef => {
    const f = typeof k === "string" ? ds.fields.find((x) => x.key === k) : undefined;
    if (!f) return bad(`"${String(k).slice(0, 40)}" is not a field of ${ds.label}`);
    return f as FieldDef;
  };

  if (d.columns !== undefined) {
    if (!Array.isArray(d.columns) || d.columns.length > MAX_COLUMNS) return bad(`Choose up to ${MAX_COLUMNS} columns`);
    out.columns = [...new Set(d.columns.map((c) => fieldOf(c).key))];
  }
  if (d.groupBy !== undefined) {
    if (!Array.isArray(d.groupBy) || d.groupBy.length > MAX_GROUPS) return bad(`Group by at most ${MAX_GROUPS} things`);
    out.groupBy = d.groupBy.map((g) => {
      const spec = parseGroup(ds, g);
      return spec.bucket ? `${spec.field.key}@${spec.bucket}` : spec.field.key;
    });
    if (new Set(out.groupBy).size !== out.groupBy.length) bad("The same group is chosen twice");
  }
  if (d.measures !== undefined) {
    if (!Array.isArray(d.measures) || d.measures.length > MAX_MEASURES) return bad(`Choose up to ${MAX_MEASURES} figures`);
    out.measures = d.measures.map((m): BuilderMeasure => {
      if (!m || typeof m !== "object") return bad("A figure is not valid");
      const mm = m as Record<string, unknown>;
      const aggregate = mm.aggregate;
      if (!["count", "sum", "avg", "min", "max"].includes(String(aggregate))) return bad("Choose how to calculate each figure");
      const agg = aggregate as BuilderMeasure["aggregate"];
      if (mm.field === null || mm.field === undefined) {
        if (agg !== "count") return bad(`${agg} needs a field`);
        return { field: null, aggregate: "count" };
      }
      const f = fieldOf(mm.field);
      if ((agg === "sum" || agg === "avg") && !(f.type === "number" && f.measure)) return bad(`${f.label} cannot be added up or averaged`);
      if ((agg === "min" || agg === "max") && !(f.type === "number" || f.type === "date")) return bad(`${f.label} has no smallest or largest value`);
      return { field: f.key, aggregate: agg };
    });
    const keys = out.measures.map((m) => `${m.aggregate}_${m.field ?? "rows"}`);
    if (new Set(keys).size !== keys.length) bad("The same figure is chosen twice");
  }
  if (out.groupBy?.length && !out.measures?.length) out.measures = [{ field: null, aggregate: "count" }];
  if (!out.columns?.length && !out.groupBy?.length && !out.measures?.length) return bad("Choose at least one column or figure");

  if (d.filters !== undefined) {
    if (!Array.isArray(d.filters) || d.filters.length > MAX_FILTERS) return bad(`Use at most ${MAX_FILTERS} filters`);
    out.filters = d.filters.map((fl): BuilderFilter => {
      if (!fl || typeof fl !== "object") return bad("A filter is not valid");
      const x = fl as Record<string, unknown>;
      const f = fieldOf(x.field);
      const op = x.op as BuilderFilterOp;
      if (!(OPS_BY_TYPE[f.type] ?? []).includes(op)) return bad(`"${String(x.op).slice(0, 20)}" cannot be used with ${f.label}`);
      if (op === "isNull" || op === "notNull") return { field: f.key, op };
      const check = (v: unknown): string | number => {
        if (f.type === "number") {
          const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
          if (!Number.isFinite(n)) return bad(`${f.label} needs a number`);
          return n;
        }
        if (typeof v !== "string" || v.length === 0 || v.length > 100) return bad(`${f.label} needs a value`);
        if (f.type === "date" && !DATE_RE.test(v)) return bad(`${f.label} needs a date like 2026-03-31`);
        return v;
      };
      if (op === "in") {
        if (!Array.isArray(x.value) || x.value.length === 0 || x.value.length > MAX_IN_VALUES) return bad(`Choose between 1 and ${MAX_IN_VALUES} values for ${f.label}`);
        return { field: f.key, op, value: x.value.map(check) };
      }
      return { field: f.key, op, value: check(x.value) };
    });
  }
  if (d.sort !== undefined && d.sort !== null) {
    const s = d.sort as Record<string, unknown>;
    if (typeof s !== "object" || typeof s.by !== "string" || !KEY_RE.test(s.by) || (s.direction !== "asc" && s.direction !== "desc")) return bad("The sort order is not valid");
    out.sort = { by: s.by, direction: s.direction };
  }
  if (d.limit !== undefined) {
    if (typeof d.limit !== "number" || !Number.isInteger(d.limit) || d.limit < 1 || d.limit > MAX_LIMIT) return bad(`Rows must be a whole number from 1 to ${MAX_LIMIT}`);
    out.limit = d.limit;
  }
  if (d.chart !== undefined) {
    if (!["auto", "bar", "line", "donut", "none"].includes(String(d.chart))) return bad("The chart type is not valid");
    out.chart = d.chart as BuilderDefinition["chart"];
  }
  return out;
}

export type CompileInput = {
  def: BuilderDefinition;
  companyId: string;
  scope: ReportScope;
  callerEmployeeId: string | null;
  payrollAccess: PayrollAreaAccess | null;
  rowLimit: number;
};

const bucketExpr = (expr: string, b: Bucket) => (b === "month" ? `to_char(${expr}, 'YYYY-MM')` : `to_char(${expr}, 'YYYY')`);

/**
 * Compiles a validated definition into one parameterised SELECT. Identifiers come only from datasets.ts, values are bound
 * parameters, and the caller's scope (company, team through the reporting line, payroll areas) is always applied. The
 * compiler refuses to return SQL that lacks the company limit, the team limit or the area limit, as the report framework does.
 */
export function compile(input: CompileInput): Compiled {
  const def = validateDefinition(input.def);
  const ds = DATASET_BY_KEY.get(def.dataset) as DatasetDef;
  const fld = (k: string) => ds.fields.find((x) => x.key === k) as FieldDef;
  const p = new Params();

  if (ds.scopeKind === "company" && input.scope !== "tenant") throw new ForbiddenException("This data is available to people with company-wide access only");

  const where: string[] = [`${ds.alias}.company_id = ${p.add(input.companyId)}::uuid`];
  if (ds.scopeKind === "employee") where.push(...employeeConditions(p, { alias: "e", companyId: input.companyId, scope: input.scope, callerEmployeeId: input.callerEmployeeId }));
  if (ds.payrollRunAlias && input.payrollAccess && !input.payrollAccess.unrestricted) where.push(`${ds.payrollRunAlias}.payroll_area_id = ANY(${p.add(input.payrollAccess.payrollAreaIds)}::uuid[])`);
  where.push(...(ds.where ?? []));

  for (const fl of def.filters ?? []) {
    const f = fld(fl.field);
    const e = f.expr;
    switch (fl.op) {
      case "isNull": where.push(`(${e}) IS NULL`); break;
      case "notNull": where.push(`(${e}) IS NOT NULL`); break;
      case "contains": where.push(`(${e}) ILIKE ${p.add(`%${String(fl.value).replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\'`); break;
      case "in": {
        const cast = f.type === "number" ? "numeric[]" : "text[]";
        where.push(`(${e})${f.type === "number" ? "" : "::text"} = ANY(${p.add(fl.value)}::${cast})`);
        break;
      }
      default: {
        const cast = f.type === "number" ? "numeric" : f.type === "date" ? "date" : "text";
        const op = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[fl.op as "eq" | "gt" | "gte" | "lt" | "lte"];
        if (fl.op === "neq") where.push(`(${e})${f.type === "text" ? "::text" : ""} IS DISTINCT FROM ${p.add(fl.value)}::${cast}`);
        else where.push(`(${e})${f.type === "text" ? "::text" : ""} ${op} ${p.add(fl.value)}::${cast}`);
      }
    }
  }

  const aggregate = !!(def.groupBy?.length || def.measures?.length);
  const columns: ReportColumn[] = [];
  const selects: string[] = [];
  const groups: GroupSpec[] = [];
  const measures: Compiled["measures"] = [];
  const groupExprs: string[] = [];

  if (aggregate) {
    for (const g of def.groupBy ?? []) {
      const spec = parseGroup(ds, g);
      const expr = spec.bucket ? bucketExpr(spec.field.expr, spec.bucket) : `(${spec.field.expr})`;
      groups.push(spec);
      groupExprs.push(expr);
      selects.push(`${expr} AS ${spec.key}`);
      columns.push({ key: spec.key, label: spec.label, type: spec.bucket ? "text" : spec.field.type === "number" ? "number" : spec.field.type === "date" ? "date" : "text" });
    }
    for (const m of def.measures ?? []) {
      const f = m.field ? fld(m.field) : null;
      const key = `${m.aggregate}_${f?.key ?? "rows"}`;
      const label =
        m.aggregate === "count"
          ? f ? `Count of ${f.label}` : "Number of records"
          : `${{ sum: "Total", avg: "Average", min: "Smallest", max: "Largest" }[m.aggregate]} ${f?.label ?? ""}`.trim();
      const inner = f ? `(${f.expr})` : "*";
      const expr =
        m.aggregate === "count" ? `COUNT(${inner})`
        : m.aggregate === "avg" ? `ROUND(AVG(${inner})::numeric, 2)`
        : `${m.aggregate.toUpperCase()}(${inner})`;
      selects.push(`${expr} AS ${key}`);
      measures.push({ key, label, aggregate: m.aggregate, field: f });
      columns.push({ key, label, type: f?.type === "date" && (m.aggregate === "min" || m.aggregate === "max") ? "date" : "number" });
    }
  } else {
    for (const k of def.columns ?? []) {
      const f = fld(k);
      selects.push(`(${f.expr}) AS ${f.key}`);
      columns.push({ key: f.key, label: f.label, type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text" });
    }
  }

  // ORDER BY uses output positions, so a sort key is only ever matched to a column we built ourselves.
  let order = "";
  if (def.sort) {
    const idx = columns.findIndex((c) => c.key === def.sort?.by);
    if (idx < 0) bad("Sort by one of the columns in the report");
    order = ` ORDER BY ${idx + 1} ${def.sort.direction === "desc" ? "DESC" : "ASC"} NULLS LAST, 1 ASC`;
  } else if (aggregate) {
    const firstDate = groups.findIndex((g) => g.field.type === "date");
    order = firstDate >= 0 ? ` ORDER BY ${firstDate + 1} ASC` : groups.length && measures.length ? ` ORDER BY ${groups.length + 1} DESC NULLS LAST, 1 ASC` : "";
  } else {
    order = " ORDER BY 1 ASC";
  }
  const limit = Math.min(def.limit ?? (aggregate ? DEFAULT_LIMIT : input.rowLimit), input.rowLimit, MAX_LIMIT * 10);
  const group = groupExprs.length ? ` GROUP BY ${groupExprs.map((_, i) => i + 1).join(", ")}` : "";
  const sql = `SELECT ${selects.join(", ")} FROM ${ds.from} WHERE ${where.join(" AND ")}${group}${order} LIMIT ${Math.max(1, limit) + 1}`;

  if (!/\.company_id\s*=\s*\$\d+/.test(sql)) throw new Error("Builder query is not limited to the caller's company");
  if (ds.scopeKind === "employee" && input.scope === "team" && !sql.includes("org_relationships")) throw new Error("Team-scoped builder query ignored the reporting line");
  if (input.payrollAccess && !input.payrollAccess.unrestricted && ds.payrollRunAlias && !sql.includes("payroll_area_id = ANY")) throw new Error("Area-scoped builder query ignored the payroll area limit");

  return { sql, params: p.values, columns, mode: aggregate ? "aggregate" : "list", groups, measures };
}

/** The same scope conditions as compile(), for the "pick a value" lists. Distinct values of one groupable text field. */
export function compileDistinct(input: Omit<CompileInput, "def" | "rowLimit"> & { dataset: string; field: string }): { sql: string; params: unknown[] } {
  const ds = DATASET_BY_KEY.get(input.dataset);
  const f = ds?.fields.find((x) => x.key === input.field);
  if (!ds || !f || f.type !== "text" || !f.groupable) return bad("Values are only listed for text fields you can group by");
  const c = compile({ ...input, def: { dataset: ds.key, groupBy: [f.key], measures: [{ field: null, aggregate: "count" }], sort: { by: f.key, direction: "asc" }, limit: 100 }, rowLimit: 100 });
  return { sql: c.sql, params: c.params };
}
