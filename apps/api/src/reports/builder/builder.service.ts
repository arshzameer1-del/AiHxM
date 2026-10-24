import { BadRequestException, ForbiddenException, Injectable, RequestTimeoutException } from "@nestjs/common";
import type { BuilderCatalogResponse, BuilderDefinition, ReportChartSpec, ReportKpi, ReportResult, ReportRow } from "@aihxm/shared-types";
import { AuditService } from "../../audit/audit.service";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { decideAccess, type ReportAccess } from "../report-access";
import type { ReportDefinition } from "../catalog/report-catalog.types";
import { ReportsService } from "../reports.service";
import { barChart, donutChart, lineChart } from "../engine/report-spec";
import { compile, compileDistinct, validateDefinition, type Compiled } from "./compile";
import { DATASET_BY_KEY, DATASETS, type DatasetDef } from "./datasets";

const STATEMENT_TIMEOUT_MS = 15_000;
export const CUSTOM_REPORT_ID = "X00";

/** The access decision for a dataset is the same one the catalog reports use, made on a stand-in definition. */
function standIn(ds: DatasetDef): ReportDefinition {
  return { id: CUSTOM_REPORT_ID, version: 1, title: ds.label, domain: ds.domain, sensitivity: ds.sensitivity, status: "available", extraPermissions: [], filters: [], visualizations: [], tags: [], sourceTables: [], statusReason: null, description: "", categoryKey: "workforce" as never, lifecycle: "published" };
}

@Injectable()
export class BuilderService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService
  ) {}

  private accessFor(ds: DatasetDef, ctx: Awaited<ReturnType<ReportsService["callerContext"]>>): ReportAccess | null {
    const a = decideAccess(standIn(ds), ctx.held, ctx.modules);
    if (!a) return null;
    if (ds.scopeKind === "company" && a.scope !== "tenant") return null;
    return a;
  }

  /** What the caller may do with a definition's data set (null when nothing). Used to decide who a scheduled file may go to. */
  async accessOf(claims: RequestClaims, rawDef: unknown): Promise<ReportAccess | null> {
    const def = validateDefinition(rawDef);
    const ds = DATASET_BY_KEY.get(def.dataset) as DatasetDef;
    const ctx = await this.reports.callerContext(claims);
    return this.accessFor(ds, ctx);
  }

  /** Datasets the caller may build on. Needs reports.build. */
  async catalog(claims: RequestClaims): Promise<BuilderCatalogResponse> {
    const ctx = await this.reports.callerContext(claims);
    if (!ctx.held.has("reports.build")) throw new ForbiddenException("Not permitted to use the Report Builder");
    const datasets = DATASETS.flatMap((ds) => {
      const a = this.accessFor(ds, ctx);
      if (!a) return [];
      return [{
        key: ds.key,
        label: ds.label,
        description: ds.description,
        sensitivity: ds.sensitivity,
        scope: a.scope,
        fields: ds.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, groupable: !!f.groupable, measure: !!f.measure })),
      }];
    });
    return { datasets };
  }

  /** Distinct values of one text field inside the caller's scope, for the filter value picker. */
  async values(claims: RequestClaims, dataset: string, field: string): Promise<string[]> {
    const ctx = await this.reports.callerContext(claims);
    if (!ctx.held.has("reports.build")) throw new ForbiddenException("Not permitted to use the Report Builder");
    const ds = DATASET_BY_KEY.get(dataset);
    if (!ds) throw new BadRequestException("Unknown data set");
    const access = this.accessFor(ds, ctx);
    if (!access) throw new ForbiddenException("Not permitted to use this data");
    const payrollAccess = await this.reports.payrollAccess(claims, ds);
    const callerEmployeeId = await this.callerEmployee(claims, access);
    const q = compileDistinct({ dataset, field, companyId: claims.company_id as string, scope: access.scope, callerEmployeeId, payrollAccess });
    return this.db.withClaims(claims, async (client) => {
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const r = await client.query<Record<string, unknown>>(q.sql, q.params);
      return r.rows.map((x) => x[field]).filter((v): v is string => typeof v === "string");
    });
  }

  private async callerEmployee(claims: RequestClaims, access: ReportAccess): Promise<string | null> {
    if (access.scope !== "team") return null;
    return this.db.withClaims(claims, async (client) => {
      const me = await client.query<{ id: string }>("SELECT id FROM employees WHERE user_account_id = $1 AND company_id = $2 LIMIT 1", [claims.sub, claims.company_id]);
      return me.rows[0]?.id ?? null;
    });
  }

  /**
   * Runs a definition for the caller. Used for builder previews, saved custom reports, dashboards and schedules. The
   * viewer's own access to the dataset decides the answer, whoever created or shared the definition.
   */
  async run(claims: RequestClaims, rawDef: unknown, o: { rowLimit: number; kind: "run" | "export"; title?: string; auditAction?: string | null }): Promise<{ result: ReportResult; access: ReportAccess }> {
    const started = Date.now();
    let def: BuilderDefinition;
    try {
      def = validateDefinition(rawDef);
    } catch (e) {
      await this.reports.logCustomUsage(claims, o.kind, "invalid", Date.now() - started, null, "invalid_definition");
      throw e;
    }
    const ds = DATASET_BY_KEY.get(def.dataset) as DatasetDef;
    const ctx = await this.reports.callerContext(claims);
    const access = this.accessFor(ds, ctx);
    if (!access) {
      await this.reports.logCustomUsage(claims, o.kind, "denied", 0, null, "forbidden");
      throw new ForbiddenException("Not permitted to use this data");
    }
    const payrollAccess = await this.reports.payrollAccess(claims, ds);
    const callerEmployeeId = await this.callerEmployee(claims, access);
    let compiled: Compiled;
    try {
      compiled = compile({ def, companyId: claims.company_id as string, scope: access.scope, callerEmployeeId, payrollAccess, rowLimit: o.rowLimit });
    } catch (e) {
      await this.reports.logCustomUsage(claims, o.kind, e instanceof BadRequestException ? "invalid" : "denied", Date.now() - started, null, "compile");
      throw e;
    }
    try {
      const result = await this.db.withClaims(claims, async (client) => {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        await client.query(
          `SELECT set_config('TimeZone', COALESCE((SELECT c.timezone FROM companies c JOIN pg_timezone_names n ON n.name = c.timezone WHERE c.id = $1), 'UTC'), true)`,
          [claims.company_id]
        );
        const res = await client.query<Record<string, unknown>>(compiled.sql, compiled.params);
        const limit = compiled.sql.match(/LIMIT (\d+)$/)?.[1];
        const max = limit ? Number(limit) - 1 : o.rowLimit;
        const truncated = res.rows.length > max;
        const rows: ReportRow[] = res.rows.slice(0, max).map((r) => {
          const out: ReportRow = {};
          for (const c of compiled.columns) {
            const v = r[c.key];
            if (v === null || v === undefined) out[c.key] = null;
            else if (c.type === "number" || c.type === "percent") out[c.key] = Number(v);
            else if (v instanceof Date) out[c.key] = v.toISOString().slice(0, 10);
            else out[c.key] = String(v);
          }
          return out;
        });
        const asOf = new Date().toISOString();
        const full: ReportResult = {
          reportId: CUSTOM_REPORT_ID,
          version: 1,
          title: o.title ?? `Custom report: ${ds.label}`,
          generatedAt: asOf,
          asOf,
          scope: access.scope,
          appliedFilters: {},
          dateRange: null,
          kpis: kpisFor(compiled, rows, truncated),
          charts: chartsFor(def, compiled, rows),
          columns: compiled.columns,
          rows,
          totalRows: rows.length,
          truncated,
          calculation: calculationNotes(def, compiled, ds),
          notes: truncated ? [`Only the first ${rows.length} rows are shown. Add filters or a smaller group to see the rest.`] : [],
        };
        const sensitive = ds.sensitivity === "sensitive" || ds.sensitivity === "restricted";
        if (o.auditAction || sensitive) {
          await this.audit.record(client, claims, {
            companyId: claims.company_id as string,
            action: o.auditAction ?? "report.run",
            target: `custom:${ds.key}`,
            metadata: { reportId: CUSTOM_REPORT_ID, dataset: ds.key, sensitivity: ds.sensitivity, rowCount: rows.length, scope: access.scope, groupBy: def.groupBy ?? [], measures: def.measures ?? [], columns: def.columns ?? [] },
          });
        }
        return full;
      });
      await this.reports.logCustomUsage(claims, o.kind, "ok", Date.now() - started, result.totalRows, null);
      return { result, access };
    } catch (err) {
      const timedOut = (err as { code?: string }).code === "57014";
      if (!(err instanceof ForbiddenException) && !(err instanceof BadRequestException)) await this.reports.logCustomUsage(claims, o.kind, "error", Date.now() - started, null, timedOut ? "timeout" : "query_error");
      if (timedOut) throw new RequestTimeoutException("This report took too long to run. Add a filter or choose fewer groups, then try again.");
      throw err;
    }
  }
}

function kpisFor(c: Compiled, rows: ReportRow[], truncated: boolean): ReportKpi[] {
  if (c.mode === "list") return [{ key: "rows", label: "Rows", value: rows.length, unit: "count", ...(truncated ? { note: "More rows exist than are shown" } : {}) }];
  if (c.groups.length === 0) {
    const r = rows[0] ?? {};
    return c.measures.map((m) => ({ key: m.key, label: m.label, value: (r[m.key] as number | null) ?? null, unit: "count" as const }));
  }
  const kpis: ReportKpi[] = [{ key: "groups", label: "Groups", value: rows.length, unit: "count" }];
  const first = c.measures[0];
  if (first && (first.aggregate === "count" || first.aggregate === "sum")) {
    kpis.push({ key: `${first.key}_total`, label: `${first.label} (all groups)`, value: rows.reduce((s, r) => s + Number(r[first.key] ?? 0), 0), unit: "count" });
  }
  return kpis;
}

function chartsFor(def: BuilderDefinition, c: Compiled, rows: ReportRow[]): ReportChartSpec[] {
  if (def.chart === "none" || c.mode !== "aggregate" || c.groups.length === 0 || rows.length === 0 || c.measures.length === 0) return [];
  const g = c.groups[0];
  const m = c.measures[0];
  if (!g || !m) return [];
  const title = `${m.label} by ${g.label.toLowerCase()}`;
  const timeLike = g.bucket !== null || g.field.type === "date";
  if (c.groups.length === 1 && (def.chart === "line" || (timeLike && (def.chart ?? "auto") === "auto"))) {
    return [lineChart({ title, unit: m.label, rows: rows.map((r) => ({ ...r, label: String(r[g.key] ?? "Not set") })), xKey: "label", series: c.measures.slice(0, 3).map((x) => ({ key: x.key, label: x.label })) })];
  }
  if (c.groups.length === 1 && def.chart === "donut") return [donutChart({ title, unit: m.label, rows, labelKey: g.key, valueKey: m.key })];
  if (c.groups.length === 1 || def.chart === "bar") return [barChart({ title, unit: m.label, rows, labelKey: g.key, valueKey: m.key, valueLabel: m.label })];
  return [];
}

function calculationNotes(def: BuilderDefinition, c: Compiled, ds: DatasetDef): string[] {
  const out = [`Built with the Report Builder from "${ds.label}". Only the records you are allowed to see are included.`];
  if (c.mode === "aggregate") out.push(`Rows are ${c.groups.length ? `grouped by ${c.groups.map((g) => g.label.toLowerCase()).join(" and ")}` : "totalled"}; ${c.measures.map((m) => m.label.toLowerCase()).join(", ")}.`);
  if (def.filters?.length) out.push(`${def.filters.length} filter${def.filters.length === 1 ? " is" : "s are"} applied.`);
  return out;
}

