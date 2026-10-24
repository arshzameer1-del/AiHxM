import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, RequestTimeoutException } from "@nestjs/common";
import type {
  ReportDatePreset,
  ReportDrill,
  ReportKpi,
  ReportCatalogEntry,
  ReportCatalogResponse,
  ReportCategoryKey,
  ReportFilterOption,
  ReportFilterOptions,
  ReportFilterValues,
  ReportResult,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { resolvePayrollAreaAccess, isPayrollAreaInScope, type PayrollAreaAccess } from "../payroll/payroll-area-access";
import { RbacService } from "../rbac/rbac.service";
import { CATEGORIES, DOMAIN_POLICIES } from "./catalog/categories";
import { REPORT_BY_ID, REPORT_CATALOG } from "./catalog/report-catalog";
import type { ReportDefinition } from "./catalog/report-catalog.types";
import { allPermissionKeysForCatalog, decideAccess, type ReportAccess } from "./report-access";
import { toCsvWithSections } from "./engine/csv";
import { normalizeFilters } from "./engine/filters";
import { previousRange, resolvePreset } from "./engine/presets";
import { DEFAULT_RANGES, EXECUTORS } from "./engine/executors";
import { Params, UNASSIGNED, employeeConditions, prettyKey } from "./engine/sql";
import type { ExecutorOutput } from "./engine/executors/types";

export const SCREEN_ROWS = 500;
export const EXPORT_ROWS = 10_000;
const STATEMENT_TIMEOUT_MS = 15_000;
const PAYROLL_VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];

/** Which report a row of a grouped report opens, and with which filter. The row carries the value in `_key`. */
const DRILLS: Record<string, ReportDrill> = {
  A03: { reportId: "B01", filter: "department", rowKey: "_key", label: "Open the employees in this department" },
  A04: { reportId: "B01", filter: "location", rowKey: "_key", label: "Open the employees at this location" },
  A05: { reportId: "B01", filter: "employmentType", rowKey: "_key", label: "Open the employees of this type" },
};

export type RunOptions = { filters?: Record<string, unknown>; preset?: ReportDatePreset | null; compare?: boolean; /** do not count this run as "recently viewed" (Overview tiles, dashboards) */ quiet?: boolean };

/** Fills `delta` and `previous` on each KPI that has a numeric twin in the comparison period. A missing twin stays unmarked. */
export function applyComparison(current: ReportKpi[], previous: ReportKpi[]): ReportKpi[] {
  const prev = new Map(previous.map((k) => [k.key, k]));
  return current.map((k) => {
    const o = prev.get(k.key);
    if (!o || o.unit !== k.unit || k.value === null || o.value === null) return k;
    return { ...k, previous: o.value, delta: Math.round((k.value - o.value) * 10) / 10 };
  });
}

type CallerContext = { held: ReadonlySet<string>; modules: ReadonlySet<string> };

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------------ catalog

  /** @internal shared with the builder, dashboards and schedules */
  async callerContext(claims: RequestClaims): Promise<CallerContext> {
    if (!claims.company_id) throw new ForbiddenException("Reports & Analytics needs a company sign-in");
    const keys = allPermissionKeysForCatalog(REPORT_CATALOG.map((d) => d.domain), REPORT_CATALOG.flatMap((d) => d.extraPermissions));
    const [held, modules] = await Promise.all([
      this.rbac.heldPermissionKeys(claims, keys),
      this.db.withClaims(claims, (client) => this.entitlements.getEnabledModuleKeys(client, claims.company_id as string)),
    ]);
    if (!held.has("reports.view")) throw new ForbiddenException("Not permitted to open Reports & Analytics");
    return { held, modules: new Set<string>(modules) };
  }

  private entryFor(def: ReportDefinition, access: ReportAccess, fav: Set<string>, last: Map<string, string>): ReportCatalogEntry {
    const cat = CATEGORIES.find((c) => c.key === def.categoryKey);
    return {
      id: def.id,
      version: def.version,
      title: def.title,
      description: def.description,
      categoryKey: def.categoryKey,
      categoryLabel: cat?.label ?? def.categoryKey,
      tags: [...def.tags],
      sourceModule: DOMAIN_POLICIES[def.domain].label,
      status: def.status,
      statusReason: def.statusReason,
      sensitivity: def.sensitivity,
      visualizations: [...def.visualizations],
      filters: [...def.filters],
      canExport: access.canExport,
      scope: access.scope,
      favorite: fav.has(def.id),
      lastViewedAt: last.get(def.id) ?? null,
    };
  }

  private async userState(claims: RequestClaims): Promise<{ fav: Set<string>; last: Map<string, string> }> {
    return this.db.withClaims(claims, async (client) => {
      const f = await client.query<{ report_id: string }>("SELECT report_id FROM report_favorites WHERE user_account_id = $1", [claims.sub]);
      const v = await client.query<{ report_id: string; last_viewed_at: Date }>(
        "SELECT report_id, last_viewed_at FROM report_recent_views WHERE user_account_id = $1 ORDER BY last_viewed_at DESC LIMIT 50",
        [claims.sub]
      );
      return { fav: new Set(f.rows.map((x) => x.report_id)), last: new Map(v.rows.map((x) => [x.report_id, x.last_viewed_at.toISOString()])) };
    });
  }

  async catalog(claims: RequestClaims): Promise<ReportCatalogResponse> {
    const ctx = await this.callerContext(claims);
    const { fav, last } = await this.userState(claims);
    const entries: ReportCatalogEntry[] = [];
    for (const def of REPORT_CATALOG) {
      const access = decideAccess(def, ctx.held, ctx.modules);
      if (access) entries.push(this.entryFor(def, access, fav, last));
    }
    const count = (s: string) => entries.filter((e) => e.status === s).length;
    const categories = CATEGORIES.map((c) => ({ key: c.key as ReportCategoryKey, label: c.label, count: entries.filter((e) => e.categoryKey === c.key).length })).filter((c) => c.count > 0);
    return {
      generatedAt: new Date().toISOString(),
      catalogTotal: REPORT_CATALOG.length,
      counts: { visible: entries.length, available: count("available"), planned: count("planned"), blocked: count("blocked"), unavailable: count("unavailable") },
      categories,
      entries,
      recent: [...last.keys()].filter((id) => entries.some((e) => e.id === id)).slice(0, 8),
      favorites: [...fav].filter((id) => entries.some((e) => e.id === id)),
    };
  }

  /** One report's catalog entry, or 404 when the id is unknown, 403 when the caller may not see it. */
  private async resolve(claims: RequestClaims, id: string): Promise<{ def: ReportDefinition; access: ReportAccess; ctx: CallerContext }> {
    const def = REPORT_BY_ID.get(id);
    if (!def) throw new NotFoundException("No such report");
    const ctx = await this.callerContext(claims);
    const access = decideAccess(def, ctx.held, ctx.modules);
    if (!access) {
      await this.logUsage(claims, def, "run", "denied", 0, null, "forbidden");
      throw new ForbiddenException("Not permitted to run this report");
    }
    return { def, access, ctx };
  }

  /** @internal what the caller may do with one catalog report (403 when nothing). */
  async accessOf(claims: RequestClaims, id: string): Promise<{ def: ReportDefinition; access: ReportAccess }> {
    const { def, access } = await this.resolve(claims, id);
    return { def, access };
  }

  async entry(claims: RequestClaims, id: string): Promise<ReportCatalogEntry> {
    const { def, access } = await this.resolve(claims, id);
    const { fav, last } = await this.userState(claims);
    return this.entryFor(def, access, fav, last);
  }

  // ------------------------------------------------------------------ favourites

  async setFavorite(claims: RequestClaims, id: string, on: boolean): Promise<{ favorite: boolean }> {
    await this.resolve(claims, id);
    await this.db.withClaims(claims, async (client) => {
      if (on) {
        await client.query(
          "INSERT INTO report_favorites (company_id, user_account_id, report_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [claims.company_id, claims.sub, id]
        );
      } else {
        await client.query("DELETE FROM report_favorites WHERE user_account_id = $1 AND report_id = $2", [claims.sub, id]);
      }
    });
    return { favorite: on };
  }

  // ------------------------------------------------------------------ running

  /** @internal */
  async todayFor(claims: RequestClaims): Promise<string> {
    return this.db.withClaims(claims, async (client) => {
      try {
        const r = await client.query<{ d: string }>(
          "SELECT ((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'UTC'))::date)::text AS d FROM companies WHERE id = $1",
          [claims.company_id]
        );
        if (r.rows[0]?.d) return r.rows[0].d;
      } catch {
        // an unknown timezone name falls back to UTC rather than failing the report
      }
      return new Date().toISOString().slice(0, 10);
    });
  }

  /** @internal */
  async payrollAccess(claims: RequestClaims, def: Pick<ReportDefinition, "domain">): Promise<PayrollAreaAccess | null> {
    if (def.domain !== "payroll") return null;
    const access = await resolvePayrollAreaAccess(this.db, this.rbac, claims, PAYROLL_VIEW_BASES);
    if (!access) throw new ForbiddenException("Not permitted to run this report");
    return access;
  }

  /** @internal the one run path; also used by saved reports, dashboards, exports and schedules */
  async execute(
    claims: RequestClaims,
    id: string,
    opts: RunOptions,
    rowLimit: number,
    kind: "run" | "export",
    auditAction: string | null
  ): Promise<ReportResult> {
    const { def, access } = await this.resolve(claims, id);
    if (def.status !== "available") {
      throw new ConflictException({ code: "REPORT_NOT_AVAILABLE", status: def.status, message: def.statusReason ?? "This report is not available yet" });
    }
    const executor = EXECUTORS[id];
    if (!executor) {
      // The catalog says available but no query exists: never fabricate a result.
      throw new ConflictException({ code: "REPORT_NOT_AVAILABLE", status: "unavailable", message: "This report has no query behind it" });
    }
    const started = Date.now();
    let filters;
    try {
      const today0 = await this.todayFor(claims);
      let rawFilters = { ...(opts.filters ?? {}) };
      if (opts.preset && opts.preset !== "custom") {
        if (!def.filters.includes("dateRange")) throw new BadRequestException("This report has no date range, so a period cannot be chosen");
        const r = resolvePreset(opts.preset, today0);
        if (r) rawFilters = { ...rawFilters, dateFrom: r.from, dateTo: r.to };
      }
      filters = { ...normalizeFilters(def.filters, rawFilters, today0, DEFAULT_RANGES[id] ?? null), today: today0 };
      if (opts.compare && !filters.range) throw new BadRequestException("This report has no date range, so there is no earlier period to compare with");
    } catch (err) {
      await this.logUsage(claims, def, kind, "invalid", Date.now() - started, null, "invalid_filters");
      throw err;
    }
    const payrollAccess = await this.payrollAccess(claims, def);

    try {
      const result = await this.db.withClaims(claims, async (client) => {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        // Timestamps are turned into dates in the company's own time zone, so "today", "this month" and "N days ago" agree
        // with the date shown to the user. An unknown zone name falls back to UTC rather than failing the report.
        await client.query(
          `SELECT set_config('TimeZone', COALESCE((SELECT c.timezone FROM companies c JOIN pg_timezone_names n ON n.name = c.timezone WHERE c.id = $1), 'UTC'), true)`,
          [claims.company_id]
        );
        let callerEmployeeId: string | null = null;
        if (access.scope === "team") {
          const me = await client.query<{ id: string }>("SELECT id FROM employees WHERE user_account_id = $1 AND company_id = $2 LIMIT 1", [claims.sub, claims.company_id]);
          callerEmployeeId = me.rows[0]?.id ?? null;
        }
        const runFor = (values: typeof filters.values, range: typeof filters.range, skipSections = false): Promise<ExecutorOutput> =>
          executor({
            skipSections,
            client,
            companyId: claims.company_id as string,
            scope: access.scope,
            callerEmployeeId,
            filters: values,
            range,
            today: filters.today,
            rowLimit,
            payrollAccess,
            catalog: REPORT_CATALOG.map((d) => ({ id: d.id, title: d.title, category: d.categoryKey, categoryLabel: CATEGORIES.find((c) => c.key === d.categoryKey)?.label ?? d.categoryKey, domain: d.domain, status: d.status })),
          });
        const out: ExecutorOutput = await runFor(filters.values, filters.range);
        let comparison: { from: string; to: string } | null = null;
        if (opts.compare && filters.range) {
          comparison = previousRange(filters.range);
          const prev = await runFor({ ...filters.values, dateFrom: comparison.from, dateTo: comparison.to }, comparison, true);
          out.kpis = applyComparison(out.kpis, prev.kpis);
        }
        const asOf = new Date().toISOString();
        const full: ReportResult = {
          reportId: def.id,
          version: def.version,
          title: def.title,
          generatedAt: asOf,
          asOf,
          scope: access.scope,
          appliedFilters: filters.values,
          dateRange: filters.range,
          ...out,
          comparison,
          drill: DRILLS[def.id] ?? null,
        };
        const sensitive = def.sensitivity === "sensitive" || def.sensitivity === "restricted";
        if (auditAction || sensitive) {
          await this.audit.record(client, claims, {
            companyId: claims.company_id as string,
            action: auditAction ?? "report.run",
            target: def.id,
            metadata: { reportId: def.id, version: def.version, sensitivity: def.sensitivity, rowCount: out.totalRows, scope: access.scope, filters: filters.values },
          });
        }
        return full;
      });
      await this.logUsage(claims, def, kind, "ok", Date.now() - started, result.totalRows, null);
      if (kind === "run" && !opts.quiet) await this.touchRecent(claims, def.id);
      return result;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const timedOut = code === "57014";
      if (!(err instanceof ForbiddenException) && !(err instanceof BadRequestException)) {
        await this.logUsage(claims, def, kind, "error", Date.now() - started, null, timedOut ? "timeout" : "query_error");
      }
      if (timedOut) throw new RequestTimeoutException("This report took too long to run. Narrow the date range or add a filter, then try again.");
      throw err;
    }
  }

  run(claims: RequestClaims, id: string, filters: Record<string, unknown>, extra: Omit<RunOptions, "filters"> = {}): Promise<ReportResult> {
    return this.execute(claims, id, { ...extra, filters: filters ?? {} }, SCREEN_ROWS, "run", null);
  }

  async exportCsv(claims: RequestClaims, id: string, filters: Record<string, unknown>, extra: Omit<RunOptions, "filters"> = {}): Promise<{ filename: string; csv: string }> {
    const { def: exportDef, access } = await this.resolve(claims, id);
    if (!access.canExport) {
      await this.logUsage(claims, exportDef, "export", "denied", 0, null, "forbidden");
      throw new ForbiddenException("Not permitted to export this report");
    }
    const result = await this.execute(claims, id, { ...extra, filters: filters ?? {}, compare: false }, EXPORT_ROWS, "export", "report.export");
    const meta = [
      `${result.title} (${result.reportId} v${result.version})`,
      `Generated ${result.asOf}`,
      ...(result.dateRange ? [`Range ${result.dateRange.from} to ${result.dateRange.to}`] : []),
      `Scope: ${result.scope === "tenant" ? "whole company" : result.scope === "team" ? "your direct reports" : "your payroll areas"}`,
      ...(result.truncated ? [`Partial: only the first ${EXPORT_ROWS} of ${result.totalRows} rows are included`] : []),
      ...result.notes.map((n) => `Note: ${n}`),
    ];
    return { filename: `${result.reportId}-${result.asOf.slice(0, 10)}.csv`, csv: toCsvWithSections(result.columns, result.rows, meta, result.sections ?? []) };
  }

  // ------------------------------------------------------------------ filter options

  async filterOptions(claims: RequestClaims, id: string): Promise<ReportFilterOptions> {
    const { def, access } = await this.resolve(claims, id);
    const wants = new Set(def.filters);
    const payrollAccess = await this.payrollAccess(claims, def);
    return this.db.withClaims(claims, async (client) => {
      const out: ReportFilterOptions = {};
      let callerEmployeeId: string | null = null;
      if (access.scope === "team") {
        const me = await client.query<{ id: string }>("SELECT id FROM employees WHERE user_account_id = $1 AND company_id = $2 LIMIT 1", [claims.sub, claims.company_id]);
        callerEmployeeId = me.rows[0]?.id ?? null;
      }
      const scoped = (p: Params) => employeeConditions(p, { alias: "e", companyId: claims.company_id as string, scope: access.scope, callerEmployeeId }).join(" AND ");
      if (wants.has("department")) {
        const p = new Params();
        const r = await client.query<ReportFilterOption>(
          `SELECT ou.id::text AS value, ou.name AS label FROM org_units ou WHERE ou.id IN (SELECT DISTINCT e.org_unit_id FROM employees e WHERE ${scoped(p)} AND e.org_unit_id IS NOT NULL) ORDER BY ou.name LIMIT 500`,
          p.values
        );
        out.department = [{ value: UNASSIGNED, label: "No department set" }, ...r.rows];
      }
      if (wants.has("location")) {
        const p = new Params();
        const r = await client.query<ReportFilterOption>(
          `SELECT l.id::text AS value, l.name AS label FROM locations l WHERE l.id IN (SELECT DISTINCT e.location_id FROM employees e WHERE ${scoped(p)} AND e.location_id IS NOT NULL) ORDER BY l.name LIMIT 500`,
          p.values
        );
        out.location = [{ value: UNASSIGNED, label: "No location set" }, ...r.rows];
      }
      if (wants.has("employmentType")) {
        const p = new Params();
        const r = await client.query<{ v: string }>(`SELECT DISTINCT e.employment_type AS v FROM employees e WHERE ${scoped(p)} ORDER BY 1 LIMIT 50`, p.values);
        out.employmentType = r.rows.map((x) => ({ value: x.v, label: prettyKey(x.v) }));
      }
      if (wants.has("leaveType")) {
        const r = await client.query<{ code: string; name: string }>("SELECT code, name FROM leave_types WHERE company_id = $1 AND is_active ORDER BY sort_order, name LIMIT 100", [claims.company_id]);
        out.leaveType = r.rows.map((x) => ({ value: x.code, label: x.name }));
      }
      if (wants.has("requestStatus")) {
        out.requestStatus = ["pending", "approved", "rejected", "cancelled"].map((v) => ({ value: v, label: prettyKey(v) }));
      }
      if (wants.has("runStatus") && payrollAccess) {
        const r = await client.query<{ status: string; payroll_area_id: string | null }>("SELECT DISTINCT status, payroll_area_id FROM payroll_runs WHERE company_id = $1 AND is_simulation = false", [claims.company_id]);
        const set = new Set(r.rows.filter((x) => isPayrollAreaInScope(payrollAccess, x.payroll_area_id)).map((x) => x.status));
        out.runStatus = [...set].sort().map((v) => ({ value: v, label: prettyKey(v) }));
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ telemetry (never stores filters or rows)

  private async logUsage(
    claims: RequestClaims,
    def: ReportDefinition,
    kind: "run" | "export",
    status: "ok" | "denied" | "invalid" | "error",
    durationMs: number,
    rowCount: number | null,
    errorCategory: string | null
  ): Promise<void> {
    try {
      await this.db.withClaims(claims, (client) =>
        client.query(
          `INSERT INTO report_run_log (company_id, user_account_id, report_id, report_version, kind, status, duration_ms, row_count, error_category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [claims.company_id, claims.sub, def.id, def.version, kind, status, durationMs, rowCount, errorCategory]
        )
      );
    } catch {
      // telemetry must never break a report
    }
  }

  /** @internal telemetry for builder runs, which have no catalog definition. Uses the sentinel id X00. */
  async logCustomUsage(claims: RequestClaims, kind: "run" | "export", status: "ok" | "denied" | "invalid" | "error", durationMs: number, rowCount: number | null, errorCategory: string | null): Promise<void> {
    try {
      await this.db.withClaims(claims, (client) =>
        client.query(
          `INSERT INTO report_run_log (company_id, user_account_id, report_id, report_version, kind, status, duration_ms, row_count, error_category)
           VALUES ($1, $2, 'X00', 1, $3, $4, $5, $6, $7)`,
          [claims.company_id, claims.sub, kind, status, durationMs, rowCount, errorCategory]
        )
      );
    } catch {
      // telemetry must never break a report
    }
  }

  private async touchRecent(claims: RequestClaims, id: string): Promise<void> {
    try {
      await this.db.withClaims(claims, (client) =>
        client.query(
          `INSERT INTO report_recent_views (company_id, user_account_id, report_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_account_id, report_id) DO UPDATE SET last_viewed_at = now(), view_count = report_recent_views.view_count + 1`,
          [claims.company_id, claims.sub, id]
        )
      );
    } catch {
      // a missing "recently viewed" entry is harmless
    }
  }
}

export type { ReportFilterValues };
