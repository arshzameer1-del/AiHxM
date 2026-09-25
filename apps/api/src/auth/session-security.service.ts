import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { CacheService } from "../cache/cache.service";
import type { RequestClaims } from "../database/tenant-context";
import { parseIpList } from "./ip-match.util";

const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "session-security" };

// Short TTLs, not zero: a revoke/lock write path calls `cache.invalidate()`
// directly (see SessionsService/CompaniesService), so the effect is
// immediate for the case that matters; the TTL is only a safety net for
// direct SQL changes or a missed invalidation, same trade-off CacheService
// itself documents for entitlements/RBAC caching.
const REVOCATION_CACHE_TTL_SECONDS = 15;
const COMPANY_STATUS_CACHE_TTL_SECONDS = 15;
const SECURITY_POLICY_CACHE_TTL_SECONDS = 15;
const PLATFORM_ADMIN_ACCESS_CACHE_TTL_SECONDS = 15;

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. How long a
 * successful `POST /auth/step-up` grant lasts before a sensitive action
 * needs it re-proven. 5 minutes matches this codebase's existing
 * short-window precedents (RESET_TOKEN_TTL_MINUTES's own 30 minutes is a
 * one-time credential, not a repeatable window; this is closer in spirit
 * to a login-time `mfa_verify` ticket's freshness) — long enough to cover
 * one deliberate admin action plus its confirmation UI, short enough that
 * a grant left open in a background tab is never a standing risk.
 */
export const STEP_UP_TTL_SECONDS = 300;

export type CompanyAccessStatus = "ok" | "locked" | "suspended" | "archived" | "not_found";

/**
 * Phase 2 gap-fill items #1/#3/#4 — a tenant's effective auth/session
 * policy, read from `tenant_configuration`/`tenant_configuration_defaults`
 * (migrations 0042 + 0055) rather than a bespoke settings table, so every
 * value here already has the generic override/history/rollback UI the
 * Configuration tab provides for free. These are the hardcoded fallbacks
 * this codebase used before Phase 2 (MAX_FAILED_ATTEMPTS=5,
 * LOCKOUT_MINUTES=15, a flat 12h token) — used only as a defensive floor
 * if a defaults row is ever somehow missing, never as the normal path.
 */
export type TenantSecurityPolicy = {
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  sessionTimeoutMinutes: number;
  /** 0 = unlimited. */
  maxConcurrentSessions: number;
  ipAllowlist: string[];
  ipDenylist: string[];
};

const FALLBACK_SECURITY_POLICY: TenantSecurityPolicy = {
  maxLoginAttempts: 5,
  lockoutDurationMinutes: 15,
  sessionTimeoutMinutes: 720,
  maxConcurrentSessions: 0,
  ipAllowlist: [],
  ipDenylist: [],
};

export type PlatformAdminAccess = {
  accessLevel: "full" | "read_only" | "scoped";
  scopedCompanyIds: string[];
};

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

  private securityPolicyCacheKey(companyId: string): string {
    return `tenant-security-policy:${companyId}`;
  }

  /**
   * `companyId === null` is a Platform Admin session — there is no tenant
   * to look a policy up for, and no per-tenant override could apply to a
   * Platform Admin's own login, so this returns the fallback directly
   * without a DB round-trip.
   */
  async getEffectiveSecurityPolicy(companyId: string | null): Promise<TenantSecurityPolicy> {
    if (!companyId) return FALLBACK_SECURITY_POLICY;

    return this.cache.getOrLoad(this.securityPolicyCacheKey(companyId), SECURITY_POLICY_CACHE_TTL_SECONDS, () =>
      this.db.withClaims(SERVICE_CLAIMS, async (client) => {
        const result = await client.query<{ setting_key: string; value: unknown }>(
          `SELECT d.setting_key, COALESCE(o.value, d.default_value) AS value
           FROM tenant_configuration_defaults d
           LEFT JOIN tenant_configuration o
             ON o.company_id = $1 AND o.category = d.category AND o.setting_key = d.setting_key
           WHERE d.category = 'security'`,
          [companyId]
        );
        const byKey = new Map(result.rows.map((r) => [r.setting_key, r.value]));
        const asInt = (key: string, fallback: number): number => {
          const v = byKey.get(key);
          return typeof v === "number" && Number.isInteger(v) ? v : fallback;
        };
        const asIpList = (key: string): string[] => {
          const v = byKey.get(key);
          return typeof v === "string" ? parseIpList(v) : [];
        };
        return {
          maxLoginAttempts: asInt("max_login_attempts", FALLBACK_SECURITY_POLICY.maxLoginAttempts),
          lockoutDurationMinutes: asInt("lockout_duration_minutes", FALLBACK_SECURITY_POLICY.lockoutDurationMinutes),
          sessionTimeoutMinutes: asInt("session_timeout_minutes", FALLBACK_SECURITY_POLICY.sessionTimeoutMinutes),
          maxConcurrentSessions: asInt("max_concurrent_sessions", FALLBACK_SECURITY_POLICY.maxConcurrentSessions),
          ipAllowlist: asIpList("ip_allowlist"),
          ipDenylist: asIpList("ip_denylist"),
        };
      })
    );
  }

  /** Called by TenantConfigurationService whenever a 'security' setting is
   *  overridden/reset/rolled back, so a policy change takes effect on the
   *  next request rather than up to 15 seconds later. */
  async invalidateSecurityPolicyCache(companyId: string): Promise<void> {
    await this.cache.invalidate(this.securityPolicyCacheKey(companyId));
  }

  private platformAdminAccessCacheKey(userAccountId: string): string {
    return `platform-admin-access:${userAccountId}`;
  }

  /**
   * Phase 2 gap-fill item #7 — Platform Admin delegation. Looked up by
   * `user_account_id` (the JWT's `sub`, same identifier PlatformAdminGuard
   * already has on hand) rather than the `platform_admins.id` row id,
   * since that's what a request actually carries. A user_account with no
   * matching `platform_admins` row (shouldn't happen for a token that
   * already passed `is_platform_admin` verification) defaults to the same
   * unrestricted 'full' access every admin had before this feature existed.
   */
  async getPlatformAdminAccess(userAccountId: string): Promise<PlatformAdminAccess> {
    return this.cache.getOrLoad(
      this.platformAdminAccessCacheKey(userAccountId),
      PLATFORM_ADMIN_ACCESS_CACHE_TTL_SECONDS,
      () =>
        this.db.withClaims(SERVICE_CLAIMS, async (client) => {
          const adminRow = await client.query<{ id: string; access_level: PlatformAdminAccess["accessLevel"] }>(
            "SELECT id, access_level FROM platform_admins WHERE user_account_id = $1",
            [userAccountId]
          );
          if (adminRow.rowCount === 0) {
            return { accessLevel: "full" as const, scopedCompanyIds: [] };
          }
          const { id, access_level: accessLevel } = adminRow.rows[0];
          if (accessLevel !== "scoped") {
            return { accessLevel, scopedCompanyIds: [] };
          }
          const scopeRows = await client.query<{ company_id: string }>(
            "SELECT company_id FROM platform_admin_company_scope WHERE platform_admin_id = $1",
            [id]
          );
          return { accessLevel, scopedCompanyIds: scopeRows.rows.map((r) => r.company_id) };
        })
    );
  }

  /** Called by PlatformAdminsService whenever an admin's access level or scope changes. */
  async invalidatePlatformAdminAccessCache(userAccountId: string): Promise<void> {
    await this.cache.invalidate(this.platformAdminAccessCacheKey(userAccountId));
  }

  private stepUpCacheKey(sessionId: string): string {
    return `step-up-verified:${sessionId}`;
  }

  /**
   * Phase 2 gap-fill item #2 — step-up re-authentication. Recorded by
   * StepUpService right after a fresh TOTP/recovery-code check succeeds;
   * read by StepUpGuard on every `@RequireStepUp()` route. Deliberately a
   * cache entry, not a `user_sessions` column: this is a short-lived,
   * purely additive grant with no audit/history value of its own (the
   * sensitive action it unlocks is what gets audited), so it needs no
   * migration and — same trade-off as every other cache use in this file —
   * naturally expires back to "not verified" (fail closed) rather than
   * needing an explicit cleanup path.
   */
  async recordStepUp(sessionId: string): Promise<void> {
    await this.cache.set(this.stepUpCacheKey(sessionId), true, STEP_UP_TTL_SECONDS);
  }

  async hasRecentStepUp(sessionId: string): Promise<boolean> {
    return (await this.cache.get<boolean>(this.stepUpCacheKey(sessionId))) === true;
  }
}
