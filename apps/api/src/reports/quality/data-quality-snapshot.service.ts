import { ExclusiveCron } from "../../common/cron-lock";
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { RequestClaims } from "../../database/tenant-context";
import { DatabaseService } from "../../database/database.service";
import { DATA_QUALITY_FIELD_ROWS } from "../engine/executors/workforce-people";

const SERVICE: RequestClaims = { is_platform_admin: false, is_service: true, sub: "data-quality-snapshot" };

/**
 * Records, once a day per company, how many current employees have each A14 field filled in. M14 draws its trend from
 * these rows. Only counts are stored, never the values. A company's own date comes from its timezone setting; the first
 * snapshot is taken shortly after the service starts so the trend begins the day it is deployed.
 */
@Injectable()
export class DataQualitySnapshotService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataQualitySnapshotService.name);
  constructor(private readonly db: DatabaseService) {}

  onApplicationBootstrap(): void {
    if (process.env.REPORT_SCHEDULER_DISABLED === "true" || process.env.NODE_ENV === "test") return;
    setTimeout(() => void this.captureAll().catch((e) => this.logger.warn(`Data quality snapshot failed: ${(e as Error).message}`)), 30_000).unref();
  }

  @Cron("30 2 * * *")
  @ExclusiveCron("DataQualitySnapshotService.nightly")
  async nightly(): Promise<void> {
    if (process.env.REPORT_SCHEDULER_DISABLED === "true") return;
    try {
      const n = await this.captureAll();
      if (n > 0) this.logger.log(`Data quality snapshot taken for ${n} company(ies)`);
    } catch (e) {
      this.logger.warn(`Data quality snapshot failed: ${(e as Error).message}`);
    }
  }

  async captureAll(): Promise<number> {
    const ids = await this.db.withClaims(SERVICE, async (c) => (await c.query("SELECT id FROM companies WHERE status <> 'churned'")).rows.map((r) => r.id as string));
    let done = 0;
    for (const id of ids) {
      try {
        await this.captureCompany(id);
        done++;
      } catch (e) {
        this.logger.warn(`Snapshot skipped for one company: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /** One company, today's date in the company's timezone. Running it twice on the same day replaces that day's figures. */
  async captureCompany(companyId: string): Promise<void> {
    await this.db.withClaims(SERVICE, async (c) => {
      await c.query(
        `WITH d AS (SELECT (now() AT TIME ZONE COALESCE((SELECT timezone FROM companies WHERE id = $1), 'UTC'))::date AS today)
         INSERT INTO data_quality_snapshots (company_id, snapshot_date, field_order, field, total, filled)
         SELECT $1::uuid, d.today, v.ord, v.field, COUNT(*)::int, (COUNT(*) FILTER (WHERE v.ok))::int
           FROM d, employees e
          CROSS JOIN LATERAL (VALUES ${DATA_QUALITY_FIELD_ROWS}) AS v(ord, field, ok)
          WHERE e.company_id = $1 AND e.employment_status <> 'terminated' AND e.date_of_joining <= d.today
          GROUP BY d.today, v.ord, v.field
         ON CONFLICT (company_id, snapshot_date, field_order) DO UPDATE SET total = EXCLUDED.total, filled = EXCLUDED.filled, field = EXCLUDED.field`,
        [companyId]
      );
    });
  }
}
