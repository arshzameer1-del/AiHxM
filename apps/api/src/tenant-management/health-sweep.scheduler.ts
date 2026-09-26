import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { HealthService } from "./health.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const SWEEP_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "tenant-health-sweep" };

/**
 * Phase 3 item #9 — Monitoring. Without a real sweep, `tenant_health_check_log`
 * only ever has data for whichever individual tenants a Platform Admin
 * happened to click into and press "Run Check" on — that would make
 * HealthService.getPlatformSummary's "at a glance" platform-wide view
 * mostly empty/stale in practice, defeating the point of building it.
 *
 * Same shape as CompaniesModule's CompaniesLifecycleScheduler: a plain
 * @nestjs/schedule cron (no BullMQ/Redis queue exists in this codebase —
 * see that class's own doc comment for why) wrapping a directly-testable
 * call into an existing, idempotent service method — here, HealthService's
 * own runCheck, run once per eligible company.
 *
 * Runs sequentially, not concurrently: each check does real file-storage
 * I/O (checkStorage's write/read/delete round-trip) per tenant, and firing
 * all of them at once would be a self-inflicted load spike with no upside.
 * One tenant's check throwing is caught and logged so it never aborts the
 * sweep for the rest — a bad tenant blocking visibility into every other
 * tenant would be exactly the kind of failure this view exists to surface.
 */
@Injectable()
export class HealthSweepScheduler {
  private readonly logger = new Logger(HealthSweepScheduler.name);

  constructor(
    private readonly health: HealthService,
    private readonly db: DatabaseService
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleSweep(): Promise<void> {
    const companyIds = await this.listEligibleCompanyIds();
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        await this.health.runCheck(SWEEP_CLAIMS, companyId);
      } catch (err) {
        failures++;
        this.logger.warn(`Health sweep check failed for company ${companyId}: ${(err as Error).message}`);
      }
    }
    if (companyIds.length > 0) {
      this.logger.log(
        `Health sweep checked ${companyIds.length} tenant(s)${failures > 0 ? `, ${failures} failed` : ""}`
      );
    }
  }

  private async listEligibleCompanyIds(): Promise<string[]> {
    return this.db.withClaims(SWEEP_CLAIMS, async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM companies WHERE status NOT IN ('draft', 'archived') ORDER BY id"
      );
      return result.rows.map((r) => r.id);
    });
  }
}
