import { Pool } from "pg";
import { SessionSecurityService } from "./session-security.service";
import { DatabaseService } from "../database/database.service";
import { CacheService } from "../cache/cache.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "session-security-service-fixtures",
};

/**
 * Phase 2 gap-fill items #1/#3/#4/#7 — SessionSecurityService's new
 * tenant-security-policy and platform-admin-access lookups.
 * getPlatformAdminAccess() and getEffectiveSecurityPolicy() are already
 * exercised indirectly by the guard/service e2e specs; this file covers
 * them directly, including the cache-invalidation paths that would be
 * awkward to prove at the HTTP layer (the 15s TTL means a wrong
 * invalidation call would only surface as flaky staleness there).
 */
describe("SessionSecurityService", () => {
  let service: SessionSecurityService;
  let pool: Pool;
  let db: DatabaseService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
  });

  beforeEach(() => {
    // A fresh CacheService (and therefore a fresh in-memory cache) per
    // test, same reasoning as every other *.service.spec.ts in this
    // codebase using `new XService(...)` directly — this also means each
    // test's cache starts cold, so a passing assertion actually exercised
    // the DB-loader/invalidation path rather than a leftover cached value
    // from a previous test.
    service = new SessionSecurityService(db, new CacheService());
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createCompany(): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const result = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Security Policy Co ${stamp}`,
        `security-policy-${stamp}`,
      ]);
      return result.rows[0].id as string;
    });
  }

  async function setSecurityOverride(companyId: string, settingKey: string, value: unknown): Promise<void> {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query(
        `INSERT INTO tenant_configuration (company_id, category, setting_key, value, updated_by)
         VALUES ($1, 'security', $2, $3::jsonb, 'test-fixture')
         ON CONFLICT (company_id, category, setting_key) DO UPDATE SET value = EXCLUDED.value`,
        [companyId, settingKey, JSON.stringify(value)]
      );
    });
  }

  describe("getEffectiveSecurityPolicy", () => {
    it("returns the fallback policy directly for a Platform Admin session (null companyId), with no DB read", async () => {
      const policy = await service.getEffectiveSecurityPolicy(null);
      expect(policy).toEqual({
        maxLoginAttempts: 5,
        lockoutDurationMinutes: 15,
        sessionTimeoutMinutes: 720,
        maxConcurrentSessions: 0,
        ipAllowlist: [],
        ipDenylist: [],
      });
    });

    it("returns the product defaults for a tenant with no overrides", async () => {
      const companyId = await createCompany();
      const policy = await service.getEffectiveSecurityPolicy(companyId);
      expect(policy).toEqual({
        maxLoginAttempts: 5,
        lockoutDurationMinutes: 15,
        sessionTimeoutMinutes: 720,
        maxConcurrentSessions: 0,
        ipAllowlist: [],
        ipDenylist: [],
      });
    });

    it("reflects a tenant override for every security setting", async () => {
      const companyId = await createCompany();
      await setSecurityOverride(companyId, "max_login_attempts", 3);
      await setSecurityOverride(companyId, "lockout_duration_minutes", 30);
      await setSecurityOverride(companyId, "session_timeout_minutes", 60);
      await setSecurityOverride(companyId, "max_concurrent_sessions", 2);
      await setSecurityOverride(companyId, "ip_allowlist", "10.0.0.0/24, 192.168.1.5");
      await setSecurityOverride(companyId, "ip_denylist", "203.0.113.9");

      const policy = await service.getEffectiveSecurityPolicy(companyId);
      expect(policy).toEqual({
        maxLoginAttempts: 3,
        lockoutDurationMinutes: 30,
        sessionTimeoutMinutes: 60,
        maxConcurrentSessions: 2,
        ipAllowlist: ["10.0.0.0/24", "192.168.1.5"],
        ipDenylist: ["203.0.113.9"],
      });
    });

    it("only overrides the settings actually overridden, inheriting the rest from defaults", async () => {
      const companyId = await createCompany();
      await setSecurityOverride(companyId, "max_login_attempts", 10);

      const policy = await service.getEffectiveSecurityPolicy(companyId);
      expect(policy.maxLoginAttempts).toBe(10);
      expect(policy.lockoutDurationMinutes).toBe(15);
      expect(policy.sessionTimeoutMinutes).toBe(720);
    });

    it("does not reflect a new override until the cache is invalidated", async () => {
      const companyId = await createCompany();
      const before = await service.getEffectiveSecurityPolicy(companyId);
      expect(before.maxLoginAttempts).toBe(5);

      await setSecurityOverride(companyId, "max_login_attempts", 1);

      const stillCached = await service.getEffectiveSecurityPolicy(companyId);
      expect(stillCached.maxLoginAttempts).toBe(5);

      await service.invalidateSecurityPolicyCache(companyId);

      const afterInvalidate = await service.getEffectiveSecurityPolicy(companyId);
      expect(afterInvalidate.maxLoginAttempts).toBe(1);
    });
  });

  describe("getPlatformAdminAccess", () => {
    async function createPlatformAdmin(
      accessLevel: "full" | "read_only" | "scoped",
      scopedCompanyIds: string[] = []
    ): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const account = await client.query(
          "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
          [`session-security-${accessLevel}-${stamp}@example.com`, "hashed"]
        );
        const userAccountId = account.rows[0].id as string;
        const admin = await client.query(
          "INSERT INTO platform_admins (full_name, email, user_account_id, access_level) VALUES ($1, $2, $3, $4) RETURNING id",
          [`Session Security ${accessLevel}`, `session-security-${accessLevel}-${stamp}@example.com`, userAccountId, accessLevel]
        );
        for (const companyId of scopedCompanyIds) {
          await client.query(
            "INSERT INTO platform_admin_company_scope (platform_admin_id, company_id) VALUES ($1, $2)",
            [admin.rows[0].id, companyId]
          );
        }
        return userAccountId;
      });
    }

    it("defaults to unrestricted 'full' access for a user_account_id with no platform_admins row", async () => {
      const access = await service.getPlatformAdminAccess("00000000-0000-0000-0000-000000000000");
      expect(access).toEqual({ accessLevel: "full", scopedCompanyIds: [] });
    });

    it("returns 'full' access for a full admin", async () => {
      const userAccountId = await createPlatformAdmin("full");
      const access = await service.getPlatformAdminAccess(userAccountId);
      expect(access).toEqual({ accessLevel: "full", scopedCompanyIds: [] });
    });

    it("returns 'read_only' access with an empty scope list", async () => {
      const userAccountId = await createPlatformAdmin("read_only");
      const access = await service.getPlatformAdminAccess(userAccountId);
      expect(access).toEqual({ accessLevel: "read_only", scopedCompanyIds: [] });
    });

    it("returns 'scoped' access with the admin's actual scoped company ids", async () => {
      const companyA = await createCompany();
      const companyB = await createCompany();
      const userAccountId = await createPlatformAdmin("scoped", [companyA, companyB]);

      const access = await service.getPlatformAdminAccess(userAccountId);
      expect(access.accessLevel).toBe("scoped");
      expect(access.scopedCompanyIds.sort()).toEqual([companyA, companyB].sort());
    });

    it("does not reflect an access-level change until the cache is invalidated", async () => {
      const userAccountId = await createPlatformAdmin("full");
      const before = await service.getPlatformAdminAccess(userAccountId);
      expect(before.accessLevel).toBe("full");

      await db.withClaims(FIXTURE_CLAIMS, (client) =>
        client.query("UPDATE platform_admins SET access_level = 'read_only' WHERE user_account_id = $1", [
          userAccountId,
        ])
      );

      const stillCached = await service.getPlatformAdminAccess(userAccountId);
      expect(stillCached.accessLevel).toBe("full");

      await service.invalidatePlatformAdminAccessCache(userAccountId);

      const afterInvalidate = await service.getPlatformAdminAccess(userAccountId);
      expect(afterInvalidate.accessLevel).toBe("read_only");
    });
  });

  // Phase 2 gap-fill item #2 — step-up re-authentication. StepUpGuard/
  // StepUpService's own behavior is covered end to end at the HTTP layer
  // (step-up.e2e.spec.ts); this covers the underlying cache methods
  // directly, including that two different sessions never share a grant.
  describe("recordStepUp / hasRecentStepUp", () => {
    it("reports no grant for a session that has never stepped up", async () => {
      expect(await service.hasRecentStepUp("session-never-verified")).toBe(false);
    });

    it("reports a grant immediately after recordStepUp", async () => {
      const sessionId = "session-just-verified";
      await service.recordStepUp(sessionId);
      expect(await service.hasRecentStepUp(sessionId)).toBe(true);
    });

    it("does not extend a grant to a different session id", async () => {
      await service.recordStepUp("session-a");
      expect(await service.hasRecentStepUp("session-b")).toBe(false);
    });
  });
});
