import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "usage-tracking" };

/**
 * TM-027's Usage dashboard needs REAL counters, not a mock number — this
 * is the one place either counter is ever incremented from (the
 * interceptor for `api_request_count`, `NotificationsService` for
 * `email_sent_count`), so both call through here rather than each
 * hand-rolling its own upsert. Runs under `is_service` claims: this is
 * infrastructure bookkeeping with no real user session behind it, same
 * posture as `CompaniesLifecycleScheduler`'s cron sweep.
 */
export async function incrementDailyUsage(
  db: DatabaseService,
  companyId: string,
  field: "api_request_count" | "email_sent_count"
): Promise<void> {
  await db.withClaims(SERVICE_CLAIMS, async (client) => {
    await client.query(
      `INSERT INTO tenant_daily_usage_counter (company_id, usage_date, ${field})
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (company_id, usage_date)
       DO UPDATE SET ${field} = tenant_daily_usage_counter.${field} + 1`,
      [companyId]
    );
  });
}
