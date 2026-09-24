import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { TenantUsageSummary } from "@aihxm/shared-types";

/**
 * TM-027/028 — Usage dashboard + Storage quota. Every figure here is a
 * real query against this tenant's own rows, not a mock/placeholder
 * (unlike `CompanyDashboardRow.mockMrrUsd`, which has no real billing
 * system to read from yet — employees, logins, documents, and the daily
 * counters below all genuinely exist).
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async getSummary(claims: RequestClaims, companyId: string): Promise<TenantUsageSummary> {
    return this.db.withClaims(claims, async (client) => {
      const companyRow = await client.query(
        "SELECT storage_quota_mb FROM companies WHERE id = $1",
        [companyId]
      );
      if (companyRow.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      const employeeCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'",
        [companyId]
      );

      const userCount = await client.query(
        `SELECT COUNT(DISTINCT user_account_id)::int AS n FROM (
           SELECT user_account_id FROM employees WHERE company_id = $1 AND user_account_id IS NOT NULL
           UNION
           SELECT user_account_id FROM company_admins WHERE company_id = $1 AND user_account_id IS NOT NULL
         ) accounts`,
        [companyId]
      );

      const storageRow = await client.query(
        "SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM employee_documents WHERE company_id = $1",
        [companyId]
      );
      const storageUsedMb = Number(storageRow.rows[0].bytes) / (1024 * 1024);

      // Last 30 days of API/email counters, plus a 30-day total.
      const usageRows = await client.query(
        `SELECT usage_date, api_request_count, email_sent_count
         FROM tenant_daily_usage_counter
         WHERE company_id = $1 AND usage_date >= CURRENT_DATE - INTERVAL '29 days'
         ORDER BY usage_date ASC`,
        [companyId]
      );

      const apiRequestsLast30Days = usageRows.rows.reduce((sum, r) => sum + r.api_request_count, 0);
      const emailsSentLast30Days = usageRows.rows.reduce((sum, r) => sum + r.email_sent_count, 0);

      return {
        companyId,
        employeeCount: employeeCount.rows[0].n,
        userCount: userCount.rows[0].n,
        storageUsedMb: Math.round(storageUsedMb * 100) / 100,
        storageQuotaMb: companyRow.rows[0].storage_quota_mb,
        apiRequestsLast30Days,
        emailsSentLast30Days,
        dailyUsage: usageRows.rows.map((r) => ({
          date: r.usage_date.toISOString ? r.usage_date.toISOString().slice(0, 10) : String(r.usage_date),
          apiRequestCount: r.api_request_count,
          emailSentCount: r.email_sent_count,
        })),
      };
    });
  }

  /** TM-028 — Manage Quota. "Quota cannot be below usage" (spec's own validation rule). */
  async setStorageQuota(claims: RequestClaims, companyId: string, storageQuotaMb: number): Promise<TenantUsageSummary> {
    if (!Number.isInteger(storageQuotaMb) || storageQuotaMb < 0) {
      throw new BadRequestException("Storage quota must be a non-negative whole number of MB.");
    }
    await this.db.withClaims(claims, async (client) => {
      const companyRow = await client.query("SELECT id FROM companies WHERE id = $1", [companyId]);
      if (companyRow.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const storageRow = await client.query(
        "SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM employee_documents WHERE company_id = $1",
        [companyId]
      );
      const usedMb = Number(storageRow.rows[0].bytes) / (1024 * 1024);
      if (storageQuotaMb < usedMb) {
        throw new BadRequestException(
          `Quota cannot be set below current usage (${Math.round(usedMb)} MB used).`
        );
      }

      await client.query("UPDATE companies SET storage_quota_mb = $2, updated_at = now() WHERE id = $1", [
        companyId,
        storageQuotaMb,
      ]);
      await this.audit.record(client, claims, {
        companyId,
        action: "company.storage_quota.updated",
        target: companyId,
        metadata: { storageQuotaMb },
      });
    });
    return this.getSummary(claims, companyId);
  }
}
