import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { RequestClaims } from "../database/tenant-context";
import type { PackageTier, SubscriptionSummary } from "@aihxm/shared-types";

/**
 * TM-025/026 — Subscription: current plan + seat management. Reuses
 * `companies.package_tier`/`seats_purchased` (already the source of truth
 * `EntitlementsService.seedForNewCompany` reads at creation time) rather
 * than inventing a parallel `subscriptions` table the spec's own generic
 * naming suggests — this platform already has exactly one place a
 * company's tier lives. `tenant_subscription_history` (migration 0042)
 * is new: a real audit trail of every plan/seat change, which the
 * `companies` row alone can't give you.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService
  ) {}

  async getSummary(claims: RequestClaims, companyId: string): Promise<SubscriptionSummary> {
    return this.db.withClaims(claims, async (client) => {
      const companyRow = await client.query(
        "SELECT package_tier, seats_purchased FROM companies WHERE id = $1",
        [companyId]
      );
      if (companyRow.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const { package_tier: packageTier, seats_purchased: seatsPurchased } = companyRow.rows[0];

      // "Seat" = a currently-employed person (active or on leave — not
      // terminated), matching how per-seat HR SaaS pricing is normally
      // billed. This is the closest real number this schema has; there is
      // no separate billing system to ask instead (Decision noted on
      // CompanyDashboardRow.mockMrrUsd applies here too).
      const usedRow = await client.query(
        "SELECT COUNT(*)::int AS used FROM employees WHERE company_id = $1 AND employment_status <> 'terminated'",
        [companyId]
      );
      const seatsUsed = usedRow.rows[0].used;

      const historyRows = await client.query(
        `SELECT * FROM tenant_subscription_history WHERE company_id = $1 ORDER BY changed_at DESC LIMIT 50`,
        [companyId]
      );

      return {
        companyId,
        packageTier,
        seatsPurchased,
        seatsUsed,
        seatsAvailable: Math.max(0, seatsPurchased - seatsUsed),
        history: historyRows.rows.map((row) => ({
          id: row.id,
          fromTier: row.from_tier,
          toTier: row.to_tier,
          seatsPurchased: row.seats_purchased,
          changedBy: row.changed_by,
          changedAt: row.changed_at.toISOString(),
        })),
      };
    });
  }

  /** TM-025 — Change Plan. */
  async changePlan(claims: RequestClaims, companyId: string, toTier: PackageTier): Promise<SubscriptionSummary> {
    await this.db.withClaims(claims, async (client) => {
      const tierRow = await client.query("SELECT key FROM package_tier WHERE key = $1", [toTier]);
      if (tierRow.rowCount === 0) {
        throw new BadRequestException(`"${toTier}" is not a known plan.`);
      }
      const companyRow = await client.query("SELECT package_tier FROM companies WHERE id = $1", [companyId]);
      if (companyRow.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }
      const fromTier = companyRow.rows[0].package_tier;

      await client.query("UPDATE companies SET package_tier = $2, updated_at = now() WHERE id = $1", [
        companyId,
        toTier,
      ]);
      await client.query(
        `INSERT INTO tenant_subscription_history (company_id, from_tier, to_tier, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [companyId, fromTier, toTier, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "company.subscription.plan_changed",
        target: companyId,
        metadata: { fromTier, toTier },
      });
    });
    return this.getSummary(claims, companyId);
  }

  /** TM-026 — seat management: set the absolute number of purchased seats. */
  async setSeats(claims: RequestClaims, companyId: string, seatsPurchased: number): Promise<SubscriptionSummary> {
    if (!Number.isInteger(seatsPurchased) || seatsPurchased < 0) {
      throw new BadRequestException("Seat count must be a non-negative whole number.");
    }
    await this.db.withClaims(claims, async (client) => {
      const companyRow = await client.query(
        "SELECT package_tier FROM companies WHERE id = $1",
        [companyId]
      );
      if (companyRow.rowCount === 0) {
        throw new NotFoundException("Company not found");
      }

      await client.query("UPDATE companies SET seats_purchased = $2, updated_at = now() WHERE id = $1", [
        companyId,
        seatsPurchased,
      ]);
      await client.query(
        `INSERT INTO tenant_subscription_history (company_id, from_tier, to_tier, seats_purchased, changed_by)
         VALUES ($1, $2, $2, $3, $4)`,
        [companyId, companyRow.rows[0].package_tier, seatsPurchased, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId,
        action: "company.subscription.seats_changed",
        target: companyId,
        metadata: { seatsPurchased },
      });
    });
    return this.getSummary(claims, companyId);
  }
}
