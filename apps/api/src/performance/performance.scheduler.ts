import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { tenantToday } from "./performance-phases";

/**
 * TAL-05: persists the `overdue` goal status nightly (the API also derives it on read, so the UI is right between runs) and
 * writes a system row to the goal history so the change is explainable.
 */
@Injectable()
export class PerformanceScheduler {
  private readonly logger = new Logger(PerformanceScheduler.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  @Cron("45 2 * * *")
  async nightly(): Promise<void> {
    try {
      const r = await this.run();
      if (r.goalsMarkedOverdue > 0) this.logger.log(`Marked ${r.goalsMarkedOverdue} goal(s) overdue`);
    } catch (err) {
      this.logger.error(`Nightly goal job failed: ${(err as Error).message}`);
    }
  }

  async run(onlyCompanyIds?: string[]): Promise<{ goalsMarkedOverdue: number }> {
    const svc = { is_platform_admin: false, is_service: true, sub: "system:performance-scheduler" };
    const companies = await this.db.withClaims({ ...svc, company_id: null } as never, async (c) => {
      const r = await c.query<{ id: string }>(`SELECT id FROM companies`);
      return r.rows.map((x) => x.id);
    });
    let total = 0;
    for (const companyId of companies) {
      if (onlyCompanyIds && !onlyCompanyIds.includes(companyId)) continue;
      total += await this.db.withClaims({ ...svc, company_id: companyId } as never, async (client) => {
        const today = await tenantToday(client, companyId);
        const r = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM goals
            WHERE company_id = $1 AND due_date < $2::date AND status IN ('active','in_progress','at_risk')`,
          [companyId, today]
        );
        for (const g of r.rows) {
          await client.query(`UPDATE goals SET status = 'overdue', updated_at = now() WHERE id = $1`, [g.id]);
          await client.query(
            `INSERT INTO goal_updates (company_id, goal_id, update_type, from_status, to_status, note)
             VALUES ($1,$2,'system',$3,'overdue','Past its due date')`,
            [companyId, g.id, g.status]
          );
        }
        if (r.rowCount) {
          await this.audit.record(client, { ...svc, company_id: companyId } as never, {
            companyId,
            action: "performance.goals.marked_overdue",
            target: `company:${companyId}`,
            metadata: { count: r.rowCount },
            reason: "Nightly overdue sweep",
            correlationId: randomUUID(),
          });
        }
        return r.rowCount ?? 0;
      });
    }
    return { goalsMarkedOverdue: total };
  }
}
