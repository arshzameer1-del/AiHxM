import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  DashboardData,
  DashboardDetail,
  DashboardSummary,
  DashboardWidgetData,
  DashboardWidgetSummary,
  DashboardWidgetType,
  ReportResult,
  SaveDashboardRequest,
  ShareGrantee,
} from "@aihxm/shared-types";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { REPORT_BY_ID } from "../catalog/report-catalog";
import { UUID_RE } from "../engine/sql";
import { ReportsService } from "../reports.service";
import { ReportRunnerService } from "./runner.service";
import { SavedReportsService, roleKeysOf } from "./saved-reports.service";
import { SharingService } from "./sharing.service";

const MAX_WIDGETS = 12;
const WIDGET_TYPES: readonly DashboardWidgetType[] = ["kpi", "chart", "table"];
const TABLE_WIDGET_ROWS = 8;

type DashRow = { id: string; name: string; description: string | null; visibility: "private" | "shared"; owner_user_account_id: string; owner_name: string | null; widgets: number; updated_at: Date };
type WidgetRow = { id: string; position: number; widget_type: DashboardWidgetType; report_id: string | null; saved_report_id: string | null; title: string | null; config: DashboardWidgetSummary["config"] };

const SELECT = `
  SELECT d.id, d.name, d.description, d.visibility, d.owner_user_account_id, d.updated_at,
         (SELECT TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) FROM employees e WHERE e.user_account_id = d.owner_user_account_id AND e.company_id = d.company_id LIMIT 1) AS owner_name,
         (SELECT COUNT(*)::int FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widgets
    FROM dashboards d`;

const VISIBLE = (me: string, roles: string) =>
  `(d.owner_user_account_id = ${me}::uuid OR EXISTS (
      SELECT 1 FROM report_shares s WHERE s.dashboard_id = d.id
         AND ((s.grantee_type = 'user' AND s.grantee_user_account_id = ${me}::uuid) OR (s.grantee_type = 'role' AND s.grantee_role_key = ANY(${roles}::text[])))))`;

/** Trims a result to what one widget draws, so a dashboard does not ship every table of every report. */
export function shapeWidget(w: Pick<DashboardWidgetSummary, "widgetType" | "config">, r: ReportResult): ReportResult {
  if (w.widgetType === "kpi") {
    const k = r.kpis.find((x) => x.key === w.config.kpiKey) ?? r.kpis[0];
    return { ...r, kpis: k ? [k] : [], charts: [], rows: [], columns: [] };
  }
  if (w.widgetType === "chart") {
    const c = r.charts[w.config.chartIndex ?? 0] ?? r.charts[0];
    return { ...r, kpis: [], charts: c ? [c] : [], rows: [], columns: [] };
  }
  return { ...r, kpis: [], charts: [], rows: r.rows.slice(0, Math.min(w.config.rows ?? TABLE_WIDGET_ROWS, 25)) };
}

@Injectable()
export class DashboardsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService,
    private readonly saved: SavedReportsService,
    private readonly runner: ReportRunnerService,
    private readonly sharing: SharingService
  ) {}

  private summary(r: DashRow, me: string): DashboardSummary {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      ownerName: r.owner_name || null,
      isOwner: r.owner_user_account_id === me,
      visibility: r.visibility,
      widgetCount: r.widgets,
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async list(claims: RequestClaims): Promise<{ mine: DashboardSummary[]; shared: DashboardSummary[] }> {
    await this.reports.callerContext(claims);
    return this.db.withClaims(claims, async (client) => {
      const roles = await roleKeysOf(client, claims.sub, claims.company_id as string);
      const r = await client.query<DashRow>(`${SELECT} WHERE d.archived_at IS NULL AND ${VISIBLE("$1", "$2")} ORDER BY d.updated_at DESC LIMIT 100`, [claims.sub, roles]);
      const all = r.rows.map((x) => this.summary(x, claims.sub));
      return { mine: all.filter((x) => x.isOwner), shared: all.filter((x) => !x.isOwner) };
    });
  }

  private async load(claims: RequestClaims, id: string): Promise<{ row: DashRow; widgets: WidgetRow[] }> {
    if (!UUID_RE.test(id)) throw new NotFoundException("No such dashboard");
    await this.reports.callerContext(claims);
    const out = await this.db.withClaims(claims, async (client) => {
      const roles = await roleKeysOf(client, claims.sub, claims.company_id as string);
      const d = await client.query<DashRow>(`${SELECT} WHERE d.id = $3::uuid AND d.archived_at IS NULL AND ${VISIBLE("$1", "$2")}`, [claims.sub, roles, id]);
      if (!d.rows[0]) return null;
      const w = await client.query<WidgetRow>("SELECT id, position, widget_type, report_id, saved_report_id, title, config FROM dashboard_widgets WHERE dashboard_id = $1 ORDER BY position, created_at", [id]);
      return { row: d.rows[0], widgets: w.rows };
    });
    if (!out) throw new NotFoundException("No such dashboard");
    return out;
  }

  private detail(d: { row: DashRow; widgets: WidgetRow[] }, me: string): DashboardDetail {
    return {
      ...this.summary(d.row, me),
      widgets: d.widgets.map((w) => ({ id: w.id, position: w.position, widgetType: w.widget_type, reportId: w.report_id, savedReportId: w.saved_report_id, title: w.title, config: w.config ?? {} })),
    };
  }

  async get(claims: RequestClaims, id: string): Promise<DashboardDetail> {
    return this.detail(await this.load(claims, id), claims.sub);
  }

  private async mustOwn(claims: RequestClaims, id: string) {
    const d = await this.load(claims, id);
    if (d.row.owner_user_account_id !== claims.sub) throw new ForbiddenException("Only the owner can change this dashboard");
    return d;
  }

  /** Every widget must point at something the author can run today; the viewer's own access is re-checked on every view. */
  private async validateWidgets(claims: RequestClaims, widgets: NonNullable<SaveDashboardRequest["widgets"]>) {
    if (!Array.isArray(widgets) || widgets.length > MAX_WIDGETS) throw new BadRequestException(`A dashboard can hold up to ${MAX_WIDGETS} widgets`);
    const out: Array<{ widgetType: DashboardWidgetType; reportId: string | null; savedReportId: string | null; title: string | null; config: DashboardWidgetSummary["config"] }> = [];
    for (const w of widgets) {
      if (!WIDGET_TYPES.includes(w?.widgetType)) throw new BadRequestException("A widget type is not valid");
      const reportId = w.reportId ?? null;
      const savedReportId = w.savedReportId ?? null;
      if ((reportId === null) === (savedReportId === null)) throw new BadRequestException("Each widget shows one report");
      if (reportId) {
        if (!REPORT_BY_ID.has(reportId)) throw new BadRequestException("A widget refers to a report that does not exist");
        await this.reports.accessOf(claims, reportId);
      } else {
        await this.saved.get(claims, savedReportId as string);
      }
      const title = typeof w.title === "string" && w.title.trim() ? w.title.trim().slice(0, 120) : null;
      const cfg = w.config ?? {};
      const config: DashboardWidgetSummary["config"] = {};
      if (typeof cfg.kpiKey === "string" && /^[A-Za-z0-9_]{1,60}$/.test(cfg.kpiKey)) config.kpiKey = cfg.kpiKey;
      if (Number.isInteger(cfg.chartIndex) && (cfg.chartIndex as number) >= 0 && (cfg.chartIndex as number) < 10) config.chartIndex = cfg.chartIndex;
      if (Number.isInteger(cfg.rows) && (cfg.rows as number) >= 1 && (cfg.rows as number) <= 25) config.rows = cfg.rows;
      out.push({ widgetType: w.widgetType, reportId, savedReportId, title, config });
    }
    return out;
  }

  private async write(claims: RequestClaims, id: string | null, body: SaveDashboardRequest): Promise<string> {
    const ctx = await this.reports.callerContext(claims);
    if (!ctx.held.has("reports.dashboard")) throw new ForbiddenException("Not permitted to create dashboards");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 120) throw new BadRequestException("Give the dashboard a name of up to 120 characters");
    if (body.description != null && (typeof body.description !== "string" || body.description.length > 500)) throw new BadRequestException("The description can be up to 500 characters");
    const widgets = await this.validateWidgets(claims, body.widgets ?? []);
    return this.db.withClaims(claims, async (client) => {
      let did = id;
      if (did) {
        await client.query("UPDATE dashboards SET name = $2, description = $3, updated_at = now() WHERE id = $1", [did, name, body.description?.trim() || null]);
        await client.query("DELETE FROM dashboard_widgets WHERE dashboard_id = $1", [did]);
      } else {
        const r = await client.query<{ id: string }>("INSERT INTO dashboards (company_id, owner_user_account_id, name, description) VALUES ($1, $2, $3, $4) RETURNING id", [claims.company_id, claims.sub, name, body.description?.trim() || null]);
        did = (r.rows[0] as { id: string }).id;
      }
      for (const [i, w] of widgets.entries()) {
        await client.query(
          `INSERT INTO dashboard_widgets (company_id, dashboard_id, position, widget_type, report_id, saved_report_id, title, config) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [claims.company_id, did, i, w.widgetType, w.reportId, w.savedReportId, w.title, JSON.stringify(w.config)]
        );
      }
      return did as string;
    });
  }

  async create(claims: RequestClaims, body: SaveDashboardRequest): Promise<DashboardDetail> {
    return this.get(claims, await this.write(claims, null, body));
  }

  async update(claims: RequestClaims, id: string, body: SaveDashboardRequest): Promise<DashboardDetail> {
    await this.mustOwn(claims, id);
    return this.get(claims, await this.write(claims, id, body));
  }

  async archive(claims: RequestClaims, id: string): Promise<{ archived: true }> {
    await this.mustOwn(claims, id);
    await this.db.withClaims(claims, (client) => client.query("UPDATE dashboards SET archived_at = now(), updated_at = now() WHERE id = $1", [id]));
    return { archived: true };
  }

  /**
   * Runs every widget with the VIEWER's access. A widget the viewer may not run comes back as an error tile with no data,
   * so a shared dashboard never shows numbers its viewer could not get by opening the report.
   */
  async data(claims: RequestClaims, id: string): Promise<DashboardData> {
    const d = await this.load(claims, id);
    const detail = this.detail(d, claims.sub);
    const widgets: DashboardWidgetData[] = [];
    for (const w of detail.widgets) {
      const fallbackTitle = w.title ?? (w.reportId ? REPORT_BY_ID.get(w.reportId)?.title ?? w.reportId : "Saved report");
      try {
        let source;
        let title = fallbackTitle;
        if (w.reportId) source = { kind: "catalog" as const, reportId: w.reportId, filters: {}, preset: null, compare: false };
        else {
          const s = await this.saved.sourceFor(claims, w.savedReportId as string);
          source = s.source;
          if (!w.title) title = s.row.name;
        }
        const { result } = await this.runner.run(claims, source, { purpose: "screen", quiet: true });
        widgets.push({ widgetId: w.id, ok: true, error: null, title, result: shapeWidget(w, result) });
      } catch (e) {
        const status = (e as { getStatus?: () => number }).getStatus?.();
        const message = status === 403 ? "You do not have access to the data behind this widget." : status === 404 ? "This report is no longer available." : status === 408 ? "This widget took too long to load." : "This widget could not be loaded.";
        widgets.push({ widgetId: w.id, ok: false, error: message, title: fallbackTitle, result: null });
      }
    }
    return { dashboard: detail, widgets };
  }

  async shares(claims: RequestClaims, id: string): Promise<ShareGrantee[]> {
    await this.mustOwn(claims, id);
    return this.sharing.list(claims, "dashboard_id", id);
  }

  async setShares(claims: RequestClaims, id: string, grantees: Array<{ type: "user" | "role"; id: string }>): Promise<ShareGrantee[]> {
    await this.mustOwn(claims, id);
    return this.sharing.replace(claims, { column: "dashboard_id", table: "dashboards", id, name: "dashboard" }, grantees);
  }
}

