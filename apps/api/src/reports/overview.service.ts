import { Injectable } from "@nestjs/common";
import type { ReportKpi, ReportsOverview } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { REPORT_BY_ID } from "./catalog/report-catalog";
import { ReportsService } from "./reports.service";

/** Headline figures: the first KPIs of real reports. A tile appears only when the viewer can run its report. */
const TILES: Array<{ reportId: string; max: number }> = [
  { reportId: "A01", max: 3 },
  { reportId: "H01", max: 1 },
  { reportId: "D01", max: 2 },
  { reportId: "C01", max: 1 },
];

/** Things that need a person's attention: shown only when the (list) report has at least one row. */
const ATTENTION: Array<{ reportId: string; message: (n: number) => string }> = [
  { reportId: "H02", message: (n) => `${n} approval${n === 1 ? " has" : "s have"} been waiting longer than expected` },
  { reportId: "D06", message: (n) => `${n} missing-punch exception${n === 1 ? "" : "s"} to review` },
  { reportId: "B11", message: (n) => `${n} contract${n === 1 ? "" : "s"} ending soon` },
  { reportId: "B12", message: (n) => `${n} employee${n === 1 ? "" : "s"} nearing the end of probation` },
  { reportId: "B14", message: (n) => `${n} employee document${n === 1 ? "" : "s"} expiring soon` },
  { reportId: "F10", message: (n) => `${n} payroll exception${n === 1 ? "" : "s"} to resolve` },
];

const CACHE_MS = 60_000;

@Injectable()
export class OverviewService {
  private cache = new Map<string, { at: number; value: ReportsOverview }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService
  ) {}

  async overview(claims: RequestClaims): Promise<ReportsOverview> {
    const ctx = await this.reports.callerContext(claims);
    const key = `${claims.company_id}:${claims.sub}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    const quiet = async (id: string) => {
      try {
        return await this.reports.execute(claims, id, { filters: {}, quiet: true }, 1, "run", null);
      } catch {
        return null; // not available to this viewer, or failed: the tile is simply left out, never faked
      }
    };
    const tiles = await Promise.all(TILES.map(async (t) => ({ t, r: await quiet(t.reportId) })));
    const attention = await Promise.all(ATTENTION.map(async (a) => ({ a, r: await quiet(a.reportId) })));

    const kpis: ReportKpi[] = tiles.flatMap(({ t, r }) => (r ? r.kpis.slice(0, t.max).map((k) => ({ ...k, reportId: t.reportId })) : []));
    const highlights = attention.flatMap(({ a, r }) => {
      if (!r) return [];
      const n = r.totalRows;
      if (n <= 0) return [];
      return [{ reportId: a.reportId, title: REPORT_BY_ID.get(a.reportId)?.title ?? a.reportId, severity: "attention" as const, message: a.message(n) }];
    });

    const counts = await this.db.withClaims(claims, async (client) => {
      const q = async (sql: string, params: unknown[]) => Number((await client.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);
      const mine = await q("SELECT COUNT(*)::int AS n FROM saved_reports WHERE owner_user_account_id = $1 AND archived_at IS NULL", [claims.sub]);
      const dashboards = await q("SELECT COUNT(*)::int AS n FROM dashboards WHERE owner_user_account_id = $1 AND archived_at IS NULL", [claims.sub]);
      const schedules = await q("SELECT COUNT(*)::int AS n FROM report_schedules WHERE owner_user_account_id = $1", [claims.sub]);
      const shared = await q(
        `SELECT COUNT(DISTINCT s.saved_report_id)::int AS n FROM report_shares s JOIN saved_reports sr ON sr.id = s.saved_report_id AND sr.archived_at IS NULL
          WHERE s.saved_report_id IS NOT NULL AND sr.owner_user_account_id <> $1 AND ((s.grantee_type = 'user' AND s.grantee_user_account_id = $1)
             OR (s.grantee_type = 'role' AND s.grantee_role_key IN (SELECT r.key FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id WHERE ura.user_account_id = $1 AND ura.company_id = $2
                  AND (ura.effective_from IS NULL OR ura.effective_from <= CURRENT_DATE) AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE))))`,
        [claims.sub, claims.company_id]
      );
      const favs = await client.query<{ report_id: string }>("SELECT report_id FROM report_favorites WHERE user_account_id = $1", [claims.sub]);
      const recent = await client.query<{ report_id: string }>("SELECT report_id FROM report_recent_views WHERE user_account_id = $1 ORDER BY last_viewed_at DESC LIMIT 8", [claims.sub]);
      return { mine, dashboards, schedules, shared, favorites: favs.rows.map((x) => x.report_id), recent: recent.rows.map((x) => x.report_id) };
    });
    void ctx;
    const value: ReportsOverview = {
      generatedAt: new Date().toISOString(),
      kpis,
      highlights,
      favorites: counts.favorites,
      recent: counts.recent,
      mine: counts.mine,
      sharedWithMe: counts.shared,
      dashboards: counts.dashboards,
      schedules: counts.schedules,
    };
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 500) this.cache.clear();
    return value;
  }
}
