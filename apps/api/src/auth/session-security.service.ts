import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { CacheService } from "../cache/cache.service";
import type { RequestClaims } from "../database/tenant-context";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "session-security" };

// Short TTLs, not zero: a revoke/lock write path calls `cache.invalidate()`
// directly (see SessionsService/CompaniesService), so the effect is
// immediate for the case that matters; the TTL is only a safety net for
// direct SQL changes or a missed invalidation, same trade-off CacheService
// itself documents for entitlements/RBAC caching.
const REVOCATION_CACHE_TTL_SECONDS = 15;
const COMPANY_STATUS_CACHE_TTL_SECONDS = 15;

export type CompanyAccessStatus = "ok" | "locked" | "suspended" | "archived" | "not_found";

/**
 * The piece that makes Force Logout (TM-017/029) and Tenant Lock (TM-030)
 * actually enforceable rather than a status flag nothing reads. Before
 * this, `PlatformAdminGuard`/`SessionGuard` did pure `jwt.verify` with zero
 * DB access — a real, verified gap: `companies.status` could already be
 * set to `suspended`, but no guard anywhere checked it, so a "suspended"
 * tenant's existing sessions kept working exactly as before.
 *
 * Both checks are cached (CacheService, Phase 14 — built but previously
 * unused on any hot path) so this adds at most one cheap cache read to
 * the request path in the common case, not a Postgres round-trip per
 * request.
 */
@Injectable()
export class SessionSecurityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService
  ) {}

  private revocationCacheKey(sessionId: string): string {
    return `session-revoked:${sessionId}`;
  }

  private companyStatusCacheKey(companyId: string): string {
    return `company-access-status:${companyId}`;
  }

  /**
   * A token with no `jti` (issued before sessions existed) is never
   * treated as revoked here; it simply expires on its own short natural
   * TTL. Tokens minted by `AuthService.issueSessionToken()`, and — as of
   * Tenant Management gap-fill Phase 1 item #4 — "Login As" impersonation
   * tokens from `companies.service.ts`'s `impersonate()`, both carry a
   * real `jti` and can be force-revoked here.
   */
  async isRevoked(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) return false;
    return this.cache.getOrLoad(this.revocationCacheKey(sessionId), REVOCATION_CACHE_TTL_SECONDS, () =>
      this.db.withClaims(SERVICE_CLAIMS, async (client) => {
        const result = await client.query<{ revoked_at: string | null }>(
          "SELECT revoked_at FROM user_sessions WHERE id = $1",
          [sessionId]
        );
        return result.rowCount === 0 ? false : result.rows[0].revoked_at !== null;
      })
    );
  }

  async companyAccessStatus(companyId: string): Promise<CompanyAccessStatus> {
    return this.cache.getOrLoad(this.companyStatusCacheKey(companyId), COMPANY_STATUS_CACHE_TTL_SECONDS, () =>
      this.db.withClaims(SERVICE_CLAIMS, async (client) => {
        const result = await client.query<{ status: string }>("SELECT status FROM companies WHERE id = $1", [
          companyId,
        ]);
        if (result.rowCount === 0) return "not_found";
        const status = result.rows[0].status;
        return status === "locked" || status === "suspended" || status === "archived" ? status : "ok";
      })
    );
  }

  /** Called by the Force Logout / revoke-session write path so the effect is immediate, not up-to-15-seconds-stale. */
  async invalidateSessionCache(sessionId: string): Promise<void> {
    await this.cache.invalidate(this.revocationCacheKey(sessionId));
  }

  /** Called by the Tenant Lock / Suspend / Archive / reactivate write path for the same reason. */
  async invalidateCompanyStatusCache(companyId: string): Promise<void> {
    await this.cache.invalidate(this.companyStatusCacheKey(companyId));
  }
}
