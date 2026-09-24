import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import type { RequestClaims } from "../database/tenant-context";
import type { HealthCheckResult, HealthCheckStatus } from "@aihxm/shared-types";

const CHECK_KEYS = ["api", "db", "jobs", "email", "storage", "integrations"] as const;
type CheckKey = (typeof CHECK_KEYS)[number];

/**
 * TM-032 — Health dashboard. Every check below observes something real
 * (a query round-trip, the scheduler registry, actual notification_log
 * rows, a real file-storage write/read/delete, actual tenant_integrations
 * rows) rather than always returning "ok" — a health screen that can
 * never show red is worse than none, per the spec's own "Critical alert
 * if failed" requirement, which only means something if failure is
 * possible.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(FILE_STORAGE) private readonly fileStorage: FileStorageService
  ) {}

  async runCheck(claims: RequestClaims, companyId: string): Promise<HealthCheckResult[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const results: Record<CheckKey, { status: HealthCheckStatus; detail: string }> = {
        api: await this.checkApi(),
        db: await this.checkDb(client),
        jobs: await this.checkJobs(),
        email: await this.checkEmail(client, companyId),
        storage: await this.checkStorage(companyId),
        integrations: await this.checkIntegrations(client, companyId),
      };

      const checkedAt = new Date();
      for (const key of CHECK_KEYS) {
        await client.query(
          `INSERT INTO tenant_health_check_log (company_id, check_key, status, detail, checked_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, key, results[key].status, results[key].detail, checkedAt]
        );
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "tenant_health.checked",
        target: companyId,
        metadata: { results: Object.fromEntries(CHECK_KEYS.map((k) => [k, results[k].status])) },
      });

      const failing = CHECK_KEYS.filter((k) => results[k].status === "down");
      if (failing.length > 0) {
        // Fire-and-forget: a slow/broken email provider must never make
        // the health check itself fail or hang the response.
        this.notifications
          .dispatch(
            { ...claims, company_id: companyId },
            {
              channel: "email",
              recipient: "platform-ops@aihxm.internal",
              templateKey: "tenant_health_critical",
              payload: { companyId, failingChecks: failing.join(", ") },
            }
          )
          .catch(() => undefined);
      }

      return CHECK_KEYS.map((key) => ({
        checkKey: key,
        status: results[key].status,
        detail: results[key].detail,
        checkedAt: checkedAt.toISOString(),
      }));
    });
  }

  async getLatest(claims: RequestClaims, companyId: string): Promise<HealthCheckResult[]> {
    return this.db.withClaims(claims, async (client) => {
      const companyCheck = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyCheck.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const rows = await client.query(
        `SELECT DISTINCT ON (check_key) check_key, status, detail, checked_at
         FROM tenant_health_check_log
         WHERE company_id = $1
         ORDER BY check_key, checked_at DESC`,
        [companyId]
      );
      const byKey = new Map(rows.rows.map((r) => [r.check_key, r]));
      return CHECK_KEYS.map((key) => {
        const row = byKey.get(key);
        return {
          checkKey: key,
          status: (row?.status as HealthCheckStatus) ?? "ok",
          detail: row?.detail ?? "Not yet checked — showing default until Refresh is run.",
          checkedAt: row?.checked_at?.toISOString() ?? new Date(0).toISOString(),
        };
      });
    });
  }

  private async checkApi(): Promise<{ status: HealthCheckStatus; detail: string }> {
    // This code is only reachable via a live HTTP request through the
    // whole Nest pipeline (guards, interceptors, this service), so
    // getting here at all is the check.
    return { status: "ok", detail: "Serving requests normally." };
  }

  private async checkDb(client: { query: (sql: string) => Promise<unknown> }): Promise<{
    status: HealthCheckStatus;
    detail: string;
  }> {
    const start = Date.now();
    await client.query("SELECT 1");
    const latencyMs = Date.now() - start;
    if (latencyMs > 1000) return { status: "down", detail: `Query round-trip took ${latencyMs}ms.` };
    if (latencyMs > 250) return { status: "degraded", detail: `Query round-trip took ${latencyMs}ms.` };
    return { status: "ok", detail: `Query round-trip: ${latencyMs}ms.` };
  }

  private async checkJobs(): Promise<{ status: HealthCheckStatus; detail: string }> {
    const cronJobs = this.schedulerRegistry.getCronJobs();
    if (cronJobs.size === 0) {
      return { status: "down", detail: "No scheduled jobs are registered." };
    }
    const names = Array.from(cronJobs.keys());
    return { status: "ok", detail: `${cronJobs.size} scheduled job(s) registered: ${names.join(", ")}.` };
  }

  private async checkEmail(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { status: string }[] }> },
    companyId: string
  ): Promise<{ status: HealthCheckStatus; detail: string }> {
    const result = await client.query(
      `SELECT status FROM notification_log
       WHERE company_id = $1 AND channel = 'email' AND created_at > now() - interval '7 days'
       ORDER BY created_at DESC LIMIT 20`,
      [companyId]
    );
    if (result.rows.length === 0) {
      return { status: "ok", detail: "No recent email activity to evaluate." };
    }
    const failed = result.rows.filter((r) => r.status === "failed").length;
    const failureRate = failed / result.rows.length;
    if (failureRate >= 0.5) {
      return { status: "down", detail: `${failed}/${result.rows.length} recent emails failed to send.` };
    }
    if (failureRate > 0) {
      return { status: "degraded", detail: `${failed}/${result.rows.length} recent emails failed to send.` };
    }
    return { status: "ok", detail: `${result.rows.length} recent email(s) sent successfully.` };
  }

  private async checkStorage(companyId: string): Promise<{ status: HealthCheckStatus; detail: string }> {
    const probeContent = Buffer.from(`health-check-${Date.now()}`);
    try {
      const stored = await this.fileStorage.save(companyId, "health-check", "probe.txt", probeContent);
      const readBack = await this.fileStorage.read(stored.storagePath);
      await this.fileStorage.delete(stored.storagePath);
      if (!readBack.equals(probeContent)) {
        return { status: "down", detail: "File storage write/read round-trip returned mismatched content." };
      }
      return { status: "ok", detail: "File storage write/read/delete round-trip succeeded." };
    } catch (err) {
      return { status: "down", detail: `File storage round-trip failed: ${(err as Error).message}` };
    }
  }

  private async checkIntegrations(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { provider_key: string; config: Record<string, unknown> }[] }> },
    companyId: string
  ): Promise<{ status: HealthCheckStatus; detail: string }> {
    const result = await client.query(
      "SELECT provider_key, config FROM tenant_integrations WHERE company_id = $1 AND enabled = true",
      [companyId]
    );
    if (result.rows.length === 0) {
      return { status: "ok", detail: "No integrations are enabled." };
    }
    const incomplete = result.rows.filter((r) => Object.keys(r.config ?? {}).length === 0);
    if (incomplete.length > 0) {
      return {
        status: "degraded",
        detail: `${incomplete.length} enabled integration(s) have no configuration saved: ${incomplete
          .map((r) => r.provider_key)
          .join(", ")}.`,
      };
    }
    return { status: "ok", detail: `${result.rows.length} integration(s) enabled and configured.` };
  }
}
